import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stateDir = await mkdtemp(join(tmpdir(), 'mosaic-worker-smoke-'));
const port = 8791, origin = `http://127.0.0.1:${port}`;
let worker;
async function stop() {
  if (!worker || worker.exitCode !== null) return;
  const child = worker; worker = null;
  const exited = new Promise(resolveExit => child.once('exit', resolveExit));
  child.kill('SIGTERM'); await exited;
}
async function start() {
  worker = spawn(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'dev', '--port', String(port), '--local-upstream', `127.0.0.1:${port}`, '--upstream-protocol', 'http', '--persist-to', stateDir, '--var', `PUBLIC_URL:${origin}`, '--var', 'NODE_ENV:development', '--var', 'URL_IMPORT_ENABLED:1'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  worker.stdout.on('data', chunk => { output = (output + chunk.toString()).slice(-12000); });
  worker.stderr.on('data', chunk => { output = (output + chunk.toString()).slice(-12000); });
  for (let i = 0; i < 100; i++) {
    if (worker.exitCode !== null) throw new Error('Local Worker exited before readiness: ' + output);
    try { const r = await fetch(origin + '/api/health', { signal: AbortSignal.timeout(500) }); if (r.ok) return; } catch {}
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  throw new Error('Local Worker did not become ready: ' + output);
}
const call = (path, method = 'GET', body, cookie, headers = {}) => fetch(origin + path, { method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(cookie ? { cookie } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(35000) });
const cookies = response => response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
const credentials = { email: `smoke-${randomUUID()}@example.invalid`, password: randomUUID() + '-safe' };
try {
  await start();
  for (const path of ['/', '/app', '/app.js', '/core.mjs', '/pricing.mjs', '/styles.css']) {
    const asset = await call(path); assert.equal(asset.status, 200, path); assert.match(asset.headers.get('content-security-policy'), /object-src 'none'/);
  }
  for (const path of ['/server.mjs', '/store.mjs', '/.env', '/data/mosaic.sqlite', '/worker.mjs']) assert.equal((await call(path)).status, 404, path);
  assert.equal((await call('/api/projects')).status, 401);
  assert.equal((await call('/api/auth/register', 'POST', {}, undefined, { origin: 'https://evil.example' })).status, 403);
  const registration = await call('/api/auth/register', 'POST', { ...credentials, name: 'Local runtime verification' }); assert.equal(registration.status, 201);
  const cookie = cookies(registration);
  let { project } = await (await call('/api/projects', 'POST', { name: 'Runtime persistence', brief: 'A small independent design studio' }, cookie)).json();
  const id = project.id;
  const snapshot = await (await call(`/api/projects/${id}/versions`, 'POST', { label: 'Initial' }, cookie)).json();
  project.name = 'Runtime saved';
  const save = await call(`/api/projects/${id}`, 'PUT', project, cookie); assert.equal(save.status, 200);
  project = (await save.json()).project; assert.equal(project.revision, 2);
  assert.equal((await call(`/api/projects/${id}`, 'PUT', { ...project, revision: 1 }, cookie)).status, 409);
  const exportFile = await call(`/api/projects/${id}/export?format=zip-html`, 'GET', undefined, cookie);
  assert.equal(exportFile.status, 200); assert.equal(Buffer.from(await exportFile.arrayBuffer()).subarray(0, 2).toString(), 'PK');
  assert.equal((await call(`/api/projects/${id}/generate`, 'POST', { revision: 2 }, cookie)).status, 503);
  assert.equal((await call('/api/billing/checkout', 'POST', { plan: 'pro' }, cookie)).status, 503);
  const other = await call('/api/auth/register', 'POST', { email: `other-${randomUUID()}@example.invalid`, password: randomUUID() + '-safe' }); assert.equal(other.status, 201);
  assert.equal((await call(`/api/projects/${id}`, 'GET', undefined, cookies(other))).status, 404);
  assert.equal((await call('/api/import', 'POST', { url: 'http://127.0.0.1/' }, cookie)).status, 422);
  const imported = await call('/api/import', 'POST', { url: 'https://www.wikipedia.org/' }, cookie);
  const importedBody = await imported.json();
  assert.equal(imported.status, 200); assert.equal(importedBody.source?.title, 'Wikipedia');
  console.log(JSON.stringify({ check: 'external-import', status: imported.status, imported: !!importedBody.source, code: importedBody.code ?? null }));
  for (const url of ['https://self-signed.badssl.com/', 'https://wrong.host.badssl.com/']) {
    const invalidTLS = await call('/api/import', 'POST', { url }, cookie);
    assert.equal(invalidTLS.status, 502); assert.equal((await invalidTLS.json()).code, 'IMPORT_FAILED');
  }
  await stop(); await start();
  const recovered = await call(`/api/projects/${id}`, 'GET', undefined, cookie); assert.equal(recovered.status, 200);
  assert.equal((await recovered.json()).project.name, 'Runtime saved');
  const restored = await call(`/api/projects/${id}/restore`, 'POST', { versionId: snapshot.version.id, revision: 2 }, cookie); assert.equal(restored.status, 200);
  assert.equal((await restored.json()).project.name, 'Runtime persistence');
  assert.equal((await call('/api/auth/logout', 'POST', {}, cookie)).status, 200);
  assert.equal((await call('/api/projects', 'GET', undefined, cookie)).status, 401);
  const login = await call('/api/auth/login', 'POST', credentials); assert.equal(login.status, 200);
  console.log(JSON.stringify({ check: 'local-workerd-runtime', passed: true, checks: ['assets', 'private-source-blocked', 'csrf', 'signup', 'account-isolation', 'save', 'conflict', 'versions', 'zip-export', 'public-page-import', 'tls-certificate-rejection', 'unconfigured-ai-and-billing', 'restart-persistence', 'restore', 'logout', 'login'], stateDir, publicDeployment: false }));
} finally { await stop(); }
