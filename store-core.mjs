import { randomUUID, createHash } from 'node:crypto';
import { createPlanCatalog } from './plans.mjs';

export function problem(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

export const hashToken = token => createHash('sha256').update(token).digest('hex');
const now = () => new Date().toISOString();
const period = () => now().slice(0, 7);
const quota = (value, fallback) => /^(?:[1-9]\d{0,6})$/.test(String(value ?? '')) ? Number(value) : fallback;

/** Shared synchronous store; the owning runtime supplies transactions and DB lifecycle. */
export function createStoreCore(db, {
  freeLimit, proLimit, studioLimit, businessLimit, env = {}, catalog = createPlanCatalog(env),
  limits: limitOverrides = {}, transaction: transact, periodicCleanup = false,
  userIdFactory = () => randomUUID(),
} = {}) {
  if (typeof transact !== 'function') throw new TypeError('A synchronous transaction adapter is required');
  function transaction(fn) {
    if (fn.constructor?.name === 'AsyncFunction') throw new TypeError('Transaction callbacks must be synchronous');
    return transact(() => {
      const value = fn();
      if (value && typeof value.then === 'function') throw new TypeError('Transaction callbacks must be synchronous');
      return value;
    });
  }
  transaction(() => {
    db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      name TEXT NOT NULL, password_hash TEXT, is_local INTEGER NOT NULL DEFAULT 0,
      stripe_customer_id TEXT UNIQUE, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL, brief TEXT NOT NULL, source TEXT,
      variants TEXT NOT NULL, active_variant TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS projects_owner ON projects(user_id, updated_at);
    CREATE TABLE IF NOT EXISTS versions (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      label TEXT NOT NULL, snapshot TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS versions_project ON versions(project_id, created_at);
    CREATE TABLE IF NOT EXISTS usage (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      period TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','committed')),
      project_id TEXT, revision INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS usage_quota ON usage(user_id, period, status);
    CREATE TABLE IF NOT EXISTS subscriptions (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      customer_id TEXT NOT NULL, status TEXT NOT NULL, price_id TEXT,
      plan TEXT NOT NULL, current_period_end INTEGER NOT NULL DEFAULT 0,
      event_created INTEGER NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS subscriptions_owner ON subscriptions(user_id);
    CREATE TABLE IF NOT EXISTS webhook_events (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, payload_hash TEXT NOT NULL,
      created INTEGER NOT NULL, handled_at TEXT NOT NULL
    );
    `);
    // Additive migration keeps existing databases and legacy subscriptions usable.
    if (!db.prepare('PRAGMA table_info(subscriptions)').all().some(column => column.name === 'interval')) db.exec('ALTER TABLE subscriptions ADD COLUMN interval TEXT');
    if (!db.prepare('PRAGMA table_info(subscriptions)').all().some(column => column.name === 'cancel_at_period_end')) db.exec('ALTER TABLE subscriptions ADD COLUMN cancel_at_period_end INTEGER NOT NULL DEFAULT 0');
  });
  const overrides = { free: freeLimit, pro: proLimit, studio: studioLimit, business: businessLimit, ...limitOverrides };
  const limits = Object.fromEntries(catalog.map(p => [p.id, quota(overrides[p.id], p.limit)]));
  const projectLimits = Object.fromEntries(catalog.map(p => [p.id, p.projectLimit]));
  let closed = false;
  const get = (sql, ...args) => db.prepare(sql).get(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  function plan(userId) {
    return get(`SELECT plan FROM subscriptions WHERE user_id=? AND plan IN ('pro','studio','business')
      AND status IN ('active','trialing') AND current_period_end>?
      ORDER BY CASE plan WHEN 'business' THEN 3 WHEN 'studio' THEN 2 ELSE 1 END DESC LIMIT 1`, userId, Math.floor(Date.now() / 1000))?.plan ?? 'free';
  }
  function publicUser(user) {
    return user ? { id: user.id, email: user.email, name: user.name, plan: plan(user.id) } : null;
  }
  function usage(userId) {
    const used = get(`SELECT COUNT(*) AS n FROM usage WHERE user_id=? AND period=?
      AND (status='committed' OR expires_at>?)`, userId, period(), Date.now()).n;
    return { used, limit: limits[plan(userId)] };
  }
  function project(row) {
    if (!row) throw problem(404, 'PROJECT_NOT_FOUND', 'Project not found');
    return { id: row.id, name: row.name, brief: row.brief,
      source: row.source ? JSON.parse(row.source) : null, variants: JSON.parse(row.variants),
      activeVariant: row.active_variant, revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at };
  }
  function getProject(userId, id) { return project(get('SELECT * FROM projects WHERE id=? AND user_id=?', id, userId)); }
  function checkRevision(saved, revision) {
    if (!Number.isSafeInteger(revision) || revision < 1) throw problem(400, 'INVALID_REVISION', 'A positive integer revision is required');
    if (saved.revision !== revision) throw problem(409, 'REVISION_CONFLICT', 'Project changed; reload before saving');
  }
  function saveProject(userId, id, value, revision) {
    const saved = getProject(userId, id);
    checkRevision(saved, revision);
    const stamp = now();
    const result = run(`UPDATE projects SET name=?,brief=?,source=?,variants=?,active_variant=?,
      revision=revision+1,updated_at=? WHERE id=? AND user_id=? AND revision=?`,
    value.name, value.brief, value.source ? JSON.stringify(value.source) : null,
    JSON.stringify(value.variants), value.activeVariant, stamp, id, userId, revision);
    if (!result.changes) throw problem(409, 'REVISION_CONFLICT', 'Project changed; reload before saving');
    return getProject(userId, id);
  }
  let lastCleanup = -Infinity;
  function cleanup() {
    run('DELETE FROM sessions WHERE expires_at<=?', Date.now());
    run("DELETE FROM usage WHERE status='pending' AND expires_at<=?", Date.now());
    lastCleanup = Date.now();
  }
  // Call at a request boundary in runtimes without background timers. Expiry
  // predicates still protect every session and reservation between cleanups.
  function cleanupIfDue() {
    if (closed || Date.now() - lastCleanup < 60_000) return false;
    transaction(cleanup);
    return true;
  }
  cleanup();
  const cleanupTimer = periodicCleanup ? setInterval(cleanup, 60_000) : null;
  cleanupTimer?.unref();
  return {
    db, limits, projectLimits, transaction, plan, publicUser, usage, getProject, checkRevision, cleanupIfDue,
    subscription(userId) {
      return get(`SELECT status,interval,current_period_end AS currentPeriodEnd,price_id AS priceId,cancel_at_period_end AS cancelAtPeriodEnd FROM subscriptions
        WHERE user_id=? ORDER BY CASE WHEN status IN ('active','trialing') AND current_period_end>?
        THEN CASE plan WHEN 'business' THEN 3 WHEN 'studio' THEN 2 WHEN 'pro' THEN 1 ELSE 0 END ELSE 0 END DESC,
        event_created DESC,updated_at DESC LIMIT 1`, userId, Math.floor(Date.now() / 1000)) ?? null;
    },
    createUser(email, name, passwordHash, isLocal = false) {
      try {
        const id = userIdFactory(email);
        run('INSERT INTO users(id,email,name,password_hash,is_local,created_at) VALUES(?,?,?,?,?,?)', id, email, name, passwordHash, Number(isLocal), now());
        return get('SELECT * FROM users WHERE id=?', id);
      } catch (error) {
        if (String(error.message).includes('UNIQUE')) throw problem(409, 'EMAIL_EXISTS', 'Email already registered');
        throw error;
      }
    },
    userByEmail: email => get('SELECT * FROM users WHERE email=?', email),
    userById: id => get('SELECT * FROM users WHERE id=?', id),
    userByCustomer: id => get('SELECT * FROM users WHERE stripe_customer_id=?', id),
    localUser() {
      return transaction(() => get('SELECT * FROM users WHERE is_local=1 LIMIT 1')
        ?? this.createUser('local@workspace.invalid', 'Local workspace', null, true));
    },
    createSession(userId, token, expiresAt) {
      transaction(() => {
        run('DELETE FROM sessions WHERE expires_at<=?', Date.now());
        // Bound active sessions per account; logging in creates a new random token.
        run(`DELETE FROM sessions WHERE token_hash IN (SELECT token_hash FROM sessions
          WHERE user_id=? ORDER BY created_at DESC LIMIT -1 OFFSET 19)`, userId);
        run('INSERT INTO sessions VALUES(?,?,?,?)', hashToken(token), userId, expiresAt, now());
      });
    },
    sessionUser(token) {
      if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
      return get(`SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id
        WHERE s.token_hash=? AND s.expires_at>?`, hashToken(token), Date.now()) ?? null;
    },
    deleteSession: token => { if (token) run('DELETE FROM sessions WHERE token_hash=?', hashToken(token)); },
    listProjects: userId => all('SELECT * FROM projects WHERE user_id=? ORDER BY updated_at DESC,id', userId).map(project),
    createProject(userId, value) {
      return transaction(() => {
        if (get('SELECT COUNT(*) n FROM projects WHERE user_id=?', userId).n >= projectLimits[plan(userId)]) throw problem(409, 'PROJECT_LIMIT', 'Your plan’s project limit has been reached');
        const id = randomUUID(), stamp = now();
        run(`INSERT INTO projects(id,user_id,name,brief,source,variants,active_variant,revision,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,1,?,?)`, id, userId, value.name, value.brief,
        value.source ? JSON.stringify(value.source) : null, JSON.stringify(value.variants), value.activeVariant, stamp, stamp);
        return getProject(userId, id);
      });
    },
    saveProject: (userId, id, value, revision) => transaction(() => saveProject(userId, id, value, revision)),
    deleteProject(userId, id) {
      return transaction(() => { getProject(userId, id); run('DELETE FROM projects WHERE id=? AND user_id=?', id, userId); });
    },
    listVersions(userId, id) {
      getProject(userId, id);
      return all('SELECT id,label,created_at AS createdAt FROM versions WHERE project_id=? ORDER BY created_at DESC,id', id);
    },
    createVersion(userId, id, label) {
      return transaction(() => {
        const saved = getProject(userId, id);
        if (get('SELECT COUNT(*) n FROM versions WHERE project_id=?', id).n >= 100) throw problem(409, 'VERSION_LIMIT', 'Version storage limit reached');
        const { name, brief, source, variants, activeVariant } = saved;
        const version = { id: randomUUID(), label, createdAt: now() };
        run('INSERT INTO versions VALUES(?,?,?,?,?)', version.id, id, label, JSON.stringify({ name, brief, source, variants, activeVariant }), version.createdAt);
        return version;
      });
    },
    restoreProject(userId, id, versionId, revision) {
      return transaction(() => {
        checkRevision(getProject(userId, id), revision);
        const version = get('SELECT snapshot FROM versions WHERE id=? AND project_id=?', versionId, id);
        if (!version) throw problem(404, 'VERSION_NOT_FOUND', 'Version not found');
        return saveProject(userId, id, JSON.parse(version.snapshot), revision);
      });
    },
    reserveUsage(userId, projectId, revision) {
      return transaction(() => {
        checkRevision(getProject(userId, projectId), revision);
        cleanup();
        const count = usage(userId);
        if (count.used >= count.limit) throw problem(429, 'QUOTA_EXCEEDED', 'Monthly AI quota reached');
        const id = randomUUID();
        run('INSERT INTO usage VALUES(?,?,?,?,?,?,?,?)', id, userId, period(), 'pending', projectId, revision, Date.now() + 300_000, now());
        return id;
      });
    },
    completeUsage(userId, projectId, value, revision, reservation) {
      return transaction(() => {
        const entry = get("SELECT * FROM usage WHERE id=? AND user_id=? AND status='pending' AND expires_at>?", reservation, userId, Date.now());
        if (!entry || entry.project_id !== projectId || entry.revision !== revision) throw problem(409, 'RESERVATION_EXPIRED', 'AI reservation expired; retry');
        const saved = saveProject(userId, projectId, value, revision);
        run("UPDATE usage SET status='committed' WHERE id=?", reservation);
        return saved;
      });
    },
    releaseUsage: id => run("DELETE FROM usage WHERE id=? AND status='pending'", id),
    setCustomer(userId, customerId) {
      run('UPDATE users SET stripe_customer_id=COALESCE(stripe_customer_id,?) WHERE id=?', customerId, userId);
      return get('SELECT stripe_customer_id FROM users WHERE id=?', userId)?.stripe_customer_id;
    },
    webhookEvent: id => get('SELECT * FROM webhook_events WHERE id=?', id),
    applyWebhook(event, payloadHash, subscription) {
      return transaction(() => {
        const previous = get('SELECT * FROM webhook_events WHERE id=?', event.id);
        if (previous) {
          if (previous.payload_hash !== payloadHash) throw problem(400, 'EVENT_MISMATCH', 'Webhook event payload changed');
          return false;
        }
        if (subscription) {
          const s = subscription;
          run(`INSERT INTO subscriptions(id,user_id,customer_id,status,price_id,plan,current_period_end,event_created,updated_at,interval,cancel_at_period_end)
            VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
            status=excluded.status,price_id=excluded.price_id,plan=excluded.plan,
            current_period_end=excluded.current_period_end,event_created=excluded.event_created,updated_at=excluded.updated_at,interval=excluded.interval,cancel_at_period_end=excluded.cancel_at_period_end
            WHERE excluded.event_created>=subscriptions.event_created AND excluded.user_id=subscriptions.user_id
            AND excluded.customer_id=subscriptions.customer_id`, s.id, s.userId, s.customerId, s.status, s.priceId,
          s.plan, s.currentPeriodEnd, event.created, now(), ['monthly','yearly'].includes(s.interval) ? s.interval : null, Number(s.cancelAtPeriodEnd === true));
        }
        run('INSERT INTO webhook_events VALUES(?,?,?,?,?)', event.id, event.type, payloadHash, event.created, now());
        return true;
      });
    },
    close() { if (!closed) { closed = true; if (cleanupTimer !== null) clearInterval(cleanupTimer); db.close(); } },
  };
}
