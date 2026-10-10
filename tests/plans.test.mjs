import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

test('catalog exposes four configurable tiers without invented prices or secrets', async () => {
  assert.ok(existsSync(new URL('../plans.mjs', import.meta.url)), 'plans catalog must exist');
  const { createPlanCatalog, publicPlans } = await import('../plans.mjs');
  const env = { AI_STUDIO_LIMIT: '777', PROJECT_STUDIO_LIMIT: '42', STRIPE_PRICE_PRO: 'price_legacy', STRIPE_PRICE_BUSINESS_YEARLY: 'price_business', STRIPE_SECRET_KEY: 'secret' };
  const catalog = createPlanCatalog(env);
  assert.deepEqual(catalog.map(p => p.id), ['free', 'pro', 'studio', 'business']);
  assert.deepEqual(catalog.map(p => p.limit), [10, 200, 777, 1500]);
  assert.deepEqual(catalog.map(p => p.projectLimit), [3, 30, 42, 200]);
  const plans = publicPlans(catalog, true);
  assert.equal(plans[1].intervals.monthly.available, true);
  assert.equal(plans[1].intervals.yearly.available, false);
  assert.equal(plans[3].intervals.yearly.available, true);
  assert.equal(plans[0].intervals.monthly.available, false);
  assert.equal(plans[1].amount, null);
  assert.equal(plans[1].priceDisplay, 'Price at checkout');
  assert.doesNotMatch(JSON.stringify(plans), /price_legacy|price_business|secret/);
  assert.ok(publicPlans(catalog, false).every(p => !p.intervals.monthly.available && !p.intervals.yearly.available));
  const invalid = createPlanCatalog({ AI_FREE_LIMIT: '-1', PROJECT_PRO_LIMIT: '0' });
  assert.equal(invalid[0].limit, 10); assert.equal(invalid[1].projectLimit, 30);
});

test('ambiguous reused Stripe prices cannot advertise an available checkout', async () => {
  const { createPlanCatalog, publicPlans } = await import('../plans.mjs');
  const plans = publicPlans(createPlanCatalog({ STRIPE_PRICE_PRO_MONTHLY: 'price_duplicate', STRIPE_PRICE_STUDIO_YEARLY: 'price_duplicate', STRIPE_PRICE_BUSINESS_MONTHLY: 'price_unique' }), true);
  assert.equal(plans[1].intervals.monthly.available, false);
  assert.equal(plans[2].intervals.yearly.available, false);
  assert.equal(plans[3].intervals.monthly.available, true);
});

test('explicit monthly price supersedes legacy Pro and every tier has independent intervals', async () => {
 const {createPlanCatalog,publicPlans}=await import('../plans.mjs');
 const env={STRIPE_PRICE_PRO:'price_legacy',STRIPE_PRICE_PRO_MONTHLY:'price_proM',STRIPE_PRICE_PRO_YEARLY:'price_proY',STRIPE_PRICE_STUDIO_MONTHLY:'price_studioM',STRIPE_PRICE_STUDIO_YEARLY:'price_studioY',STRIPE_PRICE_BUSINESS_MONTHLY:'price_businessM',STRIPE_PRICE_BUSINESS_YEARLY:'price_businessY'};
 const catalog=createPlanCatalog(env);assert.equal(catalog[1].prices.monthly,'price_proM');
 assert.ok(publicPlans(catalog,true).slice(1).every(p=>p.intervals.monthly.available&&p.intervals.yearly.available));
 assert.deepEqual(createPlanCatalog().map(p=>p.projectLimit),[3,30,100,200]);
});
