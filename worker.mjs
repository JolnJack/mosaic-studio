import { DurableObject } from 'cloudflare:workers';
import { createApplication, STATIC, documentSecurityPolicy } from './application.mjs';
import { createWorkerStore } from './worker-store.mjs';
import { fetchAdapter } from './fetch-adapter.mjs';
import { importWorkerUrl } from './worker-import.mjs';
import { accountKey, routeAPI } from './worker-routing.mjs';
import { AdmissionCore, DirectoryCore } from './worker-admission.mjs';
const csp = documentSecurityPolicy();
function safeRPC(fn) {
  try { return { ok: true, value: fn() }; }
  catch (error) { return { ok: false, status: error.status || 503, code: error.code || 'ADMISSION_UNAVAILABLE', error: error.status ? error.message : 'Account admission unavailable', retryAfter: error.retryAfter }; }
}
export class MosaicAdmission extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.core = new AdmissionCore(ctx.storage); }
  acquire(kind, options) { return safeRPC(() => this.core.acquire(kind, options)); }
  release(token) { return this.core.release(token); }
}
export class MosaicDirectory extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.core = new DirectoryCore(ctx.storage); }
  exists(key) { return this.core.exists(key); }
  register(key) { return safeRPC(() => this.core.register(key)); }
  issue(key, previousEnvelope) { return safeRPC(() => this.core.issue(key, previousEnvelope)); }
  verify(envelope) { this.core.cleanupIfDue(); return this.core.verify(envelope); }
  revoke(envelope) { return this.core.revoke(envelope); }
}

export class MosaicDatabase extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.store = createWorkerStore(ctx.storage, { env, userIdFactory: accountKey });
    const importer = (value, options) => importWorkerUrl(value, { ...options, onTransportError: env.NODE_ENV === 'development' ? error => console.warn(JSON.stringify({ event: 'local_import_transport', code: String(error.code ?? '').slice(0, 100), message: String(error.message ?? '').replace(/https?:\/\/\S+/g, '[url]').slice(0, 300) })) : undefined });
    this.application = createApplication({ store: this.store, env, importer });
    this.respond = fetchAdapter(this.application.handle);
  }
  async fetch(request) {
    this.store.cleanupIfDue();
    return this.respond(request, { clientIP: request.headers.get('x-mosaic-client-ip') || 'unknown' });
  }
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url), canonical = new URL(env.PUBLIC_URL);
    if (url.host !== canonical.host) return Response.json({ code: 'INVALID_HOST', error: 'Unexpected request host' }, { status: 400 });
    if (canonical.protocol === 'https:' && url.protocol !== 'https:') return Response.redirect(canonical.origin + url.pathname + url.search, 308);
    if (url.pathname.startsWith('/api/')) {
      try { return await routeAPI(request, env); }
      catch (error) {
        if (!error.status) console.error(JSON.stringify({ event: 'api_failure', code: 'INTERNAL_ERROR' }));
        return Response.json({ code: error.code || 'INTERNAL_ERROR', error: error.status ? error.message : 'Internal server error' }, { status: error.status || 500, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...(error.retryAfter ? { 'Retry-After': String(error.retryAfter) } : {}) } });
      }
    }
    const asset = STATIC.get(url.pathname);
    if (!asset) return new Response('Not found', { status: 404 });
    if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed', { status: 405 });
    url.pathname = '/' + asset[0]; url.search = '';
    const response = await env.ASSETS.fetch(new Request(url, { method: request.method }));
    const headers = new Headers(response.headers);
    headers.set('Content-Type', asset[1]); headers.set('Cache-Control', 'no-cache');
    headers.set('X-Content-Type-Options', 'nosniff'); headers.set('Referrer-Policy', 'same-origin');
    headers.set('X-Frame-Options', 'SAMEORIGIN'); headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    headers.set('Content-Security-Policy', csp);
    return new Response(response.body, { status: response.status, headers });
  },
};
