import {test} from 'node:test';
import assert from 'node:assert/strict';
import {load} from 'cheerio';
import {seedVariants, validateDocument, renderDocument, renderReact} from '../core.mjs';

test('gallery images survive validation, saved JSON and both export renderers',()=>{
  const doc=seedVariants()[0].document;
  const item=doc.pages[0].sections.find(s=>s.type==='gallery').items[0];
  item.image='https://example.com/owned-project.jpg';
  const clean=validateDocument(doc);
  assert.equal(clean.pages[0].sections.find(s=>s.type==='gallery').items[0].image,item.image);
  const html=load(renderDocument(clean));
  assert.equal(html('.gallery-item img').attr('src'),item.image);
  assert.equal(html('.gallery-item img').attr('alt'),item.title);
  assert.equal(html('.gallery-item img').attr('referrerpolicy'),'no-referrer');
  assert.match(renderReact(clean).jsx,/owned-project\.jpg/);
});

test('unsafe item images and escaped alt text cannot inject markup',()=>{
  const doc=seedVariants()[0].document;
  const gallery=doc.pages[0].sections.find(s=>s.type==='gallery');
  gallery.items[0].image='javascript:alert(1)';
  gallery.items[1].image='https://example.com/owned.jpg';
  gallery.items[1].title='\" onerror=\"alert(1)<script>bad</script>';
  const clean=validateDocument(doc),html=load(renderDocument(clean));
  assert.equal(clean.pages[0].sections.find(s=>s.type==='gallery').items[0].image,'');
  assert.equal(html('.gallery-item img').length,1);
  assert.equal(html('[onerror],script').length,0);
  assert.equal(html('.gallery-item img').attr('alt'),gallery.items[1].title);
});

test('non-hero layouts have real composition rules rather than unused layout labels',()=>{
  const doc=seedVariants()[0].document;
  const section=doc.pages[0].sections.find(s=>s.type==='features');
  section.layout='split';
  const $=load(renderDocument(doc)),css=$('style').text();
  assert.equal($('.features.layout-split').length,1);
  assert.match(css,/\.site-section\.layout-split/);
  assert.match(css,/\.layout-centered\s+\.grid/);
  assert.match(css,/\.layout-stacked\s+\.card/);
  assert.match(css,/\.layout-bento\s+\.gallery-item:first-child/);
  assert.match(css,/@media\s*\(max-width:760px\)/);
});

test('exported navigation stays readable and keyboard-visible with many pages',()=>{
  const doc=seedVariants()[0].document;
  for(let i=1;i<12;i++)doc.pages.push({id:`page-${i}`,name:`Long page name ${i}`,path:`/page-${i}`,sections:[]});
  const $=load(renderDocument(doc));
  assert.equal($('.site-nav a').length,12);
  assert.match($('style').text(),/\.site-nav\{[^}]*flex-wrap:wrap/);
  assert.match($('style').text(),/:focus-visible/);
});

test('CTA composition is retained in canvas, HTML and React markup',()=>{
  const doc=seedVariants()[0].document;
  const cta=doc.pages[0].sections.find(s=>s.type==='cta');
  cta.layout='split';
  assert.equal(load(renderDocument(doc))('.cta.layout-split').length,1);
  assert.equal(load(renderDocument(doc,{editing:true}))('.cta.layout-split').length,1);
  assert.match(renderReact(doc).jsx,/cta layout-split/);
});

test('design-only preview cannot navigate to export files or external destinations',()=>{
  const doc=seedVariants()[0].document;
  const html=load(renderDocument(doc,{preview:true}));
  assert.equal(html('.wordmark').attr('href'),undefined);
  assert.equal(html('a[href="mailto:hello@example.com"]').length,0);
  assert.equal(html('a[href="about:srcdoc#work"]').length,2);
  assert.equal(html('script,[data-edit]').length,0);
  assert.equal(load(renderDocument(doc))('.wordmark').attr('href'),'index.html');
  doc.pages.push({id:'about',name:'About',path:'/about',sections:[]});
  const multi=load(renderDocument(doc,{preview:true}));
  assert.equal(multi('.site-nav a[href]').length,0);
  assert.equal(multi('.site-nav a[aria-disabled="true"]').length,2);
  assert.match(renderReact(doc).jsx,/about\.html/);
});
