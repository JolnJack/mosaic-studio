import { connect as tcpConnect } from 'node:net';
import { connect as secureConnect } from 'node:tls';
import { gunzipSync, inflateSync, brotliDecompressSync } from 'node:zlib';
import { fail, publicUrl, isPublicAddress, importPublicUrl, dohLookup } from './import-source.mjs';

const BODY_LIMIT = 2_000_000, HEADER_LIMIT = 32_768;
function chunked(bytes) {
  let offset = 0, total = 0; const chunks = [];
  while (true) {
    const end = bytes.indexOf('\r\n', offset);
    if (end < 0 || end - offset > 256) throw fail('网页响应格式无效。');
    const line = bytes.subarray(offset, end).toString('ascii');
    if (!/^[0-9a-fA-F]+(?:;[^\r\n]*)?$/.test(line)) throw fail('网页响应格式无效。');
    const length = parseInt(line.split(';')[0], 16); offset = end + 2;
    if (!Number.isSafeInteger(length) || total + length > BODY_LIMIT) throw fail('目标页面过大。');
    if (length === 0) {
      const trailer = bytes.subarray(offset);
      if (trailer.length > HEADER_LIMIT || (trailer.toString() !== '\r\n' && !trailer.toString().endsWith('\r\n\r\n'))) throw fail('网页响应不完整。');
      return Buffer.concat(chunks);
    }
    if (offset + length + 2 > bytes.length || bytes.subarray(offset + length, offset + length + 2).toString() !== '\r\n') throw fail('网页响应不完整。');
    chunks.push(bytes.subarray(offset, offset + length)); total += length; offset += length + 2;
  }
}
/** Bounded HTTP/1.1 parser for one connection. Never follows redirects here. */
export function decodeHTTP(bytes) {
  if (bytes.length > BODY_LIMIT + HEADER_LIMIT) throw fail('目标页面过大。');
  const end = bytes.indexOf('\r\n\r\n');
  if (end < 0 || end > HEADER_LIMIT) throw fail('网页响应头无效或过大。');
  const [first, ...lines] = bytes.subarray(0, end).toString('latin1').split('\r\n');
  const match = /^HTTP\/1\.[01] ([1-5][0-9]{2})(?: .*)?$/.exec(first);
  if (!match) throw fail('网页响应格式无效。');
  const status = Number(match[1]), headers = new Map();
  for (const line of lines) {
    const field = /^([!#$%&'*+.^_`|~\w-]+):[ \t]*([^\r\n]*)$/.exec(line);
    if (!field) throw fail('网页响应头无效。');
    const key = field[1].toLowerCase();
    if (headers.has(key) && ['content-length', 'transfer-encoding', 'content-encoding', 'location', 'content-type'].includes(key)) throw fail('网页响应头不明确。');
    headers.set(key, field[2].trim());
  }
  if ([301, 302, 303, 307, 308].includes(status)) {
    const redirect = headers.get('location');
    if (!redirect || redirect.length > 2048) throw fail('网页重定向无效。');
    return { redirect };
  }
  if (status < 200 || status >= 300) throw fail(`目标网站返回 HTTP ${status}，无法读取。`);
  if (!/^(text\/html|application\/xhtml\+xml)(?:\s*;|$)/i.test(headers.get('content-type') ?? '')) throw fail('目标地址没有返回 HTML 页面。');
  let body = bytes.subarray(end + 4);
  const length = headers.get('content-length'), transfer = headers.get('transfer-encoding');
  if (length !== undefined && transfer !== undefined) throw fail('网页响应长度不明确。');
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) !== body.length)) throw fail('网页响应不完整。');
  if (transfer !== undefined) {
    if (transfer.toLowerCase() !== 'chunked') throw fail('网页传输格式不受支持。');
    body = chunked(body);
  }
  const encoding = (headers.get('content-encoding') ?? 'identity').toLowerCase();
  try {
    if (encoding === 'gzip') body = gunzipSync(body, { maxOutputLength: BODY_LIMIT });
    else if (encoding === 'deflate') body = inflateSync(body, { maxOutputLength: BODY_LIMIT });
    else if (encoding === 'br') body = brotliDecompressSync(body, { maxOutputLength: BODY_LIMIT });
    else if (encoding !== 'identity') throw new Error();
  } catch { throw fail('页面解压失败或解压后过大。'); }
  if (body.length > BODY_LIMIT) throw fail('目标页面过大。');
  return { html: body.toString('utf8') };
}

/** Fixed numeric destination; preserve original Host, SNI and certificate validation. */
export async function pinnedPage(url, address, { signal, tlsConnect = secureConnect, netConnect = tcpConnect, onTransportError } = {}) {
  url = publicUrl(url.href);
  if (!isPublicAddress(address?.address)) throw fail('不能连接本地、内部或保留地址。');
  signal?.throwIfAborted();
  return new Promise((resolvePage, reject) => {
    let socket, settled = false, total = 0; const chunks = [];
    const finish = (error, value) => {
      if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
      socket?.destroy(); error ? reject(error) : resolvePage(value);
    };
    const onAbort = () => finish(signal.reason ?? fail('网页读取已取消。', 499));
    const timer = setTimeout(() => finish(fail('网页读取超时。', 504)), 15_000); timer.unref?.();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const secure = url.protocol === 'https:';
      const opts = { host: address.address, port: Number(url.port) || (secure ? 443 : 80) };
      socket = secure ? tlsConnect({ ...opts, servername: url.hostname.replace(/^\[|\]$/g, ''), rejectUnauthorized: true, minVersion: 'TLSv1.2' }) : netConnect(opts);
      socket.once(secure ? 'secureConnect' : 'connect', () => {
        socket.write(`GET ${url.pathname}${url.search} HTTP/1.1\r\nHost: ${url.host}\r\nUser-Agent: AmadeuStudio/0.5 (public-page-import)\r\nAccept: text/html,application/xhtml+xml\r\nAccept-Encoding: gzip, br, deflate\r\nConnection: close\r\n\r\n`);
      });
      socket.on('data', bytes => {
        total += bytes.length;
        if (total > BODY_LIMIT + HEADER_LIMIT) return finish(fail('目标页面过大。'));
        chunks.push(Buffer.from(bytes));
      });
      socket.once('end', () => { try { finish(null, decodeHTTP(Buffer.concat(chunks))); } catch (error) { finish(error); } });
      socket.on('error', error => { onTransportError?.(error); finish(fail('免费托管环境无法安全连接该站点；部分代理站点不支持固定 IP 导入。请换一个公开网页，或从需求描述开始。', 502)); });
      socket.once('close', () => { if (!settled) finish(fail('网页下载中断。', 502)); });
    } catch (error) { onTransportError?.(error); finish(fail('无法安全连接目标网站。', 502)); }
  });
}
export function importWorkerUrl(value, { signal, onTransportError } = {}) {
  return importPublicUrl(value, { resolver: dohLookup, transport: (url, address, options) => pinnedPage(url, address, { ...options, onTransportError }), signal });
}
