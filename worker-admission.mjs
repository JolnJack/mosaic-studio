import { createHash, randomBytes } from 'node:crypto';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const CLEANUP_MS = MINUTE;
// Covers the 10s body deadline plus the 60s model deadline and response commit.
const LEASE_MS = 90_000;
const ROUTING_MS = 7 * 24 * HOUR;
const ACCOUNT_KEY = /^[0-9a-f]{64}$/;
// A canonical unpadded base64url encoding of exactly 32 random bytes.
const TOKEN = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const SHARD = /^[0-9a-f]{2}$/;

export const ADMISSION_LIMITS = Object.freeze({
  auth: Object.freeze({ limit: 30, windowMs: 15 * MINUTE }),
  signup: Object.freeze({ limit: 5, windowMs: HOUR }),
  import: Object.freeze({ limit: 30, windowMs: HOUR }),
  ai: Object.freeze({ limit: 30, windowMs: HOUR }),
});
export const STORAGE_BOUNDS = Object.freeze({
  maxCounters: 4096, maxLeases: 2048,
  maxAccounts: 4096, maxTokens: 8192, maxTokensPerAccount: 20,
});

const hash = token => createHash('sha256').update(token).digest('hex');
const opaqueToken = () => randomBytes(32).toString('base64url');
const validKey = key => typeof key === 'string' && key.length === 64 && ACCOUNT_KEY.test(key);
const validToken = token => typeof token === 'string' && token.length === 43 && TOKEN.test(token);
const failure = (status, code, message) => Object.assign(new Error(message), { status, code });
const denied = (code, message, retryAfter = 60) => Object.assign(failure(429, code, message), { retryAfter: Math.max(1, Math.ceil(retryAfter)) });
function bound(value, maximum, name) {
  const result = value ?? maximum;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) throw new TypeError(`Invalid ${name} bound`);
  return result;
}
function parseEnvelope(envelope) {
  if (typeof envelope !== 'string' || envelope.length !== 108 || envelope[64] !== '.') return null;
  const key = envelope.slice(0, 64), token = envelope.slice(65);
  return validKey(key) && validToken(token) ? { key, token } : null;
}

/** Wrappers must use ONLY this two-character name for directory lookup. */
export function directoryShard(key) { return validKey(key) ? key.slice(0, 2) : null; }
/** Reject malformed routing before even looking up a bounded directory shard. */
export function routingShard(envelope) { return parseEnvelope(envelope)?.key.slice(0, 2) ?? null; }

class SqlCore {
  constructor(storage, now) {
    if (typeof storage?.sql?.exec !== 'function' || typeof storage?.transactionSync !== 'function') throw new TypeError('SQLite transactional storage is required');
    if (typeof now !== 'function') throw new TypeError('A clock function is required');
    this.storage = storage;
    this.now = now;
  }
  rows(query, ...bindings) { return this.storage.sql.exec(query, ...bindings).toArray(); }
  row(query, ...bindings) { return this.rows(query, ...bindings)[0]; }
  stamp() {
    const stamp = this.now();
    if (!Number.isSafeInteger(stamp) || stamp < 0) throw new TypeError('Invalid clock timestamp');
    return stamp;
  }
}

/**
 * One trusted IP or account scope per instance, or multiple scopes per SQL shard.
 * Windows start on first accepted admission. Email never changes an IP scope.
 * Import/AI acquire a shared external lease by default; pass concurrent:false
 * only when applying an additional counter gate without another external lease.
 */
export class AdmissionCore extends SqlCore {
  constructor(storage, now = Date.now, { scope = 'default', maxCounters, maxLeases } = {}) {
    super(storage, now);
    if (typeof scope !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(scope)) throw new TypeError('Invalid admission scope');
    this.scope = scope;
    this.maxCounters = bound(maxCounters, STORAGE_BOUNDS.maxCounters, 'counter');
    this.maxLeases = bound(maxLeases, STORAGE_BOUNDS.maxLeases, 'lease');
    const stamp = this.stamp();
    storage.transactionSync(() => {
      this.rows(`
        CREATE TABLE IF NOT EXISTS admission_meta (
          id INTEGER PRIMARY KEY CHECK(id=1), last_cleanup INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS admission_counters (
          scope TEXT NOT NULL CHECK(length(scope)<=128),
          kind TEXT NOT NULL CHECK(kind IN ('auth','signup','import','ai')),
          count INTEGER NOT NULL, expires_at INTEGER NOT NULL,
          PRIMARY KEY(scope,kind)
        );
        CREATE INDEX IF NOT EXISTS admission_counters_expiry ON admission_counters(expires_at);
        CREATE TABLE IF NOT EXISTS admission_leases (
          token_hash TEXT PRIMARY KEY, scope TEXT NOT NULL CHECK(length(scope)<=128), expires_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS admission_leases_scope ON admission_leases(scope,expires_at);
        CREATE INDEX IF NOT EXISTS admission_leases_expiry ON admission_leases(expires_at);
      `);
      this.rows('INSERT INTO admission_meta VALUES(1,?) ON CONFLICT(id) DO NOTHING', stamp);
    });
  }

  cleanupInside(stamp) {
    const meta = this.row('SELECT last_cleanup FROM admission_meta WHERE id=1');
    if (stamp - meta.last_cleanup < CLEANUP_MS) return false;
    this.rows('DELETE FROM admission_counters WHERE expires_at<=?', stamp);
    this.rows('DELETE FROM admission_leases WHERE expires_at<=?', stamp);
    this.rows('UPDATE admission_meta SET last_cleanup=? WHERE id=1', stamp);
    return true;
  }

  cleanupIfDue() {
    const stamp = this.stamp();
    return this.storage.transactionSync(() => this.cleanupInside(stamp));
  }

  acquire(kind, { concurrent = kind === 'import' || kind === 'ai', profile = 'ip' } = {}) {
    if (typeof kind !== 'string' || !Object.hasOwn(ADMISSION_LIMITS, kind) || typeof concurrent !== 'boolean' || !['ip', 'account'].includes(profile)) throw failure(400, 'INVALID_ADMISSION', 'Invalid admission kind or concurrency option');
    const { windowMs } = ADMISSION_LIMITS[kind], stamp = this.stamp();
    const limit = profile === 'account' && kind === 'auth' ? 10 : profile === 'account' && kind === 'import' ? 20 : ADMISSION_LIMITS[kind].limit;
    return this.storage.transactionSync(() => {
      this.cleanupInside(stamp);
      const saved = this.row('SELECT count,expires_at FROM admission_counters WHERE scope=? AND kind=?', this.scope, kind);
      const active = saved && saved.expires_at > stamp;
      if (active && saved.count >= limit) throw denied('RATE_LIMITED', 'Admission limit reached', (saved.expires_at - stamp) / 1000);
      if (!saved && this.row('SELECT COUNT(*) n FROM admission_counters').n >= this.maxCounters) throw denied('ADMISSION_CAPACITY', 'Admission storage capacity reached');

      let lease;
      if (concurrent) {
        const leases = this.rows('SELECT expires_at FROM admission_leases WHERE scope=? AND expires_at>? ORDER BY expires_at', this.scope, stamp);
        if (leases.length >= 2) throw denied('EXTERNAL_BUSY', 'External operation capacity reached', (leases[0].expires_at - stamp) / 1000);
        if (this.row('SELECT COUNT(*) n FROM admission_leases').n >= this.maxLeases) throw denied('ADMISSION_CAPACITY', 'Admission storage capacity reached');
        lease = opaqueToken();
        this.rows('INSERT INTO admission_leases VALUES(?,?,?)', hash(lease), this.scope, stamp + LEASE_MS);
      }
      this.rows(`INSERT INTO admission_counters VALUES(?,?,?,?) ON CONFLICT(scope,kind)
        DO UPDATE SET count=excluded.count,expires_at=excluded.expires_at`,
      this.scope, kind, active ? saved.count + 1 : 1, active ? saved.expires_at : stamp + windowMs);
      return lease ? { lease } : {};
    });
  }

  release(lease) {
    if (!validToken(lease)) return false;
    return this.storage.transactionSync(() => this.rows(
      'DELETE FROM admission_leases WHERE token_hash=? AND scope=? RETURNING token_hash', hash(lease), this.scope,
    ).length !== 0);
  }
}

/**
 * Directory stores bounded account-allocation admissions and opaque token hashes.
 * register() reserves capacity BEFORE account creation; it never authenticates a
 * user. issue() is called only after password authentication succeeds.
 * verify() authorizes routing only: account handlers still validate the session.
 * A shard is supplied by the wrapper or bound persistently on first register().
 */
export class DirectoryCore extends SqlCore {
  constructor(storage, now = Date.now, { shard, maxAccounts, maxTokens, maxTokensPerAccount } = {}) {
    super(storage, now);
    if (shard !== undefined && (typeof shard !== 'string' || !SHARD.test(shard))) throw new TypeError('Invalid directory shard');
    this.maxTokens = bound(maxTokens, STORAGE_BOUNDS.maxTokens, 'routing token');
    this.maxTokensPerAccount = Math.min(this.maxTokens, bound(maxTokensPerAccount, STORAGE_BOUNDS.maxTokensPerAccount, 'account token'));
    // Reserve a full bounded session allocation for every admitted account.
    this.maxAccounts = Math.min(bound(maxAccounts, STORAGE_BOUNDS.maxAccounts, 'account'), Math.floor(this.maxTokens / this.maxTokensPerAccount));
    const stamp = this.stamp();
    storage.transactionSync(() => {
      this.rows(`
        CREATE TABLE IF NOT EXISTS directory_meta (
          id INTEGER PRIMARY KEY CHECK(id=1), shard TEXT, last_cleanup INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS directory_accounts (
          account_key TEXT PRIMARY KEY CHECK(length(account_key)=64), registered_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS directory_tokens (
          token_hash TEXT PRIMARY KEY,
          account_key TEXT NOT NULL REFERENCES directory_accounts(account_key) ON DELETE CASCADE,
          issued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS directory_tokens_account ON directory_tokens(account_key,expires_at);
        CREATE INDEX IF NOT EXISTS directory_tokens_expiry ON directory_tokens(expires_at);
      `);
      this.rows('INSERT INTO directory_meta VALUES(1,?,?) ON CONFLICT(id) DO NOTHING', shard ?? null, stamp);
      const saved = this.row('SELECT shard FROM directory_meta WHERE id=1').shard;
      if (shard !== undefined && saved !== null && saved !== shard) throw new TypeError('Directory shard does not match persistent storage');
      if (shard !== undefined && saved === null) this.rows('UPDATE directory_meta SET shard=? WHERE id=1', shard);
    });
  }

  matchesShard(key) {
    const shard = this.row('SELECT shard FROM directory_meta WHERE id=1').shard;
    return shard === null || shard === key.slice(0, 2);
  }

  cleanupInside(stamp) {
    const meta = this.row('SELECT last_cleanup FROM directory_meta WHERE id=1');
    if (stamp - meta.last_cleanup < CLEANUP_MS) return false;
    this.rows('DELETE FROM directory_tokens WHERE expires_at<=?', stamp);
    this.rows('UPDATE directory_meta SET last_cleanup=? WHERE id=1', stamp);
    return true;
  }

  cleanupIfDue() {
    const stamp = this.stamp();
    return this.storage.transactionSync(() => this.cleanupInside(stamp));
  }

  exists(key) {
    if (!validKey(key)) return false;
    return this.matchesShard(key) && Boolean(this.row('SELECT account_key FROM directory_accounts WHERE account_key=?', key));
  }

  register(key) {
    if (!validKey(key)) throw failure(400, 'INVALID_ACCOUNT_KEY', 'Invalid account key');
    const stamp = this.stamp();
    return this.storage.transactionSync(() => {
      if (!this.matchesShard(key)) throw failure(400, 'INVALID_DIRECTORY_SHARD', 'Account key belongs to another directory shard');
      this.cleanupInside(stamp);
      if (this.row('SELECT account_key FROM directory_accounts WHERE account_key=?', key)) return true;
      if (this.row('SELECT COUNT(*) n FROM directory_accounts').n >= this.maxAccounts) throw denied('DIRECTORY_CAPACITY', 'Directory account capacity reached');
      this.rows('INSERT INTO directory_accounts VALUES(?,?)', key, stamp);
      this.rows('UPDATE directory_meta SET shard=? WHERE id=1 AND shard IS NULL', key.slice(0, 2));
      return true;
    });
  }

  issue(key, previousEnvelope) {
    if (!validKey(key)) throw failure(400, 'INVALID_ACCOUNT_KEY', 'Invalid account key');
    const stamp = this.stamp();
    return this.storage.transactionSync(() => {
      if (!this.exists(key)) throw failure(403, 'ACCOUNT_NOT_REGISTERED', 'Account is not registered');
      this.cleanupInside(stamp);
      const previous = parseEnvelope(previousEnvelope);
      if (previous?.key === key) this.rows('DELETE FROM directory_tokens WHERE token_hash=? AND account_key=?', hash(previous.token), key);
      this.rows('DELETE FROM directory_tokens WHERE account_key=? AND expires_at<=?', key, stamp);
      this.rows(`DELETE FROM directory_tokens WHERE token_hash IN (
        SELECT token_hash FROM directory_tokens WHERE account_key=?
        ORDER BY issued_at DESC,token_hash DESC LIMIT -1 OFFSET ?)`, key, this.maxTokensPerAccount - 1);
      if (this.row('SELECT COUNT(*) n FROM directory_tokens').n >= this.maxTokens) throw denied('DIRECTORY_CAPACITY', 'Directory routing capacity reached');
      const token = opaqueToken();
      this.rows('INSERT INTO directory_tokens VALUES(?,?,?,?)', hash(token), key, stamp, stamp + ROUTING_MS);
      return `${key}.${token}`;
    });
  }

  verify(envelope) {
    const parsed = parseEnvelope(envelope);
    if (!parsed) return null;
    const stamp = this.stamp();
    if (!this.matchesShard(parsed.key)) return null;
    const issued = this.row(`SELECT t.account_key FROM directory_tokens t JOIN directory_accounts a
      ON a.account_key=t.account_key WHERE t.token_hash=? AND t.account_key=? AND t.expires_at>?`,
    hash(parsed.token), parsed.key, stamp);
    return issued?.account_key ?? null;
  }

  revoke(envelope) {
    const parsed = parseEnvelope(envelope);
    if (!parsed) return false;
    return this.storage.transactionSync(() => {
      if (!this.matchesShard(parsed.key)) return false;
      return this.rows('DELETE FROM directory_tokens WHERE token_hash=? AND account_key=? RETURNING token_hash',
        hash(parsed.token), parsed.key).length !== 0;
    });
  }
}
