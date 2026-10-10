// Render the chosen device width independently of the width of the editor panels.
const viewport=document.getElementById('canvasViewport');
const frame=document.getElementById('previewFrame');
const wrapper=viewport.querySelector('.preview-frame');
let queued=false;
function sizePreview(){
 queued=false;
 const width={desktop:1200,tablet:768,mobile:390}[viewport.dataset.device]||1200;
 const style=getComputedStyle(viewport),border=getComputedStyle(wrapper);
 const availableWidth=viewport.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight);
 const availableHeight=viewport.clientHeight-parseFloat(style.paddingTop)-parseFloat(style.paddingBottom);
 const borderX=parseFloat(border.borderLeftWidth)+parseFloat(border.borderRightWidth);
 const borderY=parseFloat(border.borderTopWidth)+parseFloat(border.borderBottomWidth);
 const scale=Math.min(1,Math.max(0.1,(availableWidth-borderX)/width));
 wrapper.style.width=`${width*scale+borderX}px`;
 wrapper.style.height=`${Math.max(100,availableHeight)}px`;
 frame.style.width=`${width}px`;
 frame.style.height=`${Math.max(100,(availableHeight-borderY)/scale)}px`;
 frame.style.transform=`scale(${scale})`;
 frame.style.transformOrigin='top left';
 document.getElementById('deviceSize').textContent=`${width}px · ${Math.round(scale*100)}%`;
}
function schedule(){if(!queued){queued=true;requestAnimationFrame(sizePreview);}}
new ResizeObserver(schedule).observe(viewport);
new MutationObserver(schedule).observe(viewport,{attributes:true,attributeFilter:['data-device']});
schedule();
