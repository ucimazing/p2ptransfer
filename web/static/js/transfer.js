/**
 * FastTransfer — Maximum-speed hybrid transfer engine v3.
 *
 * ARCHITECTURE:
 *   8 WebSocket relay connections (8 TCP streams, OS CUBIC/BBR)
 *   + 4 WebRTC P2P connections (4 SCTP streams, bonus bandwidth)
 *   = 12 parallel streams targeting 50-125 MB/s
 *
 * KEY OPTIMIZATIONS (v3.1):
 *   1. MessageChannel yield — bypasses setTimeout's 4ms clamp (0.1ms vs 4ms)
 *   2. Single-slice batch reading — 1 disk read per 256 chunks (vs 256 reads)
 *   3. 64KB chunks (65532-byte payload + 4-byte header = 65536 on wire)
 *      — fits WebRTC DataChannel default max-message-size of 65536
 *   4. Zero-copy chunk receive — Uint8Array view instead of ArrayBuffer.slice
 *   5. 16MB relay buffer high-water mark — keeps TCP pipeline saturated
 *   6. Chunk re-queue on pump failure — no stalls if P2P/relay dies mid-batch
 *
 * All streams share one atomic chunk counter. Each stream independently
 * claims chunks and sends them. Receiver deduplicates and reassembles.
 */

// CHUNK_PAYLOAD_SIZE is 65532 bytes so the full wire frame (header + payload)
// is exactly 65536 bytes = the default WebRTC DataChannel max-message-size
// (without SDP `max-message-size` negotiation). WebSocket has no such limit,
// but using the same chunk size across both transports keeps the receiver
// logic unified and the wire frame aligned to a power-of-2 boundary.
const CHUNK_PAYLOAD_SIZE = 64 * 1024 - 4; // 65532 bytes of file data per chunk
const CHUNK_SIZE = CHUNK_PAYLOAD_SIZE;    // Alias used by totalChunks calculation
const NUM_P2P = 4;                        // WebRTC P2P connections
const NUM_RELAY = 8;                      // WebSocket relay connections (8 TCP streams)
const BATCH_SIZE = 64;                    // 64 × ~64KB ≈ 4MB per batch (one disk read)
const P2P_BUF_LOW = 256 * 1024;           // P2P resume threshold
const P2P_BUF_HIGH = 1 * 1024 * 1024;     // P2P pause threshold (1MB)
const RELAY_BUF_HIGH = 8 * 1024 * 1024;   // 8MB relay buffer — keeps TCP pipeline full without over-buffering

/**
 * StreamingDownloader — writes incoming bytes to a real Chrome download
 * (visible in the downloads bar with progress), via a service worker.
 *
 * Usage:
 *   const dl = new StreamingDownloader();
 *   await dl.prepare({ name, size, mime });    // registers with SW, opens the download
 *   dl.write(uint8array);                       // write bytes, in any order BUT in-order
 *   dl.close();                                 // finishes the download
 *
 * Falls back to in-memory Blob download if:
 *   - Service workers aren't supported (old Safari)
 *   - Page is served over HTTP (SWs require HTTPS)
 *   - SW registration fails
 */
class StreamingDownloader {
  constructor() {
    this.id = 'dl-' + Math.random().toString(36).slice(2, 12);
    this.mode = null; // 'sw' | 'blob'
    this.fallbackChunks = [];
    this.fallbackMime = 'application/octet-stream';
    this.fallbackName = 'download';
  }

  async prepare({ name, size, mime }) {
    this.fallbackName = name;
    this.fallbackMime = mime || 'application/octet-stream';

    // Try the service-worker path first
    if ('serviceWorker' in navigator && window.isSecureContext) {
      try {
        const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
        // Wait for an active SW (the one that will actually handle /sw-download/...)
        const sw = await this._waitForActive(reg);
        if (sw) {
          // Register this download with the SW via a MessageChannel (reliable reply)
          const mc = new MessageChannel();
          const ack = new Promise((resolve) => {
            mc.port1.onmessage = (e) => resolve(e.data);
          });
          sw.postMessage({
            type: 'register',
            id: this.id,
            filename: name,
            size,
            mime: this.fallbackMime,
          }, [mc.port2]);
          await ack;

          // Open a hidden iframe pointed at /sw-download/<id>. This triggers
          // a fetch that the SW intercepts with a ReadableStream response,
          // which Chrome turns into a real file download.
          const iframe = document.createElement('iframe');
          iframe.hidden = true;
          iframe.src = `/sw-download/${encodeURIComponent(this.id)}`;
          document.body.appendChild(iframe);
          this._iframe = iframe;
          this._sw = sw;
          this.mode = 'sw';
          console.log('[download] streaming via service worker');
          return;
        }
      } catch (e) {
        console.warn('[download] SW streaming unavailable, falling back to Blob:', e);
      }
    }

    // Blob fallback (buffers entire file in memory, download appears at end)
    this.mode = 'blob';
    console.log('[download] using Blob fallback (non-streaming)');
  }

  write(uint8) {
    if (this.mode === 'sw') {
      // Transfer the underlying buffer to avoid a copy
      const buf = uint8.buffer.slice(uint8.byteOffset, uint8.byteOffset + uint8.byteLength);
      this._sw.postMessage({ type: 'chunk', id: this.id, data: buf }, [buf]);
    } else {
      this.fallbackChunks.push(uint8);
    }
  }

  close() {
    if (this.mode === 'sw') {
      this._sw.postMessage({ type: 'close', id: this.id });
      // Tidy up the iframe after a delay — the download has already started
      setTimeout(() => {
        if (this._iframe && this._iframe.parentNode) {
          this._iframe.parentNode.removeChild(this._iframe);
        }
      }, 2000);
    } else {
      // Blob fallback: assemble now and trigger the download
      const blob = new Blob(this.fallbackChunks, { type: this.fallbackMime });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = this.fallbackName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      this.fallbackChunks = [];
    }
  }

  abort(reason) {
    if (this.mode === 'sw' && this._sw) {
      try { this._sw.postMessage({ type: 'abort', id: this.id, reason }); } catch (e) {}
    }
    this.fallbackChunks = [];
  }

  _waitForActive(reg) {
    return new Promise((resolve) => {
      if (reg.active) { resolve(reg.active); return; }
      const worker = reg.installing || reg.waiting;
      if (!worker) { resolve(null); return; }
      worker.addEventListener('statechange', () => {
        if (worker.state === 'activated') resolve(worker);
      });
      // Fallback: poll briefly
      setTimeout(() => resolve(reg.active || null), 3000);
    });
  }
}

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
    this._retryIndices = [];  // Chunks un-sent by a failed pump — other pumps pick them up
    this._completeFired = false;
    this._sendingStarted = false;

    // Streaming download state (receiver side)
    this._downloader = null;
    this._nextWriteIndex = 0;   // Next chunk index to stream into the downloader
    this._pendingChunks = new Map(); // out-of-order chunks buffered by index
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
              this._onFileInfoReceived(msg.payload);
            }
          } catch (err) {}
        } else {
          this._handleChunk(e.data);
        }
      };
      ws.onerror = () => console.warn(`Relay${i} receiver error`);
    }
  }

  // Called on the receiver when the file-info arrives (from either P2P control
  // channel or the first relay WebSocket). Sets up the streaming downloader.
  async _onFileInfoReceived(info) {
    this.fileInfo = info;
    this.totalChunks = info.totalChunks;
    this._downloader = new StreamingDownloader();
    try {
      await this._downloader.prepare({
        name: info.name,
        size: info.size,
        mime: info.type || 'application/octet-stream',
      });
    } catch (e) {
      console.error('[download] prepare failed:', e);
    }
    if (this.onFileInfo) this.onFileInfo(this.fileInfo);
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
            this._onFileInfoReceived(msg.payload);
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
   * At 64KB chunks, 4ms/yield = 16 MB/s ceiling per connection.
   * MessageChannel yield = 0.1-0.5ms = 128-640 MB/s ceiling per connection.
   *
   * Combined with 16MB buffer high-water mark, this keeps TCP fully saturated.
   */
  async _relayPump(ws) {
    const yielder = createYielder();
    console.log('Relay pump started');

    try {
      while (this._moreWork()) {
        // Read a batch of chunks (single disk I/O)
        const batch = await this._readBatch();
        if (batch.length === 0) break;

        // Blast the batch into the WebSocket
        for (let i = 0; i < batch.length; i++) {
          if (ws.readyState !== WebSocket.OPEN) {
            // Return remaining chunks so another pump can send them
            this._requeue(batch.slice(i).map(b => b.index));
            return;
          }

          // Backpressure: yield via MessageChannel when buffer is full
          while (ws.bufferedAmount > RELAY_BUF_HIGH) {
            if (ws.readyState !== WebSocket.OPEN) {
              this._requeue(batch.slice(i).map(b => b.index));
              return;
            }
            await yielder.yield();
          }

          try {
            ws.send(batch[i].data);
          } catch (e) {
            console.warn('Relay send error:', e);
            this._requeue(batch.slice(i).map(b => b.index));
            return;
          }
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
   * Unsent chunks on channel failure are re-queued for other pumps.
   */
  async _p2pPump(channel, idx) {
    console.log(`P2P-${idx} pump started`);

    while (this._moreWork()) {
      const batch = await this._readBatch();
      if (batch.length === 0) break;

      let bi = 0;
      let failed = false;
      await new Promise((resolve) => {
        const blast = () => {
          while (bi < batch.length) {
            if (channel.readyState !== 'open') { resolve(); return; }
            if (channel.bufferedAmount > P2P_BUF_HIGH) {
              channel.onbufferedamountlow = blast;
              return;
            }
            try {
              channel.send(batch[bi].data);
            } catch (e) {
              console.warn(`P2P-${idx} send error (chunk ${batch[bi].index}):`, e.message || e);
              failed = true;
              channel.onbufferedamountlow = null;
              resolve();
              return;
            }
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

      // Re-queue anything we didn't send (channel died, or send() threw)
      if (bi < batch.length) {
        this._requeue(batch.slice(bi).map(b => b.index));
      }

      // Permanently give up on a broken channel so we don't spin
      if (failed || channel.readyState !== 'open') return;
    }
  }

  // Work-remaining helper — accounts for retry queue in addition to counter
  _moreWork() {
    return this._nextChunkIndex < this.totalChunks || this._retryIndices.length > 0;
  }

  _requeue(indices) {
    if (!indices || indices.length === 0) return;
    for (const idx of indices) this._retryIndices.push(idx);
  }

  /**
   * Read a batch of chunks with SINGLE disk I/O.
   *
   * Priority:
   *  1. Drain the retry queue (chunks released by failed pumps)
   *  2. Claim new contiguous chunks from _nextChunkIndex
   *
   * One large file.slice().arrayBuffer() per contiguous claim, plus per-chunk
   * reads for scattered retries (rare path — only hit on pump failure).
   *
   * Thread-safe: counter/queue mutations are synchronous (before any await),
   * so concurrent async pumps never claim overlapping chunks.
   */
  async _readBatch() {
    // 1. Drain retry queue first (urgent — these chunks failed on another pump)
    const retryIdx = [];
    while (retryIdx.length < BATCH_SIZE && this._retryIndices.length > 0) {
      retryIdx.push(this._retryIndices.shift());
    }

    // 2. Claim new contiguous chunks
    const remaining = BATCH_SIZE - retryIdx.length;
    const startIdx = this._nextChunkIndex;
    const count = Math.min(remaining, this.totalChunks - startIdx);
    if (count > 0) this._nextChunkIndex += count;

    if (retryIdx.length === 0 && count <= 0) return [];

    const batch = [];

    // Per-index read for retry chunks (slow path, only on failures)
    for (const chunkIdx of retryIdx) {
      const start = chunkIdx * CHUNK_PAYLOAD_SIZE;
      const end = Math.min(start + CHUNK_PAYLOAD_SIZE, this.file.size);
      const buf = await this.file.slice(start, end).arrayBuffer();
      const combined = new Uint8Array(4 + buf.byteLength);
      new DataView(combined.buffer).setUint32(0, chunkIdx);
      combined.set(new Uint8Array(buf), 4);
      batch.push({ data: combined.buffer, size: buf.byteLength, index: chunkIdx });
    }

    // Single large disk read for the contiguous new claim (fast path)
    if (count > 0) {
      const byteStart = startIdx * CHUNK_PAYLOAD_SIZE;
      const byteEnd = Math.min((startIdx + count) * CHUNK_PAYLOAD_SIZE, this.file.size);
      const bigBuf = await this.file.slice(byteStart, byteEnd).arrayBuffer();
      const bigArr = new Uint8Array(bigBuf);

      for (let i = 0; i < count; i++) {
        const chunkIdx = startIdx + i;
        const offset = i * CHUNK_PAYLOAD_SIZE;
        const end = Math.min(offset + CHUNK_PAYLOAD_SIZE, bigBuf.byteLength);
        const chunkLen = end - offset;

        const combined = new Uint8Array(4 + chunkLen);
        new DataView(combined.buffer).setUint32(0, chunkIdx);
        combined.set(bigArr.subarray(offset, end), 4);
        batch.push({ data: combined.buffer, size: chunkLen, index: chunkIdx });
      }
    }

    return batch;
  }

  _checkDone() {
    if (this.onProgress) this.onProgress(this.sentChunks / this.totalChunks);
    if (this.sentChunks === this.totalChunks && !this._completeFired) {
      this._completeFired = true;
      console.log(`Transfer complete — ${this.totalChunks} chunks queued, waiting for buffers to drain`);
      // Don't stop stats or fire onComplete yet — data may still be in TCP/SCTP
      // buffers. Wait for all connection buffers to hit zero first.
      this._waitForDrain().then(() => {
        this._stopStatsInterval();
        console.log('All buffers drained — transfer fully delivered');
        if (this.onComplete) this.onComplete();
      });
    }
  }

  async _waitForDrain() {
    const yielder = createYielder();
    try {
      while (true) {
        let totalBuffered = 0;
        for (const ws of this.relayConns) {
          if (ws && ws.readyState === WebSocket.OPEN) totalBuffered += ws.bufferedAmount;
        }
        for (const conn of this.connections) {
          if (conn && conn.channel && conn.channel.readyState === 'open') {
            totalBuffered += conn.channel.bufferedAmount;
          }
        }
        if (totalBuffered === 0) return;
        await yielder.yield();
      }
    } finally {
      yielder.destroy();
    }
  }

  // ─── RECEIVER ──────────────────────────────────────────────────────

  /**
   * Handle incoming chunk — zero-copy decode, then stream to the downloader
   * in strict index order. Out-of-order chunks are buffered until their
   * predecessors arrive so the download stream stays monotonic.
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

    // Dedup — chunk already received (via another pump)
    if (index < this._nextWriteIndex || this._pendingChunks.has(index)) return;

    // Zero-copy view into the original ArrayBuffer (skips 4-byte header)
    const chunkData = new Uint8Array(data, 4);
    this.receivedChunks++;
    this.bytesTransferred += chunkData.byteLength;

    // Stream in order to the downloader
    if (index === this._nextWriteIndex) {
      this._writeChunk(chunkData);
      this._nextWriteIndex++;
      // Drain any buffered follow-on chunks
      while (this._pendingChunks.has(this._nextWriteIndex)) {
        const next = this._pendingChunks.get(this._nextWriteIndex);
        this._pendingChunks.delete(this._nextWriteIndex);
        this._writeChunk(next);
        this._nextWriteIndex++;
      }
    } else {
      // Out of order — stash until the gap closes
      this._pendingChunks.set(index, chunkData);
    }

    if (this.onProgress) this.onProgress(this.receivedChunks / this.totalChunks);

    if (this.receivedChunks === this.totalChunks) {
      this._stopStatsInterval();
      this._finishDownload();
    }
  }

  _writeChunk(uint8) {
    if (this._downloader) {
      this._downloader.write(uint8);
    }
  }

  _finishDownload() {
    console.log('All chunks received — finishing download');
    if (this._downloader) {
      this._downloader.close();
    }
    this._pendingChunks.clear();
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
