import {test} from 'node:test';
import assert from 'node:assert/strict';
import {publicUrl,isPublicAddress,importUrl,extractSource} from '../import.mjs';
test('URL importer blocks private, reserved, encoded loopback and non-HTTP schemes',()=>{
 for(const value of ['http://127.0.0.1','http://2130706433','http://0x7f000001','http://10.2.3.4','http://[::1]','http://[::ffff:127.0.0.1]','http://localhost','http://169.254.169.254','http://192.168.1.1','http://example.com:3000','file:///etc/passwd','http://u:p@example.com'])assert.throws(()=>publicUrl(value),value);
 assert.equal(publicUrl('https://example.com').host,'example.com');assert.ok(isPublicAddress('93.184.216.34'));assert.ok(!isPublicAddress('198.18.0.1'));assert.ok(!isPublicAddress('2001:db8::1'));assert.ok(!isPublicAddress('2001::1'));assert.ok(!isPublicAddress('3fff::1'));
});
test('DNS resolving to any private address fails before network request',async()=>{
 let called=false;await assert.rejects(importUrl('https://example.com',{resolver:async()=>[{address:'1.1.1.1',family:4},{address:'10.0.0.1',family:4}],transport:async()=>{called=true;}}));assert.equal(called,false);
});
test('public redirects to internal addresses are blocked',async()=>{
 let calls=0;await assert.rejects(importUrl('https://example.com',{resolver:async()=>[{address:'1.1.1.1',family:4}],transport:async()=>{calls++;return {redirect:'http://169.254.169.254/latest/meta-data/'};}}));assert.equal(calls,1);
});
test('actual HTML parsing returns provenance, headings, links and text, excluding scripts',()=>{
 const source=extractSource('<html><head><title>A real source</title><meta name="description" content="Source description"></head><body><main><h1>Hello</h1><p>Content from an existing page.</p><a href="/about">About</a><img src="/cover.png" alt="Cover"><script>secret</script></main></body></html>','https://example.com/');
 assert.equal(source.title,'A real source');assert.equal(source.description,'Source description');assert.equal(source.headings[0].text,'Hello');assert.equal(source.links[0].href,'https://example.com/about');assert.equal(source.images[0].src,'https://example.com/cover.png');assert.ok(!source.text.includes('secret'));
});
test('resolved public address is pinned into transport and final source is returned',async()=>{
 const source=await importUrl('https://example.com',{resolver:async()=>[{address:'1.1.1.1',family:4}],transport:async(url,address)=>{assert.equal(address.address,'1.1.1.1');return {html:'<title>Pinned</title><body>Some real content</body>'};}});assert.equal(source.title,'Pinned');
});
