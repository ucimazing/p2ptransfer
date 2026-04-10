/**
 * FastTransfer streaming-download service worker.
 *
 * Design (based on StreamSaver.js):
 *
 *   1. Page posts {type:'register', id, filename, size, mime} to the SW via MessageChannel.
 *      SW keeps a map: id → { controller, filename, size, mime }.
 *
 *   2. Page navigates (or iframe/anchor-clicks) to /sw-download/<id>.
 *      SW intercepts the fetch, finds the entry, returns a Response with a
 *      ReadableStream whose controller is stashed in the entry. Chrome sees
 *      a real download with Content-Disposition: attachment and shows it in
 *      the downloads bar with progress.
 *
 *   3. Page posts {type:'chunk', id, data} messages as chunks arrive. SW
 *      enqueues each chunk into the stream controller. Chrome flushes bytes
 *      to the disk file as they come in — progressive, not buffered.
 *
 *   4. Page posts {type:'close', id} when done. SW closes the controller
 *      and Chrome marks the download complete.
 *
 *   5. {type:'abort', id} errors the stream (user cancel, transfer failure).
 */

const streams = new Map(); // id → { ready, controller, filename, size, mime, pending[] }

self.addEventListener('install', (e) => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(self.clients.claim());
});

self.addEventListener('message', (event) => {
  const msg = event.data;
  if (!msg || !msg.type) return;

  if (msg.type === 'register') {
    // Page wants to prepare a streaming download
    let controller = null;
    const pending = [];
    const entry = {
      controller: null,
      filename: msg.filename,
      size: msg.size,
      mime: msg.mime || 'application/octet-stream',
      pending,
      closed: false,
    };
    streams.set(msg.id, entry);
    // Acknowledge via the MessageChannel port the page sent
    if (event.ports && event.ports[0]) {
      event.ports[0].postMessage({ type: 'registered', id: msg.id });
    }
    return;
  }

  const entry = streams.get(msg.id);
  if (!entry) return;

  if (msg.type === 'chunk') {
    if (entry.controller) {
      // Stream is live — push directly
      try { entry.controller.enqueue(new Uint8Array(msg.data)); }
      catch (e) {}
    } else {
      // Fetch hasn't happened yet — buffer for later
      entry.pending.push(msg.data);
    }
  } else if (msg.type === 'close') {
    entry.closed = true;
    if (entry.controller) {
      try { entry.controller.close(); } catch (e) {}
      streams.delete(msg.id);
    }
  } else if (msg.type === 'abort') {
    if (entry.controller) {
      try { entry.controller.error(new Error(msg.reason || 'aborted')); } catch (e) {}
    }
    streams.delete(msg.id);
  }
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // Match /sw-download/<id>
  const m = url.pathname.match(/^\/sw-download\/(.+)$/);
  if (!m) return; // Not ours — let the network handle it

  const id = decodeURIComponent(m[1]);
  const entry = streams.get(id);
  if (!entry) {
    event.respondWith(new Response('stream not found', { status: 404 }));
    return;
  }

  const stream = new ReadableStream({
    start(controller) {
      entry.controller = controller;
      // Flush any chunks that arrived before the fetch started
      for (const chunk of entry.pending) {
        try { controller.enqueue(new Uint8Array(chunk)); } catch (e) {}
      }
      entry.pending = [];
      if (entry.closed) {
        try { controller.close(); } catch (e) {}
        streams.delete(id);
      }
    },
    cancel() {
      streams.delete(id);
    }
  });

  const headers = new Headers({
    'Content-Type': entry.mime,
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(entry.filename)}`,
    'Cache-Control': 'no-store',
  });
  if (entry.size != null && !isNaN(entry.size)) {
    headers.set('Content-Length', String(entry.size));
  }

  event.respondWith(new Response(stream, { status: 200, headers }));
});
