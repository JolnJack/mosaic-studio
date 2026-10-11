import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';

/** Adapt web requests to our existing bounded HTTP handler, without a listening server. */
export function fetchAdapter(handle) {
  return async function fetchRequest(request, { clientIP = 'unknown' } = {}) {
    const url = new URL(request.url);
    const req = request.body ? Readable.fromWeb(request.body) : Readable.from([]);
    req.method = request.method; req.url = url.pathname + url.search;
    req.headers = Object.fromEntries(request.headers); req.headers.host = url.host;
    req.socket = { remoteAddress: clientIP, encrypted: url.protocol === 'https:' };
    req.on('error', () => {});
    const res = new EventEmitter();
    res.headersSent = false; res.writableEnded = false; res.destroyed = false;
    const headers = new Headers(); let status = 200, result;
    res.setHeader = (key, value) => headers.set(key, String(value));
    res.writeHead = (code, fields) => {
      status = code; for (const [key, value] of Object.entries(fields ?? {})) res.setHeader(key, value);
      res.headersSent = true;
    };
    res.end = bytes => {
      res.writableEnded = true;
      result = new Response(request.method === 'HEAD' ? null : (bytes ?? null), { status, headers });
      res.emit('finish'); res.emit('close');
    };
    res.destroy = () => { res.destroyed = true; req.destroy(); res.emit('close'); };
    const aborted = () => { req.emit('aborted'); res.destroy(); };
    request.signal.addEventListener('abort', aborted, { once: true });
    try {
      request.signal.throwIfAborted();
      await handle(req, res);
      request.signal.throwIfAborted();
      if (!result) throw new Error('HTTP handler ended without a response');
      return result;
    } finally {
      request.signal.removeEventListener('abort', aborted);
      req.destroy();
    }
  };
}
