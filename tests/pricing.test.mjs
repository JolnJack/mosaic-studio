import test from 'node:test';
import assert from 'node:assert/strict';
// The namespace lets absent behavior fail as an assertion before implementation.
const pricing = await import('../pricing.mjs').catch(() => ({}));
const pro = {id:'pro', name:'Pro', limit:200, projectLimit:20, features:['HTML export'], intervals:{monthly:{available:true}, yearly:{available:false}}};

test('checkout requires explicit server configuration and interval availability', () => {
  assert.equal(typeof pricing.canCheckout, 'function');
  assert.equal(pricing.canCheckout(pro, 'monthly', true), true);
  for (const [plan, interval, configured] of [[pro,'yearly',true],[pro,'monthly',false],[pro,'weekly',true],[{...pro,id:'free'},'monthly',true],[{...pro,intervals:{}},'monthly',true],[pro,'monthly','true']]) {
    assert.equal(pricing.canCheckout(plan, interval, configured), false);
  }
});
test('prices never infer dollars or annual discounts', () => {
  assert.equal(typeof pricing.priceLabel, 'function');
  assert.equal(pricing.priceLabel(pro,'monthly',true), 'Price at checkout');
  assert.equal(pricing.priceLabel(pro,'yearly',true), 'Coming soon');
  assert.equal(pricing.priceLabel({...pro,price:99},'monthly',false), 'Coming soon');
  assert.equal(pricing.priceLabel({id:'free'},'yearly',false), 'Free');
});
test('four ordered tiers retain server quotas and features without invented fallback perks', () => {
  assert.equal(typeof pricing.normalizePlans, 'function');
  const plans = pricing.normalizePlans([pro,{id:'unknown',features:['Made up']}]);
  assert.deepEqual(plans.map(p=>p.id), ['free','pro','studio','business']);
  assert.equal(plans[1].limit,200);
  assert.deepEqual(plans[1].features,['HTML export']);
  assert.equal(plans[2].projectLimit,undefined);
  assert.deepEqual(plans[2].features,[]);
  assert.equal(pricing.canCheckout(plans[2],'monthly',true),false);
});
test('quota formatting preserves zero and reports unknown values honestly', () => {
  assert.equal(typeof pricing.quotaLabel, 'function');
  assert.equal(pricing.quotaLabel(0,'projects'), '0 projects');
  assert.equal(pricing.quotaLabel(1200,'AI requests / month'), '1,200 AI requests / month');
  assert.equal(pricing.quotaLabel(undefined,'projects'), 'Project limit not reported');
  assert.equal(pricing.quotaLabel(-1,'projects'), 'Project limit not reported');
});
test('subscription absence and pending cancellation never claim restored access', () => {
  assert.equal(typeof pricing.subscriptionLabel, 'function');
  assert.equal(pricing.subscriptionLabel(null), 'No subscription state reported');
  assert.match(pricing.subscriptionLabel({status:'active',cancelAtPeriodEnd:true}), /Active.*Cancellation scheduled/);
  assert.match(pricing.subscriptionLabel({status:'past_due'}), /Past due/);
  assert.match(pricing.subscriptionLabel({status:'mystery'}), /not reported/);
});
test('billing redirects accept only Stripe hosted HTTPS checkout or portal', () => {
  assert.equal(typeof pricing.stripeURL, 'function');
  assert.equal(pricing.stripeURL('https://checkout.stripe.com/c/pay/test'), 'https://checkout.stripe.com/c/pay/test');
  for (const url of ['https://checkout.stripe.com.evil.test/','javascript:alert(1)','http://checkout.stripe.com/','https://user@billing.stripe.com/','https://example.com/']) assert.equal(pricing.stripeURL(url),null);
});
test('existing paid accounts cannot start another subscription checkout', () => {
  assert.equal(pricing.canCheckout(pro,'monthly',true,'free'),true);
  assert.equal(pricing.canCheckout(pro,'monthly',true,'studio'),false);
  assert.equal(pricing.canCheckout(pro,'monthly',true,'pro'),false);
});
test('structured checkout errors expose the server message instead of an object string', () => {
  assert.equal(typeof pricing.billingErrorMessage,'function');
  assert.equal(pricing.billingErrorMessage({error:{code:'INVALID_PLAN',message:'Select a supported plan'}}),'Select a supported plan');
  assert.equal(pricing.billingErrorMessage({error:'Checkout unavailable'}),'Checkout unavailable');
  assert.equal(pricing.billingErrorMessage({error:{}}),'Checkout could not be opened. Please try again.');
});
