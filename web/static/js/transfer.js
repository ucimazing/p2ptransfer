/**
 * FastTransfer — High-speed WebRTC file transfer engine.
 *
 * Speed optimizations:
 * 1. 4 parallel DataChannels with staggered start (avoids SCTP burst crash)
 * 2. 64KB chunks — max safe size for WebRTC SCTP messages
 * 3. Ordered reliable delivery (unordered crashes SCTP with large msgs)
 * 4. Binary ArrayBuffer transfer — zero encoding overhead
 * 5. Per-channel async pumps with backpressure via onbufferedamountlow
 * 6. 4MB send buffer per channel — keeps the SCTP pipeline full
 * 7. Chunk pre-reading — overlaps file I/O with network sends (after warmup)
 */

const CHUNK_SIZE = 64 * 1024; // 64KB — max safe size for WebRTC SCTP
const NUM_CHANNELS = 4; // 4 parallel channels (8 overwhelms SCTP transport)
const BUFFER_THRESHOLD = 1 * 1024 * 1024; // 1MB — resume sending when buffer drops below this
const MAX_BUFFER = 4 * 1024 * 1024; // 4MB — pause sending when buffer exceeds this

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

    // Create multiple parallel data channels for maximum throughput
    // Ordered + reliable: SCTP handles fragmentation and retransmission
    // (unordered crashes SCTP transport with messages > ~16KB in Chrome)
    for (let i = 0; i < NUM_CHANNELS; i++) {
      const ch = this.pc.createDataChannel(`data-${i}`, {
        ordered: true,
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
          this._startSending();
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

    // Launch one independent pump per channel, staggered to avoid SCTP burst overload
    // Each pump starts 50ms after the previous one — total ramp-up: ~200ms
    for (let i = 0; i < this.channels.length; i++) {
      ((idx) => {
        setTimeout(() => this._channelPump(this.channels[idx], idx), idx * 50);
      })(i);
    }
  }

  /**
   * Independent async sending loop for a single channel.
   * Pulls chunks from the shared counter, handles backpressure, retries on failure.
   * Pre-reads the NEXT chunk while waiting for buffer space — overlaps I/O with network.
   */
  async _channelPump(channel, channelIndex) {
    let prefetchedChunk = null; // { index, combined } — pre-read chunk ready to send
    let isFirstSend = true; // Skip prefetch on first iteration to avoid SCTP burst

    while (true) {
      let index, combined;

      if (prefetchedChunk) {
        // Use the pre-read chunk from last iteration
        index = prefetchedChunk.index;
        combined = prefetchedChunk.combined;
        prefetchedChunk = null;
      } else {
        // Claim next chunk index (atomic in single-threaded JS)
        index = this._nextChunkIndex;
        if (index >= this.totalChunks) break;
        this._nextChunkIndex++;

        // Read the file slice
        combined = await this._readChunk(index);
      }

      // Check channel health
      if (channel.readyState !== 'open') {
        console.error(`Channel ${channelIndex} closed — cannot send chunk ${index}`);
        if (this.onError) this.onError(new Error(`Data channel ${channelIndex} closed unexpectedly`));
        return;
      }

      // Pre-read NEXT chunk while we wait for buffer space (overlaps I/O with network)
      // Skip prefetch on first send to let SCTP transport warm up
      let prefetchPromise = null;
      if (!isFirstSend) {
        const nextIndex = this._nextChunkIndex;
        if (nextIndex < this.totalChunks) {
          this._nextChunkIndex++;
          prefetchPromise = this._readChunk(nextIndex).then(c => ({ index: nextIndex, combined: c }));
        }
      }
      isFirstSend = false;

      // Wait for buffer space before sending
      await this._waitForBufferSpace(channel);

      // Send with retry
      let sent = false;
      let retries = 0;
      const MAX_RETRIES = 100;

      while (!sent && retries < MAX_RETRIES) {
        if (channel.readyState !== 'open') {
          console.error(`Channel ${channelIndex} closed while retrying chunk ${index}`);
          if (this.onError) this.onError(new Error(`Data channel ${channelIndex} closed during send`));
          return;
        }

        try {
          channel.send(combined);
          sent = true;
        } catch (err) {
          retries++;
          if (retries % 20 === 0) {
            console.warn(`Ch${channelIndex}: retry ${retries} for chunk ${index} (buf: ${(channel.bufferedAmount / 1048576).toFixed(1)}MB)`);
          }
          await this._waitForBufferSpace(channel);
        }
      }

      if (!sent) {
        console.error(`Channel ${channelIndex}: gave up on chunk ${index} after ${MAX_RETRIES} retries`);
        if (this.onError) this.onError(new Error(`Failed to send chunk ${index}`));
        return;
      }

      // Collect prefetched chunk (should already be resolved by now — file reads are fast)
      if (prefetchPromise) {
        prefetchedChunk = await prefetchPromise;
      }

      // Update progress tracking
      const chunkSize = (combined.byteLength || combined.length) - 4; // minus 4-byte header
      this.sentChunks++;
      this.bytesTransferred += chunkSize;

      if (this.onProgress) {
        this.onProgress(this.sentChunks / this.totalChunks);
      }

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
   * Read a file chunk and prepend the 4-byte index header.
   * Returns an ArrayBuffer ready to send.
   */
  async _readChunk(index) {
    const start = index * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, this.file.size);
    const buffer = await this.file.slice(start, end).arrayBuffer();

    // Prepend 4-byte chunk index for receiver-side reassembly
    const combined = new Uint8Array(4 + buffer.byteLength);
    new DataView(combined.buffer).setUint32(0, index);
    combined.set(new Uint8Array(buffer), 4);
    return combined.buffer;
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
      let resolved = false;
      const done = () => {
        if (resolved) return;
        resolved = true;
        channel.onbufferedamountlow = null;
        resolve();
      };

      // Primary: onbufferedamountlow fires when buffer drops below BUFFER_THRESHOLD
      channel.onbufferedamountlow = done;

      // Safety: poll every 50ms in case event is missed (race between check and registration)
      const poll = setInterval(() => {
        if (channel.bufferedAmount <= MAX_BUFFER) {
          clearInterval(poll);
          done();
        }
      }, 50);

      // Cleanup poll when resolved via event
      const origDone = done;
      const doneWithCleanup = () => { clearInterval(poll); origDone(); };
      channel.onbufferedamountlow = doneWithCleanup;
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
