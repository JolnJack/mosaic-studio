import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { load } from 'cheerio';

const landing = await import('../landing.mjs').catch(error => {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  return {};
});
const html = await readFile(new URL('../landing.html', import.meta.url), 'utf8');
const $ = load(html);

test('URL mode accepts explicit public HTTP(S) and canonicalizes the address', () => {
  assert.equal(typeof landing.validateLandingInput, 'function');
  for (const url of ['https://example.com/work', 'http://www.example.org/', 'https://8.8.8.8/', 'https://[2606:4700:4700::1111]/']) {
    assert.equal(landing.validateLandingInput({ mode: 'url', url, brief: '' }).ok, true, url);
  }
  assert.deepEqual(landing.validateLandingInput({ mode: 'url', url: ' https://EXAMPLE.com/work#about ', brief: ' Keep the copy. ' }).value,
    { mode: 'url', url: 'https://example.com/work', brief: 'Keep the copy.' });
});

test('URL mode rejects missing, ambiguous, credentialed, private and reserved targets', () => {
  assert.equal(typeof landing.validateLandingInput, 'function');
  const invalid = ['', 'example.com', '//example.com', 'javascript:alert(1)', 'file:///tmp/a', 'https://user:secret@example.com',
    'https://example.com:3000/', 'http://localhost/', 'http://LOCALHOST./', 'http://x.localhost/', 'http://intranet/',
    'http://x.local/', 'http://x.local./', 'http://x.internal/', 'http://x.lan/', 'http://x.test/',
    'http://127.0.0.1', 'http://127.1', 'http://2130706433', 'http://0x7f000001', 'http://0.0.0.0/',
    'http://10.0.0.1', 'http://172.31.0.1', 'http://192.168.1.1', 'http://169.254.169.254', 'http://100.64.0.1',
    'http://192.0.2.1', 'http://198.18.0.1', 'http://198.51.100.1', 'http://203.0.113.1', 'http://224.0.0.1',
    'http://[::1]', 'http://[fd00::1]', 'http://[fe80::1]', 'http://[::ffff:127.0.0.1]', 'http://[2001:db8::1]',
    'http://[2002:0808:0808::1]', 'https://exam\nple.com/', 'https://example.com\\x', `https://example.com/${'x'.repeat(2048)}`];
  for (const url of invalid) {
    const result = landing.validateLandingInput({ mode: 'url', url });
    assert.equal(result.ok, false, url);
    assert.equal(typeof result.errors.url, 'string', url);
  }
});

test('brief mode requires meaningful text and never carries a stale hidden URL', () => {
  assert.equal(typeof landing.validateLandingInput, 'function');
  assert.equal(landing.validateLandingInput({ mode: 'brief', brief: '  \n ' }).ok, false);
  assert.deepEqual(landing.validateLandingInput({ mode: 'brief', brief: ' A studio for potters. ', url: 'http://localhost/' }).value,
    { mode: 'brief', brief: 'A studio for potters.' });
  assert.equal(landing.validateLandingInput({ mode: 'unexpected', brief: 'A brief' }).ok, false);
});

test('URL mode requires an explicit scheme and screens special home-network names', () => {
  for (const url of ['https:example.com', 'http:/example.com', 'https:///example.com', 'https://router.home.arpa/']) {
    assert.equal(landing.validateLandingInput({ mode: 'url', url }).ok, false, url);
  }
});

test('both modes enforce the 8000 character brief limit without silently truncating', () => {
  assert.equal(typeof landing.validateLandingInput, 'function');
  for (const mode of ['brief', 'url']) {
    const input = { mode, url: 'https://example.com', brief: 'x'.repeat(8000) };
    assert.equal(landing.validateLandingInput(input).ok, true);
    assert.equal(landing.validateLandingInput({ ...input, brief: 'x'.repeat(8001) }).errors.brief.includes('8,000'), true);
    assert.equal(landing.validateLandingInput({ ...input, brief: { content: 'wrong type' } }).ok, false);
  }
});

test('handoff keeps Unicode, delimiters and multiline brief only inside the fragment', () => {
  assert.equal(typeof landing.buildStudioHandoff, 'function');
  const brief = 'A café & studio\nCopy: #plan=pro + 你好 / ?paid=1';
  const target = new URL(landing.buildStudioHandoff({ mode: 'url', url: 'https://example.com/?a=1&b=2', brief }), 'https://mosaic.example');
  assert.equal(target.pathname, '/app');
  assert.equal(target.search, '');
  const params = new URLSearchParams(target.hash.slice(1));
  assert.deepEqual([...params.keys()], ['start', 'mode', 'url', 'brief']);
  assert.equal(params.get('start'), '1');
  assert.equal(params.get('mode'), 'url');
  assert.equal(params.get('url'), 'https://example.com/?a=1&b=2');
  assert.equal(params.get('brief'), brief);
  const fromBrief = new URLSearchParams(landing.buildStudioHandoff({ mode: 'brief', brief, url: 'https://ignored.example' }).split('#')[1]);
  assert.equal(fromBrief.has('url'), false);
  assert.equal(fromBrief.get('brief'), brief);
  assert.throws(() => landing.buildStudioHandoff({ mode: 'url', url: 'http://localhost' }));
});

test('configuration notice distinguishes enabled, disabled and unreported state', () => {
  assert.equal(typeof landing.workspaceNotice, 'function');
  const enabled = landing.workspaceNotice({ aiConfigured: true, billingConfigured: true, localMode: false, registrationEnabled: true });
  assert.match(enabled.ai, /connected/i);
  assert.match(enabled.billing, /paid|recurring/i);
  assert.match(enabled.auth, /sign in/i);
  const disabled = landing.workspaceNotice({ aiConfigured: false, billingConfigured: false, localMode: true });
  assert.match(disabled.ai, /not connected/i);
  assert.match(disabled.billing, /unavailable/i);
  assert.match(disabled.auth, /local/i);
  const unknown = landing.workspaceNotice(null);
  assert.match(unknown.ai, /not verified/i);
  assert.match(unknown.billing, /not verified/i);
  assert.match(unknown.auth, /not verified/i);
  assert.match(landing.workspaceNotice({ aiConfigured: 'true' }).ai, /not verified/i);
});

test('three original sample documents work without remote assets, scripts or claimed customer proof', () => {
  assert.equal(typeof landing.samplePreview, 'function');
  const documents = ['morrow', 'relay', 'fold'].map(id => landing.samplePreview(id));
  assert.equal(new Set(documents).size, 3);
  for (const preview of documents) {
    const dom = load(preview);
    assert.equal(dom('h1').length, 1);
    assert.ok(dom('a').length > 0);
    assert.equal(dom('script, img, iframe, link, form').length, 0);
    assert.match(dom('footer').text(), /curated sample/i);
    assert.doesNotMatch(preview, /https?:\/\//);
  }
  assert.notEqual(landing.samplePreview('morrow', { before: true }), documents[0]);
  assert.throws(() => landing.samplePreview('unknown'));
});

test('sample navigation targets sections inside srcdoc instead of reloading the landing page', () => {
  for (const id of ['morrow', 'relay', 'fold']) {
    const dom = load(landing.samplePreview(id));
    dom('a').each((_, link) => {
      const href = dom(link).attr('href');
      assert.match(href, /^about:srcdoc#[a-z-]+$/);
      assert.equal(dom(`[id="${href.split('#')[1]}"]`).length, 1);
    });
  }
});

test('landing retains dynamic pricing and supplies semantic form and sample controls', () => {
  assert.equal($('#startForm').length, 1);
  assert.equal($('#startForm').attr('method'), 'dialog', 'no native GET may leak a brief if JavaScript fails');
  assert.equal($('#startUrl').attr('type'), 'url');
  assert.equal($('#startBrief').attr('maxlength'), '8000');
  for (const id of ['startUrl', 'startBrief']) assert.equal($(`label[for="${id}"]`).length, 1);
  assert.equal($('[role="tablist"] [role="tab"]').length, 2);
  assert.equal($('#startSubmit').text().trim(), 'Continue to studio');
  assert.equal($('#startSubmit').attr('disabled'), 'disabled');
  for (const id of ['pricingInterval', 'pricingCards', 'pricingStatus']) assert.equal($(`#${id}`).length, 1);
  assert.equal($('script[src="/pricing.mjs"]').length, 1);
  assert.equal($('script[src="/landing.mjs"]').length, 1);
  assert.equal($('[data-preview-open]').length, 3);
  assert.equal($('iframe[data-sample]').length, 5);
  $('iframe').each((_, frame) => {
    assert.equal($(frame).attr('sandbox'), '');
    assert.ok($(frame).attr('title'));
  });
  assert.match($('h1').text(), /Your website\.\s*A new point of view\./);
});
