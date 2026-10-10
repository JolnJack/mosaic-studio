import {test} from 'node:test';
import assert from 'node:assert/strict';
import {inflateRawSync} from 'node:zlib';
import {seedVariants,createSection} from '../core.mjs';
import {exportArchive,zipFiles,crc32} from '../export.mjs';
function entries(zip){const files={};let p=0;while(zip.readUInt32LE(p)===0x04034b50){const size=zip.readUInt32LE(p+18),length=zip.readUInt16LE(p+26),extra=zip.readUInt16LE(p+28),name=zip.subarray(p+30,p+30+length).toString();const start=p+30+length+extra;const bytes=inflateRawSync(zip.subarray(start,start+size));assert.equal(crc32(bytes),zip.readUInt32LE(p+14));files[name]=bytes.toString();p=start+size;}assert.equal(zip.readUInt32LE(p),0x02014b50);return files;}
test('full HTML archive contains all edited pages with working internal file paths',()=>{
 const doc=seedVariants()[0].document;doc.pages.push({id:'about',path:'/about',name:'About',sections:[{...createSection('hero',6),title:'About our studio'}]});const files=entries(exportArchive(doc));assert.match(files['about.html'],/About our studio/);assert.match(files['index.html'],/href="about.html"/);assert.ok(files['website.json']);assert.doesNotMatch(files['index.html'],/mosaic-select/);
});
test('React archive contains a runnable package, separate CSS, document and page routing',()=>{
 const doc=seedVariants()[0].document,files=entries(exportArchive(doc,'react'));assert.ok(JSON.parse(files['package.json']).scripts.build);assert.match(files['src/Page0.jsx'],/Good ideas deserve/);assert.match(files['src/styles.css'],/site-section/);assert.match(files['src/App.jsx'],/Page0/);assert.ok(files['src/main.jsx']);
});
test('archive refuses traversal paths',()=>assert.throws(()=>zipFiles({'../secret':'bad'})));
