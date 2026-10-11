import { createHmac, timingSafeEqual } from 'node:crypto';
import { boundedJSON } from './ai.mjs';
import { hashToken, problem } from './store-core.mjs';
import { createPlanCatalog, publicPlans, BILLING_INTERVALS } from './plans.mjs';

const stripeId = (value, prefix) => typeof value === 'string' && new RegExp(`^${prefix}_[A-Za-z0-9]{1,200}$`).test(value);
const objectId = value => typeof value === 'string' ? value : value?.id;

/** Verify the exact raw bytes, with replay tolerance and constant-time comparison. */
export function verifyStripeSignature(raw, header, secret, currentTime = Date.now()) {
  if (!secret || typeof header !== 'string' || header.length > 4096) throw problem(400, 'INVALID_WEBHOOK_SIGNATURE', 'Invalid webhook signature');
  const parts = header.split(',').map(part => part.trim().split('='));
  const stamps = parts.filter(([key]) => key === 't');
  if (stamps.length !== 1 || !/^\d{1,12}$/.test(stamps[0][1])) throw problem(400, 'INVALID_WEBHOOK_SIGNATURE', 'Invalid webhook timestamp');
  const stamp = stamps[0][1];
  if (Math.abs(Math.floor(currentTime / 1000) - Number(stamp)) > 300) throw problem(400, 'INVALID_WEBHOOK_SIGNATURE', 'Webhook signature expired');
  const expected = createHmac('sha256', secret).update(`${stamp}.`).update(raw).digest();
  const signatures = parts.filter(([key, value]) => key === 'v1' && /^[0-9a-f]{64}$/i.test(value ?? ''));
  if (!signatures.some(([, value]) => timingSafeEqual(expected, Buffer.from(value, 'hex')))) throw problem(400, 'INVALID_WEBHOOK_SIGNATURE', 'Invalid webhook signature');
}

export function createBilling({ store, env = process.env, fetchImpl = (...args) => fetch(...args) }) {
  const key = env.STRIPE_SECRET_KEY?.trim(), secret = env.STRIPE_WEBHOOK_SECRET?.trim();
  const catalog = createPlanCatalog(env).map(p => ({ ...p, limit: store.limits[p.id], projectLimit: store.projectLimits[p.id] }));
  const configured = Boolean(key && secret && catalog.some(p => Object.values(p.prices).some(Boolean)));
  const priceMatches = priceId => catalog.flatMap(p => BILLING_INTERVALS.filter(interval => p.prices[interval] && p.prices[interval] === priceId).map(interval => ({ plan: p.id, interval })));
  function selection({ plan = 'pro', interval = 'monthly' } = {}) {
    const tier = catalog.find(p => p.id === plan && p.id !== 'free');
    if (!tier) throw problem(422, 'INVALID_PLAN', 'Select Pro, Studio or Business');
    if (!BILLING_INTERVALS.includes(interval)) throw problem(422, 'INVALID_INTERVAL', 'Select monthly or yearly billing');
    return { tier, interval, price: tier.prices[interval] };
  }
  // Serialize retrieval + application per customer within this process; the store also
  // guards event identity/order atomically for independent processes and retries.
  const customerLocks = new Map();
  function requireConfiguration() {
    if (!configured) throw problem(503, 'BILLING_NOT_CONFIGURED', 'Stripe checkout and webhooks are not configured');
  }
  async function stripe(path, method = 'GET', fields, idempotencyKey, signal) {
    requireConfiguration();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    timer.unref();
    try {
      const response = await fetchImpl(`https://api.stripe.com/v1${path}`, {
        method, redirect: 'error', signal: signal ? AbortSignal.any([controller.signal, signal]) : controller.signal,
        headers: { Authorization: `Bearer ${key}`, 'Stripe-Version': '2024-06-20',
          ...(fields ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
          ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) },
        ...(fields ? { body: new URLSearchParams(fields).toString() } : {}),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw Object.assign(problem(502, 'STRIPE_ERROR', 'Stripe request failed'), { providerStatus: response.status });
      }
      return await boundedJSON(response);
    } catch (error) {
      if (controller.signal.aborted) throw problem(504, 'STRIPE_TIMEOUT', 'Stripe request timed out');
      if (error.status) throw error;
      throw problem(502, 'STRIPE_ERROR', 'Unable to contact Stripe');
    } finally { clearTimeout(timer); }
  }
  function hostedUrl(value) {
    try {
      const url = new URL(value);
      if (url.protocol === 'https:' && !url.username && !url.password && ['checkout.stripe.com', 'billing.stripe.com'].includes(url.hostname)) return url.href;
    } catch {}
    throw problem(502, 'STRIPE_ERROR', 'Stripe returned an invalid hosted URL');
  }
  async function customer(user, signal) {
    const saved = store.userById(user.id);
    if (saved.stripe_customer_id) return saved.stripe_customer_id;
    const result = await stripe('/customers', 'POST', {
      email: saved.email, name: saved.name, 'metadata[mosaic_user_id]': saved.id,
    }, `mosaic-customer-${saved.id}`, signal);
    if (!stripeId(result?.id, 'cus')) throw problem(502, 'STRIPE_ERROR', 'Stripe returned an invalid customer');
    return store.setCustomer(saved.id, result.id);
  }
  async function locked(customerId, fn) {
    const previous = customerLocks.get(customerId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(fn);
    customerLocks.set(customerId, next);
    try { return await next; }
    finally { if (customerLocks.get(customerId) === next) customerLocks.delete(customerId); }
  }
  return {
    configured,
    catalog() { return { billingConfigured: configured, currency: 'usd', plans: publicPlans(catalog, configured) }; },
    info(userId) {
      const saved = store.subscription(userId);
      const matches = saved ? priceMatches(saved.priceId) : [];
      return { plan: store.plan(userId), usage: store.usage(userId), billingConfigured: configured,
        plans: publicPlans(catalog, configured), subscription: saved ? { status: saved.status,
          interval: saved.interval ?? (matches.length === 1 ? matches[0].interval : null), currentPeriodEnd: saved.currentPeriodEnd,
          cancelAtPeriodEnd: saved.cancelAtPeriodEnd === 1 } : null };
    },
    validateSelection: selection,
    async checkout(user, origin, options = {}) {
      const { tier, interval, price } = selection(options);
      const { signal } = options;
      requireConfiguration();
      if (!price || priceMatches(price).length !== 1) throw problem(503, 'PLAN_NOT_CONFIGURED', 'This billing interval is not configured');
      if (store.plan(user.id) !== 'free') throw problem(409, 'ALREADY_SUBSCRIBED', 'Use the billing portal to manage your subscription');
      const actualPrice = await stripe(`/prices/${encodeURIComponent(price)}`, 'GET', undefined, undefined, signal);
      if (actualPrice?.id !== price || actualPrice.active !== true || actualPrice.type !== 'recurring' || actualPrice.currency !== 'usd'
        || actualPrice.recurring?.interval !== (interval === 'monthly' ? 'month' : 'year') || actualPrice.recurring?.interval_count !== 1) {
        throw problem(502, 'INVALID_STRIPE_PRICE', 'Configured price must be active and recurring in the selected interval and USD');
      }
      const customerId = await customer(user, signal);
      const result = await stripe('/checkout/sessions', 'POST', {
        mode: 'subscription', customer: customerId, client_reference_id: user.id,
        'line_items[0][price]': price, 'line_items[0][quantity]': '1',
        'subscription_data[metadata][mosaic_user_id]': user.id,
        success_url: `${origin}/app?billing=success`, cancel_url: `${origin}/app?billing=canceled`,
      }, `mosaic-checkout-${user.id}-${tier.id}-${interval}-${Math.floor(Date.now() / 60_000)}`, signal);
      return { url: hostedUrl(result?.url) };
    },
    async portal(user, origin, { signal } = {}) {
      requireConfiguration();
      const customerId = store.userById(user.id)?.stripe_customer_id;
      if (!customerId) throw problem(409, 'NO_BILLING_ACCOUNT', 'Create a checkout session before opening the billing portal');
      const result = await stripe('/billing_portal/sessions', 'POST', { customer: customerId, return_url: `${origin}/app` }, undefined, signal);
      return { url: hostedUrl(result?.url) };
    },
    async webhook(raw, signature, { signal } = {}) {
      requireConfiguration();
      verifyStripeSignature(raw, signature, secret);
      let event;
      try { event = JSON.parse(raw.toString('utf8')); }
      catch { throw problem(400, 'INVALID_WEBHOOK', 'Invalid webhook JSON'); }
      if (!stripeId(event?.id, 'evt') || typeof event.type !== 'string' || event.type.length > 150
        || !Number.isSafeInteger(event.created) || event.created < 0 || !event.data?.object) throw problem(400, 'INVALID_WEBHOOK', 'Invalid webhook event');
      const payloadHash = hashToken(raw);
      const previous = store.webhookEvent(event.id);
      if (previous) {
        if (previous.payload_hash !== payloadHash) throw problem(400, 'EVENT_MISMATCH', 'Webhook event payload changed');
        return { received: true, duplicate: true };
      }
      const object = event.data.object;
      let subscriptionId;
      if (['customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted',
        'customer.subscription.paused', 'customer.subscription.resumed'].includes(event.type)) subscriptionId = object.id;
      else if (['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(event.type) && object.mode === 'subscription') subscriptionId = objectId(object.subscription);
      else if (['invoice.paid', 'invoice.payment_failed'].includes(event.type)) subscriptionId = objectId(object.subscription ?? object.parent?.subscription_details?.subscription);
      const customerId = objectId(object.customer);
      const user = stripeId(customerId, 'cus') ? store.userByCustomer(customerId) : null;
      if (!user || !stripeId(subscriptionId, 'sub')) {
        store.applyWebhook(event, payloadHash, null);
        return { received: true };
      }
      return locked(customerId, async () => {
        if (signal?.aborted) throw signal.reason;
        if (store.webhookEvent(event.id)) {
          store.applyWebhook(event, payloadHash, null);
          return { received: true, duplicate: true };
        }
        let actual;
        try { actual = await stripe(`/subscriptions/${encodeURIComponent(subscriptionId)}`, 'GET', undefined, undefined, signal); }
        catch (error) {
          // Only a signed deletion can revoke a subscription already gone from Stripe.
          if (event.type === 'customer.subscription.deleted' && error.providerStatus === 404) actual = { ...object, status: 'canceled' };
          else throw error;
        }
        if (actual?.id !== subscriptionId || objectId(actual.customer) !== customerId || typeof actual.status !== 'string') {
          throw problem(502, 'STRIPE_ERROR', 'Stripe returned an inconsistent subscription');
        }
        const matchingItems = (actual.items?.data ?? []).flatMap(row => {
          const matches = priceMatches(objectId(row.price));
          if (matches.length !== 1 || (row.quantity ?? 1) <= 0) return [];
          const match = matches[0], recurring = row.price?.recurring;
          if (recurring && (recurring.interval !== (match.interval === 'monthly' ? 'month' : 'year') || recurring.interval_count !== 1)) return [];
          if (row.price?.active === false || (row.price?.currency && row.price.currency !== 'usd')) return [];
          return [{ row, ...match }];
        });
        const matched = matchingItems.length === 1 ? matchingItems[0] : null;
        const item = matched?.row;
        const end = item?.current_period_end ?? actual.current_period_end ?? 0;
        const currentPeriodEnd = Number.isSafeInteger(end) && end > 0 ? end : 0;
        const eligible = item && !actual.pause_collection && ['active', 'trialing'].includes(actual.status)
          && currentPeriodEnd > Math.floor(Date.now() / 1000);
        if (signal?.aborted) throw signal.reason;
        store.applyWebhook(event, payloadHash, { id: subscriptionId, userId: user.id, customerId,
          status: actual.status.slice(0, 80), priceId: item ? objectId(item.price) : null,
          plan: eligible ? matched.plan : 'free', interval: matched?.interval, currentPeriodEnd, cancelAtPeriodEnd: actual.cancel_at_period_end === true });
        return { received: true };
      });
    },
  };
}
