import {test} from 'node:test';
import assert from 'node:assert/strict';
import {canonicalVariants} from '../ai.mjs';
import {seedVariants} from '../core.mjs';

test('three design directions require real structural differences, not palette-only clones',()=>{
  const variants=seedVariants();
  for(let index=1;index<3;index++){
    const original=variants[index].document;
    variants[index].document={...structuredClone(variants[0].document),theme:original.theme};
    variants[index].document.pages[0].sections[0].title=`Different headline ${index}`;
  }
  assert.throws(()=>canonicalVariants(variants),error=>error.code==='INVALID_AI_OUTPUT'&&/layout/i.test(error.message));
});

test('valid independent sample compositions retain all three palettes and layouts',()=>{
  const result=canonicalVariants(seedVariants());
  assert.equal(result.length,3);
  assert.equal(new Set(result.map(v=>v.document.pages[0].sections[0].layout)).size,3);
});

test('renaming pages and IDs cannot disguise structurally duplicated model output',()=>{
  const variants=seedVariants();
  variants[2].document=structuredClone(variants[1].document);
  variants[2].document.theme.background='#fafafa';
  variants[2].document.pages[0].id='renamed';
  variants[2].document.pages[0].name='Renamed page';
  variants[2].document.pages[0].sections.forEach((s,index)=>s.id=`renamed-${index}`);
  assert.throws(()=>canonicalVariants(variants),error=>error.code==='INVALID_AI_OUTPUT');
});

test('equivalent default and split hero labels do not count as different compositions',()=>{
  const variants=seedVariants();
  for(let index=0;index<3;index++){
    variants[index].document.pages=[{id:'home',name:'Home',path:'/',sections:[structuredClone(variants[0].document.pages[0].sections[0])]}];
    variants[index].document.pages[0].sections[0].layout=['default','split','bento'][index];
  }
  assert.throws(()=>canonicalVariants(variants),error=>error.code==='INVALID_AI_OUTPUT');
});

test('empty grids cannot fake composition diversity with unused layout labels',()=>{
  for(const type of ['features','gallery','stats','pricing']){
    const variants=seedVariants();
    variants.forEach((v,index)=>v.document.pages[0].sections=[{id:'empty',type,title:'Same content',body:'Same body',layout:['default','stacked','bento'][index],items:[]}]);
    assert.throws(()=>canonicalVariants(variants),error=>error.code==='INVALID_AI_OUTPUT',type);
  }
});
