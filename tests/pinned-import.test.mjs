import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { gzipSync } from 'node:zlib';
import { decodeHTTP, pinnedPage } from '../pinned-import.mjs';
const response = (headers, body, status = 200) => Buffer.concat([Buffer.from(`HTTP/1.1 ${status} Status\r\n${headers}\r\n\r\n`), Buffer.from(body)]);
test('Pinned HTTP parser handles lengths, chunking, compression and bounded redirects', () => {
  assert.equal(decodeHTTP(response('Content-Type: text/html\r\nContent-Length: 5', 'hello')).html, 'hello');
  assert.equal(decodeHTTP(response('Content-Type: text/html\r\nTransfer-Encoding: chunked', '5\r\nhello\r\n0\r\n\r\n')).html, 'hello');
  const gz = gzipSync('<h1>Compressed</h1>');
  assert.equal(decodeHTTP(response(`Content-Type: text/html\r\nContent-Encoding: gzip\r\nContent-Length: ${gz.length}`, gz)).html, '<h1>Compressed</h1>');
  assert.deepEqual(decodeHTTP(response('Location: /next\r\nContent-Length: 0', '', 302)), { redirect: '/next' });
});
test('Pinned HTTP parser rejects ambiguous or truncated framing, non-HTML and compression bombs', () => {
  for (const packet of [response('Content-Type: text/html\r\nContent-Length: 6', 'hello'), response('Content-Type: text/html\r\nContent-Length: 5\r\nContent-Length: 5', 'hello'), response('Content-Type: text/html\r\nContent-Length: 5\r\nTransfer-Encoding: chunked', 'hello'), response('Content-Type: text/html\r\nTransfer-Encoding: chunked', '5\r\nhello\r\n'), response('Content-Type: application/json', '{}'), response('X-Long: ' + 'x'.repeat(33000), '')]) assert.throws(() => decodeHTTP(packet), error => error.code === 'IMPORT_FAILED');
  assert.throws(() => decodeHTTP(response('Content-Type: text/html\r\nContent-Encoding: gzip', gzipSync('x'.repeat(2000001)))), error => error.code === 'IMPORT_FAILED');
});
test('Raw transport connects only to validated numeric address with original TLS hostname and host header', async () => {
  let options, sent;
  const socket = new EventEmitter(); socket.destroy = () => {}; socket.write = text => { sent = text; queueMicrotask(() => { socket.emit('data', response('Content-Type: text/html', '<h1>OK</h1>')); socket.emit('end'); }); };
  const result = await pinnedPage(new URL('https://public.example/a?q=1'), { address: '93.184.215.14', family: 4 }, { tlsConnect: opts => { options = opts; queueMicrotask(() => socket.emit('secureConnect')); return socket; } });
  assert.equal(options.host, '93.184.215.14'); assert.equal(options.servername, 'public.example'); assert.equal(options.rejectUnauthorized, true);
  assert.match(sent, /^GET \/a\?q=1 HTTP\/1.1\r\nHost: public.example\r\n/); assert.equal(result.html, '<h1>OK</h1>');
});
test('Raw transport blocks nonpublic addresses before socket creation and cancels on abort', async () => {
  let connected = false;
  await assert.rejects(pinnedPage(new URL('https://public.example/'), { address: '127.0.0.1', family: 4 }, { tlsConnect: () => { connected = true; } })); assert.equal(connected, false);
  const controller = new AbortController(); let destroyed = false;
  const socket = new EventEmitter(); socket.destroy = () => { destroyed = true; }; socket.write = () => {};
  const work = pinnedPage(new URL('https://public.example/'), { address: '93.184.215.14', family: 4 }, { signal: controller.signal, tlsConnect: () => socket });
  controller.abort(); await assert.rejects(work); assert.equal(destroyed, true);
});
