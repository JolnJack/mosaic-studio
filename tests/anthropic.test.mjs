import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createAIProvider} from '../ai.mjs';
import {seedVariants} from '../core.mjs';

async function fixture(t, respond) {
 const seen=[];
 const server=http.createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;
  const request={path:req.url,headers:req.headers,body:JSON.parse(raw)};seen.push(request);
  const output=respond(request);res.writeHead(output.status||200,{'Content-Type':'application/json'});res.end(JSON.stringify(output.body));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 return {seen,provider:createAIProvider({AI_PROVIDER:'anthropic',ANTHROPIC_API_KEY:'fixture-secret-not-real',AI_MODEL:'fixture-claude',AI_BASE_URL:`http://127.0.0.1:${server.address().port}/v1`})};
}
const message=input=>({body:{type:'message',stop_reason:'tool_use',content:[{type:'tool_use',id:'toolu_fixture',name:'return_website',input}]}});

test('native Claude generation uses Messages headers, forced structured tool and imported content',async t=>{
 const {provider,seen}=await fixture(t,()=>message({variants:seedVariants('Native Claude fixture')}));
 assert.equal(provider.configured,true);assert.equal(provider.providerType,'anthropic');
 const variants=await provider.generate('真实产品描述',{title:'Original page',text:'Untrusted content'});
 assert.equal(variants.length,3);const req=seen[0];assert.equal(req.path,'/v1/messages');assert.equal(req.headers['x-api-key'],'fixture-secret-not-real');assert.equal(req.headers['anthropic-version'],'2023-06-01');assert.equal(req.headers.authorization,undefined);
 assert.equal(req.body.model,'fixture-claude');assert.equal(req.body.messages[0].role,'user');assert.equal(req.body.messages.length,1);assert.match(req.body.system,/untrusted/);assert.match(req.body.messages[0].content,/Original page/);assert.equal(req.body.tool_choice.name,'return_website');assert.equal(req.body.tools[0].input_schema.properties.variants.minItems,3);assert.equal(req.body.response_format,undefined);
});
test('native Claude editing preserves the document contract',async t=>{
 const original=seedVariants()[0].document,revised={...original,title:'A revised native title'};
 const {provider,seen}=await fixture(t,()=>message({document:revised}));
 assert.equal((await provider.edit(original,'Only change the title')).title,revised.title);
 assert.match(seen[0].body.messages[0].content,/Only change the title/);assert.ok(seen[0].body.tools[0].input_schema.properties.document);
});
test('native Claude rejects truncated and missing or mismatched tool output without fallback',async t=>{
 let mode='truncated';const {provider}=await fixture(t,()=>{
  if(mode==='truncated')return {body:{stop_reason:'max_tokens',content:[{type:'tool_use',name:'return_website',input:{variants:seedVariants()}}]}};
  if(mode==='missing')return {body:{stop_reason:'end_turn',content:[{type:'text',text:JSON.stringify({variants:seedVariants()})}]}};
  return {body:{stop_reason:'tool_use',content:[{type:'tool_use',name:'run_arbitrary_tool',input:{variants:seedVariants()}}]}};
 });
 for(const next of ['truncated','missing','wrong']){mode=next;await assert.rejects(provider.generate('x',null),e=>e.code==='INVALID_AI_OUTPUT');}
});
test('native Claude errors are bounded and do not reveal keys or provider payloads',async t=>{
 const {provider}=await fixture(t,()=>({status:401,body:{error:'fixture-secret-not-real upstream-private-debug'}}));
 await assert.rejects(provider.generate('x',null),e=>e.code==='AI_PROVIDER_ERROR'&&!e.message.includes('fixture-secret')&&!e.message.includes('private-debug'));
});
test('unknown provider and unconfigured Claude do not invoke the network',async()=>{
 const provider=createAIProvider({AI_PROVIDER:'anthropic'});assert.equal(provider.configured,false);await assert.rejects(provider.generate('x',null),e=>e.code==='AI_NOT_CONFIGURED');
 const unknown=createAIProvider({AI_PROVIDER:'unknown',AI_API_KEY:'fixture',AI_MODEL:'fixture'});assert.equal(unknown.configured,false);await assert.rejects(unknown.edit(seedVariants()[0].document,'x'),e=>e.code==='AI_NOT_CONFIGURED');
});
