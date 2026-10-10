const TIERS = ['free', 'pro', 'studio', 'business'];
export function canCheckout(plan, interval, configured, currentPlan) {
  return configured === true && TIERS.includes(plan?.id) && plan.id !== 'free'
    && (!currentPlan || currentPlan === 'free')
    && ['monthly', 'yearly'].includes(interval) && plan.intervals?.[interval]?.available === true;
}
export function billingErrorMessage(result) {
  return typeof result?.error?.message === 'string' ? result.error.message
    : typeof result?.error === 'string' ? result.error : 'Checkout could not be opened. Please try again.';
}
export function priceLabel(plan, interval, configured) {
  return plan?.id === 'free' ? 'Free' : canCheckout(plan, interval, configured) ? 'Price at checkout' : 'Coming soon';
}
export function normalizePlans(value) {
  const plans = Array.isArray(value) ? value : [];
  return TIERS.map(id => {
    const p = plans.find(p => p?.id === id);
    return { ...p, id, name: typeof p?.name === 'string' ? p.name : id[0].toUpperCase()+id.slice(1),
      description: typeof p?.description === 'string' ? p.description : 'Plan details will appear when reported by the server.',
      features: Array.isArray(p?.features) ? p.features.filter(f => typeof f === 'string') : [],
      intervals: p?.intervals || {} };
  });
}
export function quotaLabel(value, unit) {
  return Number.isSafeInteger(value) && value >= 0 ? `${value.toLocaleString('en-US')} ${unit}`
    : unit === 'projects' ? 'Project limit not reported' : 'AI limit not reported';
}
export function subscriptionLabel(subscription) {
  const states = {active:'Active', trialing:'Trialing', past_due:'Past due', canceled:'Canceled', unpaid:'Unpaid', incomplete:'Incomplete', incomplete_expired:'Expired', paused:'Paused'};
  if (!subscription) return 'No subscription state reported';
  if (!states[subscription.status]) return 'Subscription state not reported';
  return states[subscription.status] + (subscription.cancelAtPeriodEnd === true || subscription.cancel_at_period_end === true ? ' · Cancellation scheduled at the end of the billing period' : '');
}
export function stripeURL(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && ['checkout.stripe.com','billing.stripe.com'].includes(url.hostname) ? url.href : null;
  } catch { return null; }
}

const element = (tag, className, text) => {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
};
export function intervalControl(onChange, initial = 'monthly') {
  const group = element('div','pricing-interval');
  group.setAttribute('role','group'); group.setAttribute('aria-label','Billing interval');
  for (const [value,label] of [['monthly','Monthly'],['yearly','Annual']]) {
    const b = element('button','',label); b.type = 'button'; b.dataset.interval = value;
    b.setAttribute('aria-pressed',String(value === initial));
    b.onclick = () => {
      group.querySelectorAll('button').forEach(other => other.setAttribute('aria-pressed',String(other === b)));
      onChange(value);
    };
    group.append(b);
  }
  return group;
}
export function planCard(plan, {interval, billingConfigured, currentPlan, onCheckout, onManage, landing = false}) {
  const card = element('article',`pricing-card pricing-${plan.id}`);
  const top = element('div','pricing-card-top');
  top.append(element('span','pricing-index',`0${TIERS.indexOf(plan.id)+1} / ${plan.id === 'free' ? 'EXPLORE' : 'SUBSCRIPTION'}`),element('span','pricing-symbol',['◌','◒','✳','▦'][TIERS.indexOf(plan.id)]));
  const heading = element('h3','',plan.name);
  const price = element('p','pricing-price',priceLabel(plan,interval,billingConfigured));
  const period = element('p','pricing-period',plan.id === 'free' ? 'No subscription payment' : interval === 'yearly' ? 'Annual subscription · billed yearly' : 'Monthly subscription · billed monthly');
  const quotas = element('div','pricing-quotas');
  quotas.append(element('strong','',quotaLabel(plan.limit,'AI requests / month')),element('span','',quotaLabel(plan.projectLimit,'projects')));
  const features = element('ul','pricing-features');
  plan.features.forEach(feature => features.append(element('li','',feature)));
  if (!plan.features.length) features.append(element('li','pricing-unknown','Features not yet reported'));
  card.append(top,heading,element('p','pricing-description',plan.description),price,period,quotas,features);
  if (landing && plan.id === 'free') {
    const link = element('a','pricing-action','Explore the studio ↗'); link.href = '/app'; card.append(link);
  } else if (plan.id === currentPlan) {
    card.classList.add('is-current'); card.append(element('p','pricing-unavailable','Your current plan'));
  } else if (plan.id === 'free') {
    card.append(element('p','pricing-unavailable','Manage plan changes in billing'));
  } else if (currentPlan && currentPlan !== 'free' && billingConfigured === true && onManage) {
    const b = element('button','pricing-action','Manage in Stripe ↗'); b.type = 'button';
    b.onclick = () => onManage(b); card.append(b);
  } else if (canCheckout(plan,interval,billingConfigured,currentPlan)) {
    const b = element('button','pricing-action',`Continue with ${plan.name} ↗`); b.type = 'button';
    b.onclick = () => onCheckout(plan.id,interval,b); card.append(b);
  } else {
    card.append(element('p','pricing-unavailable',billingConfigured ? 'This interval is not available yet' : 'Subscriptions coming soon · checkout unavailable'));
  }
  return card;
}

// The landing page uses this same module; importing it in the editor has no landing side effects.
if (typeof document !== 'undefined' && document.querySelector('#pricingCards')) {
  const cards = document.querySelector('#pricingCards'), status = document.querySelector('#pricingStatus');
  let interval = 'monthly', data = {billingConfigured:false,plans:[]}, pending = false;
  const paint = () => cards.replaceChildren(...normalizePlans(data.plans).map(plan => planCard(plan,{interval,billingConfigured:data.billingConfigured,landing:true,onCheckout:checkout})));
  async function checkout(plan, chosenInterval, button) {
    if (pending) return;
    pending = true; button.disabled = true;
    status.textContent = 'Opening secure checkout. Review the final price and terms before confirming.';
    try {
      const response = await fetch('/api/billing/checkout',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({plan,interval:chosenInterval})});
      if (response.status === 401) {
        status.textContent = 'Sign in to your workspace, then select your plan in Plan & usage.';
        const link = element('a','pricing-signin','Open studio to sign in ↗'); link.href = '/app?plans=1'; status.append(' ',link); return;
      }
      const result = await response.json();
      if (!response.ok) throw new Error(billingErrorMessage(result));
      const url = stripeURL(result.url);
      if (!url) throw new Error('Checkout did not return a valid Stripe address. No plan change has been confirmed.');
      location.assign(url);
    } catch (error) { status.textContent = error.message; }
    finally { pending = false; button.disabled = false; }
  }
  document.querySelector('#pricingInterval').append(intervalControl(value => {interval = value;paint();}));
  paint();
  fetch('/api/plans',{credentials:'same-origin'}).then(async response => {
    if (!response.ok) throw new Error('Plans are temporarily unavailable. Open the studio to explore the sample; purchases are unavailable.');
    const result = await response.json();
    if (!Array.isArray(result.plans)) throw new Error('Plan details are unavailable. Please try again later.');
    data = result; paint();
    status.textContent = data.billingConfigured ? 'Availability and allowances are reported by this server. Final price, currency, taxes, and renewal terms are shown at Stripe checkout.' : 'Paid subscriptions are coming soon. Checkout is not configured on this server; no purchase is available.';
  }).catch(error => {status.textContent = error.message;});
}
