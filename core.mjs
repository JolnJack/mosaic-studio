export const SECTION_TYPES = ['hero','features','gallery','stats','pricing','faq','cta'];
export const THEMES = {
 editorial:{background:'#f4f1e9',surface:'#e7e2d7',text:'#252b26',muted:'#677062',accent:'#c0d391',font:'serif',radius:4},
 midnight:{background:'#111325',surface:'#1d2037',text:'#f1f0ff',muted:'#a5a6bd',accent:'#c4afff',font:'sans',radius:20},
 studio:{background:'#fffaf6',surface:'#f3e7dd',text:'#382a24',muted:'#806f65',accent:'#f3ac87',font:'sans',radius:12}
};
export function escapeHTML(value=''){return String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
export function safeUrl(value='',image=false){
 const str=String(value).trim(); if(!str || str.length>2048)return ''; if(!image && /^(#[\w-]*|\/[\w/?.=&%#-]*)$/.test(str) && !str.startsWith('//'))return str;
 try{const url=new URL(str);if(['https:','http:'].includes(url.protocol)&&!url.username&&!url.password)return url.href;if(!image&&['mailto:','tel:'].includes(url.protocol))return str;}catch{}return '';
}
const trim=(v,max=2000)=>typeof v==='string'?v.trim().slice(0,max):'';
const id=(v,fallback)=>/^[a-zA-Z0-9_-]{1,80}$/.test(v)?v:fallback;
function invalid(message){throw Object.assign(new Error(message),{status:422,code:'INVALID_DOCUMENT'});}
export function validateDocument(input){
 if(!input||typeof input!=='object'||Array.isArray(input))invalid('页面数据必须是对象。');
 if(input.schemaVersion!==1)invalid('不支持的页面数据版本。');
 if(!Array.isArray(input.pages)||input.pages.length<1||input.pages.length>12)invalid('项目需要 1–12 个页面。');
 const theme={...THEMES.editorial};
 for(const key of ['background','surface','text','muted','accent']){const value=input.theme?.[key];if(value!==undefined&&!/^#[0-9a-f]{6}$/i.test(value))invalid('主题颜色必须使用六位十六进制值。');if(value)theme[key]=value;}
 if(input.theme?.font!==undefined&&!['serif','sans','mono'].includes(input.theme.font))invalid('字体选项无效。');theme.font=input.theme?.font||theme.font;
 if(input.theme?.radius!==undefined){if(!Number.isFinite(input.theme.radius)||input.theme.radius<0||input.theme.radius>48)invalid('圆角值必须在 0–48 之间。');theme.radius=input.theme.radius;}
 const pages=input.pages.map((p,pi)=>{
  if(!p||!Array.isArray(p.sections)||p.sections.length>30)invalid('每页最多 30 个区块。');
  const sections=p.sections.map((s,si)=>{
   if(!s||!SECTION_TYPES.includes(s.type))invalid('不支持的区块类型。');
   if(s.items!==undefined&&(!Array.isArray(s.items)||s.items.length>20))invalid('每个区块最多 20 个条目。');
   if(s.layout!==undefined&&!['default','split','centered','stacked','bento'].includes(s.layout))invalid('不支持的区块布局。');
   return {id:id(s.id,`section-${pi}-${si}`),type:s.type,layout:s.layout||'default',eyebrow:trim(s.eyebrow,120),title:trim(s.title,240),body:trim(s.body,4000),button:{label:trim(s.button?.label,100),href:safeUrl(s.button?.href)||'#'},image:safeUrl(s.image,true),items:(s.items||[]).map(item=>({title:trim(item.title,160),body:trim(item.body,2000),price:trim(item.price,80),href:safeUrl(item.href)||'#',image:safeUrl(item.image,true)}))};
  });
  if(new Set(sections.map(s=>s.id)).size!==sections.length)invalid('区块 ID 不能重复。');
  const path=p.path==='/'?'/':'/'+trim(p.path||p.name,100).replace(/^\/+|\/+$/g,'').replace(/[^a-zA-Z0-9_-]/g,'-');
  return {id:id(p.id,`page-${pi}`),name:trim(p.name,80)||`Page ${pi+1}`,path,sections};
 });
 if(new Set(pages.map(p=>p.id)).size!==pages.length||new Set(pages.map(p=>p.path)).size!==pages.length)invalid('页面 ID 和路径不能重复。');
 return {schemaVersion:1,title:trim(input.title,160)||'Untitled website',description:trim(input.description,400),theme,pages};
}
export function createSection(type='features',n=1){
 const base={id:`${type}-${n}`,type,eyebrow:'OUR APPROACH',title:'Designed around what matters.',body:'Edit this section to describe your product, service, or point of view.',button:{label:'Get in touch',href:'#contact'},items:[]};
 if(type==='hero')Object.assign(base,{eyebrow:'A NEW PERSPECTIVE',title:'Make room for your next idea.',button:{label:'Explore our work',href:'#work'}});
 if(type==='features')base.items=[{title:'A thoughtful foundation',body:'A clear idea, shaped with care.'},{title:'Built for real people',body:'Useful details that make a difference.'},{title:'Ready for what comes next',body:'Space to evolve as your needs change.'}];
 if(type==='gallery')base.items=[{title:'Field notes',body:'A study in form and purpose.'},{title:'The collection',body:'An exploration of new possibilities.'}];
 if(type==='stats')base.items=[{title:'Your first metric',price:'—',body:'Add a verified number.'},{title:'Your second metric',price:'—',body:'Add a verified number.'}];
 if(type==='pricing')base.items=[{title:'Starter',price:'Set price',body:'Describe what this plan includes.',href:'#contact'},{title:'Professional',price:'Set price',body:'Describe what this plan includes.',href:'#contact'}];
 if(type==='faq')base.items=[{title:'How do we get started?',body:'Tell us about your idea and we will help you define the next step.'},{title:'Can this be customized?',body:'Yes. Edit the content, layout, and colors to make it yours.'}];
 if(type==='cta')Object.assign(base,{eyebrow:'START A CONVERSATION',title:'Let’s make something meaningful.',body:'A good collaboration starts with a simple hello.',button:{label:'Say hello',href:'mailto:hello@example.com'}});
 return base;
}
export function compositionSignature(input){
 const document=validateDocument(input);
 return JSON.stringify(document.pages.map(page=>page.sections.map(section=>{
  let layout=section.layout;
  if(section.type==='hero'&&['default','split'].includes(layout))layout='split';
  if(section.type==='cta'&&['default','centered'].includes(layout))layout='centered';
  if(section.type==='faq'&&['default','stacked','bento'].includes(layout))layout='default';
  if(['features','gallery','stats','pricing'].includes(section.type)&&section.items.length===0&&['default','stacked','bento'].includes(layout))layout='default';
  return [section.type,layout];
 })));
}
export function seedVariants(brief='',source=null){
 const brand=trim(source?.title,70)||'ATELIER';
 const text=trim(source?.description,320)||'A space for considered ideas. We bring clarity, character, and craft to every project.';
 const subject=trim(brief,140)||'Independent design practice';
 return Object.entries(THEMES).map(([name,theme],vi)=>{
  const hero=createSection('hero',1);Object.assign(hero,{layout:['split','centered','stacked'][vi],eyebrow:source?'CONTENT IMPORT / SAMPLE LAYOUT':'INDEPENDENT DESIGN & CREATIVE PRACTICE',title:source?.title||['Good ideas deserve a beautiful home.','An unmistakable point of view.','A little more human. A lot more you.'][vi],body:source?text:['We build thoughtful digital experiences for people and brands who see things a little differently.','A creative practice at the intersection of strategy, design, and technology. Built to move things forward.','Warm ideas. Clear intentions. Experiences made to bring people a little closer.'][vi]});
  const work=createSection('gallery',2);Object.assign(work,{id:'work',eyebrow:'SELECTED DIRECTIONS',title:['Form follows feeling.','A different kind of presence.','Small details. Lasting impressions.'][vi],body:subject,items:[{title:'Identity & direction',body:'A coherent visual language with room for your personality.'},{title:'Digital experiences',body:'Beautiful, useful spaces that feel like you.'},{title:'Strategy & story',body:'A clear point of view, expressed with intention.'}]});
  const features=createSection('features',3);features.title='From the first spark to the final detail.';if(vi===1)features.layout='bento';
  const cta=createSection('cta',4);cta.id='contact';
  return {id:`variant-${name}`,name:['Editorial / 编辑留白','Midnight / 数字夜色','Studio / 温暖工作室'][vi],document:validateDocument({schemaVersion:1,title:brand,description:text,theme,pages:[{id:'home',name:'Home',path:'/',sections:vi===1?[hero,features,work,cta]:[hero,work,features,cta]}]})};
 });
}
export function documentCSS(theme){
 return `:root{--bg:${theme.background};--surface:${theme.surface};--ink:${theme.text};--muted:${theme.muted};--accent:${theme.accent};--radius:${theme.radius}px;--font:${theme.font==='serif'?'Georgia,Times New Roman,serif':theme.font==='mono'?'ui-monospace,monospace':'Inter,Arial,sans-serif'}}*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--bg);color:var(--ink);font-family:Arial,sans-serif}a{color:inherit;text-decoration:none}button,input{font:inherit}.website{max-width:1680px;margin:auto}.site-header{display:flex;justify-content:space-between;align-items:center;padding:30px 6%;border-bottom:1px solid color-mix(in srgb,var(--ink) 14%,transparent)}.wordmark{font-size:20px;font-weight:800;letter-spacing:-.8px}.site-nav{display:flex;gap:24px;font-size:12px}.site-nav a:hover{text-decoration:underline}.site-section{padding:80px 6%;position:relative}.eyebrow{font:10px ui-monospace,monospace;letter-spacing:2px;text-transform:uppercase;color:var(--muted);margin:0 0 22px}.hero{display:grid;grid-template-columns:1.25fr 1fr;gap:7%;align-items:center;min-height:590px}.hero h1{font:normal clamp(38px,5.8vw,86px)/1.04 var(--font);letter-spacing:-3px;margin:0 0 24px}.hero .copy{max-width:510px}.copy{font-size:15px;line-height:1.85;color:var(--muted);white-space:pre-line}.button{display:inline-flex;align-items:center;gap:28px;padding:15px 21px;background:var(--accent);color:var(--ink);border:1px solid color-mix(in srgb,var(--ink) 15%,transparent);border-radius:var(--radius);font-size:12px;font-weight:700;margin-top:18px}.button:hover{filter:brightness(.96)}.art{min-height:380px;position:relative;overflow:hidden;border-radius:var(--radius);background:var(--surface)}.art svg{display:block;width:100%;height:100%;min-height:380px}.art img{width:100%;height:100%;object-fit:cover;min-height:380px}.art-caption{position:absolute;bottom:20px;left:22px;right:22px;display:flex;justify-content:space-between;font:9px monospace;letter-spacing:1px;color:var(--ink)}h2{font:normal clamp(26px,3.2vw,48px)/1.15 var(--font);letter-spacing:-1px;max-width:750px;margin:0 0 20px}.section-intro{display:flex;justify-content:space-between;gap:40px;margin-bottom:38px}.section-intro .copy{max-width:340px;margin-top:0}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:20px}.card{padding:28px;background:var(--surface);border-radius:var(--radius)}.card h3,.gallery-item h3{font-size:18px;line-height:1.3;font-weight:500;margin:18px 0 12px}.card p,.gallery-item p{font-size:13px;line-height:1.7;color:var(--muted);white-space:pre-line}.card .number{font:10px monospace;color:var(--muted)}.gallery{border-top:1px solid color-mix(in srgb,var(--ink) 14%,transparent)}.gallery-art{background:var(--surface);border-radius:var(--radius);position:relative;overflow:hidden;height:220px;display:grid;place-items:center}.gallery-art:before{content:'';width:48%;height:75%;background:var(--accent);border-radius:50% 50% 0 0;transform:rotate(-24deg);box-shadow:35px 22px 0 color-mix(in srgb,var(--ink) 15%,transparent)}.gallery-item:nth-child(2) .gallery-art:before{border-radius:0;transform:rotate(22deg);width:55%;height:55%}.gallery-item:nth-child(3) .gallery-art:before{border-radius:50%;transform:none;box-shadow:0 0 0 18px color-mix(in srgb,var(--accent) 20%,transparent)}.gallery-item{min-width:0}.gallery-item img{width:100%;height:220px;object-fit:cover}.stats{background:var(--surface)}.metric{font:normal 48px var(--font)}.pricing .price{font:normal 38px var(--font)}.faq details{padding:22px 0;border-bottom:1px solid color-mix(in srgb,var(--ink) 20%,transparent)}.faq summary{font-size:16px;cursor:pointer}.faq details p{max-width:680px;line-height:1.7;color:var(--muted)}.cta{text-align:center;background:var(--surface);margin:24px 6% 70px;border-radius:var(--radius)}.cta h2,.cta .copy{margin-left:auto;margin-right:auto;max-width:670px}.site-footer{padding:25px 6%;display:flex;justify-content:space-between;font:10px monospace;color:var(--muted);border-top:1px solid color-mix(in srgb,var(--ink) 14%,transparent)}.empty{padding:120px 6%;text-align:center;color:var(--muted)}[data-edit]{cursor:pointer}[data-edit]:hover{outline:2px dashed var(--accent);outline-offset:5px}@media(max-width:760px){.site-header{padding:22px 6%}.site-nav{gap:12px;font-size:10px}.hero{grid-template-columns:1fr;min-height:0;gap:35px}.hero h1{font-size:48px;letter-spacing:-2px}.site-section{padding:50px 6%}.art,.art svg,.art img{min-height:260px}.section-intro{display:block}.grid{grid-template-columns:1fr}.gallery-art{height:250px}.site-footer{gap:15px;flex-wrap:wrap}.cta{margin:20px 6% 40px}}@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}`;
}
function ornament(){return `<svg viewBox="0 0 500 500" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><circle cx="355" cy="115" r="80" fill="var(--accent)"/><path d="M100 430V215a120 120 0 0 1 240 0v215Z" fill="var(--ink)" opacity=".12"/><path d="M150 430V215a120 120 0 0 1 240 0v215Z" fill="var(--accent)"/><path d="M150 430V215a120 120 0 0 1 120-120v335Z" fill="var(--ink)" opacity=".08"/><path d="M30 435h430M30 448h430" stroke="var(--ink)" opacity=".25"/></svg>`;}
function layoutCSS(){return `.hero.layout-centered{display:block;text-align:center;min-height:0;padding-top:75px}.hero.layout-centered>div:first-child{max-width:960px;margin:auto}.hero.layout-centered h1{font-size:clamp(40px,6vw,86px)}.hero.layout-centered .copy{margin:auto;max-width:540px}.hero.layout-centered .art{margin:42px auto 0;max-width:950px;min-height:240px;height:240px}.hero.layout-centered .art svg{min-height:240px;height:240px}.hero.layout-stacked{display:block;padding-top:70px}.hero.layout-stacked h1{max-width:950px}.hero.layout-stacked .art{height:300px;min-height:300px;margin-top:42px}.hero.layout-stacked .art svg{height:300px;min-height:300px}.layout-bento .grid{grid-template-columns:repeat(2,1fr)}.layout-bento .card:first-child{grid-column:1/-1;padding:40px}.layout-stacked .grid{grid-template-columns:1fr}.layout-centered .section-intro{display:block;text-align:center}.layout-centered .section-intro h2,.layout-centered .section-intro p{margin-left:auto;margin-right:auto}@media(max-width:760px){.layout-bento .grid{grid-template-columns:1fr}.hero.layout-centered h1{font-size:46px}.hero.layout-centered,.hero.layout-stacked{padding-top:45px}.hero.layout-stacked .art{height:240px;min-height:240px}}`;}
function siteMarkup(doc,page,editing,preview=false){
 const e=escapeHTML;const attr=(s,field)=>editing?` data-edit="${field}" data-section="${e(s.id)}"`:'';
 const link=href=>preview&&!href.startsWith('#')?'aria-disabled="true"':`href="${e(preview?'about:srcdoc'+href:href)}"`;
 const button=s=>s.button.label?`<a class="button" ${link(s.button.href)}${attr(s,'button')}>${e(s.button.label)} <span aria-hidden="true">↗</span></a>`:'';
 const intro=s=>`<p class="eyebrow"${attr(s,'eyebrow')}>${e(s.eyebrow)}</p><div class="section-intro"><h2${attr(s,'title')}>${e(s.title)}</h2><p class="copy"${attr(s,'body')}>${e(s.body)}</p></div>`;
 const sections=page.sections.map(s=>{
  const items=s.items.map((it,i)=>{
   const title=`<h3${attr(s,`items.${i}.title`)}>${e(it.title)}</h3>`,body=`<p${attr(s,`items.${i}.body`)}>${e(it.body)}</p>`;
   if(s.type==='gallery')return `<article class="gallery-item">${it.image?`<img src="${e(it.image)}" alt="${e(it.title)}" loading="lazy" referrerpolicy="no-referrer">`:'<div class="gallery-art" aria-hidden="true"></div>'}${title}${body}</article>`;
   if(s.type==='faq')return `<details><summary${attr(s,`items.${i}.title`)}>${e(it.title)}</summary>${body}</details>`;
   if(s.type==='stats')return `<article class="card"><div class="metric"${attr(s,`items.${i}.price`)}>${e(it.price)}</div>${title}${body}</article>`;
   if(s.type==='pricing')return `<article class="card">${title}<div class="price"${attr(s,`items.${i}.price`)}>${e(it.price)}</div>${body}<a class="button" ${link(it.href)}>Learn more ↗</a></article>`;
   return `<article class="card"><span class="number">0${i+1}</span>${title}${body}</article>`;
  }).join('');
  if(s.type==='hero')return `<section class="site-section hero layout-${s.layout}" id="${e(s.id)}"><div><p class="eyebrow"${attr(s,'eyebrow')}>${e(s.eyebrow)}</p><h1${attr(s,'title')}>${e(s.title)}</h1><p class="copy"${attr(s,'body')}>${e(s.body)}</p>${button(s)}</div><div class="art">${s.image?`<img src="${e(s.image)}" alt="${e(s.title)}" referrerpolicy="no-referrer">`:ornament()}<div class="art-caption"><span>FORM / PURPOSE / POSSIBILITY</span><span>01 — STUDIO</span></div></div></section>`;
  if(s.type==='cta')return `<section class="site-section cta layout-${s.layout}" id="${e(s.id)}"><p class="eyebrow"${attr(s,'eyebrow')}>${e(s.eyebrow)}</p><h2${attr(s,'title')}>${e(s.title)}</h2><p class="copy"${attr(s,'body')}>${e(s.body)}</p>${button(s)}</section>`;
  return `<section class="site-section ${s.type} layout-${s.layout}" id="${e(s.id)}">${intro(s)}<div${s.type==='faq'?'':' class="grid"'}>${items}</div></section>`;
 }).join('');
 const nav=doc.pages.length>1?doc.pages.map(p=>`<a ${link(p.path==='/'?'index.html':p.path.slice(1)+'.html')}>${e(p.name)}</a>`).join(''):page.sections.filter(s=>['gallery','features','cta'].includes(s.type)).map(s=>`<a ${link('#'+s.id)}>${e({gallery:'Work',features:'Approach',cta:'Contact'}[s.type])}</a>`).join('');
 return `<div class="website"><header class="site-header"><a class="wordmark" ${link('index.html')}>${e(doc.title)}</a><nav class="site-nav" aria-label="Main navigation">${nav}</nav></header><main>${sections||'<p class="empty">Add a section to start this page.</p>'}</main><footer class="site-footer"><span>© ${new Date().getFullYear()} ${e(doc.title)}</span><span>${e(doc.description)}</span></footer></div>`;
}
const bridge=`document.addEventListener('click',event=>{const node=event.target.closest('[data-edit]');if(node){event.preventDefault();parent.postMessage({type:'mosaic-select',sectionId:node.dataset.section,field:node.dataset.edit},'*');}else if(event.target.closest('a'))event.preventDefault();});`;
export function renderDocument(input,{pageId,editing=false,preview=false}={}){
 const doc=validateDocument(input),page=doc.pages.find(p=>p.id===pageId)||doc.pages[0];
 return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="description" content="${escapeHTML(doc.description)}"><title>${escapeHTML(doc.title)}</title><style>${documentCSS(doc.theme)}${layoutCSS()}${compositionCSS()}</style></head><body>${siteMarkup(doc,page,editing,preview)}${editing?`<script>${bridge}</script>`:''}</body></html>`;
}
export function renderReact(input,{pageId}={}){
 const doc=validateDocument(input),page=doc.pages.find(p=>p.id===pageId)||doc.pages[0];
 // All text, links and attributes in markup come from canonical validated data.
 const markup=siteMarkup(doc,page,false);
 return {jsx:`import React from 'react';\nimport './styles.css';\n\n// Validated document rendered with the same markup as the HTML export.\nconst markup = ${JSON.stringify(markup)};\nexport default function Website() {\n  return <div dangerouslySetInnerHTML={{ __html: markup }} />;\n}\n`,css:documentCSS(doc.theme)+layoutCSS()+compositionCSS()};
}

// These are compositions, not only palette changes. Keep the same rules in
// canvas, small previews, standalone HTML, and the React archive.
function compositionCSS(){return `
.site-header{gap:24px;flex-wrap:wrap}.wordmark{overflow-wrap:anywhere;max-width:100%}
.site-nav{display:flex;flex-wrap:wrap;gap:12px 24px}.site-nav a{padding:6px 0}
a:focus-visible,summary:focus-visible{outline:2px solid var(--ink);outline-offset:5px}
.site-section{min-width:0}.site-section h1,.site-section h2,.copy,.card h3,.gallery-item h3{overflow-wrap:anywhere}
.section-intro>*{min-width:0}.grid>*{min-width:0}.gallery-item img{display:block;border-radius:var(--radius)}
.site-section.layout-split:not(.hero){display:grid;grid-template-columns:minmax(0,.85fr) minmax(0,1.55fr);gap:24px 48px;align-items:start}
.site-section.layout-split>.eyebrow{grid-column:1/-1;margin-bottom:0}
.site-section.layout-split>.section-intro{display:block;margin:0;position:sticky;top:30px}
.site-section.layout-split>.section-intro .copy{max-width:100%}
.site-section.layout-split>.grid{grid-template-columns:repeat(2,minmax(0,1fr))}
.site-section.layout-split.cta{display:block;text-align:left}
.layout-centered .grid{grid-template-columns:repeat(auto-fit,minmax(min(100%,250px),1fr));text-align:center}
.layout-centered .card{padding:40px 28px}.layout-centered .gallery-item{text-align:left}
.layout-stacked .card{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:8px 24px;align-items:center;padding:32px 36px}
.layout-stacked .card>.number{grid-column:1/-1}.layout-stacked .card>h3{margin:0}
.layout-stacked .gallery-item{display:grid;grid-template-columns:minmax(0,1.5fr) minmax(0,1fr);gap:0 32px;align-items:center}
.layout-stacked .gallery-item>.gallery-art,.layout-stacked .gallery-item>img{grid-row:1/3;height:280px}
.layout-stacked .gallery-item>h3{align-self:end}.layout-stacked .gallery-item>p{align-self:start}
.layout-bento .grid{grid-auto-flow:row;grid-template-columns:repeat(2,minmax(0,1fr))}
.layout-bento .gallery-item:first-child{grid-column:1/-1}
.layout-bento .gallery-item:first-child .gallery-art,.layout-bento .gallery-item:first-child>img{height:360px}
.layout-bento .card:first-child h3{font-size:28px}.faq>.section-intro{margin-bottom:16px}
.hero.layout-bento{grid-template-columns:1fr 1fr;gap:24px;padding-top:50px;padding-bottom:50px}
.hero.layout-bento>div:first-child{padding:38px;background:var(--surface);border-radius:var(--radius);align-self:stretch;display:flex;flex-direction:column;justify-content:center}
.hero.layout-bento .art{align-self:stretch;min-height:500px}.hero.layout-bento .button{align-self:flex-start}
.site-section.cta.layout-split{display:grid;grid-template-columns:1.3fr 1fr;text-align:left;gap:20px 48px;align-items:start}
.site-section.cta.layout-split>.eyebrow{grid-column:1/-1}
.site-section.cta.layout-split>h2{grid-column:1;grid-row:2/4;margin:0}
.site-section.cta.layout-split>.copy,.site-section.cta.layout-split>.button{grid-column:2;margin:0;justify-self:start}
.cta.layout-stacked{text-align:left}.cta.layout-stacked>h2,.cta.layout-stacked>.copy{margin-left:0;max-width:90%}
.cta.layout-stacked>.button{display:flex;justify-content:space-between;width:100%}
.cta.layout-bento{display:grid;grid-template-columns:1.5fr 1fr;gap:24px;text-align:left}
.cta.layout-bento>.eyebrow{grid-column:1/-1}.cta.layout-bento>h2{grid-column:1;grid-row:2/4;margin:0}
.cta.layout-bento>.copy{grid-column:2;padding:24px;border:1px solid color-mix(in srgb,var(--ink) 20%,transparent);border-radius:var(--radius);margin:0}
.cta.layout-bento>.button{grid-column:2;display:flex;justify-content:space-between;margin:0}
@media(max-width:760px){
 .site-section.layout-split:not(.hero){display:block}.site-section.layout-split>.eyebrow{margin-bottom:22px}
 .site-section.layout-split>.section-intro{position:static;margin-bottom:30px}
 .site-section.layout-split>.grid,.layout-bento .grid,.layout-centered .grid{grid-template-columns:1fr}
 .layout-stacked .card,.layout-stacked .gallery-item{display:block;padding:24px}
 .layout-stacked .gallery-item{padding:0}.layout-stacked .gallery-item>.gallery-art,.layout-stacked .gallery-item>img{height:240px}
 .layout-bento .gallery-item:first-child .gallery-art,.layout-bento .gallery-item:first-child>img{height:250px}
 .site-nav{gap:8px 16px}.hero h1{font-size:clamp(32px,10vw,48px)}
 .hero.layout-bento{grid-template-columns:1fr}.hero.layout-bento>div:first-child{padding:24px}.hero.layout-bento .art{min-height:260px}
 .site-section.cta.layout-split,.cta.layout-bento{display:block}.cta.layout-bento>.copy{margin-top:24px}
 .site-section.cta.layout-split>.button,.cta.layout-bento>.button{margin-top:20px}
}`;}
