import {test} from 'node:test';
import assert from 'node:assert/strict';
import {load} from 'cheerio';
import {seedVariants,validateDocument,renderDocument,renderReact,safeUrl,createSection} from '../core.mjs';
test('three sample directions retain different themes and copy, all canonical',()=>{
 const variants=seedVariants('A design studio');assert.equal(variants.length,3);assert.equal(new Set(variants.map(v=>v.document.theme.background)).size,3);assert.equal(new Set(variants.map(v=>v.document.pages[0].sections[0].title)).size,3);
 for(const v of variants)assert.deepEqual(validateDocument(v.document),v.document);
});
test('editable canvas and HTML exports share actual sections, preserve modifications',()=>{
 const doc=seedVariants()[0].document;doc.pages[0].sections[0].title='用户真正修改的标题';doc.pages[0].sections.push(createSection('faq',5));
 const preview=load(renderDocument(doc,{editing:true})),exported=load(renderDocument(doc));assert.equal(preview('h1').text(),'用户真正修改的标题');assert.equal(exported('h1').text(),preview('h1').text());assert.equal(exported('details').length,2);assert.equal(exported('script').length,0);assert.equal(preview('script').length,1);
});
test('untrusted text and unsafe URLs cannot become executable exported markup',()=>{
 const doc=seedVariants()[0].document;doc.title='</title><script>alert(1)</script>';doc.pages[0].sections[0].title='<img src=x onerror=alert(1)>';doc.pages[0].sections[0].button.href='javascript:alert(1)';doc.pages[0].sections[0].image='data:image/svg+xml,<svg onload="alert(1)">';
 const html=renderDocument(doc),$=load(html);assert.equal($('script').length,0);assert.equal($('[onerror]').length,0);assert.equal($('img').length,0);assert.equal($('h1').text(),'<img src=x onerror=alert(1)>');assert.equal($('.hero a').attr('href'),'#');
 assert.equal(safeUrl('//evil.test'), '');assert.equal(safeUrl('javascript:alert(1)'), '');assert.equal(safeUrl('https://u:p@example.com'),'');
});
test('invalid themes, unknown blocks and duplicate page/section ids are rejected',()=>{
 const doc=seedVariants()[0].document;assert.throws(()=>validateDocument({...doc,theme:{accent:'red; background:url(x)'}}));assert.throws(()=>validateDocument({...doc,pages:[]}));assert.throws(()=>validateDocument({...doc,pages:[...doc.pages,...doc.pages]}));
 doc.pages[0].sections[0].type='script';assert.throws(()=>validateDocument(doc));
});
test('React export carries the same safely escaped content and CSS',()=>{
 const doc=seedVariants()[1].document;doc.pages[0].sections[0].title='A new point of view';const {jsx,css}=renderReact(doc);assert.match(jsx,/A new point of view/);assert.match(jsx,/export default function Website/);assert.match(css,/--bg:#111325/);
});
test('different pages render independently and multi-page navigation references export paths',()=>{
 const doc=seedVariants()[0].document;doc.pages.push({id:'about',name:'About',path:'/about',sections:[{...createSection('hero',7),title:'About our people'}]});const $=load(renderDocument(doc,{pageId:'about'}));assert.equal($('h1').text(),'About our people');assert.equal($('.site-nav a').last().attr('href'),'about.html');
});
