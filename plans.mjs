// Pure catalog module: safe to serve to browsers; environment values are supplied
// by the server and Stripe price IDs never appear in publicPlans().
const TIERS = [
  ['free', 'Free', 10, 3, 'Explore the workspace', ['Website editor', 'HTML and React exports']],
  ['pro', 'Pro', 200, 30, 'Build and maintain more websites', ['Website editor', 'HTML and React exports', 'Expanded AI request quota']],
  ['studio', 'Studio', 600, 100, 'A larger workspace for frequent production', ['Website editor', 'HTML and React exports', 'Higher AI request quota', 'More saved projects']],
  ['business', 'Business', 1500, 200, 'Our largest workspace allowance', ['Website editor', 'HTML and React exports', 'Largest AI request quota', 'Largest project allowance']],
];
export const PLAN_IDS = Object.freeze(TIERS.map(([id]) => id));
export const BILLING_INTERVALS = Object.freeze(['monthly', 'yearly']);
export const validPriceId = value => typeof value === 'string' && /^price_[A-Za-z0-9]{1,200}$/.test(value);
const quota = (value, fallback) => /^(?:[1-9]\d{0,6})$/.test(String(value ?? '')) ? Number(value) : fallback;

export function createPlanCatalog(env = {}) {
  return TIERS.map(([id, name, limit, projectLimit, description, features]) => {
    const key = id.toUpperCase();
    const prices = Object.fromEntries(BILLING_INTERVALS.map(interval => {
      const value = (env[`STRIPE_PRICE_${key}_${interval.toUpperCase()}`] ?? (id === 'pro' && interval === 'monthly' ? env.STRIPE_PRICE_PRO : ''))?.trim();
      return [interval, id !== 'free' && validPriceId(value) ? value : null];
    }));
    return { id, name, description, features: [...features], limit: quota(env[`AI_${key}_LIMIT`], limit),
      projectLimit: quota(env[`PROJECT_${key}_LIMIT`], projectLimit), prices };
  });
}

export function publicPlans(catalog, billingConfigured = false) {
  const priceCounts = new Map();
  for (const plan of catalog) for (const price of Object.values(plan.prices)) if (price) priceCounts.set(price, (priceCounts.get(price) ?? 0) + 1);
  return catalog.map(({ prices, ...plan }) => ({ ...plan, amount: null,
    priceDisplay: plan.id === 'free' ? 'Free' : 'Price at checkout',
    intervals: Object.fromEntries(BILLING_INTERVALS.map(interval => [interval, { available: Boolean(billingConfigured && prices[interval] && priceCounts.get(prices[interval]) === 1) }])) }));
}
