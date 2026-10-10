const BRIEF_LIMIT = 8000;

// This is a local syntax/network-range screen, not DNS verification.
// The importer must still verify resolved addresses and redirects before fetching.
export function normalizePublicUrl(value) {
  if (typeof value !== 'string' || !/^https?:\/\/[^/\\]/i.test(value.trim()) || value.length > 2048 || /[\u0000-\u001f\u007f\\]/.test(value)) {
    throw new Error('Enter a complete public website address, starting with https:// or http://.');
  }
  let url;
  try { url = new URL(value.trim()); } catch {
    throw new Error('Enter a complete website address, starting with https:// or http://.');
  }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Use an HTTP or HTTPS address without a username or password.');
  }
  if (url.port && !['80', '443'].includes(url.port)) {
    throw new Error('Use a public website on a standard HTTP or HTTPS port.');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  const privateMessage = 'Use a public website; local, private and reserved addresses are not supported.';
  if (host.includes(':')) {
    if (!/^[23][0-9a-f]{0,3}:/.test(host) || /^2001:(?:db8|0|10|20|2):/.test(host)
      || host.startsWith('2001::') || host.startsWith('2002:') || host.startsWith('3fff:')) {
      throw new Error(privateMessage);
    }
  } else if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const [a, b, c] = host.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && [0, 2, 168].includes(b))
      || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
      || (a === 203 && b === 0 && c === 113)) throw new Error(privateMessage);
  } else {
    const labels = host.split('.');
    if (labels.length < 2 || labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
      || /(?:^|\.)(localhost|local|internal|test|lan|home|invalid|onion)$/.test(host) || /(?:^|\.)home\.arpa$/.test(host)
      || !/^[a-z][a-z0-9-]+$/.test(labels.at(-1))) throw new Error(privateMessage);
  }
  url.hostname = url.hostname.replace(/\.$/, '');
  url.hash = '';
  return url.href;
}

export function validateLandingInput(input = {}) {
  const errors = {};
  const mode = input?.mode;
  if (!['url', 'brief'].includes(mode)) errors.mode = 'Choose a website or a brief as your starting point.';
  const rawBrief = input?.brief ?? '';
  const brief = typeof rawBrief === 'string' ? rawBrief.trim() : '';
  if (typeof rawBrief !== 'string') errors.brief = 'Enter your brief as text.';
  else if (rawBrief.length > BRIEF_LIMIT) errors.brief = 'Keep your brief to 8,000 characters or fewer.';
  else if (mode === 'brief' && !brief) errors.brief = 'Describe the website you want to create.';
  let url;
  if (mode === 'url') {
    try { url = normalizePublicUrl(input?.url); } catch (error) { errors.url = error.message; }
  }
  return Object.keys(errors).length ? { ok: false, errors }
    : { ok: true, value: { mode, ...(mode === 'url' ? { url } : {}), brief } };
}

export function buildStudioHandoff(input) {
  const result = validateLandingInput(input);
  if (!result.ok) throw Object.assign(new Error(Object.values(result.errors)[0]), { fields: result.errors });
  const params = new URLSearchParams({ start: '1', mode: result.value.mode });
  if (result.value.mode === 'url') params.set('url', result.value.url);
  params.set('brief', result.value.brief);
  // Fragments are not part of the HTTP request or Referer. Do not switch to a query.
  return `/app#${params.toString()}`;
}

export function workspaceNotice(config) {
  const c = config && typeof config === 'object' ? config : {};
  return {
    auth: c.localMode === true ? 'A local workspace session is available in the studio for saving and server actions.'
      : c.localMode === false ? `Sign in for saving, import and AI.${c.registrationEnabled === false ? ' New account registration is unavailable here.' : ''}`
        : 'Workspace sign-in availability is not verified. Check in the studio before server actions.',
    ai: c.aiConfigured === true ? 'A model is connected. AI requests use the workspace allowance; provider costs may apply.'
      : c.aiConfigured === false ? 'AI is not connected. You can still explore and manually edit the sample.'
        : 'Model availability is not verified. Sample editing does not require AI.',
    billing: c.billingConfigured === true ? 'Paid plans use recurring subscriptions. Review availability and terms under Pricing.'
      : c.billingConfigured === false ? 'Paid subscriptions are coming soon; checkout is unavailable on this workspace.'
        : 'Billing availability is not verified. See Pricing for server-reported plan status.',
  };
}

const sampleStyles = `
*{box-sizing:border-box}html{scroll-behavior:smooth;scroll-padding-top:16px}body{margin:0;font-family:Arial,sans-serif;color:#252c2d;background:#fbfcfa}a{color:inherit;text-decoration:none}a:hover{text-decoration:underline}a:focus-visible,summary:focus-visible{outline:3px solid #6652c7;outline-offset:4px}h1,h2,h3,p,figure{margin:0}header{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:22px 7%;border-bottom:1px solid #252c2d22}header>a{font-size:20px;font-weight:700;letter-spacing:-1px}nav{display:flex;gap:18px;font-size:11px}main{padding:36px 7%}section{scroll-margin-top:15px}.kicker{font:9px/1.6 monospace;letter-spacing:1px;text-transform:uppercase}.intro{line-height:1.8;font-size:13px;max-width:420px}.action{display:inline-block;padding:11px 15px;font-size:11px;margin-top:20px;border:1px solid currentColor}footer{display:flex;flex-wrap:wrap;justify-content:space-between;gap:12px;padding:20px 7%;font:9px/1.7 monospace;border-top:1px solid #252c2d22}details{padding:17px 0;border-bottom:1px solid #252c2d22}summary{cursor:pointer;font-size:14px}details p{font-size:12px;line-height:1.9;margin-top:12px}h2{font-size:28px;font-weight:500;letter-spacing:-.7px}h3{font-size:17px;font-weight:500}.lower{padding-top:40px;margin-top:40px;border-top:1px solid #252c2d22}.lower>p{margin-top:16px;font-size:13px;line-height:1.8}.index{font:10px monospace;margin-bottom:12px}@media(max-width:480px){header{padding:17px 6%;gap:12px}nav{gap:12px;font-size:10px}main{padding:27px 6%}h2{font-size:25px}}@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
`;

const morrowBody = `
<header><a href="#home">morrow<span style="font-weight:400"> /</span></a><nav aria-label="Sample navigation"><a href="#work">Work</a><a href="#practice">Practice</a></nav></header>
<main id="home"><section class="morrow-hero"><div><p class="kicker">Independent architecture practice</p><h1>Spaces for<br>everyday life.</h1><p class="intro">Thoughtful homes, shaped around the people who live in them. From the first sketch to the details you touch.</p><a class="action" href="#work">Explore the projects ↗</a></div><figure class="plan" aria-label="Original illustrative courtyard house floor plan"><div class="plan-label">COURTYARD HOUSE / CONCEPT PLAN</div><div class="rooms"><div class="room living">Living<br><small>Open to the garden</small></div><div class="room courtyard">Courtyard</div><div class="room kitchen">Kitchen</div><div class="room study">Study</div><div class="room entry">Entry</div></div><figcaption><span>SCHEMATIC / NOT TO SCALE</span><span>N ↑</span></figcaption></figure></section>
<section class="lower" id="work"><p class="kicker">Selected projects / illustrative</p><h2>Built around a way of living.</h2><div class="morrow-projects"><article><p class="index">01 / RESIDENTIAL CONCEPT</p><h3>Courtyard house</h3><p class="intro">An inward-facing home with a garden at its center.</p><details><summary>Read the project note</summary><p>Living spaces open to a sheltered courtyard. A separate study gives quieter work its own place. This is an authored design concept, not a built customer project.</p></details></article><article><p class="index">02 / ADAPTIVE REUSE CONCEPT</p><h3>Workshop rooms</h3><p class="intro">A flexible studio in the shell of a small workshop.</p><details><summary>Read the project note</summary><p>Simple partitions separate focused work from shared space. The concept explores how an existing building could support a different daily routine.</p></details></article></div></section>
<section class="lower" id="practice"><p class="kicker">The practice</p><h2>Observe. Draw. Refine.</h2><p>We begin with how a place is used. The design follows through conversation, sketches and careful choices about materials.</p></section></main>`;

const morrowStyles = `
.morrow-hero{display:grid;grid-template-columns:1fr 1fr;align-items:center;gap:40px}.morrow-hero h1{font:normal clamp(36px,5.5vw,66px)/1.04 Georgia,serif;letter-spacing:-2px;margin:18px 0}.plan{background:#e6eee8;border:1px solid #a1b5a8;padding:23px;color:#344c40;min-height:280px}.plan-label{font:8px/1.6 monospace;letter-spacing:.6px;margin-bottom:23px}.rooms{display:grid;grid-template-columns:1.3fr 1fr;grid-template-rows:82px 65px 45px;gap:3px;border:3px solid #536d5b;padding:3px}.room{border:1px solid #536d5b88;display:grid;place-content:center;text-align:center;font:10px/1.8 monospace;background:#f5f8f1}.room small{font-size:7px}.living{grid-row:span 2}.courtyard{background:repeating-linear-gradient(45deg,#cadac9,#cadac9 3px,#e6eee8 3px,#e6eee8 10px)}.entry{grid-column:span 2}.plan figcaption{display:flex;justify-content:space-between;margin-top:17px;font:7px monospace}.morrow-projects{display:grid;grid-template-columns:1fr 1fr;gap:28px;margin-top:25px}.morrow-projects article{border-top:1px solid #a1b5a8;padding-top:18px}.morrow-projects .intro{margin-top:12px}#work h2{margin-top:14px}#practice h2{margin-top:14px}@media(max-width:650px){.morrow-hero{grid-template-columns:1fr;gap:26px}.plan{min-height:250px}.morrow-projects{grid-template-columns:1fr}.morrow-hero h1{font-size:44px}}
`;

const relayBody = `
<header><a href="#home">relay<span class="relay-mark" aria-hidden="true">↗</span></a><nav aria-label="Sample navigation"><a href="#workflow">Workflow</a><a href="#questions">Questions</a></nav></header>
<main id="home"><section class="relay-hero"><p class="kicker">A concept for deliberate teamwork</p><h1>Less chasing.<br>More finishing.</h1><p class="intro">A clear place for the next task, the person responsible, and the decision that moves work forward.</p><a class="action" href="#workflow">See the workflow →</a></section>
<section class="relay-flow" id="workflow"><p class="kicker">From intention to delivery</p><div class="relay-sequence"><article><span>01 / DEFINE</span><h2>Name the work.</h2><p>Write the outcome before the checklist. Give every project a clear finish line.</p></article><article><span>02 / ASSIGN</span><h2>Own the next step.</h2><p>Make responsibility visible. A small, explicit handoff beats another status meeting.</p></article><article><span>03 / CLOSE</span><h2>Keep the decision.</h2><p>Record what changed and why. Let the next project begin with useful context.</p></article></div></section>
<section class="lower" id="questions"><p class="kicker">Product concept / questions</p><h2>A focused workflow.</h2><details><summary>What is Relay?</summary><p>Relay is a fictional product used to demonstrate a software landing-page direction. Its workflow is illustrative; this preview does not create tasks or provide a separate service.</p></details><details><summary>Why show the process first?</summary><p>Explain the daily job before a visitor reads the feature list. A clear sequence connects the product promise to an understandable way of working.</p></details></section></main>`;

const relayStyles = `
body{background:#151e2d;color:#f4f7fc}header,footer,.lower,details{border-color:#ffffff26}.relay-mark{font-size:16px;display:inline-block;margin-left:8px;color:#b3e2cf}nav{color:#c0ccda}.relay-hero{text-align:center;padding:16px 0 32px}.relay-hero .kicker{color:#b3e2cf}.relay-hero h1{font-size:clamp(40px,6.3vw,78px);font-weight:650;letter-spacing:-3px;line-height:1.02;margin:22px 0}.relay-hero .intro{margin:auto;color:#bdc9d8}.relay-hero .action{background:#b3e2cf;color:#151e2d;border-color:#b3e2cf;border-radius:40px;padding:13px 22px}.relay-flow{border:1px solid #ffffff26;background:#1e2a3b;border-radius:8px;padding:28px;margin-top:18px}.relay-flow>.kicker{color:#b3e2cf}.relay-sequence{display:grid;grid-template-columns:repeat(3,1fr);gap:26px;margin-top:30px}.relay-sequence article>span{font:9px monospace;color:#b3e2cf}.relay-sequence h2{font-size:21px;margin:16px 0}.relay-sequence p{font-size:12px;line-height:1.8;color:#bdc9d8}#questions>.kicker{color:#b3e2cf}#questions>h2{margin:15px 0}@media(max-width:620px){.relay-sequence{grid-template-columns:1fr;gap:24px}.relay-sequence article+article{border-top:1px solid #ffffff26;padding-top:20px}.relay-flow{padding:22px}.relay-hero h1{font-size:48px;letter-spacing:-2px}}
`;

const foldBody = `
<header><a href="#home">FOLD.</a><nav aria-label="Sample navigation"><a href="#stories">Stories</a><a href="#about">About</a></nav></header>
<main id="home"><section class="fold-cover"><div class="fold-mast"><p class="kicker">An independent journal / sample issue</p><h1>Look<br><em>again.</em></h1><p class="intro">Notes on the objects, places and everyday choices that shape how we live.</p></div><a class="fold-feature" href="#story-one"><p class="kicker">The opening essay</p><h2>The things<br>we keep.</h2><p>On repair, attachment and the usefulness of a second life.</p><span>READ THE NOTE ↗</span></a></section>
<section class="lower" id="stories"><div class="fold-section-head"><h2>In this issue</h2><span class="kicker">Reading notes / curated</span></div><article id="story-one"><span class="index">01 / OBJECTS</span><div><h3>The things we keep.</h3><p>What makes an ordinary object worth repairing?</p><details><summary>Read the opening note</summary><p>A worn handle records a habit. Repair asks us to notice the things we already use, and to choose what deserves another season. This short note is original sample copy.</p></details></div></article><article id="story-two"><span class="index">02 / PLACES</span><div><h3>A slower route home.</h3><p>Finding a different view in a familiar neighborhood.</p><details><summary>Read the opening note</summary><p>A different turn changes what we notice: the quiet shopfront, the courtyard behind an open gate, the afternoon light on a wall. An ordinary journey can become a small act of attention.</p></details></div></article></section>
<section class="lower" id="about"><p class="kicker">About the journal</p><h2>Attention is a practice.</h2><p>Fold is a fictional editorial project. This sample explores a reading-first design through typography, article structure and direct navigation.</p></section></main>`;

const foldStyles = `
body{background:#faf7f1;color:#302823}header{border-bottom:2px solid #302823}header>a{font-family:Georgia,serif;font-size:30px;letter-spacing:-2px}.fold-cover{display:grid;grid-template-columns:1.2fr 1fr;gap:30px}.fold-mast h1{font:normal clamp(65px,8vw,108px)/.9 Georgia,serif;letter-spacing:-5px;margin:26px 0}.fold-mast h1 em{color:#ae3527}.fold-mast>.intro{max-width:270px}.fold-feature{display:flex;flex-direction:column;justify-content:space-between;min-height:320px;background:#ad382a;color:#fff6ec;padding:30px}.fold-feature:hover{text-decoration:none;background:#993126}.fold-feature h2{font:normal 42px/1.06 Georgia,serif;letter-spacing:-2px;margin:30px 0}.fold-feature p:not(.kicker){font-size:12px;line-height:1.8;max-width:210px}.fold-feature>span{font:9px monospace;margin-top:28px}.fold-section-head{display:flex;align-items:baseline;justify-content:space-between;gap:16px;margin-bottom:24px}#stories article{display:grid;grid-template-columns:140px 1fr;gap:24px;padding:23px 0;border-top:1px solid #30282333}#stories h3{font-family:Georgia,serif;font-size:24px}#stories article p{font-size:12px;line-height:1.9;margin-top:10px}#stories details{border:0;padding-bottom:0}#stories summary{font-size:11px;color:#993126}#about h2{margin-top:16px;font-family:Georgia,serif}@media(max-width:600px){.fold-cover{grid-template-columns:1fr}.fold-mast h1{font-size:74px}.fold-feature{min-height:230px}.fold-feature h2{margin:22px 0}#stories article{grid-template-columns:1fr;gap:8px}.fold-section-head{display:block}.fold-section-head .kicker{display:block;margin-top:14px}}
`;

export function samplePreview(id, { before = false } = {}) {
  const samples = {
    morrow: { title: 'Morrow — architecture sample', body: morrowBody, css: morrowStyles },
    relay: { title: 'Relay — product sample', body: relayBody, css: relayStyles },
    fold: { title: 'Fold — journal sample', body: foldBody, css: foldStyles },
  };
  if (!Object.hasOwn(samples, id)) throw new Error('Unknown sample preview.');
  const sample = samples[id];
  const beforeCSS = 'body{background:white;color:#222;font:14px Arial,sans-serif}header,main,footer{padding:18px}nav{gap:12px}header>a{font-size:16px}.morrow-hero{display:block}.morrow-hero h1{font:bold 25px/1.3 Arial,sans-serif;letter-spacing:0;margin:18px 0}.plan{display:none}.morrow-projects{display:block}.morrow-projects article{margin-top:20px;border:0;padding:0}.lower{padding-top:18px;margin-top:20px}h2{font:bold 19px/1.4 Arial,sans-serif;letter-spacing:0}.action{padding:0;border:0;text-decoration:underline;color:#255ba6}.kicker{font:12px Arial,sans-serif;letter-spacing:0;text-transform:none}';
  // A srcdoc frame inherits the embedding page's base URL. Explicit srcdoc anchors
  // keep native navigation in the sample without a base element or script permissions.
  const body = sample.body.replaceAll('href="#', 'href="about:srcdoc#');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${sample.title}</title><style>${sampleStyles}${before && id === 'morrow' ? beforeCSS : sample.css}</style></head><body>${body}<footer><span>${id.toUpperCase()} / ORIGINAL CURATED SAMPLE</span><span>Fictional project · not AI generated</span></footer></body></html>`;
}

function initializeLanding() {
  const get = id => document.getElementById(id);
  const form = get('startForm');
  if (!form) return;
  const url = get('startUrl'), brief = get('startBrief'), submit = get('startSubmit');
  const tabs = [...document.querySelectorAll('[data-start-mode]')];
  let mode = 'url';

  function clearErrors() {
    for (const id of ['urlError', 'briefError', 'startError']) {
      get(id).hidden = true;
      get(id).textContent = '';
    }
    url.removeAttribute('aria-invalid');
    brief.removeAttribute('aria-invalid');
  }
  function setMode(next) {
    mode = next;
    tabs.forEach(tab => {
      const selected = tab.dataset.startMode === mode;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
    });
    get('urlField').hidden = mode !== 'url';
    url.disabled = mode !== 'url';
    url.required = mode === 'url';
    brief.required = mode === 'brief';
    get('startFields').setAttribute('aria-labelledby', mode === 'url' ? 'urlTab' : 'briefTab');
    get('briefLabel').textContent = mode === 'url' ? 'What would you like to change? ' : 'Describe the website you want';
    if (mode === 'url') {
      const optional = document.createElement('span');
      optional.textContent = '(optional)';
      get('briefLabel').append(optional);
    }
    brief.placeholder = mode === 'url'
      ? 'A clearer homepage for our architecture practice. Keep the project stories; make the navigation simpler.'
      : 'A website for an independent architecture practice. Audience: prospective clients. Include projects, our approach and a contact section. Structured, quiet and editorial.';
    clearErrors();
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => setMode(tab.dataset.startMode));
    tab.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
        : (index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length;
      setMode(tabs[next].dataset.startMode);
      tabs[next].focus();
    });
  });
  brief.addEventListener('input', () => {
    get('briefCount').textContent = `${brief.value.length.toLocaleString('en-US')} / 8,000`;
    clearErrors();
  });
  url.addEventListener('input', clearErrors);
  form.addEventListener('submit', event => {
    event.preventDefault();
    clearErrors();
    const input = { mode, url: url.value, brief: brief.value };
    const result = validateLandingInput(input);
    if (!result.ok) {
      for (const [field, error] of Object.entries(result.errors)) {
        if (field === 'url' || field === 'brief') {
          const errorNode = get(`${field}Error`);
          errorNode.textContent = error;
          errorNode.hidden = false;
          (field === 'url' ? url : brief).setAttribute('aria-invalid', 'true');
        }
      }
      get('startError').textContent = Object.values(result.errors).join(' ');
      get('startError').hidden = false;
      (result.errors.url ? url : brief).focus();
      return;
    }
    window.location.assign(buildStudioHandoff(input));
  });
  setMode('url');
  submit.disabled = false;

  // Read configuration only. Creation, import, model calls and checkout are explicit studio actions.
  fetch('/api/config', { credentials: 'same-origin', signal: AbortSignal.timeout(8000) })
    .then(async response => {
      if (!response.ok) throw new Error('Configuration unavailable');
      const config = await response.json();
      if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Invalid configuration');
      showConfig(config, 'Workspace availability');
    }).catch(() => showConfig(null, 'Workspace availability could not be verified'));
  function showConfig(config, heading) {
    const notice = workspaceNotice(config);
    get('workspaceStatus').textContent = config ? [
      config.localMode === true ? 'Local session available' : config.localMode === false ? 'Sign-in required' : 'Access not verified',
      config.aiConfigured === true ? 'AI connected' : config.aiConfigured === false ? 'AI not connected' : 'AI not verified',
      config.billingConfigured === true ? 'See paid plans' : config.billingConfigured === false ? 'Checkout unavailable' : 'Billing not verified',
    ].join(' · ') : heading;
    get('authStatus').textContent = notice.auth;
    get('aiStatus').textContent = notice.ai;
    get('billingStatus').textContent = notice.billing;
    get('workspaceDetails').hidden = false;
  }

  document.querySelectorAll('iframe[data-sample]').forEach(frame => {
    frame.srcdoc = samplePreview(frame.dataset.sample, { before: frame.dataset.before === 'true' });
  });
  const dialog = get('sampleDialog'), dialogFrame = get('sampleDialogFrame');
  const deviceButtons = [...document.querySelectorAll('[data-preview-device]')];
  let previewTrigger;
  function previewDevice(device) {
    dialogFrame.dataset.device = device;
    deviceButtons.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.previewDevice === device)));
  }
  document.querySelectorAll('[data-preview-open]').forEach(button => {
    button.addEventListener('click', () => {
      previewTrigger = button;
      const id = button.dataset.previewOpen;
      get('sampleDialogTitle').textContent = `${id[0].toUpperCase()}${id.slice(1)} / sample preview`;
      dialogFrame.title = `${id} original curated sample website`;
      dialogFrame.srcdoc = samplePreview(id);
      previewDevice('desktop');
      dialog.showModal();
      get('closeSample').focus();
    });
  });
  deviceButtons.forEach(button => button.addEventListener('click', () => previewDevice(button.dataset.previewDevice)));
  get('closeSample').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    dialogFrame.srcdoc = '';
    previewTrigger?.focus();
  });
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
  });
}

if (typeof document !== 'undefined') initializeLanding();
