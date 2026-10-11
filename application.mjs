import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { problem } from './store-core.mjs';
import { createAIProvider, canonicalVariants, canonicalDocument, AI_TIMEOUT_MS } from './ai.mjs';
import { createBilling } from './billing.mjs';
import { seedVariants, validateDocument, renderDocument, renderReact } from './core.mjs';
import { exportArchive } from './export.mjs';

const scrypt = promisify(scryptCallback);
const COOKIE = 'mosaic_session';
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_BODY = 1024 * 1024;
export const STATIC = new Map([
  ['/', ['landing.html', 'text/html; charset=utf-8']],
  ['/app', ['index.html', 'text/html; charset=utf-8']], ['/app/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']], ['/landing.html', ['landing.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']], ['/core.mjs', ['core.mjs', 'text/javascript; charset=utf-8']],
  ['/preview-sizing.mjs', ['preview-sizing.mjs', 'text/javascript; charset=utf-8']],
  ['/plans.mjs', ['plans.mjs', 'text/javascript; charset=utf-8']],
  ['/pricing.mjs', ['pricing.mjs', 'text/javascript; charset=utf-8']],
  ['/landing.mjs', ['landing.mjs', 'text/javascript; charset=utf-8']],
  ['/studio-ui.mjs', ['studio-ui.mjs', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']], ['/landing.css', ['landing.css', 'text/css; charset=utf-8']],
]);

function text(value, field, maximum, { optional = false, fallback = '', nonempty = false } = {}) {
  if (value === undefined && optional) return fallback;
  if (typeof value !== 'string' || value.length > maximum || (nonempty && !value.trim())) throw problem(422, 'VALIDATION_ERROR', `${field} must be ${nonempty ? 'nonempty ' : ''}text of at most ${maximum} characters`);
  return value.trim();
}
function safeURL(value, { absolute = false } = {}) {
  if (typeof value !== 'string' || value.length > 2048) return '';
  if (!absolute && /^(?:#[\w-]*|\/[\w/?.=&%#-]*)$/.test(value) && !value.startsWith('//')) return value;
  try {
    const url = new URL(value);
    if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) return url.href;
    if (!absolute && ['mailto:', 'tel:'].includes(url.protocol)) return url.href;
  } catch {}
  return '';
}
function list(value, field, maximum) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maximum) throw problem(422, 'VALIDATION_ERROR', `${field} must contain at most ${maximum} entries`);
  return value;
}
export function canonicalSource(value) {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw problem(422, 'VALIDATION_ERROR', 'Source must be an object or null');
  const url = safeURL(value.url, { absolute: true });
  if (!url) throw problem(422, 'VALIDATION_ERROR', 'Source URL must be an HTTP or HTTPS address without credentials');
  const source = {
    url, title: text(value.title, 'Source title', 240, { optional: true }),
    description: text(value.description, 'Source description', 1000, { optional: true }),
    text: text(value.text, 'Source text', 24_000, { optional: true }),
    headings: list(value.headings, 'Source headings', 50).map(h => typeof h === 'string'
      ? { level: 'h2', text: text(h, 'Heading', 300) }
      : { level: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(h?.level) ? h.level : 'h2', text: text(h?.text, 'Heading', 300) }),
    links: list(value.links, 'Source links', 50).map(link => ({ text: text(link?.text ?? link?.label ?? '', 'Link text', 160), href: safeURL(link?.href) })).filter(link => link.href),
    images: list(value.images, 'Source images', 25).map(img => typeof img === 'string'
      ? { src: safeURL(img, { absolute: true }), alt: '' }
      : { src: safeURL(img?.src, { absolute: true }), alt: text(img?.alt ?? '', 'Image alt text', 160) }).filter(img => img.src),
  };
  if (value.contentSections !== undefined) source.contentSections = list(value.contentSections, 'Content sections', 12).map(section => ({
    heading: text(section?.heading, 'Section heading', 300), body: text(section?.body, 'Section body', 2000),
  }));
  if (value.navigation !== undefined) source.navigation = list(value.navigation, 'Navigation', 15).map(link => ({
    text: text(link?.text, 'Navigation text', 160), href: safeURL(link?.href),
  })).filter(link => link.href);
  if (typeof value.importedAt === 'string' && value.importedAt.length <= 40 && Number.isFinite(Date.parse(value.importedAt))) source.importedAt = value.importedAt;
  if (value.warnings !== undefined) source.warnings = list(value.warnings, 'Source warnings', 10).map(w => text(w, 'Warning', 400));
  return source;
}
function canonicalProject(value) {
  const variants = list(value.variants, 'Variants', 12);
  if (!variants.length) throw problem(422, 'VALIDATION_ERROR', 'A project needs at least one variant');
  const cleaned = variants.map(variant => {
    if (!variant || typeof variant.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(variant.id)) throw problem(422, 'VALIDATION_ERROR', 'Invalid variant ID');
    if (Buffer.byteLength(JSON.stringify(variant.document) ?? '') > 160 * 1024) throw problem(413, 'DOCUMENT_TOO_LARGE', 'Document exceeds the storage limit');
    let document;
    try { document = validateDocument(variant.document); }
    catch (error) { throw error.status ? error : problem(422, 'INVALID_DOCUMENT', 'Invalid document structure'); }
    return { id: variant.id, name: text(variant.name, 'Variant name', 100, { nonempty: true }), document };
  });
  if (new Set(cleaned.map(v => v.id)).size !== cleaned.length || !cleaned.some(v => v.id === value.activeVariant)) throw problem(422, 'VALIDATION_ERROR', 'Variant IDs must be unique and activeVariant must exist');
  const result = { name: text(value.name, 'Project name', 100, { nonempty: true }),
    brief: text(value.brief, 'Brief', 8000, { optional: true }), source: canonicalSource(value.source), variants: cleaned, activeVariant: value.activeVariant };
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_BODY) throw problem(413, 'PROJECT_TOO_LARGE', 'Project exceeds the storage limit');
  return result;
}

export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const digest = await scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$32768$8$1$${salt}$${digest.toString('hex')}`;
}
export async function verifyPassword(password, encoded) {
  const parts = typeof encoded === 'string' ? encoded.split('$') : [];
  // Fixed work factor; never execute arbitrary stored parameters.
  const valid = parts.length === 6 && parts.slice(0, 4).join('$') === 'scrypt$32768$8$1'
    && /^[0-9a-f]{32}$/.test(parts[4]) && /^[0-9a-f]{128}$/.test(parts[5]);
  const salt = valid ? parts[4] : '00000000000000000000000000000000';
  const expected = valid ? Buffer.from(parts[5], 'hex') : Buffer.alloc(64);
  const actual = await scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return timingSafeEqual(expected, actual) && valid;
}
function credentials(body, registering = false) {
  const email = text(body.email, 'Email', 254, { nonempty: true }).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw problem(422, 'VALIDATION_ERROR', 'A valid email address is required');
  if (registering && email.endsWith('@workspace.invalid')) throw problem(422, 'VALIDATION_ERROR', 'This email domain is reserved for local workspace accounts');
  if (typeof body.password !== 'string' || body.password.length > 128 || body.password.length < (registering ? 8 : 1)) throw problem(422, 'VALIDATION_ERROR', 'Password must contain 8–128 characters');
  return { email, password: body.password };
}
function sessionToken(req) {
  const tokens = String(req.headers.cookie ?? '').split(';').map(item => item.trim()).filter(item => item.startsWith(`${COOKIE}=`));
  return tokens.length === 1 ? tokens[0].slice(COOKIE.length + 1) : null;
}
const loopback = address => address === '::1' || /^(?:::ffff:)?127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(address ?? '');
const loopbackHost = hostname => ['localhost', '[::1]'].includes(hostname) || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);

function limiter() {
  const entries = new Map();
  return (key, limit, windowMs) => {
    const stamp = Date.now();
    if (entries.size >= 10_000) {
      for (const [id, entry] of entries) if (entry.until <= stamp) entries.delete(id);
      if (entries.size >= 10_000 && !entries.has(key)) throw problem(429, 'RATE_LIMITED', 'Too many requests; retry later');
    }
    let entry = entries.get(key);
    if (!entry || entry.until <= stamp) { entry = { count: 0, until: stamp + windowMs }; entries.set(key, entry); }
    if (++entry.count > limit) throw Object.assign(problem(429, 'RATE_LIMITED', 'Too many requests; retry later'), { retryAfter: Math.ceil((entry.until - stamp) / 1000) });
  };
}
function readBody(req, res, maximum = MAX_BODY) {
  return new Promise((resolveBody, reject) => {
    let total = 0, finished = false;
    const chunks = [];
    const timer = setTimeout(() => finish(problem(408, 'REQUEST_TIMEOUT', 'Request body timed out')), 10_000);
    timer.unref();
    const onData = chunk => { total += chunk.length; if (total > maximum) finish(problem(413, 'REQUEST_TOO_LARGE', 'Request body exceeds the limit')); else chunks.push(chunk); };
    const onEnd = () => finish(null, Buffer.concat(chunks));
    const onAbort = () => finish(problem(400, 'REQUEST_ABORTED', 'Request was interrupted'));
    function finish(error, result) {
      if (finished) return;
      finished = true; clearTimeout(timer);
      req.off('data', onData); req.off('end', onEnd); req.off('aborted', onAbort); req.off('error', onAbort);
      if (error) {
        if (!res.headersSent) res.setHeader('Connection', 'close');
        req.resume(); reject(error);
      } else resolveBody(result);
    }
    req.on('data', onData); req.on('end', onEnd); req.on('aborted', onAbort); req.on('error', onAbort);
    if (Number(req.headers['content-length']) > maximum) finish(problem(413, 'REQUEST_TOO_LARGE', 'Request body exceeds the limit'));
  });
}
async function readJSON(req, res, maximum) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) throw problem(415, 'UNSUPPORTED_MEDIA_TYPE', 'Use application/json');
  const raw = await readBody(req, res, maximum);
  let value;
  try { value = raw.length ? JSON.parse(raw.toString('utf8')) : {}; }
  catch { throw problem(400, 'INVALID_JSON', 'Invalid JSON request'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw problem(400, 'INVALID_JSON', 'Request must be a JSON object');
  return value;
}

export function documentSecurityPolicy() {
  const scripts = [...renderDocument(seedVariants('')[0].document, { editing: true }).matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map(match => `'sha256-${createHash('sha256').update(match[1]).digest('base64')}'`).join(' ');
  return `default-src 'self'; script-src 'self' ${scripts}; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https: http:; connect-src 'self'; frame-src 'self' blob:; frame-ancestors 'self'; object-src 'none'; base-uri 'none'; form-action 'self'`;
}
/** Shared API; no listening socket or disk assumption. close() is idempotent. */
export function createApplication({ store, env = {}, aiProvider, importer, assetLoader, getServerAddress = () => null } = {}) {
  // Capture configuration now; one test/app cannot mutate another app's configuration.
  env = { ...env };
  if (!store) throw new TypeError('A persistent store is required');
  const ai = aiProvider ?? createAIProvider(env);
  const aiConfigured = aiProvider ? Boolean(typeof ai.generate === 'function' || typeof ai.edit === 'function') : ai.configured;
  const importFunction = typeof importer === 'function' ? importer : importer?.importUrl?.bind(importer);
  if (!importFunction) { store.close(); throw new TypeError('importer must be an async function or expose importUrl'); }
  const billing = createBilling({ store, env });
  const localMode = env.LOCAL_WORKSPACE === '1' && env.NODE_ENV !== 'production';
  const registrationEnabled = !['0', 'false'].includes(String(env.REGISTRATION_ENABLED ?? '1').toLowerCase());
  let publicOrigin;
  if (env.PUBLIC_URL || env.APP_ORIGIN || env.APP_URL) {
    try {
      const parsed = new URL(env.PUBLIC_URL || env.APP_ORIGIN || env.APP_URL);
      if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') throw new Error();
      publicOrigin = parsed.origin;
    } catch { store.close(); throw new TypeError('PUBLIC_URL/APP_ORIGIN/APP_URL must be an HTTP(S) origin without path or credentials'); }
  }
  const shutdown = new AbortController();
  const pending = new Set();
  const throttle = limiter();
  let authInFlight = 0, externalInFlight = 0, webhookInFlight = 0;
  // The fixed trusted editing bridge is allowed in srcdoc; arbitrary inline scripts are not.
  const csp = documentSecurityPolicy();

  function json(res, value, status = 200) {
    if (res.destroyed || res.writableEnded) return;
    const output = JSON.stringify(value);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(output), 'Cache-Control': 'no-store' });
    res.end(output);
  }
  function requestOrigin(req) {
    const host = req.headers.host;
    if (typeof host !== 'string' || host.length > 255 || /[\s@/\\?#]/.test(host)) throw problem(400, 'INVALID_HOST', 'Invalid request host');
    let parsed;
    try { parsed = new URL(`${req.socket.encrypted ? 'https' : 'http'}://${host}`); }
    catch { throw problem(400, 'INVALID_HOST', 'Invalid request host'); }
    if (publicOrigin) {
      if (parsed.host !== new URL(publicOrigin).host) throw problem(400, 'INVALID_HOST', 'Unexpected request host');
      return publicOrigin;
    }
    const address = getServerAddress();
    if (address && typeof address === 'object' && loopback(address.address) && !loopbackHost(parsed.hostname)) throw problem(400, 'INVALID_HOST', 'Loopback server requires a loopback host');
    return parsed.origin;
  }
  function protectOrigin(req, expected) {
    if (req.headers['sec-fetch-site'] === 'cross-site' || (req.headers.origin !== undefined && req.headers.origin !== expected)) throw problem(403, 'ORIGIN_FORBIDDEN', 'Cross-origin request rejected');
    // Non-browser clients without Origin are supported. Mutations require JSON,
    // which browsers cannot submit cross-origin without an unsuccessful preflight.
  }
  function cookie(res, token, origin, expires = false) {
    const secure = env.NODE_ENV === 'production' || origin.startsWith('https:');
    res.setHeader('Set-Cookie', `${COOKIE}=${expires ? '' : token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${expires ? 0 : SESSION_MS / 1000}${secure ? '; Secure' : ''}`);
  }
  function localAllowed(req, origin) {
    return localMode && loopback(req.socket.remoteAddress) && loopbackHost(new URL(origin).hostname)
      && !req.headers.forwarded && !req.headers['x-forwarded-for'] && !req.headers['x-forwarded-host'];
  }
  function currentUser(req, origin) {
    const user = store.sessionUser(sessionToken(req));
    // A development token is not a remote/production authentication credential.
    return user?.is_local && !localAllowed(req, origin) ? null : user;
  }
  function authenticate(req) {
    const user = currentUser(req, requestOrigin(req));
    if (!user) throw problem(401, 'AUTH_REQUIRED', 'Sign in to continue');
    return user;
  }
  function login(req, res, user, origin) {
    const token = randomBytes(32).toString('base64url');
    store.deleteSession(sessionToken(req));
    store.createSession(user.id, token, Date.now() + SESSION_MS);
    cookie(res, token, origin);
    return { user: store.publicUser(user), usage: store.usage(user.id) };
  }
  async function deadline(fn, duration, code, res) {
    const controller = new AbortController();
    const onClose = () => { if (!res.writableEnded) controller.abort(problem(499, 'REQUEST_ABORTED', 'Request canceled')); };
    const onShutdown = () => controller.abort(problem(503, 'SHUTTING_DOWN', 'Server is shutting down'));
    res.on('close', onClose); shutdown.signal.addEventListener('abort', onShutdown, { once: true });
    const timer = setTimeout(() => controller.abort(problem(504, code, 'External service timed out')), duration);
    timer.unref();
    let rejectAbort;
    const aborted = new Promise((_, reject) => { rejectAbort = () => reject(controller.signal.reason); controller.signal.addEventListener('abort', rejectAbort, { once: true }); });
    try {
      if (shutdown.signal.aborted) onShutdown();
      if (res.destroyed) onClose();
      if (controller.signal.aborted) throw controller.signal.reason;
      return await Promise.race([Promise.resolve().then(() => fn(controller.signal)), aborted]);
    } finally {
      clearTimeout(timer); res.off('close', onClose); shutdown.signal.removeEventListener('abort', onShutdown);
      controller.signal.removeEventListener('abort', rejectAbort);
    }
  }
  async function external(fn) {
    if (externalInFlight >= 16) throw problem(429, 'SERVER_BUSY', 'External service capacity reached; retry later');
    externalInFlight++;
    try { return await fn(); } finally { externalInFlight--; }
  }
  async function runAI(req, res, user, id, kind) {
    throttle(`ai:${user.id}`, 30, 60 * 60 * 1000);
    throttle(`ai-ip:${req.socket.remoteAddress}`, 100, 60 * 60 * 1000);
    if (!aiConfigured || typeof ai[kind] !== 'function') throw problem(503, 'AI_NOT_CONFIGURED', 'AI generation is not configured');
    const body = await readJSON(req, res, kind === 'generate' ? 128 * 1024 : 16 * 1024);
    const saved = store.getProject(user.id, id);
    store.checkRevision(saved, body.revision);
    let brief, source, instruction, selected;
    if (kind === 'generate') {
      brief = text(body.brief, 'Brief', 8000, { optional: true, fallback: saved.brief });
      source = body.source === undefined ? saved.source : canonicalSource(body.source);
    } else {
      instruction = text(body.instruction, 'Instruction', 4000, { nonempty: true });
      selected = saved.variants.find(v => v.id === (body.variantId ?? saved.activeVariant));
      if (!selected) throw problem(422, 'INVALID_VARIANT', 'Variant not found');
    }
    return external(async () => {
      const reservation = store.reserveUsage(user.id, id, body.revision);
      try {
        const result = await deadline(signal => kind === 'generate'
          ? ai.generate(brief, structuredClone(source), { signal })
          : ai.edit(structuredClone(selected.document), instruction, { signal }), AI_TIMEOUT_MS, 'AI_TIMEOUT', res);
        const value = kind === 'generate'
          ? { ...saved, brief, source, variants: canonicalVariants(result) }
          : { ...saved, variants: saved.variants.map(v => v.id === selected.id ? { ...v, document: canonicalDocument(result) } : v) };
        if (kind === 'generate' && !value.variants.some(v => v.id === value.activeVariant)) value.activeVariant = value.variants[0].id;
        const canonical = canonicalProject(value);
        if (res.destroyed || shutdown.signal.aborted) throw problem(499, 'REQUEST_ABORTED', 'Request canceled');
        const project = store.completeUsage(user.id, id, canonical, body.revision, reservation);
        return kind === 'generate' ? { project } : { project, message: 'The selected design has been updated.' };
      } catch (error) {
        store.releaseUsage(reservation);
        if (error.status) throw error;
        throw problem(502, 'AI_PROVIDER_ERROR', 'AI provider failed to produce a valid result');
      }
    });
  }

  async function handle(req, res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', csp);
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Cache-Control', 'no-store');
    const origin = requestOrigin(req);
    if (!req.url?.startsWith('/') || req.url.startsWith('//') || req.url.length > 8192) throw problem(400, 'INVALID_URL', 'Invalid request URL');
    const url = new URL(req.url, origin), path = url.pathname, method = req.method;
    const ip = req.socket.remoteAddress ?? 'unknown';
    if (path === '/api/health' && method === 'GET') return json(res, { ok: true });
    if (path === '/api/config' && method === 'GET') return json(res, { aiConfigured, providerType: ai.providerType || 'compatible', aiProviderType: ai.providerType || 'compatible', billingConfigured: billing.configured, registrationEnabled, localMode });
    if (path === '/api/plans' && method === 'GET') return json(res, billing.catalog());
    if (path === '/api/me' && method === 'GET') {
      const user = currentUser(req, origin);
      return json(res, { user: store.publicUser(user), usage: user ? store.usage(user.id) : null });
    }
    if (path === '/api/billing/webhook' && method === 'POST') {
      if (!billing.configured) throw problem(503, 'BILLING_NOT_CONFIGURED', 'Stripe webhooks are not configured');
      if (webhookInFlight >= 8) throw problem(503, 'SERVER_BUSY', 'Webhook capacity reached; Stripe should retry');
      webhookInFlight++;
      try {
        const raw = await readBody(req, res, 256 * 1024);
        return json(res, await deadline(signal => billing.webhook(raw, req.headers['stripe-signature'], { signal }), 20_000, 'STRIPE_TIMEOUT', res));
      } finally { webhookInFlight--; }
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) protectOrigin(req, origin);
    if (path.startsWith('/api/auth/') && method === 'POST') {
      throttle(`auth-ip:${ip}`, 30, 15 * 60 * 1000);
      const body = await readJSON(req, res, 8 * 1024);
      if (path === '/api/auth/logout') {
        store.deleteSession(sessionToken(req)); cookie(res, '', origin, true); return json(res, { ok: true });
      }
      if (path === '/api/auth/local') {
        if (!localAllowed(req, origin)) throw problem(403, 'LOCAL_MODE_DISABLED', 'Local workspace sessions are only available directly on loopback in explicit development mode');
        return json(res, login(req, res, store.localUser(), origin));
      }
      if (!['/api/auth/register', '/api/auth/login'].includes(path)) throw problem(404, 'NOT_FOUND', 'Endpoint not found');
      const authLimit = env.AUTH_CONCURRENCY === '1' ? 1 : 4;
      if (authInFlight >= authLimit) throw problem(429, 'SERVER_BUSY', 'Authentication capacity reached; retry later');
      authInFlight++;
      try {
        const registering = path.endsWith('/register');
        if (registering && !registrationEnabled) throw problem(403, 'REGISTRATION_DISABLED', 'Registration is disabled');
        const { email, password } = credentials(body, registering);
        throttle(`auth-account:${createHash('sha256').update(email).digest('hex')}`, 10, 15 * 60 * 1000);
        let user;
        if (registering) {
          const name = text(body.name, 'Name', 80, { optional: true, fallback: email.split('@')[0].slice(0, 80), nonempty: true });
          user = store.createUser(email, name, await hashPassword(password));
        } else {
          user = store.userByEmail(email);
          const valid = await verifyPassword(password, user?.password_hash);
          if (!valid || !user || user.is_local) throw problem(401, 'INVALID_CREDENTIALS', 'Incorrect email or password');
        }
        return json(res, login(req, res, user, origin), registering ? 201 : 200);
      } finally { authInFlight--; }
    }
    if (path.startsWith('/api/')) {
      const user = authenticate(req);
      if (path === '/api/projects' && method === 'GET') return json(res, { projects: store.listProjects(user.id) });
      if (path === '/api/projects' && method === 'POST') {
        const body = await readJSON(req, res, 16 * 1024);
        const brief = text(body.brief, 'Brief', 8000, { optional: true });
        const variants = seedVariants(brief, null);
        const value = canonicalProject({ name: text(body.name, 'Project name', 100, { optional: true, fallback: 'Untitled project', nonempty: true }), brief, source: null, variants, activeVariant: variants[0].id });
        return json(res, { project: store.createProject(user.id, value) }, 201);
      }
      if (path === '/api/import' && method === 'POST') {
        throttle(`import:${user.id}`, 20, 60 * 60 * 1000); throttle(`import-ip:${ip}`, 60, 60 * 60 * 1000);
        const body = await readJSON(req, res, 8 * 1024);
        const target = text(body.url, 'URL', 2048, { nonempty: true });
        if (!safeURL(target, { absolute: true })) throw problem(422, 'INVALID_URL', 'Import requires an HTTP or HTTPS URL without credentials');
        const source = await external(() => deadline(signal => importFunction(target, { signal }), 30_000, 'IMPORT_TIMEOUT', res));
        return json(res, { source: canonicalSource(source) });
      }
      if (path === '/api/billing' && method === 'GET') return json(res, billing.info(user.id));
      if (path === '/api/billing/checkout' && method === 'POST') {
        throttle(`billing:${user.id}`, 10, 60 * 60 * 1000);
        const body = await readJSON(req, res, 8 * 1024);
        if (body.plan === undefined) throw problem(422, 'INVALID_PLAN', 'Select Pro, Studio or Business');
        billing.validateSelection(body);
        return json(res, await external(() => deadline(signal => billing.checkout(user, origin, { plan: body.plan, interval: body.interval, signal }), 35_000, 'STRIPE_TIMEOUT', res)));
      }
      if (path === '/api/billing/portal' && method === 'POST') {
        throttle(`billing:${user.id}`, 10, 60 * 60 * 1000);
        await readJSON(req, res, 8 * 1024);
        return json(res, await external(() => deadline(signal => billing.portal(user, origin, { signal }), 20_000, 'STRIPE_TIMEOUT', res)));
      }
      const match = /^\/api\/projects\/([A-Za-z0-9_-]{1,80})(?:\/(versions|restore|generate|chat|export))?$/.exec(path);
      if (!match) throw problem(404, 'NOT_FOUND', 'Endpoint not found');
      const [, id, action] = match;
      // Ownership is checked before every operation, including provider calls and exports.
      const saved = store.getProject(user.id, id);
      if (!action && method === 'GET') return json(res, { project: saved });
      if (!action && method === 'PUT') {
        const body = await readJSON(req, res, MAX_BODY);
        if (body.id !== undefined && body.id !== id) throw problem(400, 'PROJECT_ID_MISMATCH', 'Project ID does not match the URL');
        store.checkRevision(saved, body.revision);
        return json(res, { project: store.saveProject(user.id, id, canonicalProject(body), body.revision) });
      }
      if (!action && method === 'DELETE') {
        // Optional revision query protects a user deleting from a stale open tab.
        if (url.searchParams.has('revision')) store.checkRevision(saved, Number(url.searchParams.get('revision')));
        store.deleteProject(user.id, id); return json(res, { ok: true });
      }
      if (action === 'versions' && method === 'GET') return json(res, { versions: store.listVersions(user.id, id) });
      if (action === 'versions' && method === 'POST') {
        const body = await readJSON(req, res, 8 * 1024);
        return json(res, { version: store.createVersion(user.id, id, text(body.label, 'Version label', 100, { optional: true, fallback: `Revision ${saved.revision}`, nonempty: true })) }, 201);
      }
      if (action === 'restore' && method === 'POST') {
        const body = await readJSON(req, res, 8 * 1024);
        const versionId = text(body.versionId, 'Version ID', 80, { nonempty: true });
        return json(res, { project: store.restoreProject(user.id, id, versionId, body.revision) });
      }
      if (action === 'generate' && method === 'POST') return json(res, await runAI(req, res, user, id, 'generate'));
      if (action === 'chat' && method === 'POST') return json(res, await runAI(req, res, user, id, 'edit'));
      if (action === 'export' && method === 'GET') {
        const variantId = url.searchParams.get('variantId') ?? saved.activeVariant;
        const variant = saved.variants.find(v => v.id === variantId);
        if (!variant) throw problem(422, 'INVALID_VARIANT', 'Variant not found');
        const document = validateDocument(variant.document);
        const pageId = url.searchParams.get('pageId');
        if (pageId !== null && !document.pages.some(page => page.id === pageId)) throw problem(422, 'INVALID_PAGE', 'Page not found');
        const format = url.searchParams.get('format') || 'html';
        let output, contentType, extension;
        if (format === 'html') { output = renderDocument(document, { pageId: pageId ?? undefined }); contentType = 'text/html; charset=utf-8'; extension = 'html'; }
        else if (format === 'react') { output = JSON.stringify(renderReact(document, { pageId: pageId ?? undefined }), null, 2); contentType = 'application/json; charset=utf-8'; extension = 'react.json'; }
        else if (format === 'json') { output = JSON.stringify(document, null, 2); contentType = 'application/json; charset=utf-8'; extension = 'json'; }
        else if (['zip-html', 'zip-react'].includes(format)) { output = exportArchive(document, format.slice(4)); contentType = 'application/zip'; extension = `${format.slice(4)}.zip`; }
        else throw problem(422, 'INVALID_FORMAT', 'Use html, react, json, zip-html or zip-react');
        const size = Buffer.byteLength(output);
        if (size > 8 * 1024 * 1024) throw problem(413, 'EXPORT_TOO_LARGE', 'Export exceeds the download limit');
        const filename = saved.name.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 80) || 'mosaic-export';
        res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': size, 'Content-Disposition': `attachment; filename="${filename}.${extension}"`, 'Cache-Control': 'no-store' });
        return res.end(output);
      }
      throw problem(405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
    }
    const asset = STATIC.get(path);
    if (!asset) throw problem(404, 'NOT_FOUND', 'Not found');
    if (!['GET', 'HEAD'].includes(method)) throw problem(405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
    if (!assetLoader) throw problem(404, 'NOT_FOUND', 'Not found');
    const bytes = await assetLoader(asset[0]);
    res.writeHead(200, { 'Content-Type': asset[1], 'Content-Length': bytes.length, 'Cache-Control': 'no-cache' });
    res.end(method === 'HEAD' ? undefined : bytes);
  }
  function dispatch(req, res) {
    const work = handle(req, res).catch(error => {
      if (res.destroyed || res.writableEnded) return;
      if (res.headersSent) return res.destroy();
      if (error.retryAfter) res.setHeader('Retry-After', error.retryAfter);
      const status = Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : 500;
      json(res, { error: status === 500 ? 'Internal server error' : error.message, code: error.code ?? (status === 500 ? 'INTERNAL_ERROR' : 'REQUEST_FAILED') }, status);
    }).finally(() => pending.delete(work));
    pending.add(work);
    return work;
  }
  let closing;
  function close() {
    return closing ??= (async () => {
      shutdown.abort();
      await Promise.allSettled([...pending]);
      store.close();
    })();
  }
  return { handle: dispatch, db: store.db, store, close };
}
