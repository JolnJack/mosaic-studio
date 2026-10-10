import {test} from 'node:test';
import assert from 'node:assert/strict';
import {extractSource} from '../import.mjs';

test('URL import associates source headings with content rather than flattening all paragraphs',()=>{
 const source=extractSource('<html><title>Original studio</title><body><nav><a href="/work">Work</a><a href="javascript:bad()">Bad</a></nav><main><section><h1>A real studio</h1><p>Our existing introduction.</p></section><section><h2>Services</h2><p>Identity and digital design.</p><script>steal secrets</script></section><section><h2>Contact</h2><p>Talk to our team.</p></section></main></body></html>','https://original.example/');
 assert.deepEqual(source.contentSections,[{heading:'A real studio',body:'Our existing introduction.'},{heading:'Services',body:'Identity and digital design.'},{heading:'Contact',body:'Talk to our team.'}]);
 assert.deepEqual(source.navigation,[{text:'Work',href:'https://original.example/work'}]);
 assert.ok(!JSON.stringify(source).includes('steal secrets'));
});
test('semantic source collection is bounded and retains original text without invented claims',()=>{
 const html='<main>'+Array.from({length:25},(_,i)=>`<section><h2>Real section ${i}</h2><p>${'Original text. '.repeat(300)}</p></section>`).join('')+'</main>';
 const source=extractSource(html,'https://original.example/');
 assert.equal(source.contentSections.length,12);assert.ok(source.contentSections.every(s=>s.body.length<=2000&&s.heading.length<=300));assert.equal(source.navigation.length,0);
 assert.ok(!source.contentSections.some(s=>s.body.includes('trusted by')));
});
