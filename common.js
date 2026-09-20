// Shared by every tab: CSV reading, cell cleaning, ids, and report wording.

function parseRows(text){
  text = text.replace(/^\uFEFF/,"");
  const rows=[]; let row=[], field="", q=false;
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(q){
      if(c==='"'){ if(text[i+1]==='"'){field+='"';i++;} else q=false; }
      else field+=c;
    }else{
      if(c==='"') q=true;
      else if(c===","){ row.push(field); field=""; }
      else if(c==="\n"){ row.push(field); rows.push(row); row=[]; field=""; }
      else if(c==="\r"){ /* ignore */ }
      else field+=c;
    }
  }
  if(field.length||row.length){ row.push(field); rows.push(row); }
  return rows;
}

function parseCSV(text){                   // header-keyed objects, blank rows dropped
  const rows=parseRows(text);
  if(!rows.length) return [];
  const head=rows.shift().map(h=>h.trim());
  return rows.filter(r=>r.some(v=>v!=="")).map(r=>{
    const o={}; head.forEach((h,i)=>o[h]=(r[i]??"").trim()); return o;
  });
}

// Headers are matched on a normalized form: the labels vary by Shopify version
// and by locale.
const normHeader = h => String(h||"").toLowerCase().replace(/[^a-z0-9]/g,"");

// Shopify guards Customer ID and Phone against Excel with a leading apostrophe.
function clean(v){
  let t=String(v==null?"":v).trim();
  if(t.startsWith("'")) t=t.slice(1).trim();
  return t.replace(/\u00A0/g," ").replace(/[ \t]+/g," ").trim();
}

// One convention for every external id: <source>_<model>_<source_id>, as in
// shopify_partner_1045 or shopify_order_5821.
// Kept short because Odoo prints only the first 50 characters when an import
// fails to match an id. Keying on Shopify's own id makes a second import update
// the records instead of duplicating them.
const ID_SOURCE="shopify";
function slugify(text){
  return String(text).normalize("NFKD").replace(/[^\x00-\x7F]/g,"")
    .replace(/[^a-zA-Z0-9]+/g,"_").replace(/^_+|_+$/g,"").toLowerCase() || "unknown";
}

// Stable 32-bit fingerprint in base 36: seven characters at most, the same
// every run.
function digest(text){
  let h=0x811c9dc5;                                  // FNV-1a, 32 bits
  for(let i=0;i<text.length;i++){ h^=text.charCodeAt(i); h=Math.imul(h,0x01000193)>>>0; }
  return h.toString(36);
}

// A short Shopify id goes in verbatim, which keeps the id readable:
// shopify_partner_1045. A free-text key (a contact with no Customer ID, a
// category known only by its path) would spell out something nobody can read,
// so it is replaced by its digest: just as stable, seven characters.
const sourceId = key => {
  const s=slugify(key);
  return /^[a-z0-9][a-z0-9_]{0,15}$/.test(s) ? s : digest(String(key));
};
const externalId = (model,key) => ID_SOURCE+"_"+model+"_"+sourceId(key);

const EMAIL_RE=/^[^@\s,;]+@[^@\s,;]+\.[A-Za-z]{2,}$/;

const plural = (n,w) => n+" "+w+(n===1?"":"s");
// Names the first few offenders and counts the rest, so one bad export cannot
// bury the report.
const cap = (list,n,what) => list.slice(0,n).join("; ")+
  (list.length>n?"; … and "+(list.length-n)+" more "+what:"");

// What the Products and Customers tabs last produced, so the Inventory and
// Orders tabs can name the references their own export mentions but no file
// creates.
let knownSkus=null, knownPartners=null;
