import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHmac,randomBytes} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {createStore,hashToken} from '../store.mjs';
import {createBilling,verifyStripeSignature} from '../billing.mjs';
import {seedVariants} from '../core.mjs';
function setup(t){const dir=mkdtempSync(join(tmpdir(),'mosaic-test-'));const store=createStore(dir,{freeLimit:1});t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});return store;}
function sign(raw,secret,stamp=Math.floor(Date.now()/1000)){return `t=${stamp},v1=${createHmac('sha256',secret).update(`${stamp}.`).update(raw).digest('hex')}`;}
test('sessions are stored hashed, expire, and are revoked on logout',t=>{
 const store=setup(t),user=store.createUser('user@example.test','Test','hashed-password'),token=randomBytes(32).toString('base64url');store.createSession(user.id,token,Date.now()+10000);assert.equal(store.sessionUser(token).id,user.id);assert.equal(store.db.prepare('SELECT token_hash FROM sessions').get().token_hash,hashToken(token));store.deleteSession(token);assert.equal(store.sessionUser(token),null);
});
test('project ownership, revision conflicts and restore persist full documents',t=>{
 const store=setup(t),user=store.createUser('a@example.test','A','x'),other=store.createUser('b@example.test','B','x');const variants=seedVariants();const project=store.createProject(user.id,{name:'Original',brief:'hello',source:null,variants,activeVariant:variants[0].id});assert.throws(()=>store.getProject(other.id,project.id),error=>error.status===404);const version=store.createVersion(user.id,project.id,'Before');const changed=store.saveProject(user.id,project.id,{...project,name:'Changed'},project.revision);assert.throws(()=>store.saveProject(user.id,project.id,{...project,name:'Stale'},project.revision),error=>error.status===409);const restored=store.restoreProject(user.id,project.id,version.id,changed.revision);assert.equal(restored.name,'Original');assert.deepEqual(restored.variants,project.variants);assert.ok(restored.revision>changed.revision);
});
test('quota reservations enforce limits before requests, refund failures and commit only on save',t=>{
 const store=setup(t),user=store.createUser('quota@example.test','Quota','x'),variants=seedVariants();const project=store.createProject(user.id,{name:'Quota',brief:'',source:null,variants,activeVariant:variants[0].id});const pending=store.reserveUsage(user.id,project.id,project.revision);assert.throws(()=>store.reserveUsage(user.id,project.id,project.revision),error=>error.code==='QUOTA_EXCEEDED');store.releaseUsage(pending);assert.equal(store.usage(user.id).used,0);const again=store.reserveUsage(user.id,project.id,project.revision);store.completeUsage(user.id,project.id,project,project.revision,again);assert.equal(store.usage(user.id).used,1);
});
test('Stripe exact raw bytes, timestamp and signature are mandatory',()=>{
 const raw=Buffer.from('{"hello":"world"}'),secret='fixture-secret';verifyStripeSignature(raw,sign(raw,secret),secret);assert.throws(()=>verifyStripeSignature(Buffer.from('{"hello":"tampered"}'),sign(raw,secret),secret));assert.throws(()=>verifyStripeSignature(raw,sign(raw,secret,1),secret));
});
test('verified webhook checks current subscription, is idempotent and revokes canceled plan',async t=>{
 const store=setup(t),user=store.createUser('billing@example.test','Billing','x');store.setCustomer(user.id,'cus_fixture');let status='active',calls=0;const env={STRIPE_SECRET_KEY:'sk_test_fixture',STRIPE_PRICE_PRO:'price_fixture',STRIPE_WEBHOOK_SECRET:'fixture-secret'};
 const billing=createBilling({store,env,fetchImpl:async()=>{calls++;return new Response(JSON.stringify({id:'sub_fixture',customer:'cus_fixture',status,current_period_end:Math.floor(Date.now()/1000)+86400,items:{data:[{price:{id:'price_fixture'},quantity:1}]}}),{headers:{'Content-Type':'application/json'}});}});
 const event={id:'evt_fixture',type:'customer.subscription.updated',created:Math.floor(Date.now()/1000),data:{object:{id:'sub_fixture',customer:'cus_fixture'}}};let raw=Buffer.from(JSON.stringify(event));await billing.webhook(raw,sign(raw,env.STRIPE_WEBHOOK_SECRET));assert.equal(store.plan(user.id),'pro');await billing.webhook(raw,sign(raw,env.STRIPE_WEBHOOK_SECRET));assert.equal(calls,1);status='canceled';raw=Buffer.from(JSON.stringify({...event,id:'evt_fixture2',created:event.created+1}));await billing.webhook(raw,sign(raw,env.STRIPE_WEBHOOK_SECRET));assert.equal(store.plan(user.id),'free');
});
test('missing payment configuration does not create a checkout or an upgraded plan',async t=>{
 const store=setup(t),user=store.createUser('free@example.test','Free','x'),billing=createBilling({store,env:{}});assert.equal(billing.configured,false);await assert.rejects(billing.checkout(user,'https://app.amadeu.tech'),error=>error.code==='BILLING_NOT_CONFIGURED');assert.equal(store.plan(user.id),'free');
});

test('tier caps block only new projects and expiry preserves existing edits', t => {
 const store=setup(t), user=store.createUser('caps@example.test','Caps','x'), variants=seedVariants();
 const value={name:'Cap',brief:'',source:null,variants,activeVariant:variants[0].id};
 for(let i=0;i<3;i++)store.createProject(user.id,value);
 assert.throws(()=>store.createProject(user.id,value), e=>e.code==='PROJECT_LIMIT');
 const event={id:'evt_caps',type:'customer.subscription.updated',created:1};
 store.applyWebhook(event,'hash',{id:'sub_caps',userId:user.id,customerId:'cus_caps',status:'active',priceId:'price_caps',plan:'studio',interval:'yearly',currentPeriodEnd:Math.floor(Date.now()/1000)+1000});
 assert.equal(store.plan(user.id),'studio');assert.equal(store.usage(user.id).limit,600);
 const p=store.createProject(user.id,value);
 store.db.prepare('UPDATE subscriptions SET current_period_end=0').run();
 assert.equal(store.plan(user.id),'free');assert.equal(store.listProjects(user.id).length,4);
 assert.throws(()=>store.createProject(user.id,value), e=>e.code==='PROJECT_LIMIT');
 assert.equal(store.saveProject(user.id,p.id,{...p,name:'Still editable'},p.revision).name,'Still editable');
});

test('checkout uses validated configured price and scopes idempotency by tier and interval', async t=>{
 const store=setup(t),user=store.createUser('checkout@example.test','Checkout','x');store.setCustomer(user.id,'cus_checkout');
 const env={STRIPE_SECRET_KEY:'sk_fixture',STRIPE_WEBHOOK_SECRET:'fixture-secret',STRIPE_PRICE_PRO:'price_pro',STRIPE_PRICE_STUDIO_MONTHLY:'price_studiom',STRIPE_PRICE_STUDIO_YEARLY:'price_studioy'};
 const calls=[];let active=true,recurring='year';
 const billing=createBilling({store,env,fetchImpl:async(url,options)=>{calls.push({url,options});if(url.includes('/prices/'))return Response.json({id:url.split('/').at(-1),active,type:'recurring',currency:'usd',recurring:{interval:recurring,interval_count:1}});return Response.json({url:'https://checkout.stripe.com/c/pay_fixture'});}});
 await billing.checkout(user,'https://app.example',{plan:'studio',interval:'yearly'});
 const post=calls.find(c=>c.url.endsWith('/checkout/sessions'));assert.equal(new URLSearchParams(post.options.body).get('line_items[0][price]'),'price_studioy');assert.match(post.options.headers['Idempotency-Key'],/studio-yearly/);assert.equal(store.plan(user.id),'free');
 for(const selection of [{plan:'free'},{plan:'__proto__'},{plan:'studio',interval:'weekly'},{plan:'studio',interval:null}])await assert.rejects(billing.checkout(user,'https://app.example',selection),e=>['INVALID_PLAN','INVALID_INTERVAL'].includes(e.code));
 active=false;await assert.rejects(billing.checkout(user,'https://app.example',{plan:'studio',interval:'yearly'}),e=>e.code==='INVALID_STRIPE_PRICE');
 active=true;recurring='month';await assert.rejects(billing.checkout(user,'https://app.example',{plan:'studio',interval:'yearly'}),e=>e.code==='INVALID_STRIPE_PRICE');
 await billing.checkout(user,'https://app.example');assert.equal(new URLSearchParams(calls.at(-1).options.body).get('line_items[0][price]'),'price_pro');
 await billing.checkout(user,'https://app.example',{plan:'studio',interval:'monthly'});assert.notEqual(calls.at(-1).options.headers['Idempotency-Key'],post.options.headers['Idempotency-Key']);
});

test('webhook grants actual catalog tier, exposes subscription, rejects unmatched and expired entitlement',async t=>{
 const store=setup(t),user=store.createUser('tiers@example.test','Tiers','x');store.setCustomer(user.id,'cus_tiers');
 const env={STRIPE_SECRET_KEY:'sk_fixture',STRIPE_WEBHOOK_SECRET:'fixture-secret',STRIPE_PRICE_BUSINESS_YEARLY:'price_business'};
 let price='price_business',status='active',end=Math.floor(Date.now()/1000)+1000,interval='year';
 const billing=createBilling({store,env,fetchImpl:async()=>Response.json({id:'sub_tiers',customer:'cus_tiers',status,current_period_end:end,items:{data:[{price:{id:price,recurring:{interval,interval_count:1}},quantity:1}]}})});
 for(const [i,expected] of ['business','free','free','free'].entries()){
  if(i===1)price='price_unknown';if(i===2){price='price_business';end=1;}if(i===3){end=Math.floor(Date.now()/1000)+1000;interval='month';}
  const raw=Buffer.from(JSON.stringify({id:`evt_tiers${i}`,type:'checkout.session.completed',created:i+1,data:{object:{mode:'subscription',subscription:'sub_tiers',customer:'cus_tiers',metadata:{plan:'business'}}}}));
  await billing.webhook(raw,sign(raw,env.STRIPE_WEBHOOK_SECRET));assert.equal(store.plan(user.id),expected);
  if(i===0){const info=billing.info(user.id);assert.equal(info.subscription.interval,'yearly');assert.equal(info.subscription.currentPeriodEnd,end);assert.equal(info.subscription.status,'active');assert.equal(info.plans.length,4);}
 }
});

test('existing subscriptions migrate additively and keep legacy Pro entitlement',t=>{
 const dir=mkdtempSync(join(tmpdir(),'mosaic-migration-')),db=new DatabaseSync(join(dir,'mosaic.sqlite'));
 db.exec(`CREATE TABLE subscriptions(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,customer_id TEXT NOT NULL,status TEXT NOT NULL,price_id TEXT,plan TEXT NOT NULL,current_period_end INTEGER NOT NULL DEFAULT 0,event_created INTEGER NOT NULL,updated_at TEXT NOT NULL)`);db.close();
 const store=createStore(dir);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
 const user=store.createUser('migration@example.test','Migration','x');
 store.db.prepare('INSERT INTO subscriptions(id,user_id,customer_id,status,price_id,plan,current_period_end,event_created,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run('sub_old',user.id,'cus_old','active','price_legacy','pro',Math.floor(Date.now()/1000)+1000,1,new Date().toISOString());
 assert.equal(store.plan(user.id),'pro');const billing=createBilling({store,env:{STRIPE_SECRET_KEY:'sk_fixture',STRIPE_WEBHOOK_SECRET:'fixture-secret',STRIPE_PRICE_PRO:'price_legacy'},fetchImpl:()=>{throw new Error('No network allowed');}});
 assert.equal(billing.info(user.id).subscription.interval,'monthly');assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM subscriptions').get().n,1);
});

test('cancellation pending comes from actual Stripe subscription and retains paid access until expiry',async t=>{
 const store=setup(t),user=store.createUser('cancel@example.test','Cancel','x');store.setCustomer(user.id,'cus_cancel');
 const env={STRIPE_SECRET_KEY:'sk_fixture',STRIPE_WEBHOOK_SECRET:'fixture-secret',STRIPE_PRICE_PRO:'price_pro'};let cancel=true;
 const billing=createBilling({store,env,fetchImpl:async()=>Response.json({id:'sub_cancel',customer:'cus_cancel',status:'active',cancel_at_period_end:cancel,current_period_end:Math.floor(Date.now()/1000)+1000,items:{data:[{price:{id:'price_pro'},quantity:1}]}})});
 for(let i=0;i<2;i++){
  const raw=Buffer.from(JSON.stringify({id:`evt_cancel${i}`,type:'customer.subscription.updated',created:i+1,data:{object:{id:'sub_cancel',customer:'cus_cancel',cancel_at_period_end:!cancel}}}));
  await billing.webhook(raw,sign(raw,env.STRIPE_WEBHOOK_SECRET));assert.equal(store.plan(user.id),'pro');assert.equal(billing.info(user.id).subscription.cancelAtPeriodEnd,cancel);cancel=false;
 }
 store.db.prepare('UPDATE subscriptions SET current_period_end=0').run();assert.equal(store.plan(user.id),'free');
});
