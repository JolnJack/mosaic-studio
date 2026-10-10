import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createAIProvider,canonicalVariants} from '../ai.mjs';
import {seedVariants} from '../core.mjs';

test('real HTTP model adapter sends source and instruction and validates all three responses',async t=>{
 const requests=[];let mode='generate';
 const server=http.createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;requests.push({url:req.url,authorization:req.headers.authorization,body:JSON.parse(body)});res.setHeader('Content-Type','application/json');const content=mode==='generate'?{variants:seedVariants('Actual protocol fixture')}:{document:{...seedVariants()[0].document,title:'A genuinely revised title'}};res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(content)}}]}));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const provider=createAIProvider({AI_API_KEY:'fixture-not-a-real-key',AI_MODEL:'fixture-model',AI_BASE_URL:`http://127.0.0.1:${server.address().port}/v1`});
 const source={title:'Imported content',text:'An existing page'};const variants=await provider.generate('用户描述',source);assert.equal(variants.length,3);assert.equal(requests[0].url,'/v1/chat/completions');assert.equal(requests[0].authorization,'Bearer fixture-not-a-real-key');assert.equal(requests[0].body.model,'fixture-model');assert.match(requests[0].body.messages[1].content,/Imported content/);assert.match(requests[0].body.messages[0].content,/untrusted/);
 mode='edit';const edited=await provider.edit(variants[0].document,'Change the title');assert.equal(edited.title,'A genuinely revised title');assert.match(requests[1].body.messages[1].content,/Change the title/);
});
test('missing model configuration fails explicitly, with no template substitute',async()=>{
 const provider=createAIProvider({});assert.equal(provider.configured,false);await assert.rejects(provider.generate('hello',null),error=>error.code==='AI_NOT_CONFIGURED'&&error.status===503);
});
test('duplicate model directions and invalid model documents are rejected',()=>{
 const variants=seedVariants();variants[1].document=structuredClone(variants[0].document);assert.throws(()=>canonicalVariants(variants),error=>error.code==='INVALID_AI_OUTPUT');assert.throws(()=>canonicalVariants([]));
});
test('provider failure returns a bounded error without credentials or upstream payload',async t=>{
 const server=http.createServer((req,res)=>{res.writeHead(401);res.end('SECRET PROVIDER DUMP fixture-not-a-real-key');});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const provider=createAIProvider({AI_API_KEY:'fixture-not-a-real-key',AI_MODEL:'fixture',AI_BASE_URL:`http://127.0.0.1:${server.address().port}`});await assert.rejects(provider.generate('hello',null),error=>error.code==='AI_PROVIDER_ERROR'&&!error.message.includes('SECRET'));
});
test('canceled model request stops the HTTP adapter rather than continuing silently',async t=>{
 let requested;const entered=new Promise(resolve=>{requested=resolve;});const server=http.createServer((req,res)=>{requested();});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));});
 const provider=createAIProvider({AI_API_KEY:'fixture',AI_MODEL:'fixture',AI_BASE_URL:`http://127.0.0.1:${server.address().port}`}),controller=new AbortController();const work=provider.generate('hello',null,{signal:controller.signal});const rejected=assert.rejects(work,error=>error.code==='REQUEST_ABORTED');await entered;controller.abort();await rejected;
});
