// UI: DOM helpers, downloads, Google Sheets clipboard, tabs, file input, images.
const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const alertBox = (cls,title,lines,list) =>
  '<div class="alert'+cls+'"><h3>'+esc(title)+"</h3><p>"+lines.map(esc).join("</p><p>")+"</p>"+
  (list&&list.length?"<ul>"+list.map(b=>"<li>"+esc(b)+"</li>").join("")+"</ul>":"")+"</div>";

const ZIP_MIME="application/zip";
const XLSX_MIME="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const xlsxOf = f => makeXlsx(f.cols,f.rows);
// A file name splits at its last dot: the stem is editable, the extension is not.
const extOf = n => n.slice(n.lastIndexOf("."));
const stemOf = n => n.slice(0,n.lastIndexOf("."));

// A button whose wording changes carries all of its wordings from the start,
// stacked in one grid cell: it stays as wide as its longest label, so a row
// never shifts under the pointer.
const swapLabel = (btn,i) =>
  btn.querySelectorAll(".swap>span").forEach((s,n)=>s.classList.toggle("off",n!==i));

// A file already saved says so: the solid button turns white with a check, so a
// list of ten exports shows which ones are still missing.
const CHECK='<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" '+
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8.5 6.5 12 13 5"/></svg>';
const dlButton = label =>
  '<span class="swap"><span>'+label+'</span>'+
  '<span class="off mark">'+CHECK+"Downloaded</span></span>";
function markDownloaded(btn){
  btn.classList.remove("ghost"); btn.classList.add("done");
  swapLabel(btn,1);
}
function resetDownloaded(btn){
  btn.classList.remove("done"); swapLabel(btn,0);
}

function download(name, bytes, type){
  const a=document.createElement("a");
  a.href=URL.createObjectURL(new Blob([bytes],{type}));
  a.download=name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(a.href),4000);
}

// ---- Google Sheets ----
// Drive would take the .xlsx and convert it, but its API wants an OAuth client
// tied to an https origin and this page is opened as a local file, so the
// clipboard is the one route left. The table travels as text/html, which is
// what Sheets reads as a grid, and every cell carries a data-sheets-value
// saying "this is a string", so an external id or a barcode lands as text
// instead of losing its leading zeros. The plain-text copy is the fallback for
// anything but Sheets.
const SHEETS_NEW="https://docs.google.com/spreadsheets/create";

function sheetsHtml(cols, rows){
  const cell = v => {
    const str = v==null ? "" : String(v);
    const meta = JSON.stringify({1:2,2:str})
      .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/'/g,"&#39;");
    // a newline inside a cell survives as <br>; esc() leaves it as a raw newline
    return "<td data-sheets-value='"+meta+"'>"+esc(str).replace(/\r?\n/g,"<br>")+"</td>";
  };
  const line = cells => "<tr>"+cells.map(cell).join("")+"</tr>";
  return "<table>"+[line(cols),...rows.map(r=>line(cols.map(c=>r[c])))].join("")+"</table>";
}
// Tabs and newlines are what separate cells in the plain-text version, so a cell
// that contains them has to give them up.
function sheetsText(cols, rows){
  const cell = v => String(v==null?"":v).replace(/[\t\r\n]+/g," ");
  return [cols.join("\t"),...rows.map(r=>cols.map(c=>cell(r[c])).join("\t"))].join("\n");
}

// execCommand is retired but it is the only copy that is synchronous, keeps the
// click's user activation and writes text/html from a file:// page in every
// browser. The selection is for Safari, which refuses to copy without one.
function copyToClipboard(html, text){
  const relay = e => {
    e.clipboardData.setData("text/html", html);
    e.clipboardData.setData("text/plain", text);
    e.preventDefault();
  };
  const box=document.createElement("textarea");
  box.value=text;
  box.setAttribute("readonly","");
  box.style.cssText="position:fixed;top:0;left:-9999px;opacity:0";
  document.body.appendChild(box);
  const focused=document.activeElement;
  box.select();
  document.addEventListener("copy",relay);
  let ok=false;
  try{ ok=document.execCommand("copy"); }catch(e){ ok=false; }
  document.removeEventListener("copy",relay);
  box.remove();
  if(focused && focused.focus) focused.focus();
  return ok;
}

const PASTE_KEY = /Mac|iPhone|iPad/.test(navigator.platform||"") ? "⌘V" : "Ctrl+V";

// One button, two steps. The first click only fills the clipboard and says so,
// the second opens the blank sheet. Split that way, the new tab arrives when it
// is asked for, with the table already waiting, and a refused copy never takes
// the user to an empty spreadsheet.
// The wordings this button takes, in the order it shows them; all three are in
// the row from the start so its width never depends on which one is up.
const SHEETS_LABELS=["Copy to clipboard","Copy refused","Open Sheets"];
const sheetsButton = () =>
  '<span class="swap">'+SHEETS_LABELS.map((t,n)=>
    '<span'+(n?' class="off"':'')+'>'+t+"</span>").join("")+"</span>";

function copyForSheets(f, btn){
  clearTimeout(+btn.dataset.timer||0);
  if(!copyToClipboard(sheetsHtml(f.cols,f.rows), sheetsText(f.cols,f.rows))){
    swapLabel(btn,1);
    btn.dataset.timer=setTimeout(()=>swapLabel(btn,0),4000);
    return;
  }
  btn.dataset.act="paste";
  swapLabel(btn,2);
  btn.title="Opens a new Google Sheet, then press "+PASTE_KEY;
}

// Anything may have been copied since the first click, so the table is written
// to the clipboard again on the way out: the sheet that opens is always one
// paste away from being filled.
function pasteInSheets(f){
  copyToClipboard(sheetsHtml(f.cols,f.rows), sheetsText(f.cols,f.rows));
  window.open(SHEETS_NEW,"_blank","noopener");
}

// ---- tabs ----
// One tab per import domain, each owning its own panel and drop zone.
const tabs=[...document.querySelectorAll(".tab")];
const panelOf = tab => document.getElementById(tab.getAttribute("aria-controls"));

function selectTab(tab){
  for(const t of tabs){
    const on = t===tab;
    t.setAttribute("aria-selected",on);
    t.tabIndex = on ? 0 : -1;
    panelOf(t).hidden = !on;
  }
}
tabs.forEach((tab,i)=>{
  tab.addEventListener("click",()=>selectTab(tab));
  tab.addEventListener("keydown",e=>{
    const step = e.key==="ArrowRight" ? 1 : e.key==="ArrowLeft" ? -1 : 0;
    if(!step) return;
    e.preventDefault();
    const next=tabs[(i+step+tabs.length)%tabs.length];
    selectTab(next); next.focus();
  });
});

// ---- input ----
for(const panel of document.querySelectorAll(".panel")){
  const zone=panel.querySelector(".drop"), input=panel.querySelector(".file");
  zone.addEventListener("click",()=>input.click());
  zone.addEventListener("keydown",e=>{ if(e.key==="Enter"||e.key===" "){e.preventDefault();input.click();} });
  ["dragenter","dragover"].forEach(t=>zone.addEventListener(t,e=>{e.preventDefault();zone.classList.add("over");}));
  ["dragleave","drop"].forEach(t=>zone.addEventListener(t,e=>{e.preventDefault();zone.classList.remove("over");}));
  zone.addEventListener("drop",e=>{ const f=e.dataTransfer.files[0]; if(f) read(panel,f); });
  input.addEventListener("change",()=>{ if(input.files[0]) read(panel,input.files[0]); });
}

// Each panel names its converter in data-convert.
const CONVERTERS={products:convertProducts, inventory:convertInventory,
                  customers:convertCustomers, orders:convertOrders,
                  redirections:convertRedirections};
// The "download all" archive is named after the tab that produced it.
const ZIP_NAMES={products:"odoo-import.zip", inventory:"odoo-inventory.zip",
                 customers:"odoo-contacts.zip", orders:"odoo-orders.zip",
                 redirections:"odoo-redirections.zip"};
const panelFiles=new Map();
// The text of the last file dropped on each panel, so ticking an option runs the
// export through the converter again.
const panelTexts=new Map();
// Names the user has typed, per panel, kept against the name the converter gave
// the file: a re-run should give back the list under the names the user chose.
// A new export starts over.
const panelNames=new Map();
let imgQueue=[], imgData=[], imgSig=null;

// Ticking an option changes what goes into the file, so the export is converted
// again rather than the file patched in place.
for(const box of document.querySelectorAll(".opt input")){
  const panel=box.closest(".panel");
  box.addEventListener("change",()=>{
    const text=panelTexts.get(panel);
    if(text!=null) run(panel,text);
  });
}

async function read(panel,f){
  const zone=panel.querySelector(".drop");
  zone.classList.add("loaded");
  zone.querySelector("strong").textContent=f.name;
  zone.querySelector("span").textContent="Change";
  let text;
  try{ text=await f.text(); }
  catch{ return showErrors(panel,["This file could not be read."]); }
  panelNames.delete(panel);
  run(panel,text);
}

const setMsg = (panel,html) => panel.querySelector(".msg").innerHTML=html;
function showErrors(panel, list, bad){
  setMsg(panel, list.length ? alertBox("","Conversion failed",list,bad) : "");
}

function run(panel,text){
  const result=panel.querySelector(".result");
  const readBox=panel.querySelector(".read");
  const imgBox=panel.querySelector(".opt input");
  const opt=imgBox&&imgBox.closest(".opt");
  panelTexts.set(panel,text);
  const out=CONVERTERS[panel.dataset.convert](text,{images:!imgBox||imgBox.checked});
  // The option appears with the results and disappears with them: on its own it
  // would be a setting for a file that is not there yet.
  if(opt) opt.hidden=!!out.errors;
  if(out.errors){ showErrors(panel,out.errors,out.badValues);
                  readBox.hidden=true; result.hidden=true; return; }
  showErrors(panel,[]);
  panelFiles.set(panel,out.files);
  if(out.skus) knownSkus=out.skus;
  if(out.partners) knownPartners=out.partners;

  renderRead(panel,out);
  readBox.hidden=false;
  renderFiles(panel,out,opt);
  if(out.images) syncImages(out.images);   // images are a products-only affair
  result.hidden=false;
}

// One tab per count, read across rather than down, with the breakdown of the
// selected one underneath. Without a detailed breakdown there is only the
// one-line summary, so its "12 products · 34 variants" is cut back apart.
function renderRead(panel,out){
  const tags=panel.querySelector(".tags");
  const counts = out.detail || String(out.summary).split(" · ").map(label=>({label}));
  const pid = panel.dataset.convert;
  tags.innerHTML =
    '<div class="readTabs">'+
    counts.map((d,i)=>{
      const m=/^\s*([\d.,]+)\s+(.+)$/.exec(d.label);
      const num=m?m[1]:"", what=m?m[2]:d.label;
      const inner='<span class="n">'+esc(num)+'</span><span>'+esc(what)+"</span>";
      // Only a breakdown can be opened; a plain count has nothing behind it.
      return d.items
        ? '<button type="button" class="readTab" aria-expanded="false" data-i="'+i+
          '" aria-controls="read-'+pid+"-"+i+'">'+inner+"</button>"
        : '<span class="readTab">'+inner+"</span>";
    }).join("")+
    "</div>"+
    counts.map((d,i)=> d.items
      ? '<div class="readPanel" id="read-'+pid+"-"+i+'" data-i="'+i+'" hidden><ul class="items">'+
        (d.items.length ? d.items.map(x=>"<li>"+esc(x)+"</li>").join("")
                        : '<li class="none">'+esc(d.empty||"Nothing to list.")+"</li>")+
        "</ul></div>"
      : "").join("")+
    (out.warnings&&out.warnings.length?alertBox(" warn","Worth checking",out.warnings):"");

  // One list at a time: two open lists push the download buttons off the screen.
  tags.querySelectorAll("button.readTab").forEach(btn=>btn.addEventListener("click",()=>{
    const open=btn.getAttribute("aria-expanded")==="true";
    tags.querySelectorAll("button.readTab").forEach(b=>b.setAttribute("aria-expanded","false"));
    tags.querySelectorAll(".readPanel").forEach(r=>r.hidden=true);
    if(open) return;
    btn.setAttribute("aria-expanded","true");
    tags.querySelector('.readPanel[data-i="'+btn.dataset.i+'"]').hidden=false;
  }));
}

function renderFiles(panel,out,opt){
  const files=panel.querySelector(".files");
  const pid=panel.dataset.convert;
  // a rename is stored under the converter's own name for the file, so it
  // survives a re-run; a file no longer produced keeps its default
  let chosen=panelNames.get(panel);
  if(!chosen) panelNames.set(panel,chosen=new Map());
  out.files.forEach(f=>{ f.base=f.name; if(chosen.has(f.base)) f.name=chosen.get(f.base); });
  files.innerHTML = out.files.map((f,i)=>
    '<div class="fileRow"><span class="num">'+(i+1)+'</span><div class="fileMeta"><b>'+
    // The name is the user's to set. The field holds the stem only, the extension
    // standing beside it as text, so a rename cannot produce a file Odoo will not
    // read. The grid sizer behind the input grows the box with what is typed.
    '<span class="fileName"><span class="nameField" data-value="'+esc(stemOf(f.name))+'">'+
    '<input class="nameInput" type="text" spellcheck="false" autocomplete="off"'+
    ' aria-label="File name" data-i="'+i+'" value="'+esc(stemOf(f.name))+'"></span>'+
    '<span class="ext">'+esc(extOf(f.name))+"</span></span>"+
    // the note is a hover aside, on the same pattern as the one above the drop zone,
    // its i set against the file name rather than the model line
    (f.note
      ? '<span class="howBox noteBox"><button class="info" type="button"'+
        ' aria-label="What this file is for" aria-describedby="how-file-'+pid+"-"+i+'">'+
        '<span class="i" aria-hidden="true">i</span></button>'+
        '<p class="how" id="how-file-'+pid+"-"+i+'" role="tooltip">'+esc(f.note)+"</p></span>"
      : "")+
    '</b><div class="model">'+esc(f.model)+" · "+plural(f.rows.length,"row")+
    '</div></div><div class="rowActions">'+
    '<button class="btn" data-act="dl" data-i="'+i+'">'+dlButton("Download")+"</button>"+
    '<button class="btn ghost" data-act="sheets" data-i="'+i+'">'+sheetsButton()+"</button></div>"+
    (f.imageOpt?'<div class="optSlot"></div>':"")+'</div>').join("");
  files.querySelectorAll("button[data-act]").forEach(b=>b.addEventListener("click",()=>{
    const f=out.files[+b.dataset.i];
    if(b.dataset.act==="dl"){ download(f.name,xlsxOf(f),XLSX_MIME); markDownloaded(b); }
    else if(b.dataset.act==="sheets") copyForSheets(f,b);
    else pasteInSheets(f);
  }));
  files.querySelectorAll("input.nameInput").forEach(inp=>{
    const f=out.files[+inp.dataset.i], field=inp.parentNode, ext=extOf(f.name);
    const resize=()=>{ field.dataset.value=inp.value; };
    inp.addEventListener("input",()=>{
      // the characters a file system refuses, dropped as they are typed rather
      // than at the end, so the field never shows a name it will not keep
      const clean=inp.value.replace(/[\\/:*?"<>|]/g,"");
      if(clean!==inp.value){
        const at=Math.max(0,inp.selectionStart-(inp.value.length-clean.length));
        inp.value=clean; inp.setSelectionRange(at,at);
      }
      resize();
    });
    inp.addEventListener("keydown",e=>{ if(e.key==="Enter"){ e.preventDefault(); inp.blur(); } });
    inp.addEventListener("blur",()=>{
      const stem=inp.value.trim();
      // an empty field is not a name: the row goes back to the one it had
      inp.value = stem || stemOf(f.name);
      resize();
      if(inp.value+ext===f.name) return;
      f.name=inp.value+ext;
      chosen.set(f.base,f.name);
      // the copy already saved carries the old name, so the row is due again
      resetDownloaded(inp.closest(".fileRow").querySelector('button[data-act="dl"]'));
    });
  });
  // The option belongs to the products file, so it is moved into that row rather
  // than standing above the results. Moving the element keeps its listeners, and
  // the data-act selector above leaves its own controls alone.
  const slot=files.querySelector(".optSlot");
  if(opt && slot) slot.appendChild(opt);
}

// ---- images ----
// The photos to fetch do not depend on the option, so a re-run finding the same
// URLs keeps what has already been downloaded.
function syncImages(list){
  const sig=list.map(i=>i.url).join("\n");
  if(sig!==imgSig){
    imgSig=sig; imgData=[];
    showZip(false); $("#imgHint").textContent="";
  }
  imgQueue=list;
  $("#imgActions").hidden = imgQueue.length===0;
}

// The two buttons are one slot: once there is a zip to take, it stands in the
// place of the fetch button rather than beside it.
function showZip(ready){
  if(ready) resetDownloaded($("#dlImgs"));
  $("#dlImgs").hidden=!ready;
  $("#fetchImgs").hidden=ready;
}

// The fetch runs from its own button and from "Download all". Two clicks never
// start two runs: the second is handed the run already in flight, so the archive
// is never built on a half-filled imgData.
let imgRun=null;
function fetchImages(){
  return imgRun || (imgRun = runImageFetch().finally(()=>{ imgRun=null; }));
}
async function runImageFetch(){
  $("#fetchImgs").disabled=true; imgData=[];
  // Progress and errors go to #imgHint: there is no per-image list to write into.
  let ko=0, firstError="";
  for(let i=0;i<imgQueue.length;i++){
    const im=imgQueue[i];
    $("#imgHint").textContent="fetching "+(i+1)+" of "+imgQueue.length+"…";
    try{
      const res=await fetch(im.url,{mode:"cors"});
      if(!res.ok) throw new Error("response "+res.status);
      const blob=await res.blob();
      if(!/^image\//.test(blob.type||"")) throw new Error("not an image ("+(blob.type||"unknown type")+")");
      imgData.push({paths:im.paths,bytes:new Uint8Array(await blob.arrayBuffer())});
    }catch(e){
      if(!firstError) firstError=(im.paths[0]||"image")+": "+e.message;
      ko++;
    }
  }
  const ok=imgData.length;
  $("#fetchImgs").disabled=false;
  // Nothing arrived: the fetch button stays, so the run can be tried again.
  showZip(ok>0);
  $("#imgHint").textContent = ko===0
    ? ""
    : plural(ko,"failure")+" out of "+imgQueue.length+" ("+firstError+"). If the message "+
      "mentions CORS or the network, the CDN is refusing your browser too, because the page "+
      "is a local file: save the images by hand from your store, keeping exactly the file "+
      "names from the Image column of the products file."+
      (ok?" The "+plural(ok,"image")+" that did arrive are in images.zip.":"");
  return ok;
}

$("#fetchImgs").addEventListener("click",()=>{ fetchImages(); });

// One download per URL, but a photo shared by several variants is written into
// each of their folders: the zip stores it once per path.
// its two wordings, from the page's plain label, on the file rows' pattern
$("#dlImgs").innerHTML=dlButton("Download .zip");
$("#dlImgs").addEventListener("click",()=>{
  download("images.zip",
    makeZip(imgData.flatMap(d=>d.paths.map(name=>({name,bytes:d.bytes})))),ZIP_MIME);
  markDownloaded($("#dlImgs"));
});

// The whole export in one archive: the files, plus the photos under Products
// Images/ so they stay clear of the spreadsheets. Photos not fetched yet are
// fetched now, since the button stands for everything the export is made of.
for(const button of document.querySelectorAll(".all"))
  button.addEventListener("click",async ()=>{
    const panel=button.closest(".panel"), files=panelFiles.get(panel)||[];
    if(!files.length || button.disabled) return;
    const withImages = panel.contains($("#dlImgs"));
    if(withImages && imgQueue.length && !imgData.length){
      const label=button.textContent;
      button.disabled=true; button.textContent="Fetching images…";
      try{ await fetchImages(); }
      finally{ button.disabled=false; button.textContent=label; }
    }
    // Read the files again: an option ticked while the photos were coming in has
    // run the export through the converter and replaced them.
    const entries=(panelFiles.get(panel)||files).map(f=>({name:f.name,bytes:xlsxOf(f)}));
    if(withImages)
      for(const d of imgData)
        for(const name of d.paths) entries.push({name:"Products Images/"+name,bytes:d.bytes});
    download(ZIP_NAMES[panel.dataset.convert]||"odoo-import.zip",
      makeZip(entries),ZIP_MIME);
  });
