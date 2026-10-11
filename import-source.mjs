import {isIP} from 'node:net';
import {load} from 'cheerio';
import {safeUrl} from './core.mjs';
export const fail=(message,status=422)=>Object.assign(new Error(message),{status,code:'IMPORT_FAILED'});
export function isPublicAddress(address){
 if(isIP(address)===4){
  const [a,b,c]=address.split('.').map(Number);
  return !(a===0||a===10||a===127||a>=224||(a===100&&b>=64&&b<=127)||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&(b===168||b===0||b===2))||(a===198&&(b===18||b===19||(b===51&&c===100)))||(a===203&&b===0&&c===113));
 }
 if(isIP(address)===6){
  const str=address.toLowerCase();
  // Allow global unicast only; exclude documentation, transition and special allocations.
  return /^[23][0-9a-f]{0,3}:/.test(str)&&!/^2001:(?:db8|0|10|20|2):/.test(str)&&!str.startsWith('2001::')&&!str.startsWith('2002:')&&!str.startsWith('3fff:');
 }
 return false;
}
export function publicUrl(value){
 let url;try{url=new URL(value);}catch{throw fail('请输入完整的 http:// 或 https:// 网站地址。');}
 if(!['https:','http:'].includes(url.protocol)||url.username||url.password)throw fail('仅支持不含凭据的 HTTP/HTTPS 地址。');
 if(url.port&&!['80','443'].includes(url.port))throw fail('导入仅允许标准网站端口。');
 const host=url.hostname.replace(/^\[|\]$/g,'').toLowerCase();
 if(host==='localhost'||host.endsWith('.localhost')||host.endsWith('.local')||host.endsWith('.internal')||host.endsWith('.test'))throw fail('不能导入本地或内部网络地址。');
 if(isIP(host)&&!isPublicAddress(host))throw fail('不能导入本地、内部或保留网络地址。');
 url.hash='';return url;
}
export async function resolvePublic(url,resolver){
 const host=url.hostname.replace(/^\[|\]$/g,'');
 const addresses=isIP(host)?[{address:host,family:isIP(host)}]:await resolver(host,{all:true,verbatim:true});
 if(!addresses.length||addresses.some(x=>!isPublicAddress(x.address)))throw fail('目标地址解析到内部或保留网络，已拒绝导入。');
 return addresses[0];
}
export async function dohLookup(host){
 const responses=await Promise.all(['A','AAAA'].map(async type=>{
  const response=await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}`,{headers:{accept:'application/dns-json'},signal:AbortSignal.timeout(8000)});
  if(!response.ok)throw fail('公共 DNS 查询失败。',502);
  const data=await response.json();
  if(data.Status!==0&&data.Status!==3)throw fail('公共 DNS 查询失败。',502);
  return (data.Answer||[]).filter(a=>a.type===1||a.type===28).map(a=>({address:a.data,family:a.type===1?4:6}));
 }));return responses.flat();
}
export function extractSource(html,url){
 const $=load(html);const normalize=v=>String(v||'').replace(/\s+/g,' ').trim();
 $('script,style,noscript,iframe,svg,canvas,template').remove();
 const title=normalize($('title').first().text()||$('h1').first().text()).slice(0,240);
 const description=normalize($('meta[name="description"]').attr('content')||$('meta[property="og:description"]').attr('content')).slice(0,1000);
 const headings=$('h1,h2,h3').toArray().slice(0,50).map(node=>({level:node.tagName,text:normalize($(node).text()).slice(0,300)})).filter(x=>x.text);
 const links=$('a[href]').toArray().slice(0,150).map(node=>{let href;try{href=safeUrl(new URL($(node).attr('href'),url).href);}catch{}return {text:normalize($(node).text()).slice(0,160),href:href||''};}).filter(x=>x.href&&x.text).slice(0,50);
 const images=$('img[src]').toArray().slice(0,25).map(node=>{let src;try{src=safeUrl(new URL($(node).attr('src'),url).href,true);}catch{}return {src:src||'',alt:normalize($(node).attr('alt')).slice(0,160)};}).filter(x=>x.src);
 const root=$('main').length?$('main'):$('body');
 const contentSections=[];let current;
 // Semantic content only: retain the source's own heading/paragraph associations,
 // never execute its scripts or treat its markup as an instruction or new design.
 for(const element of root.find('h1,h2,h3,p,li').toArray()){
  const value=normalize($(element).text());if(!value)continue;
  if(/^h[123]$/.test(element.tagName)){
   if(contentSections.length>=12)break;
   current={heading:value.slice(0,300),body:''};contentSections.push(current);
  }else{
   if($(element).parents('p,li').length)continue;
   if(!current){current={heading:title.slice(0,300),body:''};contentSections.push(current);}
   current.body=normalize(current.body+' '+value).slice(0,2000);
  }
 }
 const navigation=$('nav a[href], [role="navigation"] a[href]').toArray().slice(0,60).map(element=>{
  let href='';try{href=safeUrl(new URL($(element).attr('href'),url).href);}catch{}
  return {text:normalize($(element).text()).slice(0,160),href};
 }).filter(link=>link.href&&link.text).slice(0,15);
 const text=normalize(root.text()).slice(0,24000);
 return {url,title,description,text,headings,links,images,contentSections,navigation,importedAt:new Date().toISOString(),warnings:text.length<100?['公开 HTML 中正文较少；这个站点可能需要 JavaScript 渲染。']:[]};
}
export async function importPublicUrl(value,{resolver,transport,signal}={}){
 let url=publicUrl(value);
 for(let redirects=0;redirects<5;redirects++){
  signal?.throwIfAborted();
  const address=await resolvePublic(url,resolver);signal?.throwIfAborted();const result=await transport(url,address,{signal});
  if(result.redirect){url=publicUrl(new URL(result.redirect,url).href);continue;}
  return extractSource(result.html,url.href);
 }
 throw fail('目标网站重定向次数过多。');
}
