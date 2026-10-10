const URL_LIMIT = 2048;
const BRIEF_LIMIT = 8000;

function publicURL(value) {
  if (value.length > URL_LIMIT) throw new Error('Website URL must be at most 2048 characters.');
  if (!/^https?:\/\//i.test(value) || /[\x00-\x20\x7f\\]/.test(value)) throw new Error('Enter a complete HTTP or HTTPS URL with no control characters or backslashes.');
  let url;
  try { url = new URL(value); } catch { throw new Error('Enter an absolute HTTP or HTTPS website URL without credentials.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('Use an HTTP or HTTPS website URL without credentials.');
  if (url.port && !['80', '443'].includes(url.port)) throw new Error('Import supports standard website ports only.');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  if (host === 'localhost' || /\.(?:localhost|local|internal|test|invalid|lan|home|onion)$/.test(host) || !host.includes('.') && !host.includes(':'))
    throw new Error('Use a public website, not a local or internal address.');
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const [a,b,c] = host.split('.').map(Number);
    if (a===0 || a===10 || a===127 || a>=224 || a===100&&b>=64&&b<=127 || a===169&&b===254 || a===172&&b>=16&&b<=31 || a===192&&[0,2,168].includes(b) || a===198&&(b===18||b===19||b===51&&c===100) || a===203&&b===0&&c===113)
      throw new Error('Use a public website, not a private or reserved address.');
  } else if (host.includes(':') && (!/^[23][0-9a-f]{0,3}:/.test(host) || /^2001:(?:db8|0|10|20|2):/.test(host) || host.startsWith('2001::') || host.startsWith('2002:') || host.startsWith('3fff:'))) {
    throw new Error('Use a public website, not a private or reserved address.');
  }
  if (url.href.length > URL_LIMIT) throw new Error('Website URL must be at most 2048 characters.');
  url.hash = '';
  return url.href;
}

// Navigation is a prefill contract only. This module has no fetch or storage side effects.
export function parseStartHash(hash) {
  const raw = String(hash || '').replace(/^#/, '');
  if (!/^start(?:=|&|$)/.test(raw) && !/(?:^|&)start=1(?:&|$)/.test(raw)) return null;
  const draft = {mode:'brief', name:'', brief:'', url:'', error:''};
  if (raw === 'start') return draft;
  if (raw.length > 150000) return {...draft, error:'The project handoff is too long. Enter the details here.'};
  try {
    const params = new URLSearchParams();
    for (const part of raw.split('&')) {
      const split = part.indexOf('=');
      const key = decodeURIComponent((split < 0 ? part : part.slice(0, split)).replace(/\+/g, ' '));
      const value = decodeURIComponent((split < 0 ? '' : part.slice(split + 1)).replace(/\+/g, ' '));
      if (params.has(key) && ['start', 'mode', 'url', 'brief'].includes(key)) throw new Error('The project handoff contains duplicate fields.');
      params.append(key, value);
    }
    if (params.get('start') !== '1') return null;
    const mode = params.get('mode') || 'brief';
    if (!['url', 'brief'].includes(mode)) throw new Error('Choose website URL or design brief to start.');
    draft.mode = mode;
    const brief = params.get('brief') || '';
    draft.brief = brief.slice(0, BRIEF_LIMIT);
    if (brief.length > BRIEF_LIMIT) draft.error = 'The brief was shortened to 8000 characters. Review it before creating.';
    if (mode === 'url' && params.get('url')) draft.url = publicURL(params.get('url').trim());
    return draft;
  } catch (error) {
    draft.url = '';
    draft.error = error instanceof URIError ? 'The project handoff has invalid text encoding. Enter the details here.' : error.message;
    return draft;
  }
}

export function validateStartInput(input) {
  if (!['url', 'brief'].includes(input.mode)) throw new Error('Choose website URL or design brief to start.');
  const name = String(input.name || '').trim();
  const rawBrief = String(input.brief || '');
  if (!name || name.length > 100) throw new Error('Enter a project name of 1–100 characters.');
  if (rawBrief.length > BRIEF_LIMIT) throw new Error('Design brief must be at most 8000 characters.');
  return {mode:input.mode, name, brief:rawBrief.trim(), url:input.mode === 'url' ? publicURL(String(input.url || '').trim()) : ''};
}

export function previewScale(width) {
  return Number.isFinite(width) && width > 0 ? Math.min(width / 1200, 1) : 0;
}

// Called only by explicit form submission after authentication. A successful
// import and created project are retained so a retry does not repeat those steps.
function bindStartOwner(draft, ownerId) {
  if (typeof ownerId !== 'string' || !ownerId) throw new Error('Sign in to the project owner account to continue.');
  if (draft.ownerId && draft.ownerId !== ownerId) throw new Error('This retained project belongs to another account. Start a new project in your current account.');
  if (!draft.ownerId && (draft.createdProject || draft.importedSource)) throw new Error('The retained project owner cannot be verified. Start a new project in your current account.');
  draft.ownerId = ownerId;
}

function comparable(value) {
  if (Array.isArray(value)) return value.map(comparable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key=>[key,comparable(value[key])]));
  return value;
}
const sameValue = (a,b) => JSON.stringify(comparable(a)) === JSON.stringify(comparable(b));

export function reconcileStartProject(draft, project, input, source) {
  if (!draft.applied) {
    if (draft.copyFields) Object.assign(project, structuredClone(draft.copyFields), {name:input.name,brief:input.brief});
    draft.applied = true;
  }
  // Server reload may remove a source that previously failed to save. Reconcile
  // it on every retry, without replaying the sample or replacing newer edits.
  if (source && !sameValue(project.source, source)) project.source = structuredClone(source);
}

export function assertStartSaved(draft, saved, ownerId) {
  bindStartOwner(draft, ownerId);
  if (saved?.id !== draft.createdProject?.id) throw new Error('The server did not confirm the retained project was saved.');
  if (draft.mode === 'url' && (!draft.importedSource || !sameValue(saved.source, draft.importedSource)))
    throw new Error('The imported source was not confirmed in the saved project. Your source is retained; retry saving.');
}

export async function prepareStartProject(input, draft, request, ownerId) {
  bindStartOwner(draft, ownerId);
  const clean = validateStartInput(input);
  if (clean.mode === 'url' && (!draft.importedSource || draft.importedURL !== clean.url)) {
    const {source} = await request('/api/import', {method:'POST', body:{url:clean.url}});
    if (!source || typeof source.text !== 'string') throw new Error('The import API returned no readable source.');
    draft.importedSource = source;
    draft.importedURL = clean.url;
  }
  if (!draft.createdProject) {
    const {project} = await request('/api/projects', {method:'POST', body:{name:clean.name, brief:clean.brief}});
    if (!project?.id) throw new Error('The project API did not confirm a created project.');
    draft.createdProject = project;
  }
  return {project:draft.createdProject, source:clean.mode === 'url' ? draft.importedSource : null};
}
