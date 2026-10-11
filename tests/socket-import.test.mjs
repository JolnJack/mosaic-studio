import test from 'node:test';
import assert from 'node:assert/strict';
import { socketPage } from '../socket-import.mjs';
const packet = Buffer.from('HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 11\r\n\r\n<h1>OK</h1>');
test('Worker native socket pins the public IP, verifies original TLS name, and sends original Host', async () => {
  let destination, tlsOptions, sent, closed = 0;
  const secure = { opened: Promise.resolve(), closed: Promise.resolve(), readable: new ReadableStream({ start(c) { c.enqueue(packet); c.close(); } }), writable: new WritableStream({ write(bytes) { sent = Buffer.from(bytes).toString(); } }), close() { closed++; return Promise.resolve(); } };
  const connect = (address, options) => { destination = { address, options }; return { opened: Promise.resolve(), closed: Promise.resolve(), startTls(options) { tlsOptions = options; return secure; }, close: secure.close }; };
  assert.equal((await socketPage(new URL('https://public.example/a?q=1'), { address: '93.184.215.14' }, { connect })).html, '<h1>OK</h1>');
  assert.deepEqual(destination, { address: { hostname: '93.184.215.14', port: 443 }, options: { secureTransport: 'starttls' } });
  assert.deepEqual(tlsOptions, { expectedServerHostname: 'public.example' });
  assert.match(sent, /^GET \/a\?q=1 HTTP\/1.1\r\nHost: public.example\r\n/); assert.ok(closed);
});
test('Worker native socket rejects private IPs before connect and bounds hanging connection', async () => {
  let connected = false, closed = false;
  await assert.rejects(socketPage(new URL('https://public.example/'), { address: '127.0.0.1' }, { connect() { connected = true; } })); assert.equal(connected, false);
  await assert.rejects(socketPage(new URL('https://public.example/'), { address: '93.184.215.14' }, { timeoutMs: 20, connect() { return { opened: new Promise(() => {}), closed: new Promise(() => {}), close() { closed = true; return new Promise(() => {}); } }; } }), e => e.status === 504);
  assert.equal(closed, true);
});
