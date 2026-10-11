import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../store.mjs';
import { createApplication } from '../application.mjs';
import { fetchAdapter } from '../fetch-adapter.mjs';

async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'mosaic-fetch-'));
  const store = createStore(dir);
  const app = createApplication({ store, env: { NODE_ENV: 'production', PUBLIC_URL: 'https://app.amadeu.tech', AUTH_CONCURRENCY: '1' }, importer: async () => ({ url: 'https://example.com/', title: 'Imported', text: 'Public source' }), ...options });
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  const fetchApp = fetchAdapter(app.handle);
  const request = (path, method = 'GET', body, cookie, extra = {}) => fetchApp(new Request(`https://app.amadeu.tech${path}`, {
    method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(cookie ? { cookie } : {}), ...extra }, body: body === undefined ? undefined : JSON.stringify(body),
  }), { clientIP: '203.0.113.10' });
  return { request, fetchApp, store };
}
test('Fetch adapter preserves real secure signup, authenticated save, versions and ZIP export', async t => {
  const { request } = await fixture(t);
  const signup = await request('/api/auth/register', 'POST', { email: 'fetch@example.com', password: 'long-password', name: 'Fetch' });
  assert.equal(signup.status, 201); const cookie = signup.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly; SameSite=Lax/); assert.match(cookie, /Secure/);
  assert.equal((await (await request('/api/me', 'GET', undefined, cookie)).json()).user.email, 'fetch@example.com');
  let { project } = await (await request('/api/projects', 'POST', { name: 'Cloud save', brief: 'An independent design studio' }, cookie)).json();
  const first = structuredClone(project);
  const v = await (await request(`/api/projects/${project.id}/versions`, 'POST', { label: 'Initial' }, cookie)).json();
  project.name = 'Saved remotely';
  const saved = await request(`/api/projects/${project.id}`, 'PUT', project, cookie); assert.equal(saved.status, 200);
  project = (await saved.json()).project; assert.equal(project.revision, 2);
  assert.equal((await request(`/api/projects/${project.id}`, 'PUT', first, cookie)).status, 409);
  const restored = await request(`/api/projects/${project.id}/restore`, 'POST', { revision: 2, versionId: v.version.id }, cookie);
  assert.equal((await restored.json()).project.name, 'Cloud save');
  const zip = await request(`/api/projects/${project.id}/export?format=zip-html`, 'GET', undefined, cookie);
  assert.equal(zip.status, 200); assert.equal(zip.headers.get('content-type'), 'application/zip');
  assert.equal(Buffer.from(await zip.arrayBuffer()).subarray(0, 2).toString(), 'PK');
  assert.equal((await request('/api/auth/logout', 'POST', {}, cookie)).status, 200);
  assert.equal((await request('/api/projects', 'GET', undefined, cookie)).status, 401);
});
test('Fetch adapter preserves host, origin, method, body limits and unavailable provider checks', async t => {
  const { request, fetchApp } = await fixture(t);
  assert.equal((await fetchApp(new Request('https://evil.example/api/health'))).status, 400);
  assert.equal((await request('/api/auth/register', 'POST', {}, undefined, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await request('/api/auth/register', 'POST', { email: 'a@example.com', password: 'x'.repeat(9000) })).status, 413);
  assert.equal((await request('/server.mjs')).status, 404);
  const signup = await request('/api/auth/register', 'POST', { email: 'owner@example.com', password: 'long-password' });
  const cookie = signup.headers.get('set-cookie');
  const { project } = await (await request('/api/projects', 'POST', {}, cookie)).json();
  const ai = await request(`/api/projects/${project.id}/generate`, 'POST', { revision: 1 }, cookie);
  assert.equal(ai.status, 503); assert.equal((await ai.json()).code, 'AI_NOT_CONFIGURED');
  const imported = await request('/api/import', 'POST', { url: 'https://example.com' }, cookie); assert.equal(imported.status, 200);
});
test('Fetch adapter aborts external work on client cancellation without an unhandled stream error', async t => {
  let canceled = false;
  const { fetchApp } = await fixture(t, { importer: async (_url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => { canceled = true; reject(signal.reason); }, { once: true })) });
  const signup = await fetchApp(new Request('https://app.amadeu.tech/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'cancel@example.com', password: 'long-password' }) }));
  const controller = new AbortController();
  const work = fetchApp(new Request('https://app.amadeu.tech/api/import', { method: 'POST', signal: controller.signal, headers: { 'content-type': 'application/json', cookie: signup.headers.get('set-cookie') }, body: JSON.stringify({ url: 'https://example.com' }) }));
  setTimeout(() => controller.abort(), 15);
  await assert.rejects(work, /abort/i); assert.equal(canceled, true);
});
