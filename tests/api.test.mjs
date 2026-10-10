import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import http from 'node:http';
import {createApp,canonicalSource} from '../server.mjs';
import {seedVariants} from '../core.mjs';
async function setup(t,options={}){
 const dir=mkdtempSync(join(tmpdir(),'mosaic-api-'));
 const app=await createApp({dataDir:dir,env:{NODE_ENV:'test',LOCAL_WORKSPACE:'0',REGISTRATION_ENABLED:'1'},...options});
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 const origin=`http://127.0.0.1:${app.server.address().port}`;
 t.after(async()=>{await new Promise(resolve=>app.server.close(resolve));if(app.close)await app.close();else app.store.close();rmSync(dir,{recursive:true,force:true});});
 function client(){let cookie='';return async(method,path,body,headers={})=>{
  const response=await fetch(origin+path,{method,headers:{...(cookie?{Cookie:cookie}:{}),...(method!=='GET'?{Origin:origin,'Content-Type':'application/json'}:{}),...headers},...(body!==undefined?{body:JSON.stringify(body)}:{})});
  if(response.headers.get('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];
  const contentType=response.headers.get('content-type')||'';const data=contentType.includes('json')?await response.json():contentType.includes('zip')?Buffer.from(await response.arrayBuffer()):await response.text();return {status:response.status,data,response};
 };}
 return {app,origin,client};
}
const user=(name)=>({email:`${name}@example.test`,name,password:'Very-long-fixture-password-42'});
test('import semantic sections and navigation persist and reach the AI provider',async t=>{
 const source={url:'https://example.com',title:'Imported',contentSections:[{heading:'  Services  ',body:'  Repair and maintenance  '}],navigation:[{text:'  About  ',href:'https://example.com/about'},{text:'Unsafe',href:'javascript:alert(1)'}]};
 let delivered;
 const {client}=await setup(t,{importer:async()=>source,aiProvider:{providerType:'anthropic',generate:async(brief,input)=>{delivered=input;return seedVariants(brief,input);}}}),a=client();
 await a('POST','/api/auth/register',user('semantics'));
 const imported=(await a('POST','/api/import',{url:source.url})).data.source;
 assert.deepEqual(imported.contentSections,[{heading:'Services',body:'Repair and maintenance'}]);assert.deepEqual(imported.navigation,[{text:'About',href:'https://example.com/about'}]);
 let p=(await a('POST','/api/projects',{name:'Semantics'})).data.project;
 p=(await a('PUT',`/api/projects/${p.id}`,{...p,source:imported})).data.project;
 assert.deepEqual((await a('GET',`/api/projects/${p.id}`)).data.project.source.contentSections,imported.contentSections);
 assert.equal((await a('POST',`/api/projects/${p.id}/generate`,{revision:p.revision})).status,200);assert.deepEqual(delivered.contentSections,imported.contentSections);assert.deepEqual(delivered.navigation,imported.navigation);
 assert.equal((await a('GET','/api/config')).data.aiProviderType,'anthropic');
});
test('semantic source fields retain optionality and enforce length, count and safe URL bounds',()=>{
 const base={url:'https://example.com'};assert.equal(Object.hasOwn(canonicalSource(base),'contentSections'),false);
 for(const extra of [{contentSections:Array(13).fill({heading:'x',body:'y'})},{navigation:Array(16).fill({text:'x',href:'/'})},{contentSections:[{heading:'x'.repeat(301),body:''}]},{contentSections:[{heading:'',body:'x'.repeat(2001)}]},{navigation:[{text:'x'.repeat(161),href:'/'}]},{contentSections:null},{navigation:[null]}])assert.throws(()=>canonicalSource({...base,...extra}),e=>e.status===422);
 const normalized=canonicalSource({...base,contentSections:[{heading:'x'.repeat(300),body:'y'.repeat(2000),secret:'omit'}],navigation:[{text:'Valid',href:'/about'},{text:'Bad',href:'https://user:pass@example.com'}]});assert.equal(normalized.contentSections[0].body.length,2000);assert.equal(Object.hasOwn(normalized.contentSections[0],'secret'),false);assert.deepEqual(normalized.navigation,[{text:'Valid',href:'/about'}]);
});
test('config exposes matching provider aliases for both frontend contracts',async t=>{
 const {client}=await setup(t,{aiProvider:{providerType:'anthropic',generate:async()=>seedVariants()}});
 const result=await client()('GET','/api/config');assert.equal(result.data.providerType,'anthropic');assert.equal(result.data.aiProviderType,result.data.providerType);
});
test('public plans, provider type, strict checkout selection and project caps',async t=>{
 const {client}=await setup(t,{env:{NODE_ENV:'test',AI_STUDIO_LIMIT:'700',PROJECT_FREE_LIMIT:'1'},aiProvider:{providerType:'local',generate:async()=>seedVariants()}}),a=client();
 const catalog=await a('GET','/api/plans');assert.equal(catalog.status,200);assert.equal(catalog.data.currency,'usd');assert.equal(catalog.data.billingConfigured,false);assert.deepEqual(catalog.data.plans.map(p=>p.id),['free','pro','studio','business']);assert.equal(catalog.data.plans[2].limit,700);assert.equal(catalog.data.plans[0].projectLimit,1);
 assert.equal((await a('GET','/api/config')).data.aiProviderType,'local');assert.equal((await a('GET','/plans.mjs')).status,200);
 await a('POST','/api/auth/register',user('commercial'));const p=(await a('POST','/api/projects',{name:'Only project'})).data.project;
 assert.equal((await a('POST','/api/projects',{name:'Over cap'})).data.code,'PROJECT_LIMIT');assert.equal((await a('PUT',`/api/projects/${p.id}`,{...p,name:'Can edit'})).status,200);
 for(const body of [{plan:'unknown'},{plan:'free'},{plan:'pro',interval:'weekly'},{plan:'pro',interval:null}])assert.equal((await a('POST','/api/billing/checkout',body)).status,422);
 assert.equal((await a('POST','/api/billing/checkout',{plan:'studio',interval:'yearly'})).status,503);
 const info=(await a('GET','/api/billing')).data;assert.equal(info.plans.length,4);assert.equal(info.plan,'free');assert.equal(info.subscription,null);
});
test('configured public plans expose only independently configured intervals and no Stripe secrets',async t=>{
 const {client}=await setup(t,{env:{NODE_ENV:'test',STRIPE_SECRET_KEY:'sk_private',STRIPE_WEBHOOK_SECRET:'whsec_private',STRIPE_PRICE_PRO:'price_legacy',STRIPE_PRICE_STUDIO_YEARLY:'price_studio'}}),a=client();
 const result=await a('GET','/api/plans');assert.equal(result.status,200);assert.equal(result.data.billingConfigured,true);
 assert.equal(result.data.plans[1].intervals.monthly.available,true);assert.equal(result.data.plans[1].intervals.yearly.available,false);assert.equal(result.data.plans[2].intervals.yearly.available,true);assert.equal(result.data.plans[3].intervals.monthly.available,false);
 assert.doesNotMatch(JSON.stringify(result.data),/sk_private|whsec_private|price_legacy|price_studio/);
 assert.equal((await a('GET','/api/config')).data.aiProviderType,'compatible');assert.equal((await a('GET','/pricing.mjs')).status,200);
 assert.equal((await a('GET','/api/billing')).status,401);
});
test('real signup/login/logout cookie flow and password failures',async t=>{
 const {client}=await setup(t),a=client();let r=await a('POST','/api/auth/register',user('alice'));assert.equal(r.status,201);assert.ok(r.response.headers.get('set-cookie').includes('HttpOnly'));assert.equal((await a('GET','/api/me')).data.user.email,'alice@example.test');await a('POST','/api/auth/logout',{});assert.equal((await a('GET','/api/me')).data.user,null);assert.equal((await a('POST','/api/auth/login',{email:'alice@example.test',password:'wrong'})).status,401);assert.equal((await a('POST','/api/auth/login',user('alice'))).status,200);
});
test('two real accounts cannot read/edit/export each other’s saved project',async t=>{
 const {client}=await setup(t),a=client(),b=client();await a('POST','/api/auth/register',user('alice'));await b('POST','/api/auth/register',user('bob'));const created=await a('POST','/api/projects',{name:'Alice project',brief:'A brief'});assert.equal(created.status,201);const p=created.data.project;assert.equal((await b('GET',`/api/projects/${p.id}`)).status,404);assert.equal((await b('GET',`/api/projects/${p.id}/export?format=html`)).status,404);assert.equal((await b('PUT',`/api/projects/${p.id}`,p)).status,404);assert.equal((await b('GET','/api/projects')).data.projects.length,0);
});
test('edit save revision conflict snapshot restore and whole site export',async t=>{
 const {client}=await setup(t),a=client();await a('POST','/api/auth/register',user('edit'));let p=(await a('POST','/api/projects',{name:'Edited site',brief:'A brief'})).data.project;p.variants[0].document.pages[0].sections[0].title='Actually edited in the project';let r=await a('PUT',`/api/projects/${p.id}`,p);assert.equal(r.status,200);const saved=r.data.project;assert.equal((await a('PUT',`/api/projects/${p.id}`,p)).status,409);const version=(await a('POST',`/api/projects/${p.id}/versions`,{label:'Edited snapshot'})).data.version;p=structuredClone(saved);p.name='Changed project';p=(await a('PUT',`/api/projects/${p.id}`,p)).data.project;r=await a('POST',`/api/projects/${p.id}/restore`,{versionId:version.id,revision:p.revision});assert.equal(r.status,200);assert.equal(r.data.project.name,'Edited site');r=await a('GET',`/api/projects/${p.id}/export?format=html`);assert.equal(r.status,200);assert.match(r.data,/Actually edited in the project/);const zip=await a('GET',`/api/projects/${p.id}/export?format=zip-react`);assert.equal(zip.status,200);assert.equal(zip.data.readUInt32LE(0),0x04034b50);
});
test('unconfigured AI rejects without project mutation or quota charge; payment rejects too',async t=>{
 const {client}=await setup(t),a=client();await a('POST','/api/auth/register',user('disabled'));const p=(await a('POST','/api/projects',{name:'No model',brief:'Brief'})).data.project;const r=await a('POST',`/api/projects/${p.id}/generate`,{brief:'Do work',source:null,revision:p.revision});assert.equal(r.status,503);assert.equal(r.data.code,'AI_NOT_CONFIGURED');assert.equal((await a('GET',`/api/projects/${p.id}`)).data.project.revision,p.revision);assert.equal((await a('GET','/api/me')).data.usage.used,0);assert.equal((await a('POST','/api/billing/checkout',{plan:'pro'})).status,503);
});
test('injected model and importer exercise full backend generate/chat flow',async t=>{
 const aiProvider={configured:true,generate:async(brief,source)=>seedVariants(brief,source),edit:async(document,instruction)=>({...document,title:instruction})};
 const {client}=await setup(t,{aiProvider,importer:async url=>({url,title:'Imported company',description:'Actual imported source',text:'Important existing website content',headings:[],links:[],images:[]})}),a=client();await a('POST','/api/auth/register',user('model'));const source=(await a('POST','/api/import',{url:'https://example.com'})).data.source;assert.equal(source.title,'Imported company');let p=(await a('POST','/api/projects',{name:'Model flow',brief:'Brief'})).data.project;let r=await a('POST',`/api/projects/${p.id}/generate`,{brief:'A website',source,revision:p.revision});assert.equal(r.status,200);p=r.data.project;assert.equal(p.variants.length,3);r=await a('POST',`/api/projects/${p.id}/chat`,{instruction:'A revised site',variantId:p.activeVariant,revision:p.revision});assert.equal(r.status,200);assert.equal(r.data.project.variants.find(v=>v.id===p.activeVariant).document.title,'A revised site');assert.equal((await a('GET','/api/me')).data.usage.used,2);
});
test('cross-origin writes, unauthenticated projects and private source files are blocked',async t=>{
 const {client}=await setup(t),a=client();assert.equal((await a('GET','/api/projects')).status,401);assert.equal((await a('POST','/api/auth/register',user('csrf'),{Origin:'https://evil.example'})).status,403);for(const path of ['/.env','/store.mjs','/data/mosaic.sqlite','/server.mjs'])assert.equal((await a('GET',path)).status,404,path);
});
test('HTTPS origin behind a reverse proxy uses APP_URL and sets Secure cookies',async t=>{
 const {origin}=await setup(t,{env:{NODE_ENV:'production',LOCAL_WORKSPACE:'0',APP_URL:'https://app.amadeu.tech'}});
 // Native HTTP models proxy-upstream Host; fetch intentionally normalizes Host.
 const post=(path,body,requestOrigin='https://app.amadeu.tech')=>new Promise((resolve,reject)=>{const req=http.request(origin+path,{method:'POST',headers:{Host:'app.amadeu.tech',Origin:requestOrigin,'Content-Type':'application/json'}},res=>{const chunks=[];res.on('data',b=>chunks.push(b));res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(Buffer.concat(chunks).toString()),cookie:res.headers['set-cookie']?.[0]}));});req.on('error',reject);req.end(JSON.stringify(body));});
 const r=await post('/api/auth/register',user('proxy'));assert.equal(r.status,201,JSON.stringify(r.data));assert.match(r.cookie,/; Secure/);assert.equal((await post('/api/auth/local',{})).status,403);assert.equal((await post('/api/auth/login',user('proxy'),'https://evil.example')).status,403);
});
test('concurrent AI completions cannot overwrite a newer project or double-charge a failed save',async t=>{
 let release;const gate=new Promise(resolve=>{release=resolve;});let calls=0;let both;const entered=new Promise(resolve=>{both=resolve;});
 const aiProvider={generate:async()=>{calls++;if(calls===2)both();await gate;return seedVariants();},edit:async()=>{}};
 const {client}=await setup(t,{aiProvider}),a=client();await a('POST','/api/auth/register',user('race'));const p=(await a('POST','/api/projects',{name:'Concurrent',brief:'hello'})).data.project;
 const payload={brief:'hello',source:null,revision:p.revision};const first=a('POST',`/api/projects/${p.id}/generate`,payload),second=a('POST',`/api/projects/${p.id}/generate`,payload);await entered;release();const responses=await Promise.all([first,second]);assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);assert.equal((await a('GET','/api/me')).data.usage.used,1);assert.equal((await a('GET',`/api/projects/${p.id}`)).data.project.revision,p.revision+1);
});
test('local sessions require explicit loopback development mode, not proxy forwarding',async t=>{
 const {client}=await setup(t,{env:{NODE_ENV:'development',LOCAL_WORKSPACE:'1'}}),a=client();assert.equal((await a('POST','/api/auth/local',{}, {'X-Forwarded-For':'127.0.0.1'})).status,403);assert.equal((await a('POST','/api/auth/local',{})).status,200);assert.equal((await a('GET','/api/me')).data.user.email,'local@workspace.invalid');
});
