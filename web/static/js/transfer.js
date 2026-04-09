/**
 * FastTransfer — Maximum-speed WebRTC file transfer engine.
 *
 * ARCHITECTURE: 4 independent RTCPeerConnections with batch-send tight loops.
 *
 * Each PeerConnection has its own SCTP transport and congestion window.
 * Single SCTP tops out at ~10 MB/s; 4 independent transports = ~40 MB/s.
 *
 * Speed optimizations:
 * 1. 4 independent SCTP transports (4x congestion windows)
 * 2. Batch pre-read: read 16 chunks into RAM, then blast synchronously
 * 3. Tight synchronous send loop — zero async gaps between sends
 * 4. Resume via onbufferedamountlow (pure event-driven, no polling)
 * 5. SDP optimization: remove bandwidth caps
 */

const CHUNK_SIZE = 64 * 1024;              // 64KB per chunk
const NUM_CONNECTIONS = 4;                  // 4 independent SCTP transports
const BATCH_SIZE = 16;                      // Pre-read 16 chunks per batch (1MB)
const BUFFER_LOW = 256 * 1024;              // 256KB — resume threshold
const BUFFER_HIGH = 1 * 1024 * 1024;        // 1MB — pause threshold

class TransferEngine {
  constructor(role, signaling) {
    this.role = role;
    this.signaling = signaling;
    this.connections = [];

    this.onProgress = null;
    this.onComplete = null;
    this.onError = null;
    this.onFileInfo = null;
    this.onStats = null;

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
    this._sendingStarted = false;
  }

  // ─── PEER CONNECTION ───────────────────────────────────────────────

  _createPeerConnection(index) {
    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
      ],
      iceCandidatePoolSize: 5,
    });

    this._addTurnToPC(pc);

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
      }
    };

    return {
      pc, channel: null, index,
      remoteDescriptionSet: false,
      pendingCandidates: [],
      ready: false,
    };
  }

  async _addTurnToPC(pc) {
    try {
      const resp = await fetch('/api/turn');
      const creds = await resp.json();
      if (creds.uris && creds.uris.length > 0) {
        try {
          const cfg = pc.getConfiguration();
          cfg.iceServers.push({ urls: creds.uris, username: creds.username, credential: creds.password });
          pc.setConfiguration(cfg);
        } catch (e) {}
      }
    } catch (e) {}
  }

  /**
   * SDP optimization — safely create a new SDP string with bandwidth caps removed.
   * Returns a plain {type, sdp} object (never mutates the original).
   */
  _optimizeSDP(type, sdp) {
    let s = sdp;
    // Remove any bandwidth restrictions
    s = s.replace(/b=AS:\d+\r?\n/g, '');
    s = s.replace(/b=TIAS:\d+\r?\n/g, '');
    return { type, sdp: s };
  }

  // ─── SENDER ─────────────────────────────────────────────────────────

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

      if (i === 0) {
        const ctrl = conn.pc.createDataChannel('control', { ordered: true });
        ctrl.onopen = () => {
          console.log('Control channel open — sending file info');
          ctrl.send(JSON.stringify({ type: 'file-info', payload: this.fileInfo }));
        };
      }

      const ch = conn.pc.createDataChannel('data', { ordered: true });
      ch.binaryType = 'arraybuffer';
      ch.bufferedAmountLowThreshold = BUFFER_LOW;
      conn.channel = ch;

      ch.onopen = () => {
        console.log(`PC${i} data channel open`);
        conn.ready = true;
        this._tryStartSending();
      };
      ch.onerror = (e) => console.error(`PC${i} channel error:`, e);

      this.connections.push(conn);
    }

    // Create and send all offers
    for (const conn of this.connections) {
      const offer = await conn.pc.createOffer();
      // Create a safe copy with optimized SDP (never mutate original)
      const optimized = this._optimizeSDP(offer.type, offer.sdp);
      await conn.pc.setLocalDescription(optimized);

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

  async handleAnswer(payload) {
    const { index } = payload;
    const conn = this.connections[index];
    if (!conn) return;

    const optimized = this._optimizeSDP(payload.type, payload.sdp);
    await conn.pc.setRemoteDescription(new RTCSessionDescription(optimized));
    conn.remoteDescriptionSet = true;
    console.log(`PC${index} remote set (sender)`);

    for (const c of conn.pendingCandidates) {
      try { await conn.pc.addIceCandidate(new RTCIceCandidate(c)); } catch (e) {}
    }
    conn.pendingCandidates = [];
  }

  /**
   * Start sending as soon as at least 1 connection is ready.
   * Additional connections join the transfer as they become ready.
   */
  _tryStartSending() {
    if (this._sendingStarted) {
      // Already started — launch a pump for the newly ready connection
      const newReady = this.connections.filter(c => c.ready && !c.pumpStarted);
      for (const conn of newReady) {
        conn.pumpStarted = true;
        console.log(`PC${conn.index} joining transfer in progress`);
        this._batchPump(conn.channel, conn.index);
      }
      return;
    }

    // Start transfer on first ready connection
    this._sendingStarted = true;
    console.log('Starting transfer — connections will join as they become ready');
    this.startTime = performance.now();
    this.sentChunks = 0;
    this.bytesTransferred = 0;
    this._lastTime = this.startTime;
    this._lastBytes = 0;
    this._nextChunkIndex = 0;
    this._startStatsInterval();

    // Launch pumps for all currently ready connections
    for (const conn of this.connections) {
      if (conn.ready) {
        conn.pumpStarted = true;
        this._batchPump(conn.channel, conn.index);
      }
    }
  }

  // ─── RECEIVER ───────────────────────────────────────────────────────

  async handleOffer(payload) {
    const { index } = payload;
    console.log(`Handling offer for PC${index}`);

    const conn = this._createPeerConnection(index);
    while (this.connections.length <= index) this.connections.push(null);
    this.connections[index] = conn;

    conn.pc.ondatachannel = (event) => {
      const ch = event.channel;

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

      ch.binaryType = 'arraybuffer';
      conn.channel = ch;
      ch.onmessage = (e) => this._handleChunk(e.data);
    };

    const optimized = this._optimizeSDP(payload.type, payload.sdp);
    await conn.pc.setRemoteDescription(new RTCSessionDescription(optimized));
    conn.remoteDescriptionSet = true;

    // Flush global pending ICE (arrived before connection was created)
    if (this._globalPendingIce && this._globalPendingIce[index]) {
      for (const c of this._globalPendingIce[index]) {
        try { await conn.pc.addIceCandidate(new RTCIceCandidate(c)); } catch (e) {}
      }
      delete this._globalPendingIce[index];
    }

    for (const c of conn.pendingCandidates) {
      try { await conn.pc.addIceCandidate(new RTCIceCandidate(c)); } catch (e) {}
    }
    conn.pendingCandidates = [];

    const answer = await conn.pc.createAnswer();
    const optAnswer = this._optimizeSDP(answer.type, answer.sdp);
    await conn.pc.setLocalDescription(optAnswer);

    this.signaling.send({
      type: 'answer',
      payload: {
        index,
        type: conn.pc.localDescription.type,
        sdp: conn.pc.localDescription.sdp,
      },
    });
  }

  // ─── ICE ROUTING ───────────────────────────────────────────────────

  async addIceCandidate(payload) {
    const { index, candidate } = payload;
    if (!candidate) return;

    const conn = this.connections[index];
    if (!conn) {
      if (!this._globalPendingIce) this._globalPendingIce = {};
      if (!this._globalPendingIce[index]) this._globalPendingIce[index] = [];
      this._globalPendingIce[index].push(candidate);
      return;
    }

    if (!conn.remoteDescriptionSet) {
      conn.pendingCandidates.push(candidate);
      return;
    }

    try { await conn.pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch (e) {}
  }

  // ─── BATCH SEND ENGINE ─────────────────────────────────────────────

  /**
   * BATCH PUMP — High-speed sending loop for one connection.
   *
   * 1. Claim & read BATCH_SIZE chunks sequentially into memory
   * 2. Blast them in a SYNCHRONOUS while-loop (zero async gaps)
   * 3. When buffer fills → onbufferedamountlow resumes (pure event-driven)
   * 4. When batch exhausted → read next batch (only async boundary)
   */
  async _batchPump(channel, connIndex) {
    while (true) {
      // Step 1: Claim and read a batch of chunks (sequential reads — reliable)
      const batch = [];
      for (let i = 0; i < BATCH_SIZE; i++) {
        const idx = this._nextChunkIndex;
        if (idx >= this.totalChunks) break;
        this._nextChunkIndex++;

        const start = idx * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, this.file.size);
        const buffer = await this.file.slice(start, end).arrayBuffer();
        const combined = new Uint8Array(4 + buffer.byteLength);
        new DataView(combined.buffer).setUint32(0, idx);
        combined.set(new Uint8Array(buffer), 4);
        batch.push({ data: combined.buffer, size: buffer.byteLength });
      }

      if (batch.length === 0) break; // All chunks claimed

      // Step 2: Blast the batch synchronously
      let batchIdx = 0;

      await new Promise((resolve) => {
        const sendTight = () => {
          while (batchIdx < batch.length) {
            if (channel.readyState !== 'open') {
              console.error(`PC${connIndex} channel closed during send`);
              resolve();
              return;
            }

            if (channel.bufferedAmount > BUFFER_HIGH) {
              channel.onbufferedamountlow = sendTight;
              return; // Event will resume us
            }

            try {
              channel.send(batch[batchIdx].data);
            } catch (err) {
              // Buffer full between check and send — wait for drain
              channel.onbufferedamountlow = sendTight;
              return;
            }

            this.sentChunks++;
            this.bytesTransferred += batch[batchIdx].size;
            batchIdx++;

            if (this.onProgress) {
              this.onProgress(this.sentChunks / this.totalChunks);
            }

            if (this.sentChunks === this.totalChunks && !this._completeFired) {
              this._completeFired = true;
              this._stopStatsInterval();
              console.log(`Transfer complete — ${this.totalChunks} chunks via ${NUM_CONNECTIONS} connections`);
              setTimeout(() => { if (this.onComplete) this.onComplete(); }, 500);
            }
          }

          channel.onbufferedamountlow = null;
          resolve();
        };

        sendTight();
      });

      if (channel.readyState !== 'open') return;
    }
  }

  // ─── RECEIVING ─────────────────────────────────────────────────────

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

    if (this.onComplete) {
      this.onComplete({
        fileName: this.fileInfo.name,
        fileSize: this.fileInfo.size,
        elapsed,
        avgSpeed: this.fileInfo.size / elapsed,
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
      const avgSpeed = this._speedSamples.reduce((a, b) => a + b, 0) / this._speedSamples.length;

      this._lastTime = now;
      this._lastBytes = this.bytesTransferred;

      if (this.onStats) {
        const totalElapsed = (now - this.startTime) / 1000;
        const progress = this.role === 'sender'
          ? this.sentChunks / this.totalChunks
          : this.receivedChunks / this.totalChunks;
        const remaining = progress > 0 ? (totalElapsed / progress) * (1 - progress) : 0;

        this.onStats({ speed: avgSpeed, instantSpeed: speed, bytesTransferred: this.bytesTransferred,
          elapsed: totalElapsed, eta: remaining, progress });
      }
    }, 500);
  }

  _stopStatsInterval() {
    if (this._statsInterval) { clearInterval(this._statsInterval); this._statsInterval = null; }
  }

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
      const handler = this.handlers[msg.type];
      if (handler) handler(msg.payload);
    };
    this.ws.onerror = (e) => console.error('WebSocket error:', e);
    this.ws.onclose = (e) => console.log('WebSocket closed:', e.code, e.reason);
  }

  on(type, handler) { this.handlers[type] = handler; }

  send(msg) {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
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

function formatSpeed(bytesPerSec) { return formatBytes(bytesPerSec) + '/s'; }

function formatTime(seconds) {
  if (!isFinite(seconds) || seconds < 0) return '--:--';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}
