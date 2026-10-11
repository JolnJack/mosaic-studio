import {lookup} from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import {createGunzip,createInflate,createBrotliDecompress} from 'node:zlib';
import {fail,importPublicUrl,dohLookup} from './import-source.mjs';
export {isPublicAddress,publicUrl,resolvePublic,dohLookup,extractSource} from './import-source.mjs';
function requestPage(url,address,{signal}={}){
 return new Promise((resolve,reject)=>{
  const request=(url.protocol==='https:'?https:http).get(url,{
   headers:{'User-Agent':'AmadeuStudio/0.2 (+public-page-import)','Accept':'text/html,application/xhtml+xml','Accept-Encoding':'gzip, br, deflate'},
   lookup:(_host,opts,callback)=>callback(null,opts.all?[address]:address.address,address.family),
   timeout:12000,signal
  },response=>{
   const status=response.statusCode;
   if([301,302,303,307,308].includes(status)){response.resume();return resolve({redirect:response.headers.location});}
   if(status<200||status>=300){response.resume();return reject(fail(`目标网站返回 HTTP ${status}，无法读取。`));}
   if(!/text\/html|application\/xhtml\+xml/i.test(response.headers['content-type']||'')){response.resume();return reject(fail('目标地址没有返回 HTML 页面。'));}
   const encoding=response.headers['content-encoding'];let stream=response;
   if(encoding==='gzip')stream=response.pipe(createGunzip());else if(encoding==='deflate')stream=response.pipe(createInflate());else if(encoding==='br')stream=response.pipe(createBrotliDecompress());else if(encoding&&encoding!=='identity'){response.resume();return reject(fail('页面采用了不支持的压缩格式。'));}
   const chunks=[];let size=0,wire=0;
   response.on('data',chunk=>{wire+=chunk.length;if(wire>2_000_000){request.destroy();reject(fail('目标页面过大，请选择更简洁的页面。'));}});
   stream.on('data',chunk=>{size+=chunk.length;if(size>2_000_000){stream.destroy();request.destroy();reject(fail('目标页面过大，请选择更简洁的页面。'));}else chunks.push(chunk);});
   stream.on('error',()=>reject(fail('页面解压或下载失败。')));response.on('error',()=>reject(fail('页面下载中断。')));
   stream.on('end',()=>resolve({html:Buffer.concat(chunks).toString('utf8')}));
  });
  request.on('timeout',()=>request.destroy(fail('网页读取超时。',504)));
  request.on('error',error=>reject(error.status?error:fail('无法连接目标网站。',502)));
  const timer=setTimeout(()=>request.destroy(fail('网页读取超时。',504)),15000);request.once('close',()=>clearTimeout(timer));
 });
}
export function importUrl(value,{resolver=process.env.IMPORT_DNS_MODE==='doh'?dohLookup:lookup,transport=requestPage,signal}={}) { return importPublicUrl(value,{resolver,transport,signal}); }
