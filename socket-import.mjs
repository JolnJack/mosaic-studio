import { decodeHTTP } from './pinned-import.mjs';
import { fail, publicUrl, isPublicAddress } from './import-source.mjs';

/** Cloudflare's native stream socket. No DNS re-resolution, custom CA, or TLS bypass. */
export async function socketPage(url, address, { connect, signal, timeoutMs = 15000, onTransportError } = {}) {
  url = publicUrl(url.href);
  if (!isPublicAddress(address?.address)) throw fail('不能连接本地、内部或保留地址。');
  signal?.throwIfAborted();
  let socket, reader, writer, timer, rejectDeadline;
  const deadline = new Promise((_, reject) => { rejectDeadline = reject; timer = setTimeout(() => reject(fail('网页读取超时。', 504)), timeoutMs); });
  const onAbort = () => rejectDeadline(signal.reason ?? fail('网页读取已取消。', 499));
  signal?.addEventListener('abort', onAbort, { once: true });
  const guarded = value => Promise.race([value, deadline]);
  const cleanup = promise => Promise.resolve(promise).catch(() => {});
  try {
    const secure = url.protocol === 'https:';
    socket = connect({ hostname: address.address, port: Number(url.port) || (secure ? 443 : 80) }, { secureTransport: secure ? 'starttls' : 'off' });
    cleanup(socket.closed);
    await guarded(socket.opened);
    if (secure) {
      socket = socket.startTls({ expectedServerHostname: url.hostname.replace(/^\[|\]$/g, '') });
      cleanup(socket.closed); await guarded(socket.opened);
    }
    writer = socket.writable.getWriter();
    await guarded(writer.write(new TextEncoder().encode(`GET ${url.pathname}${url.search} HTTP/1.1\r\nHost: ${url.host}\r\nUser-Agent: AmadeuStudio/0.5 (public-page-import)\r\nAccept: text/html,application/xhtml+xml\r\nAccept-Encoding: gzip, br, deflate\r\nConnection: close\r\n\r\n`)));
    reader = socket.readable.getReader();
    let size = 0; const chunks = [];
    while (true) {
      const { value, done } = await guarded(reader.read()); if (done) break;
      size += value.byteLength; if (size > 2032768) throw fail('目标页面过大。');
      chunks.push(Buffer.from(value));
    }
    return decodeHTTP(Buffer.concat(chunks));
  } catch (error) {
    if (error.code === 'IMPORT_FAILED' || signal?.aborted) throw error;
    onTransportError?.(error);
    throw fail('免费托管环境无法安全连接该站点；部分代理站点不支持固定 IP 导入。请换一个公开网页，或从需求描述开始。', 502);
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
    try { cleanup(reader?.cancel()); reader?.releaseLock(); } catch {}
    try { cleanup(writer?.abort()); writer?.releaseLock(); } catch {}
    try { cleanup(socket?.close()); } catch {}
  }
}
