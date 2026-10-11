import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHmac } from 'node:crypto';
import { accountKey, routeAPI, boundedRaw } from '../worker-routing.mjs';
import { createWorkerStore } from '../worker-store.mjs';
import { createApplication } from '../application.mjs';
import { fetchAdapter } from '../fetch-adapter.mjs';
import { AdmissionCore, DirectoryCore } from '../worker-admission.mjs';

function sqlStorage(t) {
  const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys=ON'); t.after(() => db.close());
  return { sql: { exec(sql, ...args) { if (sql.includes('CREATE TABLE')) { db.exec(sql); return { toArray: () => [] }; } const statement = db.prepare(sql); const rows = statement.columns().length ? statement.all(...args) : (statement.run(...args), []); return { toArray: () => rows }; } }, transactionSync(fn) { db.exec('BEGIN'); try { const result = fn(); db.exec('COMMIT'); return result; } catch(e) { db.exec('ROLLBACK'); throw e; } } };
}
const safeRPC = fn => (...args) => { try { return { ok: true, value: fn(...args) }; } catch (e) { return { ok: false, status: e.status, code: e.code, error: e.message, retryAfter: e.retryAfter }; } };

function fixture(t, extraEnv = {}) {
  const accounts = new Map(), env = { NODE_ENV: 'production', PUBLIC_URL: 'https://app.amadeu.tech', AUTH_CONCURRENCY: '1', URL_IMPORT_ENABLED: '1', ...extraEnv };
  const admissions = new Map(), directories = new Map();
  env.MOSAIC_ADMISSION = { getByName(name) { if (!admissions.has(name)) { const core = new AdmissionCore(sqlStorage(t)); admissions.set(name, { acquire: safeRPC(core.acquire.bind(core)), release: core.release.bind(core) }); } return admissions.get(name); } };
  env.MOSAIC_DIRECTORY = { getByName(name) { if (!directories.has(name)) { const core = new DirectoryCore(sqlStorage(t)); directories.set(name, { exists: core.exists.bind(core), register: safeRPC(core.register.bind(core)), issue: safeRPC(core.issue.bind(core)), verify: core.verify.bind(core), revoke: core.revoke.bind(core) }); } return directories.get(name); } };
  env.MOSAIC_DB = { getByName(name) {
    if (!accounts.has(name)) {
      const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys=ON');
      const storage = { sql: { exec(sql, ...args) { if (sql.includes('CREATE TABLE')) { db.exec(sql); return { toArray: () => [] }; } const statement = db.prepare(sql); const rows = statement.columns().length ? statement.all(...args) : (statement.run(...args), []); return { toArray: () => rows }; } }, transactionSync(fn) { db.exec('BEGIN'); try { const result = fn(); db.exec('COMMIT'); return result; } catch(e) { db.exec('ROLLBACK'); throw e; } } };
      const app = createApplication({ store: createWorkerStore(storage, { env, userIdFactory: accountKey }), env, importer: async () => ({ url: 'https://example.com', title: 'Source' }) });
      accounts.set(name, { store: app.store, fetch: fetchAdapter(app.handle), close: async () => { await app.close(); db.close(); } });
    }
    return accounts.get(name);
  } };
  t.after(async () => { for (const app of accounts.values()) await app.close(); });
  const call = (path, method = 'GET', body, cookie, headers = {}) => routeAPI(new Request(env.PUBLIC_URL + path, { method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(cookie ? { cookie } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }), env);
  return { call, env, accounts };
}
const cookies = response => response.headers.getSetCookie().map(x => x.split(';')[0]).join('; ');
test('Account routing cookie is not authorization; separate durable stores and random sessions enforce isolation', async t => {
  const { call, accounts } = fixture(t);
  const a = await call('/api/auth/register', 'POST', { email: 'Owner@Example.com', password: 'long-password' }); assert.equal(a.status, 201);
  const b = await call('/api/auth/register', 'POST', { email: 'other@example.com', password: 'long-password' }); assert.equal(b.status, 201);
  const ac = cookies(a), bc = cookies(b); assert.equal(accounts.size, 2);
  const { project } = await (await call('/api/projects', 'POST', { name: 'Private' }, ac)).json();
  assert.equal((await call(`/api/projects/${project.id}`, 'GET', undefined, bc)).status, 404);
  await assert.rejects(call('/api/projects', 'GET', undefined, 'mosaic_account=' + accountKey('owner@example.com')), e => e.status === 401);
  const swapped = ac.replace(accountKey('owner@example.com'), accountKey('other@example.com'));
  await assert.rejects(call('/api/projects', 'GET', undefined, swapped), e => e.status === 401);
  const loggedIn = await call('/api/auth/login', 'POST', { email: 'owner@example.com', password: 'long-password' }); assert.equal(loggedIn.status, 200); assert.equal(accounts.size, 2);
  assert.equal((await (await call('/api/projects', 'GET', undefined, cookies(loggedIn))).json()).projects[0].name, 'Private');
  const logout = await call('/api/auth/logout', 'POST', {}, cookies(loggedIn)); assert.match(logout.headers.getSetCookie().join('\n'), /mosaic_account=;.*Max-Age=0/);
  await assert.rejects(call('/api/projects', 'GET', undefined, cookies(loggedIn)), e => e.status === 401);
});
test('Anonymous forged routing cookies and nonexistent login emails cannot allocate account databases', async t => {
  const { call, accounts } = fixture(t);
  for (const value of ['a'.repeat(64), 'a'.repeat(64) + '.' + 'A'.repeat(43)]) {
    assert.deepEqual(await (await call('/api/me', 'GET', undefined, 'mosaic_account=' + value)).json(), { user: null, usage: null });
    await assert.rejects(call('/api/projects', 'GET', undefined, 'mosaic_account=' + value + '; mosaic_session=' + 'B'.repeat(43)), e => e.status === 401);
  }
  const login = await call('/api/auth/login', 'POST', { email: 'unknown@example.com', password: 'long-password' }); assert.equal(login.status, 401);
  assert.equal(accounts.size, 0);
});
test('Thirty distinct-email login attempts share the same persistent IP window', async t => {
  const { call, accounts } = fixture(t);
  for (let i = 0; i < 30; i++) assert.equal((await call('/api/auth/login', 'POST', { email: `absent-${i}@example.com`, password: 'long-password' }, undefined, { 'cf-connecting-ip': '203.0.113.99' })).status, 401);
  await assert.rejects(call('/api/auth/login', 'POST', { email: 'absent-31@example.com', password: 'long-password' }, undefined, { 'cf-connecting-ip': '203.0.113.99' }), e => e.status === 429);
  assert.equal(accounts.size, 0);
});
test('directory capacity admission fails before creating an account database and can safely retry', async t => {
  const { call, accounts, env } = fixture(t);
  const directoryBinding = env.MOSAIC_DIRECTORY;
  env.MOSAIC_DIRECTORY = { getByName() { return { register: async () => ({ ok: false, status: 429, code: 'DIRECTORY_CAPACITY', error: 'Full' }) }; } };
  const body = { email: 'capacity@example.com', password: 'long-password' };
  await assert.rejects(call('/api/auth/register', 'POST', body), e => e.code === 'DIRECTORY_CAPACITY');
  assert.equal(accounts.size, 0);
  env.MOSAIC_DIRECTORY = directoryBinding;
  assert.equal((await call('/api/auth/register', 'POST', body)).status, 201);
  assert.equal((await call('/api/auth/login', 'POST', body)).status, 200);
});
test('repeated authentication in one browser does not evict the other browser session', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1780000000000 });
  const { call } = fixture(t), credentials = { email: 'two-browsers@example.com', password: 'long-password' };
  const a = cookies(await call('/api/auth/register', 'POST', credentials));
  let b = cookies(await call('/api/auth/login', 'POST', credentials));
  for (let i = 0; i < 21; i++) {
    t.mock.timers.tick(16 * 60_000); // Respect both persistent and original rate windows.
    const login = await call('/api/auth/login', 'POST', credentials, b);
    assert.equal(login.status, 200); b = cookies(login);
  }
  assert.equal((await (await call('/api/me', 'GET', undefined, a)).json()).user?.email, credentials.email);
  assert.equal((await (await call('/api/me', 'GET', undefined, b)).json()).user?.email, credentials.email);
});
test('Public config and unauthenticated requests allocate no durable database; origin and body checks precede routing', async t => {
  const { call, accounts } = fixture(t);
  assert.equal((await (await call('/api/config')).json()).billingConfigured, false);
  assert.equal((await (await call('/api/plans')).json()).plans.length, 4);
  assert.deepEqual(await (await call('/api/me')).json(), { user: null, usage: null });
  await assert.rejects(call('/api/projects'), e => e.status === 401);
  await assert.rejects(call('/api/auth/register', 'POST', {}, undefined, { origin: 'https://evil.example' }), e => e.status === 403);
  await assert.rejects(call('/api/billing/webhook', 'POST', {}), e => e.code === 'BILLING_NOT_CONFIGURED');
  assert.equal(accounts.size, 0);
});
test('unavailable production URL import is disclosed and fails before external work or quota', async t => {
  const { call } = fixture(t, { URL_IMPORT_ENABLED: '0' });
  assert.equal((await (await call('/api/config')).json()).urlImportConfigured, false);
  const owner = await call('/api/auth/register', 'POST', { email: 'import-disabled@example.com', password: 'long-password' });
  await assert.rejects(call('/api/import', 'POST', { url: 'https://www.wikipedia.org/' }, cookies(owner)), e => e.status === 503 && e.code === 'IMPORT_UNAVAILABLE');
});
test('Oversized auth body without Content-Length rejects promptly and does not hang a cloned body', async t => {
  const { call, accounts } = fixture(t);
  const result = await Promise.race([call('/api/auth/register', 'POST', { email: 'a@example.com', password: 'x'.repeat(9000) }).then(() => 'accepted', e => e.status), new Promise(resolve => setTimeout(() => resolve('hung'), 100))]);
  assert.equal(result, 413); assert.equal(accounts.size, 0);
});

async function promptly(work) {
  let timer;
  try {
    return await Promise.race([work.then(() => 'accepted', error => error.code), new Promise(resolve => { timer = setTimeout(() => resolve('hung'), 100); })]);
  } finally { clearTimeout(timer); }
}
function streamingRequest(body, signal, headers = {}) {
  return new Request('https://app.amadeu.tech/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body, signal, duplex: 'half' });
}
test('Router body deadline stops a stalled read at ten seconds and cancels its source', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let canceled = false;
  const request = streamingRequest(new ReadableStream({ cancel() { canceled = true; } }));
  const result = boundedRaw(request, 8192).then(() => 'accepted', error => error.code);
  t.mock.timers.tick(10_000);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  const actual = await Promise.race([result, Promise.resolve('hung')]);
  assert.equal(actual, 'REQUEST_TIMEOUT');
  assert.equal(canceled, true);
  assert.equal(request.body.locked, false);
});
test('Router body abort stops a pending read even if cancellation never settles', async () => {
  const controller = new AbortController(); let canceled = false;
  const request = streamingRequest(new ReadableStream({ cancel() { canceled = true; return new Promise(() => {}); } }), controller.signal);
  const work = boundedRaw(request, 8192);
  controller.abort();
  assert.equal(await promptly(work), 'REQUEST_ABORTED');
  assert.equal(canceled, true);
  assert.equal(request.body.locked, false);
});
test('Router body rejects an already aborted request before reading', async () => {
  const controller = new AbortController(); controller.abort();
  const request = streamingRequest(new ReadableStream(), controller.signal);
  assert.equal(await promptly(boundedRaw(request, 8192)), 'REQUEST_ABORTED');
  assert.equal(request.body.locked, false);
});
test('Oversized streaming auth body rejects without waiting for cancellation', async t => {
  const { env, accounts } = fixture(t); let canceled = false;
  const request = streamingRequest(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(8193)); }, cancel() { canceled = true; return new Promise(() => {}); } }));
  assert.equal(await promptly(routeAPI(request, env)), 'REQUEST_TOO_LARGE');
  assert.equal(canceled, true); assert.equal(request.body.locked, false); assert.equal(accounts.size, 0);
});
test('Content-Length rejection cancels the body without waiting for cleanup', async () => {
  let canceled = false;
  const request = streamingRequest(new ReadableStream({ cancel() { canceled = true; return new Promise(() => {}); } }), undefined, { 'content-length': '8193' });
  assert.equal(await promptly(boundedRaw(request, 8192)), 'REQUEST_TOO_LARGE');
  assert.equal(canceled, true); assert.equal(request.body.locked, false);
});
test('Router body returns valid bytes and releases its reader', async () => {
  const request = streamingRequest(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{}')); controller.close(); } }));
  assert.equal((await boundedRaw(request, 8192)).toString(), '{}');
  assert.equal(request.body.locked, false);
});
test('Router body preserves the size error when cancellation rejects', async () => {
  const request = streamingRequest(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(8193)); }, cancel() { return Promise.reject(new Error('cleanup failed')); } }));
  await assert.rejects(boundedRaw(request, 8192), error => error.code === 'REQUEST_TOO_LARGE');
  assert.equal(request.body.locked, false);
});

const stripeEnv = { STRIPE_SECRET_KEY: 'sk_test_fixture', STRIPE_WEBHOOK_SECRET: 'fixture-secret', STRIPE_PRICE_PRO: 'price_fixture' };
function stripeEvent(type, object, id = 'evt_fixture') {
  return { id, type, created: Math.floor(Date.now() / 1000), data: { object } };
}
function signedWebhook(env, event, signature) {
  const raw = Buffer.from(JSON.stringify(event)), stamp = Math.floor(Date.now() / 1000);
  const signed = `t=${stamp},v1=${createHmac('sha256', env.STRIPE_WEBHOOK_SECRET).update(`${stamp}.`).update(raw).digest('hex')}`;
  return routeAPI(new Request(env.PUBLIC_URL + '/api/billing/webhook', { method: 'POST', headers: { 'stripe-signature': signature ?? signed, cookie: 'mosaic_account=' + 'a'.repeat(64) }, body: raw }), env);
}
test('Signed unsupported and non-subscription Stripe events acknowledge without lookup or account allocation', async t => {
  const { env, accounts } = fixture(t, stripeEnv);
  t.mock.method(globalThis, 'fetch', async () => { assert.fail('Unrelated event must not fetch Stripe'); });
  const cases = [
    ['customer.created', { id: 'cus_unrelated' }],
    ['product.updated', { id: 'prod_unrelated' }],
    ['checkout.session.completed', { mode: 'payment', customer: 'cus_unrelated', subscription: 'sub_fixture' }],
    ['checkout.session.async_payment_succeeded', { mode: 'payment', customer: 'cus_unrelated' }],
    ['invoice.paid', { customer: 'cus_unrelated' }],
    ['customer.subscription.updated', { id: 'not-a-subscription', customer: 'cus_unrelated' }],
    ['customer.subscription.updated', { id: 'sub_fixture', customer: 'not-a-customer' }],
  ];
  for (const [type, object] of cases) {
    const response = await signedWebhook(env, stripeEvent(type, object));
    assert.equal(response.status, 200, type); assert.deepEqual(await response.json(), { received: true });
  }
  assert.equal(accounts.size, 0);
});
test('Supported Stripe events for unrelated customers acknowledge without allocating a database', async t => {
  const { env, accounts } = fixture(t, stripeEnv);
  let metadata;
  t.mock.method(globalThis, 'fetch', async () => Response.json({ id: 'cus_unrelated', metadata }));
  for (metadata of [undefined, {}, { mosaic_user_id: 'not-a-routing-key' }, { mosaic_user_id: ['a'.repeat(64)] }]) {
    const response = await signedWebhook(env, stripeEvent('customer.subscription.updated', { id: 'sub_fixture', customer: 'cus_unrelated' }));
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), { received: true });
  }
  assert.equal(accounts.size, 0);
});
test('Stripe acknowledgement still requires an exact signature and valid Node event envelope', async t => {
  const { env, accounts } = fixture(t, stripeEnv);
  t.mock.method(globalThis, 'fetch', async () => { assert.fail('Invalid event must not fetch Stripe'); });
  await assert.rejects(signedWebhook(env, stripeEvent('customer.created', { id: 'cus_fixture' }), 'invalid'), error => error.code === 'INVALID_WEBHOOK_SIGNATURE');
  const valid = stripeEvent('customer.subscription.updated', { id: 'sub_fixture', customer: 'cus_fixture' });
  for (const event of [{ ...valid, id: 'invalid' }, { ...valid, id: ['evt_fixture'] }, { ...valid, type: null }, { ...valid, type: 'x'.repeat(151) }, { ...valid, created: -1 }, { ...valid, created: '1' }, { ...valid, data: {} }]) {
    await assert.rejects(signedWebhook(env, event), error => error.code === 'INVALID_WEBHOOK');
  }
  assert.equal(accounts.size, 0);
});
test('All Node-supported subscription event types route exact bytes to the owned account', async t => {
  const { call, env, accounts } = fixture(t, stripeEnv);
  const owner = (await (await call('/api/auth/register', 'POST', { email: 'billing@example.com', password: 'long-password' })).json()).user;
  const store = accounts.get('account:' + owner.id).store; store.setCustomer(owner.id, 'cus_owner');
  t.mock.method(globalThis, 'fetch', async url => {
    if (url.endsWith('/customers/cus_owner')) return Response.json({ id: 'cus_owner', metadata: { mosaic_user_id: owner.id } });
    assert.equal(url, 'https://api.stripe.com/v1/subscriptions/sub_fixture');
    return Response.json({ id: 'sub_fixture', customer: 'cus_owner', status: 'active', current_period_end: Math.floor(Date.now() / 1000) + 86400, items: { data: [{ price: { id: 'price_fixture' }, quantity: 1 }] } });
  });
  const cases = [
    ...['created', 'updated', 'deleted', 'paused', 'resumed'].map(action => [`customer.subscription.${action}`, { id: 'sub_fixture', customer: 'cus_owner' }]),
    ['checkout.session.completed', { mode: 'subscription', subscription: 'sub_fixture', customer: 'cus_owner' }],
    ['checkout.session.async_payment_succeeded', { mode: 'subscription', subscription: { id: 'sub_fixture' }, customer: { id: 'cus_owner' } }],
    ['invoice.paid', { subscription: 'sub_fixture', customer: 'cus_owner' }],
    ['invoice.payment_failed', { parent: { subscription_details: { subscription: { id: 'sub_fixture' } } }, customer: 'cus_owner' }],
  ];
  for (const [index, [type, object]] of cases.entries()) {
    const event = stripeEvent(type, object, `evt_supported${index}`);
    assert.equal((await signedWebhook(env, event)).status, 200, type);
    assert.ok(store.webhookEvent(event.id), type);
    const duplicate = await signedWebhook(env, event); assert.equal((await duplicate.json()).duplicate, true);
  }
  assert.equal(store.plan(owner.id), 'pro'); assert.equal(accounts.size, 1);
});
test('Stripe routing metadata cannot grant a foreign customer access to another account', async t => {
  const { call, env, accounts } = fixture(t, stripeEnv);
  const owner = (await (await call('/api/auth/register', 'POST', { email: 'owned@example.com', password: 'long-password' })).json()).user;
  const store = accounts.get('account:' + owner.id).store; store.setCustomer(owner.id, 'cus_owner');
  t.mock.method(globalThis, 'fetch', async url => {
    assert.equal(url, 'https://api.stripe.com/v1/customers/cus_foreign');
    return Response.json({ id: 'cus_foreign', metadata: { mosaic_user_id: owner.id } });
  });
  const response = await signedWebhook(env, stripeEvent('customer.subscription.updated', { id: 'sub_fixture', customer: 'cus_foreign' }));
  assert.equal(response.status, 200); assert.equal(store.plan(owner.id), 'free'); assert.equal(store.subscription(owner.id), null);
});
test('Stripe customer lookup and actual subscription must match the signed customer', async t => {
  const { call, env, accounts } = fixture(t, stripeEnv);
  const owner = (await (await call('/api/auth/register', 'POST', { email: 'consistent@example.com', password: 'long-password' })).json()).user;
  const store = accounts.get('account:' + owner.id).store; store.setCustomer(owner.id, 'cus_owner');
  let mismatch = true;
  t.mock.method(globalThis, 'fetch', async url => url.includes('/customers/')
    ? Response.json({ id: mismatch ? 'cus_foreign' : 'cus_owner', metadata: { mosaic_user_id: owner.id } })
    : Response.json({ id: 'sub_fixture', customer: 'cus_foreign', status: 'active' }));
  const event = stripeEvent('customer.subscription.updated', { id: 'sub_fixture', customer: 'cus_owner' });
  await assert.rejects(signedWebhook(env, event), error => error.code === 'INVALID_WEBHOOK');
  mismatch = false;
  assert.equal((await signedWebhook(env, event)).status, 502);
  assert.equal(store.plan(owner.id), 'free'); assert.equal(store.webhookEvent(event.id), undefined);
});
