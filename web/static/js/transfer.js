/**
 * FastTransfer — Hybrid P2P + Relay file transfer engine.
 *
 * ARCHITECTURE: 4 WebRTC PeerConnections + 1 WebSocket relay, all sharing
 * a single chunk counter. Each stream independently pulls chunks and sends.
 *
 * Why hybrid:
 * - WebRTC SCTP in Chrome uses TCP-Reno congestion control → ~4-10 MB/s per
 *   connection on internet links. 4 connections ≈ 16-40 MB/s.
 * - WebSocket uses OS TCP stack (CUBIC/BBR) → 30-50 MB/s single connection.
 * - Combined: 4 P2P + 1 relay ≈ 40-60 MB/s on fast links.
 *
 * The relay goes through the server but uses zero-copy io.Copy in Go,
 * adding minimal latency. P2P connections run alongside for free bandwidth.
 */

const CHUNK_SIZE = 64 * 1024;              // 64KB per chunk
const NUM_CONNECTIONS = 4;                  // 4 WebRTC PeerConnections
const BATCH_SIZE = 16;                      // Pre-read 16 chunks per batch
const BUFFER_LOW = 256 * 1024;              // 256KB resume threshold
const BUFFER_HIGH = 1 * 1024 * 1024;        // 1MB pause threshold
const RELAY_BUFFER_HIGH = 4 * 1024 * 1024;  // 4MB for WebSocket relay

class TransferEngine {
  constructor(role, signaling, roomId) {
    this.role = role;
    this.signaling = signaling;
    this.roomId = roomId;
    this.connections = [];
    this.relayWs = null; // WebSocket relay connection

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
      ready: false, pumpStarted: false,
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

  _optimizeSDP(type, sdp) {
    let s = sdp;
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

    // Start WebSocket relay connection IMMEDIATELY (fastest to establish)
    this._startRelayConnection('sender');

    // Create P2P connections in parallel
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

    for (const conn of this.connections) {
      const offer = await conn.pc.createOffer();
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
    console.log(`${NUM_CONNECTIONS} P2P offers + relay connection started`);
  }

  async handleAnswer(payload) {
    const { index } = payload;
    const conn = this.connections[index];
    if (!conn) return;
    const optimized = this._optimizeSDP(payload.type, payload.sdp);
    await conn.pc.setRemoteDescription(new RTCSessionDescription(optimized));
    conn.remoteDescriptionSet = true;
    for (const c of conn.pendingCandidates) {
      try { await conn.pc.addIceCandidate(new RTCIceCandidate(c)); } catch (e) {}
    }
    conn.pendingCandidates = [];
  }

  // ─── WEBSOCKET RELAY ──────────────────────────────────────────────

  _startRelayConnection(role) {
    const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${wsProto}//${location.host}/ws-relay?room=${this.roomId}&role=${role}`;
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    this.relayWs = ws;

    if (role === 'sender') {
      ws.onopen = () => {
        console.log('Relay WebSocket connected (sender)');
        // Send file info as first text message
        ws.send(JSON.stringify({ type: 'file-info', payload: this.fileInfo }));
        this._tryStartSending();
      };
      ws.onerror = (e) => console.warn('Relay WS error:', e);
      ws.onclose = () => console.log('Relay WS closed');
    } else {
      // Receiver side
      ws.onopen = () => console.log('Relay WebSocket connected (receiver)');
      ws.onmessage = (e) => {
        if (typeof e.data === 'string') {
          // Text message = file info
          try {
            const msg = JSON.parse(e.data);
            if (msg.type === 'file-info' && !this.fileInfo) {
              this.fileInfo = msg.payload;
              this.totalChunks = msg.payload.totalChunks;
              this.receivedBuffers = new Array(this.totalChunks);
              console.log('File info from relay:', this.fileInfo);
              if (this.onFileInfo) this.onFileInfo(this.fileInfo);
            }
          } catch (err) {}
        } else {
          // Binary = chunk data (same format as P2P: 4-byte header + data)
          this._handleChunk(e.data);
        }
      };
      ws.onerror = (e) => console.warn('Relay WS error:', e);
    }
  }

  // ─── SENDING ENGINE ───────────────────────────────────────────────

  _tryStartSending() {
    if (this._sendingStarted) {
      // Already started — launch pumps for newly ready connections
      for (const conn of this.connections) {
        if (conn.ready && !conn.pumpStarted) {
          conn.pumpStarted = true;
          console.log(`PC${conn.index} joining transfer`);
          this._batchPump(conn.channel, `P2P-${conn.index}`, BUFFER_HIGH);
        }
      }
      return;
    }

    // Need at least the relay OR one P2P connection to start
    const relayReady = this.relayWs && this.relayWs.readyState === WebSocket.OPEN;
    const p2pReady = this.connections.some(c => c.ready);
    if (!relayReady && !p2pReady) return;

    this._sendingStarted = true;
    console.log('Starting transfer —', relayReady ? 'relay +' : '', 'P2P connections joining as ready');
    this.startTime = performance.now();
    this.sentChunks = 0;
    this.bytesTransferred = 0;
    this._lastTime = this.startTime;
    this._lastBytes = 0;
    this._nextChunkIndex = 0;
    this._startStatsInterval();

    // Launch relay pump (if ready)
    if (relayReady) {
      this._relayPump();
    }

    // Launch P2P pumps for all currently ready connections
    for (const conn of this.connections) {
      if (conn.ready) {
        conn.pumpStarted = true;
        this._batchPump(conn.channel, `P2P-${conn.index}`, BUFFER_HIGH);
      }
    }
  }

  /**
   * RELAY PUMP — High-speed sending loop through the WebSocket relay.
   * Uses bufferedAmount backpressure. WebSocket over TCP with OS-level
   * congestion control (CUBIC/BBR) achieves 30-50 MB/s.
   */
  async _relayPump() {
    const ws = this.relayWs;
    console.log('Relay pump started');

    while (true) {
      // Claim and read a batch
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

      if (batch.length === 0) break;

      // Blast batch with backpressure
      for (let i = 0; i < batch.length; i++) {
        if (ws.readyState !== WebSocket.OPEN) {
          console.warn('Relay WS closed during send');
          return;
        }

        // Wait for buffer to drain if needed
        while (ws.bufferedAmount > RELAY_BUFFER_HIGH) {
          await new Promise(r => setTimeout(r, 5));
          if (ws.readyState !== WebSocket.OPEN) return;
        }

        ws.send(batch[i].data);
        this.sentChunks++;
        this.bytesTransferred += batch[i].size;
        this._checkProgress();
      }
    }

    console.log('Relay pump finished');
  }

  /**
   * BATCH PUMP — For P2P DataChannels. Pre-reads chunks then sends synchronously.
   */
  async _batchPump(channel, label, bufferHigh) {
    console.log(`${label} pump started`);

    while (true) {
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

      if (batch.length === 0) break;

      // Synchronous tight send loop
      let batchIdx = 0;
      await new Promise((resolve) => {
        const sendTight = () => {
          while (batchIdx < batch.length) {
            if (channel.readyState !== 'open') { resolve(); return; }
            if (channel.bufferedAmount > bufferHigh) {
              channel.onbufferedamountlow = sendTight;
              return;
            }
            try {
              channel.send(batch[batchIdx].data);
            } catch (err) {
              channel.onbufferedamountlow = sendTight;
              return;
            }
            this.sentChunks++;
            this.bytesTransferred += batch[batchIdx].size;
            batchIdx++;
            this._checkProgress();
          }
          channel.onbufferedamountlow = null;
          resolve();
        };
        sendTight();
      });

      if (channel.readyState !== 'open') return;
    }

    console.log(`${label} pump finished`);
  }

  _checkProgress() {
    if (this.onProgress) {
      this.onProgress(this.sentChunks / this.totalChunks);
    }
    if (this.sentChunks === this.totalChunks && !this._completeFired) {
      this._completeFired = true;
      this._stopStatsInterval();
      console.log(`Transfer complete — ${this.totalChunks} chunks`);
      setTimeout(() => { if (this.onComplete) this.onComplete(); }, 500);
    }
  }

  // ─── RECEIVER ───────────────────────────────────────────────────────

  async handleOffer(payload) {
    const { index } = payload;
    const conn = this._createPeerConnection(index);
    while (this.connections.length <= index) this.connections.push(null);
    this.connections[index] = conn;

    conn.pc.ondatachannel = (event) => {
      const ch = event.channel;
      if (ch.label === 'control') {
        ch.onmessage = (e) => {
          const msg = JSON.parse(e.data);
          if (msg.type === 'file-info' && !this.fileInfo) {
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
    const opt = this._optimizeSDP(answer.type, answer.sdp);
    await conn.pc.setLocalDescription(opt);

    this.signaling.send({
      type: 'answer',
      payload: { index, type: conn.pc.localDescription.type, sdp: conn.pc.localDescription.sdp },
    });
  }

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
    if (!conn.remoteDescriptionSet) { conn.pendingCandidates.push(candidate); return; }
    try { await conn.pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch (e) {}
  }

  // ─── CHUNK RECEIVING (BOTH P2P AND RELAY) ──────────────────────────

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

    // Deduplicate (same chunk could theoretically arrive from both P2P and relay)
    if (this.receivedBuffers[index]) return;

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
      this.onComplete({ fileName: this.fileInfo.name, fileSize: this.fileInfo.size,
        elapsed, avgSpeed: this.fileInfo.size / elapsed });
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
    if (this.relayWs) { try { this.relayWs.close(); } catch (e) {} }
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
  send(msg) { if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg)); }
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
