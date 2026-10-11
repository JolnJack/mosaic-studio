import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, createHmac } from 'node:crypto';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBilling } from '../billing.mjs';
import { createStore } from '../store.mjs';
import { seedVariants } from '../core.mjs';

// Report a missing sidecar as an assertion failure, so the initial RED run
// demonstrates the missing factory rather than failing during test discovery.
const workerModule = await import('../worker-store.mjs').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});
const coreModule = await import('../store-core.mjs').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});

// Only the unavailable DO boundary is simulated. Queries, constraints, triggers,
// changes(), migrations and transaction rollback execute in real Node SQLite.
function storageFixture(t) {
  const native = new DatabaseSync(':memory:');
  native.exec('PRAGMA foreign_keys=ON'); // DO storage enforces foreign keys.
  t.after(() => native.close());
  let activeCursor = false;
  const queries = [];
  const storage = {
    sql: {
      exec(query, ...bindings) {
        assert.equal(activeCursor, false, 'consume the previous cursor before the next query');
        assert.doesNotMatch(query, /\b(?:BEGIN|COMMIT|ROLLBACK|SAVEPOINT)\b/i, 'use storage.transactionSync');
        assert.doesNotMatch(query, /PRAGMA\s+(?:journal_mode|busy_timeout|synchronous|foreign_keys)/i, 'no connection-owned PRAGMAs in DO SQL');
        queries.push(query);
        let rows;
        if (query.split(';').filter(part => part.trim()).length > 1) {
          assert.equal(bindings.length, 0);
          native.exec(query);
          rows = [];
        } else {
          rows = native.prepare(query).all(...bindings);
        }
        activeCursor = true;
        let index = 0;
        return {
          get rowsWritten() { throw new Error('rowsWritten is billing metadata, not changes'); },
          next() {
            if (index < rows.length) return { value: rows[index++], done: false };
            activeCursor = false;
            return { value: undefined, done: true };
          },
          toArray() {
            const result = rows.slice(index);
            index = rows.length;
            activeCursor = false;
            return result;
          },
          [Symbol.iterator]() { return this; },
        };
      },
    },
    transactionSync(callback) {
      assert.equal(activeCursor, false);
      native.exec('BEGIN IMMEDIATE');
      try {
        const result = callback();
        assert.equal(activeCursor, false);
        native.exec('COMMIT');
        return result;
      } catch (error) {
        activeCursor = false;
        native.exec('ROLLBACK');
        throw error;
      }
    },
  };
  return { storage, native, queries };
}

function setup(t, env = {}) {
  assert.equal(typeof workerModule.createWorkerStore, 'function', 'createWorkerStore sidecar is missing');
  const fixture = storageFixture(t);
  const store = workerModule.createWorkerStore(fixture.storage, { env });
  t.after(() => store.close());
  return { ...fixture, store };
}

function projectValue(name = 'Original') {
  const variants = seedVariants('A research workspace');
  return { name, brief: 'Keep the full document', source: { url: 'https://example.com/', title: 'Source', text: 'Original text' }, variants, activeVariant: variants[0].id };
}
const user = (store, email = 'user@example.test') => store.createUser(email, 'User', 'stored-password-hash');
const token = () => randomBytes(32).toString('base64url');
const code = expected => error => error.code === expected;
function subscription(owner, overrides = {}) {
  return { id: 'sub_fixture', userId: owner.id, customerId: 'cus_fixture', status: 'active', priceId: 'price_fixture', plan: 'pro', currentPeriodEnd: Math.floor(Date.now() / 1000) + 86400, interval: 'monthly', cancelAtPeriodEnd: false, ...overrides };
}
const event = (id, created) => ({ id, type: 'customer.subscription.updated', created });

test('worker adapter get returns undefined on empty results and consumes nonempty cursors', t => {
  const { store } = setup(t);
  assert.equal(store.userByEmail('missing@example.test'), undefined);
  assert.equal(store.userById('missing'), undefined);
  const first = user(store, 'a@example.test');
  user(store, 'b@example.test');
  assert.equal(store.db.prepare('SELECT * FROM users ORDER BY email').get().id, first.id);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 2);
  assert.equal(store.db.prepare('SELECT * FROM users WHERE id=?').all('missing').length, 0);
});

test('run changes counts direct affected rows, excluding trigger and cascade writes', t => {
  const { store, native, queries } = setup(t);
  const owner = user(store);
  const project = store.createProject(owner.id, projectValue());
  store.createVersion(owner.id, project.id, 'Snapshot');
  native.exec(`CREATE TABLE audit(message TEXT); CREATE TRIGGER audit_user AFTER UPDATE ON users BEGIN INSERT INTO audit VALUES ('one'); INSERT INTO audit VALUES ('two'); END;`);
  assert.equal(store.db.prepare('UPDATE users SET name=? WHERE id=?').run('Updated', owner.id).changes, 1);
  assert.equal(native.prepare('SELECT COUNT(*) n FROM audit').get().n, 2);
  assert.equal(store.db.prepare('UPDATE users SET name=? WHERE id=?').run('Missing', 'absent').changes, 0);
  assert.equal(store.db.prepare('DELETE FROM projects WHERE id=?').run(project.id).changes, 1);
  assert.equal(native.prepare('SELECT COUNT(*) n FROM versions').get().n, 0);
  assert.ok(queries.some(query => /^SELECT changes\(\)/i.test(query)));
});

test('transactionSync returns callback values and rolls back writes on exception', t => {
  const { store } = setup(t);
  assert.equal(store.transaction(() => 42), 42);
  const failure = new Error('rollback fixture');
  assert.throws(() => store.transaction(() => {
    user(store);
    throw failure;
  }), error => error === failure);
  assert.equal(store.userByEmail('user@example.test'), undefined);
  assert.ok(user(store).id);
});

test('transaction callbacks returning a promise cannot commit synchronous writes', t => {
  const { store } = setup(t);
  assert.throws(() => store.transaction(() => {
    user(store);
    return Promise.resolve('invalid async transaction');
  }), /synchronous/i);
  assert.equal(store.userByEmail('user@example.test'), undefined);
});

test('foreign keys reject orphans and user deletion cascades owned records', t => {
  const { store, native } = setup(t);
  assert.throws(() => store.createSession('missing', token(), Date.now() + 10000), /FOREIGN KEY/i);
  const owner = user(store);
  const project = store.createProject(owner.id, projectValue());
  store.createVersion(owner.id, project.id, 'Snapshot');
  store.createSession(owner.id, token(), Date.now() + 10000);
  store.reserveUsage(owner.id, project.id, project.revision);
  store.applyWebhook(event('evt_fk', 1), 'hash', subscription(owner));
  assert.equal(store.db.prepare('DELETE FROM users WHERE id=?').run(owner.id).changes, 1);
  for (const table of ['sessions', 'projects', 'versions', 'usage', 'subscriptions']) {
    assert.equal(native.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 0, table);
  }
});

test('email uniqueness and lookup remain case insensitive', t => {
  const { store } = setup(t);
  const owner = user(store, 'Mixed@Example.test');
  assert.equal(store.userByEmail('mixed@example.TEST').id, owner.id);
  assert.throws(() => user(store, 'MIXED@example.test'), code('EMAIL_EXISTS'));
});

test('sessions retain hashing, expiry, account ownership, revocation and per-account caps', t => {
  const { store, native } = setup(t);
  const owner = user(store), other = user(store, 'other@example.test');
  const first = token(), otherToken = token();
  store.createSession(owner.id, first, Date.now() + 60000);
  store.createSession(other.id, otherToken, Date.now() + 60000);
  assert.equal(store.sessionUser(first).id, owner.id);
  assert.equal(store.sessionUser(otherToken).id, other.id);
  assert.equal(native.prepare('SELECT token_hash FROM sessions WHERE user_id=?').get(owner.id).token_hash, coreModule.hashToken(first));
  assert.equal(store.sessionUser('malformed'), null);
  store.deleteSession(first);
  assert.equal(store.sessionUser(first), null);
  const expired = token();
  store.createSession(owner.id, expired, Date.now() - 1);
  assert.equal(store.sessionUser(expired), null);
  for (let i = 0; i < 25; i++) store.createSession(owner.id, token(), Date.now() + 60000);
  assert.equal(native.prepare('SELECT COUNT(*) n FROM sessions WHERE user_id=?').get(owner.id).n, 20);
  assert.equal(store.sessionUser(otherToken).id, other.id);
});

test('project and version operations enforce ownership before reads and mutations', t => {
  const { store } = setup(t);
  const owner = user(store), other = user(store, 'other@example.test');
  const project = store.createProject(owner.id, projectValue());
  const version = store.createVersion(owner.id, project.id, 'Private');
  assert.deepEqual(store.listProjects(other.id), []);
  for (const operation of [
    () => store.getProject(other.id, project.id),
    () => store.saveProject(other.id, project.id, project, project.revision),
    () => store.deleteProject(other.id, project.id),
    () => store.listVersions(other.id, project.id),
    () => store.createVersion(other.id, project.id, 'Stolen'),
    () => store.restoreProject(other.id, project.id, version.id, project.revision),
    () => store.reserveUsage(other.id, project.id, project.revision),
  ]) assert.throws(operation, code('PROJECT_NOT_FOUND'));
  const second = store.createProject(owner.id, projectValue('Second'));
  assert.throws(() => store.restoreProject(owner.id, second.id, version.id, second.revision), code('VERSION_NOT_FOUND'));
  assert.equal(store.getProject(owner.id, project.id).revision, 1);
});

test('snapshot restoration retains source and complete documents with increasing revisions', t => {
  const { store } = setup(t);
  const owner = user(store), original = store.createProject(owner.id, projectValue());
  const version = store.createVersion(owner.id, original.id, 'Before changes');
  original.variants[0].name = 'Mutated caller object';
  const saved = store.getProject(owner.id, original.id);
  const edited = store.saveProject(owner.id, saved.id, { ...saved, name: 'Edited', brief: 'Changed', source: null }, saved.revision);
  const restored = store.restoreProject(owner.id, saved.id, version.id, edited.revision);
  assert.equal(restored.name, 'Original');
  assert.equal(restored.brief, saved.brief);
  assert.deepEqual(restored.source, saved.source);
  assert.deepEqual(restored.variants, saved.variants);
  assert.equal(restored.activeVariant, saved.activeVariant);
  assert.equal(restored.revision, 3);
  assert.equal(store.listVersions(owner.id, saved.id)[0].label, 'Before changes');
});

test('revision validation rejects stale saves and restores without changing stored data', t => {
  const { store } = setup(t);
  const owner = user(store), project = store.createProject(owner.id, projectValue());
  const version = store.createVersion(owner.id, project.id, 'Original');
  const edited = store.saveProject(owner.id, project.id, { ...project, name: 'Edited' }, 1);
  assert.throws(() => store.saveProject(owner.id, project.id, project, 1), code('REVISION_CONFLICT'));
  assert.throws(() => store.restoreProject(owner.id, project.id, version.id, 1), code('REVISION_CONFLICT'));
  for (const revision of [0, -1, 1.5, '2', NaN]) assert.throws(() => store.saveProject(owner.id, project.id, project, revision), code('INVALID_REVISION'));
  assert.deepEqual(store.getProject(owner.id, project.id), edited);
});

test('project and version caps preserve existing projects for editing', t => {
  const { store } = setup(t);
  const owner = user(store), project = store.createProject(owner.id, projectValue());
  for (let i = 0; i < 100; i++) store.createVersion(owner.id, project.id, `Version ${i}`);
  assert.throws(() => store.createVersion(owner.id, project.id, 'Too many'), code('VERSION_LIMIT'));
  for (let i = 0; i < 2; i++) store.createProject(owner.id, projectValue());
  assert.throws(() => store.createProject(owner.id, projectValue()), code('PROJECT_LIMIT'));
  assert.equal(store.saveProject(owner.id, project.id, { ...project, name: 'Still editable' }, 1).name, 'Still editable');
});

test('quota reservations refund failures and commit only alongside a successful revision save', t => {
  const { store, native } = setup(t, { AI_FREE_LIMIT: '1' });
  const owner = user(store), other = user(store, 'other@example.test');
  const project = store.createProject(owner.id, projectValue());
  const pending = store.reserveUsage(owner.id, project.id, 1);
  assert.deepEqual(store.usage(owner.id), { used: 1, limit: 1 });
  assert.throws(() => store.reserveUsage(owner.id, project.id, 1), code('QUOTA_EXCEEDED'));
  assert.throws(() => store.completeUsage(other.id, project.id, project, 1, pending), code('RESERVATION_EXPIRED'));
  store.releaseUsage(pending);
  assert.equal(store.usage(owner.id).used, 0);
  const stale = store.reserveUsage(owner.id, project.id, 1);
  const edited = store.saveProject(owner.id, project.id, { ...project, name: 'Concurrent edit' }, 1);
  assert.throws(() => store.completeUsage(owner.id, project.id, project, 1, stale), code('REVISION_CONFLICT'));
  assert.equal(native.prepare('SELECT status FROM usage WHERE id=?').get(stale).status, 'pending');
  assert.equal(store.getProject(owner.id, project.id).name, 'Concurrent edit');
  store.releaseUsage(stale);
  const reservation = store.reserveUsage(owner.id, project.id, edited.revision);
  const completed = store.completeUsage(owner.id, project.id, edited, edited.revision, reservation);
  assert.equal(completed.revision, 3);
  store.releaseUsage(reservation);
  assert.equal(store.usage(owner.id).used, 1);
  assert.equal(native.prepare('SELECT status FROM usage WHERE id=?').get(reservation).status, 'committed');
});

test('expired reservations cannot save and do not consume current-period quota', t => {
  const { store, native } = setup(t, { AI_FREE_LIMIT: '1' });
  const owner = user(store), project = store.createProject(owner.id, projectValue());
  const reservation = store.reserveUsage(owner.id, project.id, 1);
  native.prepare('UPDATE usage SET expires_at=? WHERE id=?').run(Date.now() - 1, reservation);
  assert.equal(store.usage(owner.id).used, 0);
  assert.throws(() => store.completeUsage(owner.id, project.id, project, 1, reservation), code('RESERVATION_EXPIRED'));
  const next = store.reserveUsage(owner.id, project.id, 1);
  store.completeUsage(owner.id, project.id, project, 1, next);
  native.prepare('UPDATE usage SET period=? WHERE id=?').run('1999-01', next);
  assert.equal(store.usage(owner.id).used, 0);
});

test('worker cleanup has no timer, is throttled, and preserves committed usage', t => {
  let stamp = Date.now();
  t.mock.method(Date, 'now', () => stamp);
  t.mock.method(globalThis, 'setInterval', () => { throw new Error('worker store must not schedule timers'); });
  const { store, native } = setup(t);
  const owner = user(store), project = store.createProject(owner.id, projectValue());
  const session = token();
  store.createSession(owner.id, session, stamp + 10000);
  const reservation = store.reserveUsage(owner.id, project.id, 1);
  const committed = store.reserveUsage(owner.id, project.id, 1);
  store.completeUsage(owner.id, project.id, project, 1, committed);
  native.prepare('UPDATE usage SET expires_at=? WHERE id=?').run(stamp + 10000, reservation);
  stamp += 20000;
  assert.equal(store.cleanupIfDue(), false);
  assert.equal(native.prepare('SELECT COUNT(*) n FROM sessions').get().n, 1);
  stamp += 40001;
  assert.equal(store.cleanupIfDue(), true);
  assert.equal(store.cleanupIfDue(), false);
  assert.equal(native.prepare('SELECT COUNT(*) n FROM sessions').get().n, 0);
  assert.equal(native.prepare('SELECT COUNT(*) n FROM usage').get().n, 1);
  assert.equal(native.prepare('SELECT status FROM usage').get().status, 'committed');
  store.close();
  store.close();
  assert.equal(native.prepare('SELECT COUNT(*) n FROM users').get().n, 1, 'adapter does not close DO-owned storage');
});

test('subscription entitlement preserves tier priority, interval, cancellation and expiry', t => {
  const { store, native } = setup(t);
  const owner = user(store);
  store.setCustomer(owner.id, 'cus_fixture');
  assert.equal(store.setCustomer(owner.id, 'cus_other'), 'cus_fixture');
  assert.equal(store.userByCustomer('cus_fixture').id, owner.id);
  store.applyWebhook(event('evt_pro', 1), 'hash1', subscription(owner));
  store.applyWebhook(event('evt_business', 2), 'hash2', subscription(owner, { id: 'sub_business', plan: 'business', interval: 'yearly', cancelAtPeriodEnd: true }));
  assert.equal(store.plan(owner.id), 'business');
  assert.equal(store.usage(owner.id).limit, 1500);
  assert.equal(store.subscription(owner.id).interval, 'yearly');
  assert.equal(store.subscription(owner.id).cancelAtPeriodEnd, 1);
  native.exec('UPDATE subscriptions SET current_period_end=0');
  assert.equal(store.plan(owner.id), 'free');
});

test('webhooks remain idempotent, reject changed payloads and resist older or foreign updates', t => {
  const { store } = setup(t);
  const owner = user(store), other = user(store, 'other@example.test');
  const current = subscription(owner);
  assert.equal(store.applyWebhook(event('evt_current', 20), 'payload', current), true);
  assert.equal(store.applyWebhook(event('evt_current', 20), 'payload', current), false);
  assert.throws(() => store.applyWebhook(event('evt_current', 20), 'tampered', current), code('EVENT_MISMATCH'));
  store.applyWebhook(event('evt_old', 10), 'old', { ...current, status: 'canceled' });
  store.applyWebhook(event('evt_foreign', 30), 'foreign', { ...current, userId: other.id, customerId: 'cus_other', status: 'canceled' });
  assert.equal(store.plan(owner.id), 'pro');
  assert.equal(store.plan(other.id), 'free');
  assert.throws(() => store.applyWebhook(event('evt_orphan', 40), 'orphan', { ...current, id: 'sub_orphan', userId: 'missing' }), /FOREIGN KEY/i);
  assert.equal(store.webhookEvent('evt_orphan'), undefined);
  assert.equal(store.applyWebhook(event('evt_cancel', 50), 'cancel', { ...current, status: 'canceled' }), true);
  assert.equal(store.plan(owner.id), 'free');
});

test('billing webhook consumes the worker store with exact-byte signature and deduplication parity', async t => {
  const { store } = setup(t);
  const owner = user(store);
  store.setCustomer(owner.id, 'cus_fixture');
  let calls = 0;
  const env = { STRIPE_SECRET_KEY: 'sk_test_fixture', STRIPE_WEBHOOK_SECRET: 'fixture-secret', STRIPE_PRICE_PRO: 'price_fixture' };
  const billing = createBilling({ store, env, fetchImpl: async () => {
    calls++;
    return Response.json({ id: 'sub_fixture', customer: 'cus_fixture', status: 'active', current_period_end: Math.floor(Date.now() / 1000) + 86400, items: { data: [{ price: { id: 'price_fixture' }, quantity: 1 }] } });
  } });
  const created = Math.floor(Date.now() / 1000);
  const raw = Buffer.from(JSON.stringify({ ...event('evt_billing', created), data: { object: { id: 'sub_fixture', customer: 'cus_fixture' } } }));
  const signature = `t=${created},v1=${createHmac('sha256', env.STRIPE_WEBHOOK_SECRET).update(`${created}.`).update(raw).digest('hex')}`;
  await billing.webhook(raw, signature);
  await billing.webhook(raw, signature);
  assert.equal(store.plan(owner.id), 'pro');
  assert.equal(calls, 1);
  await assert.rejects(billing.webhook(Buffer.from('{}'), signature), code('INVALID_WEBHOOK_SIGNATURE'));
});

test('legacy subscription migration retains existing rows and can initialize repeatedly', t => {
  assert.equal(typeof workerModule.createWorkerStore, 'function', 'createWorkerStore sidecar is missing');
  const { storage, native } = storageFixture(t);
  native.exec(`CREATE TABLE subscriptions(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,customer_id TEXT NOT NULL,status TEXT NOT NULL,price_id TEXT,plan TEXT NOT NULL,current_period_end INTEGER NOT NULL DEFAULT 0,event_created INTEGER NOT NULL,updated_at TEXT NOT NULL); INSERT INTO subscriptions VALUES('sub_old','legacy_user','cus_old','active','price_old','pro',9999999999,1,'2026-01-01');`);
  const store = workerModule.createWorkerStore(storage, { env: {} });
  assert.equal(store.plan('legacy_user'), 'pro');
  assert.equal(store.subscription('legacy_user').interval, null);
  assert.equal(store.subscription('legacy_user').cancelAtPeriodEnd, 0);
  assert.equal(native.prepare('SELECT COUNT(*) n FROM subscriptions').get().n, 1);
  workerModule.createWorkerStore(storage, { env: {} }).close();
  store.close();
  assert.equal(native.prepare('SELECT COUNT(*) n FROM subscriptions').get().n, 1);
});

test('shared core accepts catalog and limit overrides without importing native SQLite', t => {
  assert.equal(typeof coreModule.createStoreCore, 'function', 'createStoreCore extraction is missing');
  const { store, storage } = setup(t);
  store.close();
  const custom = coreModule.createStoreCore(store.db, {
    env: {}, catalog: [{ id: 'free', limit: 9, projectLimit: 2 }], limits: { free: 4 },
    transaction: callback => storage.transactionSync(callback), periodicCleanup: false,
  });
  assert.equal(custom.usage(user(custom).id).limit, 4);
  assert.equal(custom.projectLimits.free, 2);
  custom.close();
  for (const path of ['../store-core.mjs', '../worker-store.mjs', '../plans.mjs']) {
    assert.doesNotMatch(readFileSync(new URL(path, import.meta.url), 'utf8'), /(?:from\s*|import\s*\()['"]node:(?:sqlite|fs)(?:\/promises)?['"]/);
    assert.doesNotMatch(readFileSync(new URL(path, import.meta.url), 'utf8'), /from\s*['"]\.\/store\.mjs['"]/);
  }
});

test('supplied identity factory receives emails and persists IDs in isolated storage objects', t => {
  const first = storageFixture(t), second = storageFixture(t);
  const emails = [];
  const userIdFactory = email => {
    emails.push(email);
    return `account_${coreModule.hashToken(email.toLowerCase())}`;
  };
  const a = workerModule.createWorkerStore(first.storage, { userIdFactory });
  const b = workerModule.createWorkerStore(second.storage, { userIdFactory });
  t.after(() => { a.close(); b.close(); });
  const alice = user(a, 'Alice@example.test'), bob = user(b, 'bob@example.test');
  assert.deepEqual(emails, ['Alice@example.test', 'bob@example.test']);
  assert.equal(alice.id, `account_${coreModule.hashToken('alice@example.test')}`);
  assert.equal(bob.id, `account_${coreModule.hashToken('bob@example.test')}`);
  assert.equal(first.native.prepare('SELECT id FROM users').get().id, alice.id);
  assert.equal(second.native.prepare('SELECT id FROM users').get().id, bob.id);
  assert.equal(a.userById(bob.id), undefined);
  assert.equal(b.userById(alice.id), undefined);
  const project = a.createProject(alice.id, projectValue());
  const session = token();
  a.createSession(alice.id, session, Date.now() + 60000);
  assert.equal(b.sessionUser(session), null);
  assert.deepEqual(b.listProjects(bob.id), []);
  assert.throws(() => b.getProject(bob.id, project.id), code('PROJECT_NOT_FOUND'));
  const reopened = workerModule.createWorkerStore(first.storage, { userIdFactory });
  t.after(() => reopened.close());
  assert.equal(reopened.userByEmail('alice@example.test').id, alice.id);
  assert.equal(reopened.sessionUser(session).id, alice.id);
});

test('default Node identity remains random UUIDs after a worker identity factory is supplied', t => {
  const { storage } = storageFixture(t);
  const worker = workerModule.createWorkerStore(storage, { userIdFactory: () => 'fixed_worker_identity' });
  t.after(() => worker.close());
  user(worker);
  const dir = mkdtempSync(join(tmpdir(), 'mosaic-worker-identity-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const node = createStore(dir);
  t.after(() => node.close());
  const first = user(node), second = user(node, 'other@example.test');
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  assert.match(first.id, uuid);
  assert.match(second.id, uuid);
  assert.notEqual(first.id, second.id);
});

test('billing customer and checkout metadata use the supplied stored identity', async t => {
  const { storage, native } = storageFixture(t);
  const expectedId = 'account_route_hash_fixture';
  const store = workerModule.createWorkerStore(storage, { userIdFactory: () => expectedId });
  t.after(() => store.close());
  const owner = user(store);
  const calls = [];
  const env = { STRIPE_SECRET_KEY: 'sk_test_fixture', STRIPE_WEBHOOK_SECRET: 'fixture-secret', STRIPE_PRICE_PRO: 'price_fixture' };
  const billing = createBilling({ store, env, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    if (url.includes('/prices/')) return Response.json({ id: 'price_fixture', active: true, type: 'recurring', currency: 'usd', recurring: { interval: 'month', interval_count: 1 } });
    if (url.endsWith('/customers')) return Response.json({ id: 'cus_identityfixture' });
    if (url.endsWith('/checkout/sessions')) return Response.json({ url: 'https://checkout.stripe.com/c/pay_fixture' });
    throw new Error('Unexpected billing request');
  } });
  await billing.checkout(owner, 'https://app.amadeu.tech', { plan: 'pro', interval: 'monthly' });
  const customer = calls.find(call => call.url.endsWith('/customers'));
  assert.equal(new URLSearchParams(customer.options.body).get('metadata[mosaic_user_id]'), expectedId);
  assert.equal(customer.options.headers['Idempotency-Key'], `mosaic-customer-${expectedId}`);
  const checkout = calls.find(call => call.url.endsWith('/checkout/sessions'));
  const fields = new URLSearchParams(checkout.options.body);
  assert.equal(fields.get('client_reference_id'), expectedId);
  assert.equal(fields.get('subscription_data[metadata][mosaic_user_id]'), expectedId);
  assert.equal(native.prepare('SELECT id FROM users').get().id, expectedId);
  assert.equal(store.userByCustomer('cus_identityfixture').id, expectedId);
});
