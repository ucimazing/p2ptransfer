/**
 * FastTransfer — Maximum-speed hybrid transfer engine v3.
 *
 * ARCHITECTURE:
 *   8 WebSocket relay connections (8 TCP streams, OS CUBIC/BBR)
 *   + 4 WebRTC P2P connections (4 SCTP streams, bonus bandwidth)
 *   = 12 parallel streams targeting 50-125 MB/s
 *
 * KEY OPTIMIZATIONS (v3):
 *   1. MessageChannel yield — bypasses setTimeout's 4ms clamp (0.1ms vs 4ms)
 *   2. Single-slice batch reading — 1 disk read per batch vs 64 individual reads
 *   3. 256KB chunks — 4x fewer WebSocket frames than 64KB
 *   4. Zero-copy chunk receive — Uint8Array view instead of ArrayBuffer.slice
 *   5. 16MB relay buffer high-water mark — keeps TCP pipeline saturated
 *
 * All streams share one atomic chunk counter. Each stream independently
 * claims chunks and sends them. Receiver deduplicates and reassembles.
 */

const CHUNK_SIZE = 256 * 1024;           // 256KB — matches Go relay buffer, 4x fewer frames
const NUM_P2P = 4;                       // WebRTC P2P connections
const NUM_RELAY = 8;                     // WebSocket relay connections (8 TCP streams)
const BATCH_SIZE = 64;                   // Chunks per batch (16MB per batch with single disk read)
const P2P_BUF_LOW = 512 * 1024;         // P2P resume threshold (512KB)
const P2P_BUF_HIGH = 2 * 1024 * 1024;   // P2P pause threshold (2MB)
const RELAY_BUF_HIGH = 16 * 1024 * 1024; // 16MB relay buffer — keep TCP pipeline saturated

/**
 * MessageChannel yield — bypasses setTimeout's 4ms minimum after 5 nested levels.
 * setTimeout(0) actual latency: 1ms first 5 calls, then 4ms+ forever.
 * MessageChannel.postMessage: consistently 0.1-0.5ms.
 *
 * Each pump creates its own yielder for safe concurrent use.
 */
function createYielder() {
  const ch = new MessageChannel();
  ch.port2.start();
  return {
    yield: () => new Promise(resolve => {
      ch.port2.onmessage = resolve;
      ch.port1.postMessage(null);
    }),
    destroy: () => {
      ch.port1.close();
      ch.port2.close();
    }
  };
}

class TransferEngine {
  constructor(role, signaling, roomId) {
    this.role = role;
    this.signaling = signaling;
    this.roomId = roomId;
    this.connections = [];   // P2P connections
    this.relayConns = [];    // WebSocket relay connections

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

  // ─── P2P SETUP ─────────────────────────────────────────────────────

  _createPC(index) {
    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
      ],
      iceCandidatePoolSize: 5,
    });
    this._addTurn(pc);
    pc.onicecandidate = (e) => {
      if (e.candidate) {
        this.signaling.send({ type: 'ice-candidate', payload: { index, candidate: e.candidate } });
      }
    };
    pc.oniceconnectionstatechange = () => {
      const s = pc.iceConnectionState;
      if (s === 'connected' || s === 'completed') console.log(`PC${index} connected`);
      else if (s === 'failed') console.error(`PC${index} ICE failed`);
    };
    return { pc, channel: null, index, remoteDescriptionSet: false,
      pendingCandidates: [], ready: false, pumpStarted: false };
  }

  async _addTurn(pc) {
    try {
      const r = await fetch('/api/turn');
      const c = await r.json();
      if (c.uris && c.uris.length > 0) {
        try {
          const cfg = pc.getConfiguration();
          cfg.iceServers.push({ urls: c.uris, username: c.username, credential: c.password });
          pc.setConfiguration(cfg);
        } catch (e) {}
      }
    } catch (e) {}
  }

  _fixSDP(type, sdp) {
    let s = sdp.replace(/b=AS:\d+\r?\n/g, '').replace(/b=TIAS:\d+\r?\n/g, '');
    return { type, sdp: s };
  }

  // ─── SENDER ─────────────────────────────────────────────────────────

  async createOffer(file) {
    this.file = file;
    this.totalChunks = Math.ceil(file.size / CHUNK_SIZE);
    this.fileInfo = {
      name: file.name, size: file.size,
      type: file.type || 'application/octet-stream',
      totalChunks: this.totalChunks,
    };

    // 1. Start relay connections FIRST (fastest to establish)
    for (let i = 0; i < NUM_RELAY; i++) {
      this._openRelaySender(i);
    }

    // 2. Start P2P connections in parallel
    for (let i = 0; i < NUM_P2P; i++) {
      const conn = this._createPC(i);
      if (i === 0) {
        const ctrl = conn.pc.createDataChannel('control', { ordered: true });
        ctrl.onopen = () => {
          ctrl.send(JSON.stringify({ type: 'file-info', payload: this.fileInfo }));
        };
      }
      const ch = conn.pc.createDataChannel('data', { ordered: true });
      ch.binaryType = 'arraybuffer';
      ch.bufferedAmountLowThreshold = P2P_BUF_LOW;
      conn.channel = ch;
      ch.onopen = () => { conn.ready = true; this._tryStart(); };
      ch.onerror = (e) => console.error(`PC${i} error:`, e);
      this.connections.push(conn);
    }

    for (const conn of this.connections) {
      const offer = await conn.pc.createOffer();
      const opt = this._fixSDP(offer.type, offer.sdp);
      await conn.pc.setLocalDescription(opt);
      this.signaling.send({
        type: 'offer',
        payload: { index: conn.index, type: conn.pc.localDescription.type, sdp: conn.pc.localDescription.sdp },
      });
    }
  }

  _openRelaySender(idx) {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/ws-relay?room=${this.roomId}&role=sender&idx=${idx}`);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      console.log(`Relay${idx} connected (sender)`);
      // Send file info on first relay only
      if (idx === 0) {
        ws.send(JSON.stringify({ type: 'file-info', payload: this.fileInfo }));
      }
      this.relayConns[idx] = ws;
      this._tryStart();
    };
    ws.onerror = () => console.warn(`Relay${idx} error`);
    ws.onclose = () => console.log(`Relay${idx} closed`);
  }

  async handleAnswer(payload) {
    const conn = this.connections[payload.index];
    if (!conn) return;
    const opt = this._fixSDP(payload.type, payload.sdp);
    await conn.pc.setRemoteDescription(new RTCSessionDescription(opt));
    conn.remoteDescriptionSet = true;
    for (const c of conn.pendingCandidates) {
      try { await conn.pc.addIceCandidate(new RTCIceCandidate(c)); } catch (e) {}
    }
    conn.pendingCandidates = [];
  }

  // ─── RECEIVER ───────────────────────────────────────────────────────

  startRelayReceiver() {
    for (let i = 0; i < NUM_RELAY; i++) {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${proto}//${location.host}/ws-relay?room=${this.roomId}&role=receiver&idx=${i}`);
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => console.log(`Relay${i} connected (receiver)`);
      ws.onmessage = (e) => {
        if (typeof e.data === 'string') {
          try {
            const msg = JSON.parse(e.data);
            if (msg.type === 'file-info' && !this.fileInfo) {
              this.fileInfo = msg.payload;
              this.totalChunks = msg.payload.totalChunks;
              this.receivedBuffers = new Array(this.totalChunks);
              if (this.onFileInfo) this.onFileInfo(this.fileInfo);
            }
          } catch (err) {}
        } else {
          this._handleChunk(e.data);
        }
      };
      ws.onerror = () => console.warn(`Relay${i} receiver error`);
    }
  }

  async handleOffer(payload) {
    const { index } = payload;
    const conn = this._createPC(index);
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
            if (this.onFileInfo) this.onFileInfo(this.fileInfo);
          }
        };
        return;
      }
      ch.binaryType = 'arraybuffer';
      conn.channel = ch;
      ch.onmessage = (e) => this._handleChunk(e.data);
    };

    const opt = this._fixSDP(payload.type, payload.sdp);
    await conn.pc.setRemoteDescription(new RTCSessionDescription(opt));
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
    const optA = this._fixSDP(answer.type, answer.sdp);
    await conn.pc.setLocalDescription(optA);
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

  // ─── SENDING ENGINE ───────────────────────────────────────────────

  _tryStart() {
    const relayReady = this.relayConns.filter(ws => ws && ws.readyState === WebSocket.OPEN);
    const p2pReady = this.connections.filter(c => c.ready && !c.pumpStarted);

    if (!this._sendingStarted) {
      if (relayReady.length === 0 && p2pReady.length === 0) return;
      this._sendingStarted = true;
      this.startTime = performance.now();
      this.sentChunks = 0;
      this.bytesTransferred = 0;
      this._lastTime = this.startTime;
      this._lastBytes = 0;
      this._nextChunkIndex = 0;
      this._startStatsInterval();
      console.log(`Transfer starting: ${relayReady.length} relay + ${p2pReady.length} P2P streams`);
    }

    // Launch relay pumps
    for (const ws of relayReady) {
      if (!ws._pumpStarted) {
        ws._pumpStarted = true;
        this._relayPump(ws);
      }
    }

    // Launch P2P pumps
    for (const conn of p2pReady) {
      conn.pumpStarted = true;
      this._p2pPump(conn.channel, conn.index);
    }
  }

  /**
   * RELAY PUMP — Maximum throughput with MessageChannel yield.
   *
   * Key insight: setTimeout(0) has a 4ms minimum after 5 nested levels in Chrome.
   * At 256KB chunks, 4ms/yield = 64 MB/s ceiling per connection.
   * MessageChannel yield = 0.1-0.5ms = 512-2560 MB/s ceiling per connection.
   *
   * Combined with 16MB buffer high-water mark, this keeps TCP fully saturated.
   */
  async _relayPump(ws) {
    const yielder = createYielder();
    console.log('Relay pump started');

    try {
      while (this._nextChunkIndex < this.totalChunks) {
        // Read a batch of chunks (single disk I/O)
        const batch = await this._readBatch();
        if (batch.length === 0) break;

        // Blast the batch into the WebSocket
        for (let i = 0; i < batch.length; i++) {
          if (ws.readyState !== WebSocket.OPEN) return;

          // Backpressure: yield via MessageChannel when buffer is full
          while (ws.bufferedAmount > RELAY_BUF_HIGH) {
            if (ws.readyState !== WebSocket.OPEN) return;
            await yielder.yield();
          }

          ws.send(batch[i].data);
          this.sentChunks++;
          this.bytesTransferred += batch[i].size;
          this._checkDone();
        }
      }
    } finally {
      yielder.destroy();
    }
  }

  /**
   * P2P PUMP — Tight loop with native onbufferedamountlow callback.
   * No setTimeout/MessageChannel needed — browser handles backpressure natively.
   */
  async _p2pPump(channel, idx) {
    console.log(`P2P-${idx} pump started`);

    while (this._nextChunkIndex < this.totalChunks) {
      const batch = await this._readBatch();
      if (batch.length === 0) break;

      let bi = 0;
      await new Promise((resolve) => {
        const blast = () => {
          while (bi < batch.length) {
            if (channel.readyState !== 'open') { resolve(); return; }
            if (channel.bufferedAmount > P2P_BUF_HIGH) {
              channel.onbufferedamountlow = blast;
              return;
            }
            try { channel.send(batch[bi].data); }
            catch (e) { channel.onbufferedamountlow = blast; return; }
            this.sentChunks++;
            this.bytesTransferred += batch[bi].size;
            bi++;
            this._checkDone();
          }
          channel.onbufferedamountlow = null;
          resolve();
        };
        blast();
      });

      if (channel.readyState !== 'open') return;
    }
  }

  /**
   * Read a batch of chunks with SINGLE disk I/O.
   *
   * Previous: 64 separate file.slice().arrayBuffer() calls = 64 disk reads.
   * Now: 1 large file.slice().arrayBuffer() + in-memory subdivision.
   * At 256KB × 64 chunks = 16MB per batch, this is 64x fewer I/O operations.
   *
   * Thread-safe: _nextChunkIndex claim is synchronous (before any await),
   * so concurrent async pumps never claim overlapping chunks.
   */
  async _readBatch() {
    // Atomically claim a range of chunks (synchronous — no interleaving)
    const startIdx = this._nextChunkIndex;
    const count = Math.min(BATCH_SIZE, this.totalChunks - startIdx);
    if (count <= 0) return [];
    this._nextChunkIndex += count;

    // Single disk read for the entire batch
    const byteStart = startIdx * CHUNK_SIZE;
    const byteEnd = Math.min((startIdx + count) * CHUNK_SIZE, this.file.size);
    const bigBuf = await this.file.slice(byteStart, byteEnd).arrayBuffer();
    const bigArr = new Uint8Array(bigBuf);

    // Subdivide into chunks with 4-byte index header
    const batch = [];
    for (let i = 0; i < count; i++) {
      const chunkIdx = startIdx + i;
      const offset = i * CHUNK_SIZE;
      const end = Math.min(offset + CHUNK_SIZE, bigBuf.byteLength);
      const chunkLen = end - offset;

      // [4-byte chunk index | chunk data]
      const combined = new Uint8Array(4 + chunkLen);
      new DataView(combined.buffer).setUint32(0, chunkIdx);
      combined.set(bigArr.subarray(offset, end), 4);
      batch.push({ data: combined.buffer, size: chunkLen });
    }
    return batch;
  }

  _checkDone() {
    if (this.onProgress) this.onProgress(this.sentChunks / this.totalChunks);
    if (this.sentChunks === this.totalChunks && !this._completeFired) {
      this._completeFired = true;
      this._stopStatsInterval();
      console.log(`Transfer complete — ${this.totalChunks} chunks sent`);
      setTimeout(() => { if (this.onComplete) this.onComplete(); }, 500);
    }
  }

  // ─── RECEIVER ──────────────────────────────────────────────────────

  /**
   * Handle incoming chunk — zero-copy with Uint8Array view.
   * Previous: data.slice(4) created a full copy of chunk data.
   * Now: new Uint8Array(data, 4) creates a VIEW — no copy, same performance.
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
    if (this.receivedBuffers[index]) return; // Dedup — chunk already received

    // Zero-copy: Uint8Array view into the original ArrayBuffer (skips 4-byte header)
    const chunkData = new Uint8Array(data, 4);
    this.receivedBuffers[index] = chunkData;
    this.receivedChunks++;
    this.bytesTransferred += chunkData.byteLength;
    if (this.onProgress) this.onProgress(this.receivedChunks / this.totalChunks);
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
    a.href = url; a.download = this.fileInfo.name;
    document.body.appendChild(a); a.click();
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
      const el = (now - this._lastTime) / 1000;
      const bd = this.bytesTransferred - this._lastBytes;
      const speed = el > 0 ? bd / el : 0;
      this._speedSamples.push(speed);
      if (this._speedSamples.length > 10) this._speedSamples.shift();
      const avg = this._speedSamples.reduce((a, b) => a + b, 0) / this._speedSamples.length;
      this._lastTime = now; this._lastBytes = this.bytesTransferred;
      if (this.onStats) {
        const te = (now - this.startTime) / 1000;
        const p = this.role === 'sender' ? this.sentChunks / this.totalChunks : this.receivedChunks / this.totalChunks;
        const rem = p > 0 ? (te / p) * (1 - p) : 0;
        this.onStats({ speed: avg, instantSpeed: speed, bytesTransferred: this.bytesTransferred,
          elapsed: te, eta: rem, progress: p });
      }
    }, 500);
  }

  _stopStatsInterval() {
    if (this._statsInterval) { clearInterval(this._statsInterval); this._statsInterval = null; }
  }

  destroy() {
    this._stopStatsInterval();
    for (const ws of this.relayConns) { try { if (ws) ws.close(); } catch (e) {} }
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
      const h = this.handlers[msg.type];
      if (h) h(msg.payload);
    };
    this.ws.onerror = (e) => console.error('WS error:', e);
    this.ws.onclose = (e) => console.log('WS closed:', e.code);
  }
  on(type, handler) { this.handlers[type] = handler; }
  send(msg) { if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg)); }
  waitOpen() {
    return new Promise((resolve, reject) => {
      if (this.ws.readyState === WebSocket.OPEN) { resolve(); return; }
      this.ws.onopen = () => resolve();
      this.ws.onerror = (e) => reject(e);
    });
  }
  close() { this.ws.close(); }
}

// ─── UTILITIES ─────────────────────────────────────────────────────────

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024; const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}
function formatSpeed(bps) { return formatBytes(bps) + '/s'; }
function formatTime(s) {
  if (!isFinite(s) || s < 0) return '--:--';
  return `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, '0')}`;
}
