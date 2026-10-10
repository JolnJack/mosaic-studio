import {deflateRawSync} from 'node:zlib';
import {validateDocument,renderDocument,renderReact} from './core.mjs';
const table=Uint32Array.from({length:256},(_,n)=>{let c=n;for(let i=0;i<8;i++)c=c&1?0xedb88320^(c>>>1):c>>>1;return c>>>0;});
export function crc32(bytes){let crc=0xffffffff;for(const byte of bytes)crc=table[(crc^byte)&255]^(crc>>>8);return (crc^0xffffffff)>>>0;}
export function zipFiles(files){
 const parts=[],central=[];let offset=0;
 for(const [name,content] of Object.entries(files)){
  if(!/^[a-zA-Z0-9_.\/-]+$/.test(name)||name.startsWith('/')||name.split('/').includes('..'))throw new Error('Unsafe archive filename');
  const file=Buffer.from(content),packed=deflateRawSync(file),path=Buffer.from(name),crc=crc32(file);
  const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50,0);local.writeUInt16LE(20,4);local.writeUInt16LE(8,8);local.writeUInt16LE(0x21,12);local.writeUInt32LE(crc,14);local.writeUInt32LE(packed.length,18);local.writeUInt32LE(file.length,22);local.writeUInt16LE(path.length,26);
  const directory=Buffer.alloc(46);directory.writeUInt32LE(0x02014b50,0);directory.writeUInt16LE(20,4);directory.writeUInt16LE(20,6);directory.writeUInt16LE(8,10);directory.writeUInt16LE(0x21,14);directory.writeUInt32LE(crc,16);directory.writeUInt32LE(packed.length,20);directory.writeUInt32LE(file.length,24);directory.writeUInt16LE(path.length,28);directory.writeUInt32LE(offset,42);
  parts.push(local,path,packed);central.push(directory,path);offset+=local.length+path.length+packed.length;
 }
 const index=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(Object.keys(files).length,8);end.writeUInt16LE(Object.keys(files).length,10);end.writeUInt32LE(index.length,12);end.writeUInt32LE(offset,16);
 return Buffer.concat([...parts,index,end]);
}
export function exportArchive(input,format='html'){
 const doc=validateDocument(input),files={};
 if(format==='html'){
  for(const page of doc.pages){const name=page.path==='/'?'index.html':page.path.slice(1)+'.html';files[name]=renderDocument(doc,{pageId:page.id});}
  if(!files['index.html'])files['index.html']=renderDocument(doc);
  files['README.txt']='This archive contains your complete website pages. Open index.html, or serve this directory as a static site. Imported image URLs remain remote. Review all business claims and contact links before publication. No account, AI or payment credentials are included.';
 }else if(format==='react'){
  for(const [i,page] of doc.pages.entries()){const result=renderReact(doc,{pageId:page.id});files[`src/Page${i}.jsx`]=result.jsx;if(i===0)files['src/styles.css']=result.css;}
  files['src/App.jsx']=doc.pages.map((_,i)=>`import Page${i} from './Page${i}.jsx';`).join('\n')+`\nexport default function App(){const path=window.location.pathname;\n${doc.pages.map((p,i)=>`if(path===${JSON.stringify(p.path==='/'?'/index.html':p.path+'.html')}||path===${JSON.stringify(p.path)})return <Page${i}/>;`).join('\n')}\nreturn <Page0/>;}`;
  files['src/main.jsx']="import React from 'react';\nimport {createRoot} from 'react-dom/client';\nimport App from './App.jsx';\ncreateRoot(document.getElementById('root')).render(<App/>);\n";
  files['index.html']='<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Website</title></head><body><div id="root"></div><script type="module" src="/src/main.jsx"></script></body></html>';
  files['package.json']=JSON.stringify({name:'amadeu-export',private:true,type:'module',scripts:{dev:'vite',build:'vite build',preview:'vite preview'},dependencies:{react:'^19.0.0','react-dom':'^19.0.0'},devDependencies:{vite:'^7.0.0','@vitejs/plugin-react':'^4.7.0'}},null,2);
  files['vite.config.js']="import {defineConfig} from 'vite';\nimport react from '@vitejs/plugin-react';\nexport default defineConfig({plugins:[react()]});\n";
  files['README.md']='# React website export\n\nRun npm install, npm run dev. Build with npm run build. Configure a fallback to index.html on your static host for multi-page routes. JSX wraps sanitized document markup to preserve preview/export parity; it is not a granular component code generator. No backend or credentials are included.\n';
 }else throw new Error('Unsupported archive format');
 files['website.json']=JSON.stringify(doc,null,2);return zipFiles(files);
}
