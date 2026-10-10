import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {parseStartHash, validateStartInput, previewScale} from '../studio-ui.mjs';
import * as studioUI from '../studio-ui.mjs';
const prepareStartProject=(input,draft,request,ownerId='A')=>studioUI.prepareStartProject(input,draft,request,ownerId);
import {seedVariants, createSection, SECTION_TYPES, renderDocument} from '../core.mjs';
import {importUrl} from '../import.mjs';
import {canonicalSource} from '../server.mjs';

test('URL handoff decodes once and returns only a prefill draft', () => {
  const draft = parseStartHash('#start=1&mode=url&url=https%3A%2F%2Fexample.com%2Fa%3Fx%3D1%26y%3D2&brief=Keep+%2520+literal');
  assert.equal(draft.mode, 'url');
  assert.equal(draft.url, 'https://example.com/a?x=1&y=2');
  assert.equal(draft.brief, 'Keep %20 literal');
  assert.equal(draft.error, '');
  assert.equal(draft.projectId, undefined);
});
test('plain start and brief handoffs support empty optional brief', () => {
  assert.equal(parseStartHash('#start').mode, 'brief');
  assert.equal(parseStartHash('#start=1&mode=brief&brief=Portfolio').brief, 'Portfolio');
  assert.equal(validateStartInput({mode:'brief', name:'Studio', brief:''}).brief, '');
  assert.equal(parseStartHash('#unrelated=1'), null);
  assert.equal(parseStartHash('#start=0'), null);
});
test('credentialed and non-HTTP URLs are rejected without usable prefill', () => {
  for (const url of ['https://user:secret@example.com', 'javascript:alert(1)', 'file:///tmp/a', '//example.com', 'https://']) {
    assert.throws(() => validateStartInput({mode:'url', name:'Studio', url}), /HTTP|credentials/i);
    const draft = parseStartHash(`#start=1&mode=url&url=${encodeURIComponent(url)}`);
    assert.equal(draft.url, '');
    assert.ok(draft.error);
  }
});
test('malformed escapes, duplicate fields and unsupported modes fail safely', () => {
  for (const hash of ['#start=1&mode=url&url=%ZZ', '#start=1&mode=brief&brief=%E0%A4%A', '#start=1&mode=url&mode=brief', '#start=1&mode=unknown']) {
    assert.ok(parseStartHash(hash).error, hash);
  }
});
test('handoffs are bounded and explicit submission rejects oversized values', () => {
  const draft = parseStartHash(`#start=1&mode=brief&brief=${'a'.repeat(8001)}`);
  assert.equal(draft.brief.length, 8000);
  assert.ok(draft.error);
  assert.throws(() => validateStartInput({mode:'brief', name:'Studio', brief:'a'.repeat(8001)}), /8000/);
  assert.throws(() => validateStartInput({mode:'url', name:'Studio', url:`https://example.com/${'a'.repeat(2048)}`}), /2048/);
  assert.throws(() => validateStartInput({mode:'brief', name:' '}), /name/i);
});
test('submitted fields normalize URL and ignore hidden URL in brief mode', () => {
  assert.deepEqual(validateStartInput({mode:'url', name:' Studio ', brief:' hello ', url:' https://EXAMPLE.com '}), {mode:'url', name:'Studio', brief:'hello', url:'https://example.com/'});
  assert.equal(validateStartInput({mode:'brief', name:'Studio', url:'javascript:bad'}).url, '');
});
test('obvious private, reserved and nonstandard-port import targets fail before creation', () => {
  for (const url of ['http://localhost', 'https://a.localhost', 'http://127.1', 'http://2130706433', 'https://10.2.3.4', 'https://192.168.1.1', 'http://169.254.169.254', 'https://172.16.0.1', 'https://192.0.2.1', 'https://224.0.0.1', 'http://[::1]', 'https://[fc00::1]', 'https://[::ffff:127.0.0.1]', 'https://example.com:8443', 'http://app.internal', 'http://app.local', 'https://app.test', 'http://x.lan', 'http://x.home', 'http://x.onion']) {
    assert.throws(() => validateStartInput({mode:'url', name:'Studio', url}), /public|port|local/i, url);
    assert.ok(parseStartHash(`#start=1&mode=url&url=${encodeURIComponent(url)}`).error, url);
  }
});
test('ambiguous URL syntax is rejected instead of silently normalized', () => {
  for(const url of ['https:example.com', 'https://exam\nple.com/', 'https://example.com\\x'])
    assert.throws(() => validateStartInput({mode:'url',name:'Studio',url}), /HTTP|public|URL/i);
  assert.equal(validateStartInput({mode:'url',name:'Studio',url:'https://example.com/work#about'}).url, 'https://example.com/work');
});
test('miniatures fit a 1200 by 750 document without overflow or enlargement', () => {
  assert.equal(previewScale(300), 0.25);
  assert.equal(previewScale(1500), 1);
  assert.equal(previewScale(0), 0);
  assert.equal(previewScale(Number.NaN), 0);
});
test('explicit URL submission imports before creating and reuses partial success on retry', async () => {
  const draft={};const paths=[];let createAttempts=0;
  const request=async (path, options) => {
    paths.push(path);assert.equal(options.method, 'POST');
    if(path==='/api/import') return {source:{url:'https://example.com/',text:'Real imported content'}};
    if(++createAttempts===1) throw new Error('Create unavailable');
    return {project:{id:'real-project'}};
  };
  const input={mode:'url',name:'Studio',url:'https://example.com/'};
  await assert.rejects(prepareStartProject(input,draft,request), /unavailable/);
  const result=await prepareStartProject(input,draft,request);
  await prepareStartProject(input,draft,request);
  assert.equal(result.project.id, 'real-project');
  assert.equal(result.source.text, 'Real imported content');
  assert.deepEqual(paths, ['/api/import','/api/projects','/api/projects']);
});
test('failed import never creates a project or calls generation or billing', async () => {
  const paths=[];
  await assert.rejects(prepareStartProject({mode:'url',name:'Studio',url:'https://example.com'}, {}, async path=>{paths.push(path);throw new Error('Import failed');}), /Import failed/);
  assert.deepEqual(paths, ['/api/import']);
});
test('brief submission creates once without import; invalid input makes no request', async () => {
  const paths=[];const draft={};const request=async path=>{paths.push(path);return {project:{id:'brief-project'}};};
  const input={mode:'brief',name:'Studio',brief:'My brief'};
  await prepareStartProject(input,draft,request);await prepareStartProject(input,draft,request);
  assert.deepEqual(paths, ['/api/projects']);
  await assert.rejects(prepareStartProject({mode:'url',name:'Studio',url:'http://localhost'}, {}, request), /public|local/i);
  assert.deepEqual(paths, ['/api/projects']);
});
test('all three actual variant previews render without an editing bridge', () => {
  const variants=seedVariants('Independent studio');
  const html=variants.map(v => renderDocument(v.document, {editing:false}));
  assert.equal(new Set(html).size, 3);
  for (const output of html) assert.doesNotMatch(output, /<script|mosaic-select|data-edit=/i);
});
test('section library can render every actual section in the active theme', () => {
  const document=seedVariants('Studio')[1].document;
  for (const type of SECTION_TYPES) {
    const section=createSection(type, 1);
    const output=renderDocument({...document, pages:[{id:'library', name:'Section', path:'/', sections:[section]}]}, {editing:false});
    assert.ok(output.includes(document.theme.background));
    assert.ok(output.includes(section.title));
    assert.doesNotMatch(output, /<script/i);
  }
});

test('owner change rejects a retained project before making any request', async () => {
  const draft={ownerId:'A',createdProject:{id:'project-A'},applied:true};const paths=[];
  await assert.rejects(prepareStartProject({mode:'brief',name:'Studio'},draft,async path=>{paths.push(path);return {};},'B'), /account|owner/i);
  assert.deepEqual(paths,[]);
  assert.equal(draft.createdProject.id,'project-A');
});
test('same-owner retry retains prefill and reuses the confirmed project', async () => {
  const draft={ownerId:'A',name:'Kept name',brief:'Kept brief',createdProject:{id:'project-A'}};
  const result=await prepareStartProject({mode:'brief',name:draft.name,brief:draft.brief},draft,()=>assert.fail('No request on cached retry'),'A');
  assert.equal(result.project.id,'project-A');assert.equal(draft.name,'Kept name');assert.equal(draft.brief,'Kept brief');
});
test('applied draft reconciles missing source after server reload without reapplying sample fields', () => {
  assert.equal(typeof studioUI.reconcileStartProject,'function');
  const importedSource={url:'https://example.com/',text:'Real source',title:'Imported'};
  const draft={applied:true,importedSource,copyFields:{name:'Old sample',variants:['Old sample variants']}};
  const current={id:'project-A',revision:4,name:'Server name',source:null,variants:['Retained server variants']};
  const before=structuredClone(current);
  studioUI.reconcileStartProject(draft,current,{name:'Studio',brief:''},importedSource);
  assert.deepEqual(current.source,importedSource);
  assert.equal(current.name,before.name);assert.deepEqual(current.variants,before.variants);
  assert.equal(current.revision,4);assert.equal(draft.applied,true);
  current.variants=['New edits'];studioUI.reconcileStartProject(draft,current,{name:'Studio',brief:''},importedSource);
  assert.deepEqual(current.variants,['New edits']);
});
test('saved-source assertion refuses false success and accepts confirmed matching source', () => {
  assert.equal(typeof studioUI.assertStartSaved,'function');
  const source={url:'https://example.com/',text:'Real source'};
  const draft={ownerId:'A',mode:'url',createdProject:{id:'project-A'},importedSource:source};
  assert.throws(()=>studioUI.assertStartSaved(draft,{id:'project-A',source:null},'A'),/source|saved/i);
  assert.throws(()=>studioUI.assertStartSaved(draft,{id:'project-A',source:{...source,text:'Different'}},'A'),/source|saved/i);
  assert.throws(()=>studioUI.assertStartSaved(draft,{id:'project-A',source},'B'),/account|owner/i);
  assert.doesNotThrow(()=>studioUI.assertStartSaved(draft,{id:'project-A',revision:5,source:{text:source.text,url:source.url}},'A'));
});
test('actual explicit sign-out clears both start caches only after logout succeeds', async () => {
  const app=await readFile(new URL('../app.js',import.meta.url),'utf8');
  const accountCode=app.slice(app.indexOf('function accountDialog()'),app.indexOf('function showSource()'));
  const clearCode=app.match(/function clearStartCaches\(\)\{[^}]*\}/)?.[0]||'';
  const buttons=[];let shouldFail=true,logoutOperation;const context=vm.createContext({
    state:{user:{id:'A',name:'A',email:'a@example.com'}},sessions:new Map(),
    modal:()=>({append(){}}),paragraph:()=>({}),button:(label,css,action)=>{buttons.push({label,action});return {};},
    run:(label,action)=>{logoutOperation=action().catch(error=>error);return logoutOperation;},api:async path=>{assert.equal(path,'/api/auth/logout');if(shouldFail)throw new Error('Logout failed');},
    sample:()=>({}),session:p=>p,activate(){},renderAccount(){},toast(){},$:()=>({close(){}}),anyDirty:()=>false,
  });
  vm.runInContext(`let startDraft={ownerId:'A',createdProject:{id:'project-A'}},pendingStart={brief:'Queued'};${clearCode}\n${accountCode}\naccountDialog();`,context);
  buttons[0].action();assert.match((await logoutOperation).message,/Logout failed/);
  assert.equal(vm.runInContext('startDraft.createdProject.id',context),'project-A');
  shouldFail=false;buttons[0].action();await logoutOperation;
  assert.equal(vm.runInContext('startDraft',context),null);assert.equal(vm.runInContext('pendingStart',context),null);
});
test('actual retry integration records undo after source reconciliation and refuses missing saved source', async () => {
  const app=await readFile(new URL('../app.js',import.meta.url),'utf8');
  const start=app.indexOf('const result=await prepareStartProject(input,draft,api,');
  const retryCode=app.slice(start,app.indexOf('\n  } catch(error)',start));
  const source={url:'https://example.com/',text:'Imported source'};
  const draft={ownerId:'A',mode:'url',name:'Studio',url:source.url,importedURL:source.url,importedSource:source,createdProject:{id:'project-A'},applied:true,copyFields:{name:'Old sample'}};
  const current={project:{id:'project-A',name:'Server edits',source:null,variants:['Server edits'],brief:'',activeVariant:'v1',revision:4},undo:[{earlier:'undo'}],redo:[{earlier:'redo'}]};
  const fields=p=>({name:p.name,brief:p.brief,source:p.source,variants:p.variants,activeVariant:p.activeVariant});
  const messages=[];let returnMissing=true;let savedPayload;
  const context=vm.createContext({
    draft,input:{mode:'url',name:'Studio',brief:'',url:source.url},state:{user:{id:'A'}},sessions:new Map([['project-A',current]]),
    ...studioUI,api:()=>assert.fail('Cached import and creation must make no request'),session:()=>assert.fail('Must reuse existing session'),
    activate(){},project:()=>current.project,clone:structuredClone,fields,fingerprint:p=>JSON.stringify(fields(p)),render(){},
    saveInternal:async()=>{savedPayload=structuredClone(current.project);return {...savedPayload,source:returnMissing?null:savedPayload.source};},
    $:()=>({close(){}}),toast:message=>messages.push(message),
  });
  vm.runInContext('let startDraft=draft;',context);
  await assert.rejects(vm.runInContext(`(async()=>{${retryCode}})()`,context),/source|saved/i);
  assert.deepEqual(savedPayload.source,source);assert.equal(savedPayload.name,'Server edits');
  assert.equal(current.undo.length,2);assert.equal(current.undo[1].source,null);assert.equal(current.redo.length,0);
  assert.equal(messages.length,0);assert.equal(vm.runInContext('startDraft===draft',context),true);
  returnMissing=false;await vm.runInContext(`(async()=>{${retryCode}})()`,context);
  assert.equal(current.undo.length,2);assert.equal(messages.length,1);assert.equal(vm.runInContext('startDraft',context),null);
});
test('real importer and server canonical source roundtrip satisfy the saved-source assertion', async () => {
  const html='<!doctype html><title> Example Domain </title><meta name="description" content=" A source fixture "><nav><a href="/about"> About </a></nav><main><h1>Example Domain</h1><p>This actual importer fixture has readable content to preserve through both API normalizations, with headings, links, and image references.</p><h2>Services</h2><p> Original copy. </p><a href="/contact">Contact</a><img src="https://example.com/photo.jpg" alt=" Sample image "><script>neverExecuted()</script></main>';
  const imported=await importUrl('https://example.com/',{
    resolver:async()=>[{address:'93.184.216.34',family:4}],transport:async()=>({html}),
  });
  // /api/import canonicalizes the real extractor output. Project PUT uses the
  // same canonicalSource after a JSON roundtrip, and the store keeps that JSON.
  const apiSource=canonicalSource({...imported,unknownField:'must be omitted'});
  const savedSource=canonicalSource(JSON.parse(JSON.stringify(apiSource)));
  const draft={ownerId:'A',mode:'url',createdProject:{id:'project-A'},importedSource:apiSource};
  assert.equal(Object.hasOwn(apiSource,'unknownField'),false);
  assert.equal(apiSource.navigation[0].text,'About');assert.ok(apiSource.importedAt);
  assert.deepEqual(savedSource,apiSource);
  assert.doesNotThrow(()=>studioUI.assertStartSaved(draft,{id:'project-A',revision:5,source:savedSource},'A'));
  assert.throws(()=>studioUI.assertStartSaved(draft,{id:'project-A',revision:5,source:null},'A'),/source|saved/i);
});
