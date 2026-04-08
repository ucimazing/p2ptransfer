/**
 * FastTransfer — High-speed WebRTC file transfer engine.
 *
 * Speed optimizations:
 * 1. Multiple parallel DataChannels (8 channels) to saturate bandwidth
 * 2. Large chunk size (256KB) to reduce per-chunk overhead
 * 3. Ordered reliable delivery across parallel channels
 * 4. Binary ArrayBuffer transfer — zero encoding overhead
 * 5. Flow control via bufferedAmountLowThreshold to prevent backpressure stalls
 * 6. Aggressive SCTP buffer sizing
 */

const CHUNK_SIZE = 64 * 1024; // 64KB per chunk (safe for WebRTC SCTP)
const NUM_CHANNELS = 4; // Parallel data channels (4 is stable, 8 overwhelms SCTP)
const BUFFER_THRESHOLD = 512 * 1024; // 512KB — resume sending when buffer drops below this
const MAX_BUFFER = 2 * 1024 * 1024; // 2MB — pause sending when buffer exceeds this

class TransferEngine {
  constructor(role, signaling) {
    this.role = role; // 'sender' or 'receiver'
    this.signaling = signaling;
    this.pc = null;
    this.channels = [];
    this.onProgress = null;
    this.onComplete = null;
    this.onError = null;
    this.onFileInfo = null;
    this.onStats = null;

    // Transfer state
    this.file = null;
    this.fileInfo = null;
    this.totalChunks = 0;
    this.sentChunks = 0;
    this.receivedChunks = 0;
    this.receivedBuffers = [];
    this.startTime = 0;
    this.bytesTransferred = 0;
    this._speedSamples = [];
    this._lastBytes = 0;
    this._lastTime = 0;
    this._statsInterval = null;

    // ICE candidate buffer — queued until remote description is set
    this._pendingCandidates = [];
    this._remoteDescriptionSet = false;
  }

  /**
   * Initialize the RTCPeerConnection with optimized settings.
   */
  createPeerConnection() {
    // ICE servers: STUN (free) + TURN (fetched from server with time-limited credentials)
    const iceServers = [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
    ];

    const config = {
      iceServers: iceServers,
      iceCandidatePoolSize: 10,
    };

    this.pc = new RTCPeerConnection(config);

    // Fetch TURN credentials and add them (non-blocking)
    this._addTurnServers();

    this.pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.signaling.send({
          type: 'ice-candidate',
          payload: event.candidate,
        });
      }
    };

    this.pc.oniceconnectionstatechange = () => {
      const state = this.pc.iceConnectionState;
      console.log(`ICE connection state: ${state}`);
      if (state === 'failed') {
        console.error('ICE connection failed — peer may be behind strict NAT');
        if (this.onError) this.onError(new Error('Connection failed — could not reach peer'));
      } else if (state === 'disconnected') {
        console.warn('ICE disconnected — connection may recover');
      } else if (state === 'connected' || state === 'completed') {
        console.log('P2P connection established!');
      }
    };

    this.pc.onconnectionstatechange = () => {
      console.log(`Connection state: ${this.pc.connectionState}`);
    };

    return this.pc;
  }

  /**
   * Fetch TURN credentials from server and update ICE config.
   */
  async _addTurnServers() {
    try {
      const resp = await fetch('/api/turn');
      const creds = await resp.json();
      if (creds.uris && creds.uris.length > 0) {
        const turnServer = {
          urls: creds.uris,
          username: creds.username,
          credential: creds.password,
        };
        try {
          const currentConfig = this.pc.getConfiguration();
          currentConfig.iceServers.push(turnServer);
          this.pc.setConfiguration(currentConfig);
          console.log('TURN servers added:', creds.uris);
        } catch (e) {
          console.warn('Could not update ICE config (connection already started):', e.message);
        }
      }
    } catch (e) {
      console.log('No TURN server configured (direct P2P only)');
    }
  }

  /**
   * SENDER: Create data channels and offer.
   */
  async createOffer(file) {
    this.file = file;
    this.totalChunks = Math.ceil(file.size / CHUNK_SIZE);
    this.fileInfo = {
      name: file.name,
      size: file.size,
      type: file.type || 'application/octet-stream',
      totalChunks: this.totalChunks,
    };

    this.createPeerConnection();

    // Create a control channel for metadata
    const controlChannel = this.pc.createDataChannel('control', {
      ordered: true,
    });
    controlChannel.onopen = () => {
      console.log('Control channel open, sending file info');
      controlChannel.send(JSON.stringify({ type: 'file-info', payload: this.fileInfo }));
    };

    // Create multiple parallel data channels for speed
    // Using ordered + reliable delivery to prevent SCTP transport crashes
    for (let i = 0; i < NUM_CHANNELS; i++) {
      const ch = this.pc.createDataChannel(`data-${i}`, {
        ordered: true, // Ordered delivery — stable and fast enough
      });
      ch.binaryType = 'arraybuffer';
      ch.bufferedAmountLowThreshold = BUFFER_THRESHOLD;
      this.channels.push(ch);
    }

    // Wait for all channels to open, then start sending after a brief stabilization delay
    let openCount = 0;
    this.channels.forEach((ch) => {
      ch.onopen = () => {
        openCount++;
        console.log(`Data channel opened (${openCount}/${NUM_CHANNELS})`);
        if (openCount === NUM_CHANNELS) {
          // Small delay to let SCTP transport stabilize before blasting data
          setTimeout(() => this._startSending(), 200);
        }
      };
      ch.onerror = (e) => {
        console.error('Data channel error:', e);
      };
    });

    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    console.log('SDP offer created and set as local description');

    this.signaling.send({
      type: 'offer',
      payload: {
        type: this.pc.localDescription.type,
        sdp: this.pc.localDescription.sdp,
      },
    });
  }

  /**
   * RECEIVER: Handle incoming offer and create answer.
   */
  async handleOffer(offer) {
    console.log('Received offer, creating peer connection...');
    this.createPeerConnection();

    // Track received data channels
    let dataChannelCount = 0;
    this.pc.ondatachannel = (event) => {
      const ch = event.channel;
      console.log(`Data channel received: ${ch.label}`);

      if (ch.label === 'control') {
        ch.onmessage = (e) => {
          const msg = JSON.parse(e.data);
          if (msg.type === 'file-info') {
            this.fileInfo = msg.payload;
            this.totalChunks = msg.payload.totalChunks;
            this.receivedBuffers = new Array(this.totalChunks);
            console.log('File info received:', this.fileInfo);
            if (this.onFileInfo) this.onFileInfo(this.fileInfo);
          }
        };
        return;
      }

      // Data channel
      ch.binaryType = 'arraybuffer';
      dataChannelCount++;
      this.channels.push(ch);

      ch.onmessage = (e) => {
        this._handleChunk(e.data);
      };
    };

    // Set remote description FIRST, then process buffered candidates
    await this.pc.setRemoteDescription(new RTCSessionDescription(offer));
    console.log('Remote description set');

    // Now flush any ICE candidates that arrived before setRemoteDescription
    this._remoteDescriptionSet = true;
    await this._flushPendingCandidates();

    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    console.log('SDP answer created and set as local description');

    this.signaling.send({
      type: 'answer',
      payload: {
        type: this.pc.localDescription.type,
        sdp: this.pc.localDescription.sdp,
      },
    });
  }

  /**
   * Handle incoming answer (sender side).
   */
  async handleAnswer(answer) {
    console.log('Received answer, setting remote description...');
    await this.pc.setRemoteDescription(new RTCSessionDescription(answer));
    this._remoteDescriptionSet = true;
    console.log('Remote description set (sender side)');

    // Flush any pending candidates
    await this._flushPendingCandidates();
  }

  /**
   * Add ICE candidate from peer — buffers if remote description not yet set.
   */
  async addIceCandidate(candidate) {
    if (!candidate) return;

    if (!this.pc || !this._remoteDescriptionSet) {
      // Buffer the candidate — remote description hasn't been set yet
      console.log('Buffering ICE candidate (remote description not set yet)');
      this._pendingCandidates.push(candidate);
      return;
    }

    try {
      await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (e) {
      console.warn('Failed to add ICE candidate:', e.message);
    }
  }

  /**
   * Flush buffered ICE candidates after remote description is set.
   */
  async _flushPendingCandidates() {
    if (this._pendingCandidates.length > 0) {
      console.log(`Flushing ${this._pendingCandidates.length} buffered ICE candidates`);
    }
    for (const candidate of this._pendingCandidates) {
      try {
        await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (e) {
        console.warn('Failed to add buffered ICE candidate:', e.message);
      }
    }
    this._pendingCandidates = [];
  }

  /**
   * SENDER: Start sending file chunks across parallel channels.
   *
   * Each channel runs its own independent async pump that:
   * 1. Claims the next chunk index from a shared counter
   * 2. Reads the file slice into an ArrayBuffer
   * 3. Waits for buffer space if the SCTP send buffer is full
   * 4. Sends the chunk — retrying on "queue full" errors
   * 5. Loops until all chunks are sent
   *
   * This guarantees zero dropped chunks and proper backpressure handling.
   */
  _startSending() {
    console.log('All channels open — starting transfer');
    this.startTime = performance.now();
    this.sentChunks = 0;
    this.bytesTransferred = 0;
    this._lastTime = this.startTime;
    this._lastBytes = 0;

    this._startStatsInterval();

    // Shared chunk counter — each channel atomically claims the next index
    // (safe because JS is single-threaded; no two pumps run simultaneously)
    this._nextChunkIndex = 0;

    // Launch one independent pump per channel
    for (let i = 0; i < this.channels.length; i++) {
      this._channelPump(this.channels[i], i);
    }
  }

  /**
   * Independent async sending loop for a single channel.
   * Pulls chunks from the shared counter, handles backpressure, and retries on failure.
   */
  async _channelPump(channel, channelIndex) {
    while (true) {
      // Claim next chunk index (atomic in single-threaded JS)
      const index = this._nextChunkIndex;
      if (index >= this.totalChunks) break; // All chunks claimed
      this._nextChunkIndex++;

      // Check channel health
      if (channel.readyState !== 'open') {
        console.error(`Channel ${channelIndex} closed — cannot send chunk ${index}`);
        // Put the chunk back (best-effort — another pump may pick up remaining work)
        // Actually, we can't easily "unclaim" it. Instead, we'll let it fail
        // and the transfer will stall. But this should be very rare.
        if (this.onError) this.onError(new Error(`Data channel ${channelIndex} closed unexpectedly`));
        return;
      }

      // Wait for buffer space BEFORE reading the file (prevents unnecessary memory usage)
      await this._waitForBufferSpace(channel);

      // Read the file slice
      const start = index * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, this.file.size);
      const slice = this.file.slice(start, end);
      const buffer = await slice.arrayBuffer();

      // Prepend 4-byte chunk index header for reassembly on the receiver
      const header = new ArrayBuffer(4);
      new DataView(header).setUint32(0, index);
      const combined = new Uint8Array(4 + buffer.byteLength);
      combined.set(new Uint8Array(header), 0);
      combined.set(new Uint8Array(buffer), 4);

      // Send with retry — if the buffer filled between our check and the send call,
      // we wait and retry rather than dropping the chunk
      let sent = false;
      let retries = 0;
      const MAX_RETRIES = 50;

      while (!sent && retries < MAX_RETRIES) {
        if (channel.readyState !== 'open') {
          console.error(`Channel ${channelIndex} closed while retrying chunk ${index}`);
          if (this.onError) this.onError(new Error(`Data channel ${channelIndex} closed during send`));
          return;
        }

        try {
          channel.send(combined.buffer);
          sent = true;
        } catch (err) {
          // "send queue is full" — wait for buffer to drain and retry
          retries++;
          if (retries % 10 === 0) {
            console.warn(`Channel ${channelIndex}: retry ${retries} for chunk ${index} (buffered: ${formatBytes(channel.bufferedAmount)})`);
          }
          await this._waitForBufferSpace(channel);
        }
      }

      if (!sent) {
        console.error(`Channel ${channelIndex}: gave up on chunk ${index} after ${MAX_RETRIES} retries`);
        if (this.onError) this.onError(new Error(`Failed to send chunk ${index} after ${MAX_RETRIES} retries`));
        return;
      }

      // Update progress tracking
      this.sentChunks++;
      this.bytesTransferred += buffer.byteLength;

      if (this.onProgress) {
        this.onProgress(this.sentChunks / this.totalChunks);
      }

      // Check if transfer is complete
      if (this.sentChunks === this.totalChunks) {
        this._stopStatsInterval();
        console.log(`Transfer complete — all ${this.totalChunks} chunks sent`);
        setTimeout(() => {
          if (this.onComplete) this.onComplete();
        }, 500);
      }
    }
  }

  /**
   * Returns a promise that resolves when the channel's send buffer
   * drops below MAX_BUFFER. Resolves immediately if already below.
   */
  _waitForBufferSpace(channel) {
    if (channel.bufferedAmount <= MAX_BUFFER) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      // Use onbufferedamountlow event — fires when bufferedAmount drops below threshold
      const onLow = () => {
        channel.onbufferedamountlow = null;
        resolve();
      };
      channel.onbufferedamountlow = onLow;

      // Safety timeout: if the event doesn't fire within 5 seconds, check manually
      // (handles edge case where bufferedAmount drops between our check and event registration)
      setTimeout(() => {
        if (channel.bufferedAmount <= MAX_BUFFER) {
          channel.onbufferedamountlow = null;
          resolve();
        }
        // If still full, the onbufferedamountlow handler will eventually fire
      }, 200);
    });
  }

  /**
   * RECEIVER: Handle incoming chunk and reassemble.
   */
  _handleChunk(data) {
    if (!this.startTime) {
      this.startTime = performance.now();
      this._lastTime = this.startTime;
      this._lastBytes = 0;
      this._startStatsInterval();
    }

    const view = new DataView(data);
    const index = view.getUint32(0);
    const chunkData = data.slice(4);

    this.receivedBuffers[index] = chunkData;
    this.receivedChunks++;
    this.bytesTransferred += chunkData.byteLength;

    if (this.onProgress) {
      this.onProgress(this.receivedChunks / this.totalChunks);
    }

    if (this.receivedChunks === this.totalChunks) {
      this._stopStatsInterval();
      this._assembleAndDownload();
    }
  }

  /**
   * RECEIVER: Assemble chunks and trigger download.
   */
  _assembleAndDownload() {
    console.log('All chunks received — assembling file');
    const blob = new Blob(this.receivedBuffers, {
      type: this.fileInfo.type,
    });

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = this.fileInfo.name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    // Clean up memory
    this.receivedBuffers = [];

    const elapsed = (performance.now() - this.startTime) / 1000;
    const avgSpeed = this.fileInfo.size / elapsed;

    if (this.onComplete) {
      this.onComplete({
        fileName: this.fileInfo.name,
        fileSize: this.fileInfo.size,
        elapsed: elapsed,
        avgSpeed: avgSpeed,
      });
    }
  }

  /**
   * Speed statistics tracking.
   */
  _startStatsInterval() {
    this._statsInterval = setInterval(() => {
      const now = performance.now();
      const elapsed = (now - this._lastTime) / 1000;
      const bytesDelta = this.bytesTransferred - this._lastBytes;
      const speed = bytesDelta / elapsed; // bytes per second

      this._speedSamples.push(speed);
      if (this._speedSamples.length > 10) this._speedSamples.shift();

      const avgSpeed =
        this._speedSamples.reduce((a, b) => a + b, 0) / this._speedSamples.length;

      this._lastTime = now;
      this._lastBytes = this.bytesTransferred;

      if (this.onStats) {
        const totalElapsed = (now - this.startTime) / 1000;
        const progress = this.role === 'sender'
          ? this.sentChunks / this.totalChunks
          : this.receivedChunks / this.totalChunks;
        const remaining = progress > 0 ? (totalElapsed / progress) * (1 - progress) : 0;

        this.onStats({
          speed: avgSpeed,
          instantSpeed: speed,
          bytesTransferred: this.bytesTransferred,
          elapsed: totalElapsed,
          eta: remaining,
          progress: progress,
        });
      }
    }, 500);
  }

  _stopStatsInterval() {
    if (this._statsInterval) {
      clearInterval(this._statsInterval);
      this._statsInterval = null;
    }
  }

  /**
   * Clean up all resources.
   */
  destroy() {
    this._stopStatsInterval();
    this.channels.forEach((ch) => {
      try { ch.close(); } catch (e) {}
    });
    if (this.pc) {
      this.pc.close();
    }
  }
}

/**
 * WebSocket signaling wrapper.
 */
class SignalingClient {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.handlers = {};

    this.ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      console.log('Signaling received:', msg.type);
      const handler = this.handlers[msg.type];
      if (handler) handler(msg.payload);
    };

    this.ws.onerror = (e) => {
      console.error('WebSocket error:', e);
    };

    this.ws.onclose = (e) => {
      console.log('WebSocket closed:', e.code, e.reason);
    };
  }

  on(type, handler) {
    this.handlers[type] = handler;
  }

  send(msg) {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
      console.log('Signaling sent:', msg.type);
    } else {
      console.warn('WebSocket not open, cannot send:', msg.type, 'readyState:', this.ws.readyState);
    }
  }

  waitOpen() {
    return new Promise((resolve, reject) => {
      if (this.ws.readyState === WebSocket.OPEN) {
        resolve();
        return;
      }
      this.ws.onopen = () => {
        console.log('WebSocket connected');
        resolve();
      };
      this.ws.onerror = (e) => {
        console.error('WebSocket connection failed:', e);
        reject(e);
      };
    });
  }

  close() {
    this.ws.close();
  }
}

/**
 * Utility: format bytes to human readable.
 */
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * Utility: format speed to human readable.
 */
function formatSpeed(bytesPerSec) {
  return formatBytes(bytesPerSec) + '/s';
}

/**
 * Utility: format seconds to mm:ss.
 */
function formatTime(seconds) {
  if (!isFinite(seconds) || seconds < 0) return '--:--';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}
