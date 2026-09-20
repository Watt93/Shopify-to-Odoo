// Writers: uncompressed ZIP and minimal XLSX, no dependency.
// ---- Uncompressed ZIP ("stored" method), no dependency ----
const CRC_TABLE = (()=>{const t=new Uint32Array(256);
  for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xEDB88320^(c>>>1):c>>>1;t[n]=c>>>0;}
  return t;})();
function crc32(b){let c=0xFFFFFFFF;for(let i=0;i<b.length;i++)c=CRC_TABLE[(c^b[i])&0xFF]^(c>>>8);
  return (c^0xFFFFFFFF)>>>0;}

// A zip record: a fixed-size little-endian header, then the entry name. Fields
// left out stay zero, which is what the format wants for what we do not use
// (flags, compression, comments, disk numbers).
function zipRecord(size, fields, name){
  const buf=new Uint8Array(size+name.length), v=new DataView(buf.buffer);
  for(const [at,width,val] of fields)
    width===2 ? v.setUint16(at,val,true) : v.setUint32(at,val,true);
  buf.set(name,size);
  return buf;
}

function makeZip(entries){          // entries: [{name, text}|{name, bytes}]
  const enc=new TextEncoder(), NONE=new Uint8Array(0), local=[], central=[];
  const d=new Date(),
        time=((d.getHours()<<11)|(d.getMinutes()<<5)|(d.getSeconds()>>1))&0xFFFF,
        date=(((d.getFullYear()-1980)<<9)|((d.getMonth()+1)<<5)|d.getDate())&0xFFFF;
  let offset=0;

  for(const e of entries){
    const name=enc.encode(e.name), body=e.bytes||enc.encode(e.text),
          crc=crc32(body), n=body.length;
    const head=zipRecord(30,[[0,4,0x04034b50],[4,2,20],[10,2,time],[12,2,date],
      [14,4,crc],[18,4,n],[22,4,n],[26,2,name.length]],name);
    central.push(zipRecord(46,[[0,4,0x02014b50],[4,2,20],[6,2,20],[12,2,time],[14,2,date],
      [16,4,crc],[20,4,n],[24,4,n],[28,2,name.length],[42,4,offset]],name));
    local.push(head,body);
    offset+=head.length+n;
  }

  const cdSize=central.reduce((a,b)=>a+b.length,0);
  const all=[...local,...central,zipRecord(22,[[0,4,0x06054b50],
    [8,2,entries.length],[10,2,entries.length],[12,4,cdSize],[16,4,offset]],NONE)];

  const out=new Uint8Array(all.reduce((a,b)=>a+b.length,0));
  let o=0; for(const p of all){ out.set(p,o); o+=p.length; }
  return out;
}

// ---- Minimal XLSX writer, no dependency, on top of makeZip ----
// Odoo's official import template is an .xlsx: no quote escaping, no commas to
// protect, no spreadsheet app reinterpreting the contents.
const XML='<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const NS="http://schemas.openxmlformats.org/";
const relsXml = (...rels) => XML+'<Relationships xmlns="'+NS+'package/2006/relationships">'+
  rels.map(([id,type,target])=>'<Relationship Id="'+id+'" Type="'+NS+type+
    '" Target="'+target+'"/>').join("")+'</Relationships>';

function xmlEsc(s){
  return String(s==null?"":s)
    .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;")
    // control characters are forbidden in XML 1.0
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g,"");
}
function colName(n){                       // 1 -> A, 27 -> AA
  let s=""; while(n>0){ const m=(n-1)%26; s=String.fromCharCode(65+m)+s; n=(n-m-1)/26; }
  return s;
}
function sheetXml(cols, rows){
  const line=(cells,r)=>'<row r="'+r+'">'+cells.map((v,i)=>
    '<c r="'+colName(i+1)+r+'" t="inlineStr"><is><t xml:space="preserve">'+xmlEsc(v)+'</t></is></c>'
  ).join("")+"</row>";
  return XML+'<worksheet xmlns="'+NS+'spreadsheetml/2006/main"><sheetData>'+
    [line(cols,1),...rows.map((row,i)=>line(cols.map(c=>row[c]),i+2))].join("")+
    '</sheetData></worksheet>';
}
function makeXlsx(cols, rows, sheetName){
  const ct=(part,type)=>'<Override PartName="'+part+'" ContentType="application/vnd.'+
    'openxmlformats-officedocument.spreadsheetml.'+type+'+xml"/>';
  return makeZip([
    {name:"[Content_Types].xml", text:XML+'<Types xmlns="'+NS+'package/2006/content-types">'+
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'+
      '<Default Extension="xml" ContentType="application/xml"/>'+
      ct("/xl/workbook.xml","sheet.main")+ct("/xl/worksheets/sheet1.xml","worksheet")+'</Types>'},
    {name:"_rels/.rels",
      text:relsXml(["rId1","officeDocument/2006/relationships/officeDocument","xl/workbook.xml"])},
    {name:"xl/workbook.xml", text:XML+'<workbook xmlns="'+NS+'spreadsheetml/2006/main" xmlns:r="'+
      NS+'officeDocument/2006/relationships"><sheets><sheet name="'+xmlEsc(sheetName||"Sheet1")+
      '" sheetId="1" r:id="rId1"/></sheets></workbook>'},
    {name:"xl/_rels/workbook.xml.rels",
      text:relsXml(["rId1","officeDocument/2006/relationships/worksheet","worksheets/sheet1.xml"])},
    {name:"xl/worksheets/sheet1.xml", text:sheetXml(cols,rows)},
  ]);
}

