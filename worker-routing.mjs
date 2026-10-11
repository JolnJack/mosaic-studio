import { createHash } from 'node:crypto';
import { createAIProvider, boundedJSON } from './ai.mjs';
import { createBilling, verifyStripeSignature } from './billing.mjs';
import { createPlanCatalog } from './plans.mjs';
import { problem } from './store-core.mjs';
import { directoryShard, routingShard } from './worker-admission.mjs';

const ROUTE_COOKIE = 'mosaic_account';
export const accountKey = email => createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
const validKey = value => /^[0-9a-f]{64}$/.test(value ?? '');
function cookieValue(request, name) {
  const values = (request.headers.get('cookie') ?? '').split(';').map(x => x.trim()).filter(x => x.startsWith(name + '='));
  return values.length === 1 ? values[0].slice(name.length + 1) : null;
}
const directoryFor = (env, key) => env.MOSAIC_DIRECTORY.getByName('directory:' + directoryShard(key));
async function unwrapRPC(work) {
  const result = await work;
  if (!result?.ok) throw Object.assign(problem(result?.status || 503, result?.code || 'ADMISSION_UNAVAILABLE', result?.error || 'Account admission unavailable'), { retryAfter: result?.retryAfter });
  return result.value;
}
async function admit(env, scope, kind, leases, concurrent = false) {
  const stub = env.MOSAIC_ADMISSION.getByName(scope);
  const value = await unwrapRPC(stub.acquire(kind, { concurrent, profile: scope.startsWith('account:') ? 'account' : 'ip' }));
  if (value.lease) leases.push([stub, value.lease]);
}
function cookie(key, request, expires = false) {
  return `${ROUTE_COOKIE}=${expires ? '' : key}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${expires ? 0 : 604800}${new URL(request.url).protocol === 'https:' ? '; Secure' : ''}`;
}
export async function boundedRaw(request, maximum) {
  const reader = request.body?.getReader();
  const chunks = []; let size = 0;
  let timer, rejectInterrupted;
  const interrupted = new Promise((_, reject) => { rejectInterrupted = reject; });
  const onAbort = () => rejectInterrupted(problem(400, 'REQUEST_ABORTED', 'Request was interrupted'));
  try {
    if (request.signal.aborted) throw problem(400, 'REQUEST_ABORTED', 'Request was interrupted');
    if (Number(request.headers.get('content-length')) > maximum) throw problem(413, 'REQUEST_TOO_LARGE', 'Request body exceeds the limit');
    if (!reader) return Buffer.alloc(0);
    request.signal.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => rejectInterrupted(problem(408, 'REQUEST_TIMEOUT', 'Request body timed out')), 10_000);
    timer.unref?.();
    while (true) {
      const { value, done } = await Promise.race([reader.read(), interrupted]); if (done) break;
      size += value.byteLength; if (size > maximum) throw problem(413, 'REQUEST_TOO_LARGE', 'Request body exceeds the limit');
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  } finally {
    clearTimeout(timer); request.signal.removeEventListener('abort', onAbort);
    if (reader) {
      // Closing pending reads is immediate; an underlying source's cleanup may
      // never settle. Do not let it delay the deadline, abort or size response.
      try { void reader.cancel().catch(() => {}); } finally { reader.releaseLock(); }
    }
  }
}
function publicBilling(env) {
  const catalog = createPlanCatalog(env);
  return createBilling({ env, store: { limits: Object.fromEntries(catalog.map(p => [p.id, p.limit])), projectLimits: Object.fromEntries(catalog.map(p => [p.id, p.projectLimit])) } });
}
const json = (value, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });

/** Persistent, bounded-directory routing admission is separate from the random
 * account session. Neither a guessed account key nor arbitrary cookie allocates
 * a private database. Leases/windows survive Worker/DO reconstruction. */
export async function routeAPI(request, env) {
  const leases = [];
  try { return await routeInner(request, env, leases); }
  finally { await Promise.all(leases.map(async ([stub, token]) => { try { await stub.release(token); } catch {} })); }
}
async function routeInner(request, env, leases) {
  const path = new URL(request.url).pathname;
  const method = request.method;
  if (path === '/api/health' && method === 'GET') return json({ ok: true });
  if (path === '/api/config' && method === 'GET') {
    const ai = createAIProvider(env), billing = publicBilling(env);
    return json({ aiConfigured: ai.configured, providerType: ai.providerType || 'compatible', aiProviderType: ai.providerType || 'compatible', billingConfigured: billing.configured, registrationEnabled: !['0', 'false'].includes(String(env.REGISTRATION_ENABLED ?? '1').toLowerCase()), urlImportConfigured: env.URL_IMPORT_ENABLED === '1', localMode: false });
  }
  if (path === '/api/plans' && method === 'GET') return json(publicBilling(env).catalog());
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && path !== '/api/billing/webhook') {
    if (request.headers.get('sec-fetch-site') === 'cross-site' || (request.headers.has('origin') && request.headers.get('origin') !== new URL(request.url).origin)) throw problem(403, 'ORIGIN_FORBIDDEN', 'Cross-origin request rejected');
  }
  let key = null, authenticating = false, directory;
  const envelope = cookieValue(request, ROUTE_COOKIE);
  const ipScope = 'ip:' + createHash('sha256').update(request.headers.get('cf-connecting-ip') || 'unknown').digest('hex');
  if (['/api/auth/register', '/api/auth/login'].includes(path) && method === 'POST') {
    await admit(env, ipScope, 'auth', leases, true);
    if (path.endsWith('/register')) {
      if (['0', 'false'].includes(String(env.REGISTRATION_ENABLED ?? '1').toLowerCase())) throw problem(403, 'REGISTRATION_DISABLED', 'Registration is disabled');
      await admit(env, ipScope, 'signup', leases);
    }
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')) throw problem(415, 'UNSUPPORTED_MEDIA_TYPE', 'Use application/json');
    let body;
    try {
      const raw = await boundedRaw(request, 8192);
      body = JSON.parse(raw.toString('utf8'));
      request = new Request(request, { body: raw });
    }
    catch (error) { if (error.status) throw error; throw problem(400, 'INVALID_JSON', 'Invalid JSON request'); }
    if (typeof body?.email !== 'string' || body.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email.trim())) throw problem(422, 'VALIDATION_ERROR', 'A valid email address is required');
    key = accountKey(body.email); authenticating = true;
    directory = directoryFor(env, key);
    if (path.endsWith('/login') && !await directory.exists(key)) return json({ code: 'INVALID_CREDENTIALS', error: 'Email or password is incorrect' }, 401);
    await admit(env, 'account:' + key, 'auth', leases);
    if (path.endsWith('/register')) await unwrapRPC(directory.register(key));
  } else if (path === '/api/billing/webhook' && method === 'POST') {
    if (!publicBilling(env).configured) throw problem(503, 'BILLING_NOT_CONFIGURED', 'Stripe webhooks are not configured');
    const raw = await boundedRaw(request, 262144);
    request = new Request(request, { body: raw });
    verifyStripeSignature(raw, request.headers.get('stripe-signature'), env.STRIPE_WEBHOOK_SECRET?.trim());
    let event; try { event = JSON.parse(raw.toString('utf8')); } catch { throw problem(400, 'INVALID_WEBHOOK', 'Invalid webhook JSON'); }
    if (typeof event?.id !== 'string' || !/^evt_[A-Za-z0-9]{1,200}$/.test(event.id) || typeof event.type !== 'string' || event.type.length > 150
      || !Number.isSafeInteger(event.created) || event.created < 0 || !event.data?.object) throw problem(400, 'INVALID_WEBHOOK', 'Invalid webhook event');
    const object = event.data.object;
    const objectId = value => typeof value === 'string' ? value : value?.id;
    // Match billing.mjs: only subscription-affecting events need account routing.
    // The account handler still verifies stored customer ownership and re-fetches
    // the subscription; routing metadata alone never grants an entitlement.
    let subscription;
    if (['customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted',
      'customer.subscription.paused', 'customer.subscription.resumed'].includes(event.type)) subscription = object.id;
    else if (['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(event.type) && object.mode === 'subscription') subscription = objectId(object.subscription);
    else if (['invoice.paid', 'invoice.payment_failed'].includes(event.type)) subscription = objectId(object.subscription ?? object.parent?.subscription_details?.subscription);
    const customer = typeof object?.customer === 'string' ? object.customer : object?.customer?.id;
    if (typeof subscription !== 'string' || !/^sub_[A-Za-z0-9]{1,200}$/.test(subscription)
      || typeof customer !== 'string' || !/^cus_[A-Za-z0-9]{1,200}$/.test(customer)) return json({ received: true });
    const response = await fetch(`https://api.stripe.com/v1/customers/${encodeURIComponent(customer)}`, { redirect: 'error', signal: AbortSignal.timeout(15000), headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY.trim()}`, 'Stripe-Version': '2024-06-20' } });
    if (!response.ok) { await response.body?.cancel(); throw problem(502, 'STRIPE_ERROR', 'Stripe customer lookup failed'); }
    const current = await boundedJSON(response, 65536);
    key = current?.metadata?.mosaic_user_id;
    if (current?.id !== customer) throw problem(400, 'INVALID_WEBHOOK', 'Stripe returned an inconsistent customer');
    if (typeof key !== 'string' || !validKey(key)) return json({ received: true });
    if (!await directoryFor(env, key).exists(key)) return json({ received: true });
  } else {
    const shard = routingShard(envelope);
    const session = cookieValue(request, 'mosaic_session');
    if (shard && /^[A-Za-z0-9_-]{43}$/.test(session ?? '')) {
      directory = env.MOSAIC_DIRECTORY.getByName('directory:' + shard);
      key = await directory.verify(envelope);
    }
  }
  let kind;
  if (path === '/api/import' && method === 'POST' && env.URL_IMPORT_ENABLED !== '1') {
    if (!key) throw problem(401, 'AUTH_REQUIRED', 'Sign in to continue');
    throw problem(503, 'IMPORT_UNAVAILABLE', 'Safe URL import is unavailable on this hosted beta. Use a design brief and manual editing instead.');
  }
  if (path === '/api/import' && method === 'POST') kind = 'import';
  if (/^\/api\/projects\/[^/]+\/(?:generate|chat)$/.test(path) && method === 'POST') kind = 'ai';
  if (kind) {
    await admit(env, ipScope, kind, leases, true);
    await admit(env, 'account:' + key, kind, leases, true);
  }
  if (!key) {
    if (path === '/api/me' && method === 'GET') return json({ user: null, usage: null });
    if (path === '/api/auth/logout' && method === 'POST') {
      const response = json({ ok: true });
      response.headers.append('Set-Cookie', cookie('', request, true));
      response.headers.append('Set-Cookie', cookie('', request, true).replace(ROUTE_COOKIE + '=', 'mosaic_session=')); return response;
    }
    if (path === '/api/auth/local') throw problem(403, 'LOCAL_MODE_DISABLED', 'Local workspace is unavailable');
    throw problem(401, 'AUTH_REQUIRED', 'Sign in to continue');
  }
  const headers = new Headers(request.headers); headers.set('x-mosaic-client-ip', request.headers.get('cf-connecting-ip') || 'unknown');
  const response = await env.MOSAIC_DB.getByName('account:' + key).fetch(new Request(request, { headers }));
  if ((authenticating && response.ok) || (path === '/api/auth/logout' && response.ok)) {
    const result = new Response(response.body, response);
    if (authenticating) {
      result.headers.append('Set-Cookie', cookie(await unwrapRPC(directory.issue(key, envelope)), request));
    } else {
      await directory?.revoke(envelope);
      result.headers.append('Set-Cookie', cookie('', request, true));
    }
    return result;
  }
  return response;
}
