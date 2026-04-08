/**
 * FastTransfer — High-speed WebRTC file transfer engine.
 *
 * KEY ARCHITECTURE: Multiple RTCPeerConnections (not multiple DataChannels).
 * Each PeerConnection gets its own SCTP transport with its own congestion
 * window. This is the only way to saturate high-bandwidth links via WebRTC,
 * because a single SCTP transport tops out at ~5-15 MB/s regardless of how
 * many DataChannels share it.
 *
 * With 4 PeerConnections on a 400 Mbps link → ~40-50 MB/s aggregate.
 *
 * Speed optimizations:
 * 1. 4 independent SCTP transports (4x the congestion windows)
 * 2. 64KB chunks — proven safe for WebRTC SCTP
 * 3. Per-connection async pumps with backpressure
 * 4. 4MB send buffer per connection — keeps each SCTP pipeline full
 * 5. Chunk pre-reading — overlaps file I/O with network sends
 * 6. Staggered connection start — avoids initial burst overload
 */

const CHUNK_SIZE = 64 * 1024;       // 64KB per chunk
const NUM_CONNECTIONS = 4;           // 4 independent P2P connections
const BUFFER_THRESHOLD = 1024 * 1024;       // 1MB — resume threshold
const MAX_BUFFER = 4 * 1024 * 1024;         // 4MB — pause threshold

class TransferEngine {
  constructor(role, signaling) {
    this.role = role;
    this.signaling = signaling;

    // Array of { pc, channel, index, remoteDescriptionSet, pendingCandidates, ready }
    this.connections = [];

    // Callbacks
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
    this._nextChunkIndex = 0;
    this._completeFired = false;
  }

  /**
   * Create a single RTCPeerConnection with ICE handling routed by index.
   */
  _createPeerConnection(index) {
    const config = {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
      ],
      iceCandidatePoolSize: 5,
    };

    const pc = new RTCPeerConnection(config);

    // Add TURN servers (non-blocking)
    this._addTurnToPC(pc);

    // ICE candidates include the connection index for routing
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.signaling.send({
          type: 'ice-candidate',
          payload: { index, candidate: event.candidate },
        });
      }
    };

    pc.oniceconnectionstatechange = () => {
      const state = pc.iceConnectionState;
      if (state === 'connected' || state === 'completed') {
        console.log(`PC${index} connected`);
      } else if (state === 'failed') {
        console.error(`PC${index} ICE failed`);
        if (this.onError) this.onError(new Error(`Connection ${index} failed`));
      }
    };

    const conn = {
      pc,
      channel: null,
      index,
      remoteDescriptionSet: false,
      pendingCandidates: [],
      ready: false,
    };

    return conn;
  }

  /**
   * Fetch TURN credentials and add to a specific PeerConnection.
   */
  async _addTurnToPC(pc) {
    try {
      const resp = await fetch('/api/turn');
      const creds = await resp.json();
      if (creds.uris && creds.uris.length > 0) {
        try {
          const cfg = pc.getConfiguration();
          cfg.iceServers.push({
            urls: creds.uris,
            username: creds.username,
            credential: creds.password,
          });
          pc.setConfiguration(cfg);
        } catch (e) {
          // Connection may have already started
        }
      }
    } catch (e) {
      // No TURN configured — direct P2P only
    }
  }

  // ─── SENDER ─────────────────────────────────────────────────────────

  /**
   * SENDER: Create N PeerConnections with 1 DataChannel each, send N offers.
   */
  async createOffer(file) {
    this.file = file;
    this.totalChunks = Math.ceil(file.size / CHUNK_SIZE);
    this.fileInfo = {
      name: file.name,
      size: file.size,
      type: file.type || 'application/octet-stream',
      totalChunks: this.totalChunks,
      numConnections: NUM_CONNECTIONS,
    };

    for (let i = 0; i < NUM_CONNECTIONS; i++) {
      const conn = this._createPeerConnection(i);

      // First connection carries the control channel for file metadata
      if (i === 0) {
        const ctrl = conn.pc.createDataChannel('control', { ordered: true });
        ctrl.onopen = () => {
          console.log('Control channel open — sending file info');
          ctrl.send(JSON.stringify({ type: 'file-info', payload: this.fileInfo }));
        };
      }

      // One data channel per connection
      const ch = conn.pc.createDataChannel('data', { ordered: true });
      ch.binaryType = 'arraybuffer';
      ch.bufferedAmountLowThreshold = BUFFER_THRESHOLD;
      conn.channel = ch;

      ch.onopen = () => {
        console.log(`PC${i} data channel open`);
        conn.ready = true;
        this._checkAllReady();
      };

      ch.onerror = (e) => {
        console.error(`PC${i} channel error:`, e);
      };

      this.connections.push(conn);
    }

    // Send all offers (ICE gathering starts in parallel)
    for (const conn of this.connections) {
      const offer = await conn.pc.createOffer();
      await conn.pc.setLocalDescription(offer);

      this.signaling.send({
        type: 'offer',
        payload: {
          index: conn.index,
          type: conn.pc.localDescription.type,
          sdp: conn.pc.localDescription.sdp,
        },
      });
    }

    console.log(`${NUM_CONNECTIONS} offers sent`);
  }

  /**
   * SENDER: Handle answer for a specific connection.
   */
  async handleAnswer(payload) {
    const { index } = payload;
    const conn = this.connections[index];
    if (!conn) {
      console.warn(`No connection for answer index ${index}`);
      return;
    }

    await conn.pc.setRemoteDescription(
      new RTCSessionDescription({ type: payload.type, sdp: payload.sdp })
    );
    conn.remoteDescriptionSet = true;
    console.log(`PC${index} remote description set (sender)`);

    // Flush buffered ICE candidates
    for (const candidate of conn.pendingCandidates) {
      try {
        await conn.pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (e) {
        console.warn(`PC${index} failed to add buffered ICE:`, e.message);
      }
    }
    conn.pendingCandidates = [];
  }

  /**
   * Check if all data channels are open; if so, start sending.
   */
  _checkAllReady() {
    const readyCount = this.connections.filter(c => c.ready).length;
    console.log(`Connections ready: ${readyCount}/${NUM_CONNECTIONS}`);
    if (readyCount === NUM_CONNECTIONS) {
      this._startSending();
    }
  }

  // ─── RECEIVER ───────────────────────────────────────────────────────

  /**
   * RECEIVER: Handle an incoming offer (called once per connection).
   */
  async handleOffer(payload) {
    const { index } = payload;
    console.log(`Handling offer for PC${index}`);

    const conn = this._createPeerConnection(index);

    // Ensure connections array is indexed correctly
    while (this.connections.length <= index) {
      this.connections.push(null);
    }
    this.connections[index] = conn;

    conn.pc.ondatachannel = (event) => {
      const ch = event.channel;
      console.log(`PC${index} received channel: ${ch.label}`);

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
      conn.channel = ch;
      ch.onmessage = (e) => this._handleChunk(e.data);
    };

    // Set remote description
    await conn.pc.setRemoteDescription(
      new RTCSessionDescription({ type: payload.type, sdp: payload.sdp })
    );
    conn.remoteDescriptionSet = true;

    // Flush buffered ICE candidates
    for (const candidate of conn.pendingCandidates) {
      try {
        await conn.pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (e) {}
    }
    conn.pendingCandidates = [];

    // Create and send answer
    const answer = await conn.pc.createAnswer();
    await conn.pc.setLocalDescription(answer);

    this.signaling.send({
      type: 'answer',
      payload: {
        index,
        type: conn.pc.localDescription.type,
        sdp: conn.pc.localDescription.sdp,
      },
    });

    console.log(`PC${index} answer sent`);
  }

  // ─── ICE CANDIDATE ROUTING ─────────────────────────────────────────

  /**
   * Route an ICE candidate to the correct PeerConnection by index.
   */
  async addIceCandidate(payload) {
    const { index, candidate } = payload;
    if (!candidate) return;

    const conn = this.connections[index];
    if (!conn) {
      // Connection not created yet — this can happen if ICE arrives before offer is processed
      console.log(`Buffering ICE for PC${index} (connection not yet created)`);
      // Store globally and flush when connection is created
      if (!this._globalPendingIce) this._globalPendingIce = {};
      if (!this._globalPendingIce[index]) this._globalPendingIce[index] = [];
      this._globalPendingIce[index].push(candidate);
      return;
    }

    if (!conn.remoteDescriptionSet) {
      conn.pendingCandidates.push(candidate);
      return;
    }

    try {
      await conn.pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (e) {
      console.warn(`PC${index} failed to add ICE:`, e.message);
    }
  }

  // ─── SENDING ENGINE ────────────────────────────────────────────────

  /**
   * Start sending: launch one async pump per connection, staggered.
   */
  _startSending() {
    console.log(`All ${NUM_CONNECTIONS} connections ready — starting transfer`);
    this.startTime = performance.now();
    this.sentChunks = 0;
    this.bytesTransferred = 0;
    this._lastTime = this.startTime;
    this._lastBytes = 0;
    this._nextChunkIndex = 0;

    this._startStatsInterval();

    // Stagger pump starts by 30ms to avoid initial burst
    for (let i = 0; i < this.connections.length; i++) {
      const conn = this.connections[i];
      setTimeout(() => this._channelPump(conn.channel, i), i * 30);
    }
  }

  /**
   * Independent async sending loop for a single connection's channel.
   */
  async _channelPump(channel, connIndex) {
    let prefetchedChunk = null;
    let isFirstSend = true;

    while (true) {
      let index, combined;

      if (prefetchedChunk) {
        index = prefetchedChunk.index;
        combined = prefetchedChunk.combined;
        prefetchedChunk = null;
      } else {
        index = this._nextChunkIndex;
        if (index >= this.totalChunks) break;
        this._nextChunkIndex++;
        combined = await this._readChunk(index);
      }

      if (channel.readyState !== 'open') {
        console.error(`PC${connIndex} channel closed — cannot send chunk ${index}`);
        if (this.onError) this.onError(new Error(`Connection ${connIndex} channel closed`));
        return;
      }

      // Pre-read next chunk (skip on first send to let SCTP warm up)
      let prefetchPromise = null;
      if (!isFirstSend) {
        const nextIdx = this._nextChunkIndex;
        if (nextIdx < this.totalChunks) {
          this._nextChunkIndex++;
          prefetchPromise = this._readChunk(nextIdx).then(c => ({ index: nextIdx, combined: c }));
        }
      }
      isFirstSend = false;

      // Wait for buffer space
      await this._waitForBufferSpace(channel);

      // Send with retry
      let sent = false;
      let retries = 0;
      while (!sent && retries < 100) {
        if (channel.readyState !== 'open') {
          if (this.onError) this.onError(new Error(`PC${connIndex} closed during send`));
          return;
        }
        try {
          channel.send(combined);
          sent = true;
        } catch (err) {
          retries++;
          if (retries % 20 === 0) {
            console.warn(`PC${connIndex}: retry ${retries} for chunk ${index}`);
          }
          await this._waitForBufferSpace(channel);
        }
      }

      if (!sent) {
        if (this.onError) this.onError(new Error(`Failed to send chunk ${index}`));
        return;
      }

      // Collect prefetched chunk
      if (prefetchPromise) {
        prefetchedChunk = await prefetchPromise;
      }

      // Update stats
      const chunkBytes = (combined.byteLength || combined.length) - 4;
      this.sentChunks++;
      this.bytesTransferred += chunkBytes;

      if (this.onProgress) {
        this.onProgress(this.sentChunks / this.totalChunks);
      }

      if (this.sentChunks === this.totalChunks && !this._completeFired) {
        this._completeFired = true;
        this._stopStatsInterval();
        console.log(`Transfer complete — ${this.totalChunks} chunks sent via ${NUM_CONNECTIONS} connections`);
        setTimeout(() => {
          if (this.onComplete) this.onComplete();
        }, 500);
      }
    }
  }

  /**
   * Read a file chunk and prepend 4-byte index header.
   */
  async _readChunk(index) {
    const start = index * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, this.file.size);
    const buffer = await this.file.slice(start, end).arrayBuffer();

    const combined = new Uint8Array(4 + buffer.byteLength);
    new DataView(combined.buffer).setUint32(0, index);
    combined.set(new Uint8Array(buffer), 4);
    return combined.buffer;
  }

  /**
   * Wait for send buffer to drain below MAX_BUFFER.
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
        clearInterval(poll);
        resolve();
      };

      channel.onbufferedamountlow = done;

      // Safety poll in case event is missed
      const poll = setInterval(() => {
        if (channel.bufferedAmount <= MAX_BUFFER) done();
      }, 50);
    });
  }

  // ─── RECEIVING ENGINE ──────────────────────────────────────────────

  /**
   * Handle incoming chunk from any connection.
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
   * Assemble all chunks and trigger browser download.
   */
  _assembleAndDownload() {
    console.log('All chunks received — assembling file');
    const blob = new Blob(this.receivedBuffers, { type: this.fileInfo.type });

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = this.fileInfo.name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    this.receivedBuffers = [];

    const elapsed = (performance.now() - this.startTime) / 1000;
    const avgSpeed = this.fileInfo.size / elapsed;

    if (this.onComplete) {
      this.onComplete({
        fileName: this.fileInfo.name,
        fileSize: this.fileInfo.size,
        elapsed,
        avgSpeed,
      });
    }
  }

  // ─── STATS ─────────────────────────────────────────────────────────

  _startStatsInterval() {
    this._statsInterval = setInterval(() => {
      const now = performance.now();
      const elapsed = (now - this._lastTime) / 1000;
      const bytesDelta = this.bytesTransferred - this._lastBytes;
      const speed = elapsed > 0 ? bytesDelta / elapsed : 0;

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
          progress,
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
    for (const conn of this.connections) {
      if (!conn) continue;
      try { if (conn.channel) conn.channel.close(); } catch (e) {}
      try { conn.pc.close(); } catch (e) {}
    }
  }
}

// ─── SIGNALING ─────────────────────────────────────────────────────────

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

    this.ws.onerror = (e) => console.error('WebSocket error:', e);
    this.ws.onclose = (e) => console.log('WebSocket closed:', e.code, e.reason);
  }

  on(type, handler) {
    this.handlers[type] = handler;
  }

  send(msg) {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    } else {
      console.warn('WS not open, cannot send:', msg.type);
    }
  }

  waitOpen() {
    return new Promise((resolve, reject) => {
      if (this.ws.readyState === WebSocket.OPEN) { resolve(); return; }
      this.ws.onopen = () => { console.log('WebSocket connected'); resolve(); };
      this.ws.onerror = (e) => reject(e);
    });
  }

  close() { this.ws.close(); }
}

// ─── UTILITIES ─────────────────────────────────────────────────────────

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatSpeed(bytesPerSec) {
  return formatBytes(bytesPerSec) + '/s';
}

function formatTime(seconds) {
  if (!isFinite(seconds) || seconds < 0) return '--:--';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}
