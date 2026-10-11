import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

const module = await import('../worker-admission.mjs').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});
const key = value => createHash('sha256').update(value).digest('hex');
const rateLimited = error => error.status === 429 && Number.isInteger(error.retryAfter) && error.retryAfter > 0;

// Simulate only the DO API boundary. SQLite executes real constraints and
// transactions; no cursor may remain live when another query is issued.
function fixture(t) {
  const native = new DatabaseSync(':memory:');
  native.exec('PRAGMA foreign_keys=ON');
  t.after(() => native.close());
  const queries = [];
  let cursorOpen = false;
  const storage = {
    sql: {
      exec(query, ...bindings) {
        assert.equal(cursorOpen, false, 'consume SQL cursors before the next query');
        assert.doesNotMatch(query, /\b(?:BEGIN|COMMIT|ROLLBACK|SAVEPOINT)\b/i);
        queries.push(query);
        let rows;
        if (query.split(';').filter(part => part.trim()).length > 1) {
          assert.equal(bindings.length, 0);
          native.exec(query);
          rows = [];
        } else rows = native.prepare(query).all(...bindings);
        cursorOpen = true;
        return { toArray() { cursorOpen = false; return rows; } };
      },
    },
    transactionSync(callback) {
      assert.equal(cursorOpen, false);
      native.exec('BEGIN IMMEDIATE');
      try {
        const value = callback();
        assert.equal(cursorOpen, false);
        assert.equal(Boolean(value?.then), false);
        native.exec('COMMIT');
        return value;
      } catch (error) {
        cursorOpen = false;
        native.exec('ROLLBACK');
        throw error;
      }
    },
  };
  let stamp = 1_000_000;
  return { native, storage, queries, now: () => stamp, advance: ms => { stamp += ms; } };
}
function admission(t, options = {}) {
  assert.equal(typeof module.AdmissionCore, 'function', 'AdmissionCore is missing');
  const f = fixture(t);
  return { ...f, core: new module.AdmissionCore(f.storage, f.now, options) };
}
function directory(t, options = {}) {
  assert.equal(typeof module.DirectoryCore, 'function', 'DirectoryCore is missing');
  const f = fixture(t);
  return { ...f, core: new module.DirectoryCore(f.storage, f.now, options) };
}

test('one IP auth gate stops the 31st distinct email and persists across restarts', t => {
  const f = admission(t, { scope: 'ip:fixture' });
  for (let email = 0; email < 30; email++) {
    const reloaded = new module.AdmissionCore(f.storage, f.now, { scope: 'ip:fixture' });
    assert.deepEqual(reloaded.acquire('auth'), {}, `email ${email}@example.test`);
  }
  assert.throws(() => f.core.acquire('auth'), rateLimited);
  f.advance(15 * 60_000 - 1);
  assert.throws(() => f.core.acquire('auth'), rateLimited);
  f.advance(1);
  assert.deepEqual(f.core.acquire('auth'), {});
});

test('signup is capped at five per hour before new-account allocation', t => {
  const f = admission(t);
  const allocated = [];
  const register = account => { f.core.acquire('signup'); allocated.push(account); };
  for (let i = 0; i < 5; i++) register(key(`email-${i}`));
  assert.throws(() => register(key('sixth-email')), rateLimited);
  assert.equal(allocated.length, 5);
  f.advance(60 * 60_000);
  register(key('sixth-email'));
  assert.equal(allocated.length, 6);
});

test('import and AI hourly counters persist independently with thirty admissions each', t => {
  const f = admission(t);
  for (const kind of ['import', 'ai']) {
    for (let i = 0; i < 30; i++) f.core.acquire(kind, { concurrent: false });
    const reloaded = new module.AdmissionCore(f.storage, f.now);
    assert.throws(() => reloaded.acquire(kind, { concurrent: false }), rateLimited);
  }
  f.advance(60 * 60_000);
  assert.deepEqual(f.core.acquire('import', { concurrent: false }), {});
  assert.deepEqual(f.core.acquire('ai', { concurrent: false }), {});
});

test('IP and account scopes sharing storage keep persistent counters separate', t => {
  const f = admission(t, { scope: 'ip:one' });
  const account = new module.AdmissionCore(f.storage, f.now, { scope: 'account:one' });
  for (let i = 0; i < 30; i++) f.core.acquire('auth');
  assert.throws(() => f.core.acquire('auth'), rateLimited);
  assert.deepEqual(account.acquire('auth'), {});
  assert.deepEqual(new module.AdmissionCore(f.storage, f.now, { scope: 'ip:two' }).acquire('auth'), {});
  assert.throws(() => new module.AdmissionCore(f.storage, f.now, { scope: 'ip:one' }).acquire('auth'), rateLimited);
});

test('external concurrency is combined across import and AI and leases survive restarts', t => {
  const f = admission(t);
  const first = f.core.acquire('import').lease, second = f.core.acquire('ai').lease;
  assert.match(first, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first, second);
  const reloaded = new module.AdmissionCore(f.storage, f.now);
  assert.throws(() => reloaded.acquire('import'), rateLimited);
  assert.equal(reloaded.release(first), true);
  assert.equal(reloaded.release(first), false);
  assert.match(reloaded.acquire('import').lease, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(reloaded.release('malformed'), false);
});

test('leases cover body plus model deadlines, expire after ninety seconds and remain scope-owned', t => {
  const f = admission(t, { scope: 'ip:one' });
  const first = f.core.acquire('ai').lease;
  f.core.acquire('import');
  const other = new module.AdmissionCore(f.storage, f.now, { scope: 'ip:two' });
  assert.equal(other.release(first), false);
  assert.throws(() => f.core.acquire('ai'), rateLimited);
  f.advance(70_000);
  assert.throws(() => f.core.acquire('ai'), rateLimited);
  f.advance(19_999);
  assert.throws(() => f.core.acquire('ai'), rateLimited);
  f.advance(1);
  assert.match(f.core.acquire('ai').lease, /^[A-Za-z0-9_-]{43}$/);
});

test('denied concurrency atomically rolls back counter changes', t => {
  const f = admission(t);
  const first = f.core.acquire('import').lease, second = f.core.acquire('import').lease;
  for (let i = 0; i < 35; i++) assert.throws(() => f.core.acquire('import'), rateLimited);
  f.core.release(first); f.core.release(second);
  for (let i = 0; i < 28; i++) f.core.acquire('import', { concurrent: false });
  assert.throws(() => f.core.acquire('import', { concurrent: false }), rateLimited);
});

test('admission cleanup is persistent, throttled, and schedules no timer', t => {
  t.mock.method(globalThis, 'setInterval', () => { throw new Error('no admission timers'); });
  t.mock.method(globalThis, 'setTimeout', () => { throw new Error('no admission timers'); });
  const f = admission(t);
  f.core.acquire('auth'); f.core.acquire('ai');
  assert.equal(f.core.cleanupIfDue(), false);
  f.advance(60_000);
  assert.equal(f.core.cleanupIfDue(), true);
  assert.equal(new module.AdmissionCore(f.storage, f.now).cleanupIfDue(), false);
  assert.equal(f.native.prepare('SELECT COUNT(*) n FROM admission_leases').get().n, 1);
  assert.equal(f.native.prepare('SELECT COUNT(*) n FROM admission_counters').get().n, 2);
  f.advance(60 * 60_000);
  assert.equal(f.core.cleanupIfDue(), true);
  assert.equal(f.native.prepare('SELECT COUNT(*) n FROM admission_counters').get().n, 0);
});

test('admission tables reject unbounded scopes and lease growth without partial admission', t => {
  const f = admission(t, { scope: 'one', maxCounters: 1, maxLeases: 1 });
  const lease = f.core.acquire('import').lease;
  assert.throws(() => f.core.acquire('import'), rateLimited);
  assert.throws(() => new module.AdmissionCore(f.storage, f.now, { scope: 'two', maxCounters: 1, maxLeases: 1 }).acquire('auth'), rateLimited);
  assert.equal(f.native.prepare('SELECT COUNT(*) n FROM admission_counters').get().n, 1);
  assert.equal(f.native.prepare('SELECT COUNT(*) n FROM admission_leases').get().n, 1);
  f.core.release(lease);
  assert.match(f.core.acquire('import').lease, /^[A-Za-z0-9_-]{43}$/);
  assert.throws(() => f.core.acquire('unknown'), error => error.status === 400);
  assert.throws(() => new module.AdmissionCore(f.storage, f.now, { scope: 'x'.repeat(129) }), /scope/i);
});

test('admission rejects non-string kinds without coercion or storage side effects', t => {
  const f = admission(t), before = f.queries.length;
  const coercible = { toString() { throw new Error('must not coerce request input'); } };
  for (const invalid of [null, undefined, ['auth'], coercible, 'x'.repeat(10000)]) {
    assert.throws(() => f.core.acquire(invalid), error => error.status === 400);
  }
  assert.equal(f.queries.length, before);
});

test('directory shards are exactly two hexadecimal characters and routing parsing rejects malformed values', () => {
  assert.equal(typeof module.directoryShard, 'function', 'directoryShard is missing');
  assert.equal(typeof module.routingShard, 'function', 'routingShard is missing');
  const account = key('alice@example.test');
  const token = randomBytes(32).toString('base64url');
  assert.equal(module.directoryShard(account), account.slice(0, 2));
  assert.equal(module.routingShard(`${account}.${token}`), account.slice(0, 2));
  for (const value of [null, {}, '', 'x'.repeat(64), account.toUpperCase(), account + 'a']) assert.equal(module.directoryShard(value), null);
  for (const value of [null, {}, '', account, `${account}.x`, `${account}.${token}.extra`, `${account}.${'x'.repeat(44)}`, `${account}.${'!'.repeat(43)}`, `${account}.${'A'.repeat(42)}B`, 'x'.repeat(10000)]) assert.equal(module.routingShard(value), null);
});

test('unknown accounts and unissued envelopes never authorize account object allocation', t => {
  const f = directory(t), account = key('unknown@example.test');
  const allocated = [];
  const route = envelope => {
    if (module.routingShard(envelope) === null) return null;
    const verified = f.core.verify(envelope);
    if (verified) allocated.push(verified);
    return verified;
  };
  assert.equal(f.core.exists(account), false);
  assert.throws(() => f.core.issue(account), error => error.code === 'ACCOUNT_NOT_REGISTERED');
  assert.equal(route(`${account}.${randomBytes(32).toString('base64url')}`), null);
  const before = f.queries.length;
  assert.equal(route('invalid'), null);
  assert.equal(f.queries.length, before, 'reject malformed input before storage');
  assert.deepEqual(allocated, []);
});

test('registered account and hashed issued envelope persist across re-instantiation', t => {
  const f = directory(t), account = key('alice@example.test');
  assert.equal(f.core.register(account), true);
  assert.equal(f.core.register(account), true);
  const envelope = f.core.issue(account);
  assert.match(envelope, /^[0-9a-f]{64}\.[A-Za-z0-9_-]{43}$/);
  const reloaded = new module.DirectoryCore(f.storage, f.now);
  assert.equal(reloaded.exists(account), true);
  assert.equal(reloaded.verify(envelope), account);
  const rawToken = envelope.split('.')[1];
  const rows = f.native.prepare('SELECT * FROM directory_tokens').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].token_hash, createHash('sha256').update(rawToken).digest('hex'));
  assert.equal(JSON.stringify(rows).includes(rawToken), false);
  assert.equal(f.queries.some(query => query.includes(rawToken)), false);
});

test('directory token substitution and wrong shard envelopes are rejected', t => {
  const first = key('alice@example.test');
  const f = directory(t, { shard: first.slice(0, 2) });
  f.core.register(first);
  const envelope = f.core.issue(first);
  const wrong = (first.startsWith('00') ? '01' : '00') + first.slice(2);
  assert.equal(f.core.exists(wrong), false);
  assert.throws(() => f.core.register(wrong), error => error.status === 400);
  assert.equal(f.core.verify(`${wrong}.${envelope.split('.')[1]}`), null);
  const sameShardOther = first.slice(0, 2) + 'a'.repeat(62);
  f.core.register(sameShardOther);
  assert.equal(f.core.verify(`${sameShardOther}.${envelope.split('.')[1]}`), null);
});

test('directory binds its shard persistently even without constructor shard configuration', t => {
  const f = directory(t), first = '00' + 'a'.repeat(62), other = '01' + 'b'.repeat(62);
  f.core.register(first);
  const reloaded = new module.DirectoryCore(f.storage, f.now);
  assert.throws(() => reloaded.register(other), error => error.status === 400);
  assert.equal(reloaded.exists(other), false);
  assert.throws(() => new module.DirectoryCore(f.storage, f.now, { shard: '01' }), /shard/i);
});

test('directory logout revocation is persistent and leaves other sessions valid', t => {
  const f = directory(t), account = key('alice@example.test');
  f.core.register(account);
  const first = f.core.issue(account), second = f.core.issue(account);
  assert.notEqual(first, second);
  assert.equal(f.core.revoke(first), true);
  assert.equal(f.core.revoke(first), false);
  assert.equal(f.core.revoke('invalid'), false);
  const reloaded = new module.DirectoryCore(f.storage, f.now);
  assert.equal(reloaded.verify(first), null);
  assert.equal(reloaded.verify(second), account);
});

test('directory expiry rejects tokens at the exact boundary and cleanup is throttled across restarts', t => {
  t.mock.method(globalThis, 'setInterval', () => { throw new Error('no directory timers'); });
  const f = directory(t), account = key('alice@example.test');
  f.core.register(account);
  const envelope = f.core.issue(account);
  assert.equal(f.core.cleanupIfDue(), false);
  f.advance(7 * 24 * 60 * 60_000 - 1);
  assert.equal(f.core.verify(envelope), account);
  f.advance(1);
  assert.equal(f.core.verify(envelope), null);
  assert.equal(f.core.cleanupIfDue(), true);
  assert.equal(new module.DirectoryCore(f.storage, f.now).cleanupIfDue(), false);
  assert.equal(f.native.prepare('SELECT COUNT(*) n FROM directory_tokens').get().n, 0);
  assert.equal(f.core.exists(account), true);
});

test('directory validates bounded keys and envelopes without storage or allocation side effects', t => {
  const f = directory(t);
  const before = f.queries.length;
  for (const invalid of [undefined, {}, '', 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64)]) {
    assert.equal(f.core.exists(invalid), false);
    assert.throws(() => f.core.register(invalid), error => error.status === 400);
    assert.throws(() => f.core.issue(invalid), error => error.status === 400);
  }
  for (const invalid of ['invalid', 'x'.repeat(10000), null, {}]) {
    assert.equal(f.core.verify(invalid), null);
    assert.equal(f.core.revoke(invalid), false);
  }
  assert.equal(f.queries.length, before);
  assert.equal(f.native.prepare('SELECT COUNT(*) n FROM directory_accounts').get().n, 0);
});

test('directory reserves finite token capacity before account admission and rotates only that account tokens', t => {
  const first = '00' + 'a'.repeat(62), second = '00' + 'b'.repeat(62);
  const f = directory(t, { maxAccounts: 1, maxTokens: 1 });
  f.core.register(first);
  assert.throws(() => f.core.register(second), rateLimited);
  const envelope = f.core.issue(first);
  const replacement = f.core.issue(first);
  assert.equal(f.core.verify(envelope), null);
  assert.equal(f.core.verify(replacement), first);
  assert.equal(f.native.prepare('SELECT COUNT(*) n FROM directory_accounts').get().n, 1);
  assert.equal(f.native.prepare('SELECT COUNT(*) n FROM directory_tokens').get().n, 1);
  f.core.revoke(envelope);
  assert.equal(f.core.verify(f.core.issue(first)), first);
});

test('bounded routing-token rotation permits repeated authentication across re-instantiation', t => {
  const f = directory(t), account = '00' + 'a'.repeat(62);
  f.core.register(account);
  const envelopes = Array.from({ length: 20 }, () => { f.advance(1); return new module.DirectoryCore(f.storage, f.now).issue(account); });
  const newest = f.core.issue(account);
  assert.equal(f.core.verify(envelopes[0]), null);
  for (const envelope of envelopes.slice(1)) assert.equal(f.core.verify(envelope), account);
  assert.equal(f.core.verify(newest), account);
  assert.equal(f.native.prepare('SELECT COUNT(*) n FROM directory_tokens').get().n, 20);
});
test('directory account admission reserves all per-account token slots before any user can commit', t => {
  const f = directory(t, { maxTokens: 2, maxTokensPerAccount: 2 });
  const a = '00' + 'a'.repeat(62), b = '00' + 'b'.repeat(62); f.core.register(a);
  assert.throws(() => f.core.register(b), rateLimited);
  for (let i = 0; i < 40; i++) assert.equal(f.core.verify(f.core.issue(a)), a);
  assert.equal(f.native.prepare('SELECT COUNT(*) n FROM directory_tokens').get().n, 2);
});
test('successful same-account token replacement is atomic and preserves another account envelope', t => {
  const f = directory(t), a = '00' + 'a'.repeat(62), b = '00' + 'b'.repeat(62);
  f.core.register(a); f.core.register(b);
  const a1 = f.core.issue(a), a2 = f.core.issue(a, a1);
  assert.equal(f.core.verify(a1), null); assert.equal(f.core.verify(a2), a);
  const b1 = f.core.issue(b, a2);
  assert.equal(f.core.verify(a2), a); assert.equal(f.core.verify(b1), b);
  assert.equal(f.native.prepare('SELECT COUNT(*) n FROM directory_tokens').get().n, 2);
});
test('persistent account profile preserves ten auth and twenty import limits across reconstruction', t => {
  const f = admission(t);
  for (let i = 0; i < 10; i++) new module.AdmissionCore(f.storage, f.now).acquire('auth', { profile: 'account' });
  assert.throws(() => new module.AdmissionCore(f.storage, f.now).acquire('auth', { profile: 'account' }), rateLimited);
  for (let i = 0; i < 20; i++) new module.AdmissionCore(f.storage, f.now).acquire('import', { profile: 'account', concurrent: false });
  assert.throws(() => new module.AdmissionCore(f.storage, f.now).acquire('import', { profile: 'account', concurrent: false }), rateLimited);
});

test('separate directory storage objects never accept another shard issued token', t => {
  const first = directory(t), second = directory(t);
  const a = '00' + 'a'.repeat(62), b = '01' + 'b'.repeat(62);
  first.core.register(a); second.core.register(b);
  const envelope = first.core.issue(a);
  assert.equal(second.core.verify(envelope), null);
  assert.equal(second.core.verify(`${b}.${envelope.split('.')[1]}`), null);
  assert.equal(first.core.verify(envelope), a);
});

test('portable cores import no filesystem, SQLite or Cloudflare runtime dependencies', () => {
  assert.equal(typeof module.AdmissionCore, 'function', 'AdmissionCore is missing');
  assert.doesNotMatch(readFileSync(new URL('../worker-admission.mjs', import.meta.url), 'utf8'), /(?:node:(?:sqlite|fs)|cloudflare:)/);
});
