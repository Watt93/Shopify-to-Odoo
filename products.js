// Products tab: reads Shopify's products export, writes the Odoo import files.
// ===== CORE START =====
// No settings; the choices below are fixed and documented in the README.
//  - no uom_id column: Odoo applies its default unit, which avoids failing on
//    non-English databases where the unit is named "Unité(s)" or similar.
//  - categ_id follows Shopify's "Product Category", falling back to "Type".
//    File 1 creates the categories, the products file points at them by id.
//  - attribute names are taken from the export verbatim, nothing renamed and
//    nothing split, so the same code fits any kind of store.

// Odoo imports a file in batches and groups a product's variants by name inside
// one batch, so a product whose rows straddle a boundary is created twice. The
// user can raise this default on the import screen.
const IMPORT_BATCH = 2000;

// Values are ordered by themselves, never by their attribute name. SCALE covers
// the letter sizes, which no sort can recover from the text. Everything else
// goes by its number, or keeps the order of the export.
const SCALE = new Map();
[["XXXS"],["XXS"],["XS","EXTRA SMALL"],["S","SMALL"],["M","MEDIUM"],["L","LARGE"],
 ["XL","EXTRA LARGE"],["XXL","2XL"],["XXXL","3XL"],["XXXXL","4XL"],["5XL"]]
  .forEach((names,rank)=>names.forEach(n=>SCALE.set(n,rank)));

// Colour names worth a swatch. An unknown name simply gets none.
const COLOR_HEX = {
  "black":"#000000","white":"#FFFFFF","grey":"#8A8D8A","gray":"#8A8D8A",
  "silver":"#C0C0C0","beige":"#D8C8AE","cream":"#F2E8D5","brown":"#6B4F3A",
  "red":"#B3323C","orange":"#D97A2B","yellow":"#D9B62B","green":"#4C6138",
  "blue":"#2E5C8A","navy":"#1F2A44","purple":"#6B4C8C","pink":"#D9A2AC"
};

// Shopify writes this export under two sets of headers: the old one ("Handle",
// "Variant SKU", "Option1 Name") and the current one ("URL handle", "SKU",
// "Option1 name"). Only the wording differs, so the newer spelling is folded
// onto the older one here and the rest of this file sees only one of them.
// Only the columns read below are listed; any other header is left as it is.
const COLUMNS=["Handle","Title","Body (HTML)","Product Category","Type","Product Type",
  "Cost per item","Image Src","Variant Image","Variant SKU","Variant Price","Variant Barcode",
  "Variant Inventory Qty","Option1 Name","Option1 Value","Option2 Name","Option2 Value",
  "Option3 Name","Option3 Value"];
const HEADER_MAP=new Map(COLUMNS.map(c=>[c.toLowerCase(),c]));   // case alone never matters
[["url handle","Handle"],["description","Body (HTML)"],["sku","Variant SKU"],
 ["price","Variant Price"],["barcode","Variant Barcode"],
 ["inventory quantity","Variant Inventory Qty"],["product image url","Image Src"],
 ["variant image url","Variant Image"]].forEach(([from,to])=>HEADER_MAP.set(from,to));

// Header-keyed objects, blank rows dropped, both header sets reading the same.
// A rename only applies when the canonical column is absent, so a file holding
// both "SKU" and "Variant SKU" keeps the two apart.
function parseProductCSV(text){
  const rows=parseRows(text);
  if(!rows.length) return [];
  const raw=rows.shift().map(h=>h.trim()), present=new Set(raw);
  const head=raw.map(h=>{
    const canon=HEADER_MAP.get(h.toLowerCase().replace(/\s+/g," "));
    return canon && !present.has(canon) ? canon : h;
  });
  return rows.filter(r=>r.some(v=>v!=="")).map(r=>{
    const o={}; head.forEach((h,i)=>o[h]=(r[i]??"").trim()); return o;
  });
}

function stripHTML(s){
  return (s||"").replace(/<\/li>/gi," ; ").replace(/<[^>]+>/g," ")
    .replace(/&nbsp;/gi," ").replace(/&amp;/gi,"&").replace(/&lt;/gi,"<").replace(/&gt;/gi,">")
    .replace(/&#39;|&apos;/gi,"'").replace(/&quot;/gi,'"')
    .replace(/\s+/g," ").replace(/^[\s;]+|[\s;]+$/g,"");
}
// "Light  Blue", "light-blue" and "LIGHT BLUE" are one colour. A hex value is
// its own swatch: some stores fill the option that way.
const norm = v => String(v).replace(/[\s._\-]+/g," ").trim();
const HEX6 = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i;
function hexOf(v){
  const s=norm(v);
  if(HEX6.test(s)) return s[0]==="#" ? s.toUpperCase() : "#"+s.toUpperCase();
  return COLOR_HEX[s.toLowerCase()] || "";
}

// Odoo recognises an image by its extension, so a URL ending in
// ".png?v=1787153525" is silently rejected. The query string is stripped only
// when the remaining path is an image, so signed URLs stay intact.
const IMG_EXT=/\.(jpe?g|png|gif|webp|avif|bmp|tiff?)$/i;
function imageFileName(u){
  const n=decodeURIComponent(String(u||"").split("/").pop()||"")
    .replace(/[^A-Za-z0-9._-]+/g,"_").replace(/^_+|_+$/g,"");
  return n||"image.png";
}
function cleanImageUrl(u){
  const cut=String(u||"").trim().split("#")[0], q=cut.indexOf("?");
  if(q<0) return cut;
  return IMG_EXT.test(cut.slice(0,q)) ? cut.slice(0,q) : cut;
}

// The number in a value and the text around it: "250 ml" is 250 in "ml".
// Values compare as numbers only when that text is the same throughout, so
// "500 g" never sorts against "1 kg".
const NUMBER = /[-+]?\d+(?:[.,]\d+)?/;
const numOf  = v => { const m=String(v).match(NUMBER);
                      return m ? parseFloat(m[0].replace(",",".")) : NaN; };
const unitOf = v => norm(String(v).replace(NUMBER,"")).toLowerCase();

// Three kinds of value, in this order: letter sizes, numbers, then whatever
// cannot be ranked, which keeps the order of the export. An attribute mixing
// them, such as a "Size" spanning a garment and a bottle, comes out grouped
// instead of shuffled.
function sortValues(vals){
  const key=x=>norm(x).toUpperCase(), scale=x=>SCALE.has(key(x));
  const nums=vals.filter(x=>!scale(x) && !isNaN(numOf(x)));
  const ranked=nums.length>1 && new Set(nums.map(unitOf)).size===1;
  const seen=new Map(vals.map((x,i)=>[x,i]));
  const rank=x=>scale(x) ? 0 : (ranked && nums.includes(x) ? 1 : 2);
  return vals.slice().sort((a,b)=>
    rank(a)-rank(b) ||
    (rank(a)===0 ? SCALE.get(key(a))-SCALE.get(key(b))
   : rank(a)===1 ? numOf(a)-numOf(b)
   : seen.get(a)-seen.get(b)));
}

// Odoo's Color display type draws the swatch from value_ids/html_color. Asked
// for when the attribute is named after colour in one of the usual languages,
// or when every one of its values is a colour we recognise.
const COLOR_NAME = /^(colou?rs?|couleurs?|farben?|kleur(en)?|colori?|colores?|cor(es)?)$/i;
const isColorAttr = (attr,vals) =>
  COLOR_NAME.test(norm(attr)) || vals.every(x=>hexOf(x));

function convertProducts(text,opts){
  // Whether the products file carries its photos. Odoo fetches every URL in the
  // Image column while importing, which is the slowest part of the import;
  // without the column the same file goes in on text alone.
  const withImages = !opts || opts.images!==false;
  const rows = parseProductCSV(text);
  const warnings=[];
  if(!rows.length) return {errors:["The file is empty or unreadable."]};

  // Handle and title identify a product; every other column is optional. A store
  // selling one-off items often has neither options nor references, and such an
  // export still has to go through.
  const need=["Handle","Title"];
  const missing=need.filter(c=>!(c in rows[0]));
  if(missing.length) return {errors:[
    "This file does not look like a Shopify product export. Missing columns: "+missing.join(", ")+"."]};
  if(!("Variant Price" in rows[0]))
    warnings.push("This export carries no price column; every product comes out without a sales price.");

  // --- group by handle ---
  const products=new Map();
  for(const r of rows){
    const h=(r.Handle||"").trim(); if(!h) continue;
    if(!products.has(h)) products.set(h,{handle:h,head:null,variants:[],gallery:[]});
    const p=products.get(h);
    if(r.Title) p.head=r;
    // A row is a variant as soon as it carries any variant data. Relying on
    // Variant SKU alone dropped products that have no internal reference.
    const isVariant = ["Variant SKU","Variant Price","Option1 Value",
      "Variant Inventory Qty","Variant Barcode","Cost per item"]
      .some(k=>(r[k]||"").trim()!=="");
    if(isVariant) p.variants.push(r);
    else if((r["Image Src"]||"").trim()) p.gallery.push(r);
  }
  for(const [h,p] of products){
    // A row with no variant data at all, nothing but a title, is still a product:
    // a store selling one-off pieces is made of nothing else. Its own row becomes
    // its single variant instead of the product being dropped.
    if(!p.variants.length && p.head){
      p.variants.push(p.head);
      p.gallery=p.gallery.filter(r=>r!==p.head);
    }
    if(!p.variants.length){ products.delete(h);
      warnings.push("“"+h+"” has neither a title nor any variant data, and was skipped.");
      continue; }
    if(!p.head){ p.head=p.variants[0];
      warnings.push("“"+h+"” has no title row; the first variant was used as reference."); }
  }
  if(!products.size) return {errors:["No product found in this file."]};

  // Shopify writes the option names on the product's first row only, so they are
  // carried across every row of the same handle; without that, later variants
  // come out with no attribute value.
  const KEYS=[["Option1 Name","Option1 Value"],["Option2 Name","Option2 Value"],
              ["Option3 Name","Option3 Value"]];
  for(const p of products.values()){
    const names=["","",""];
    for(const v of p.variants)
      KEYS.forEach(([nk],i)=>{ if(!names[i] && (v[nk]||"").trim()) names[i]=v[nk].trim(); });
    // "Image Src" only appears on the product's first rows, so it is carried
    // forward: an empty cell would erase the image written by the previous row.
    p.imageUrl="";
    for(const v of p.variants.concat(p.gallery)){
      const u=cleanImageUrl(v["Image Src"]||v["Variant Image"]);
      if(u){ p.imageUrl=u; break; }
    }
    for(const v of p.variants){
      v.pairs=[];
      let seen=0;
      KEYS.forEach(([nk,vk],i)=>{
        const val=(v[vk]||"").trim();
        const name=(v[nk]||"").trim()||names[i];
        if(!val) return;
        // Shopify writes "Title / Default Title" on products with no options.
        // That is not an attribute: the product must stay variant-free.
        if(/^default title$/i.test(val) || /^title$/i.test(name)) return;
        seen++;
        if(name) v.pairs.push([norm(name),val]);
      });
      if(seen && !v.pairs.length)
        warnings.push("Variant “"+(v["Variant SKU"]||v[KEYS[0][1]]||"?")+
          "” has option values but no usable attribute name.");
    }
  }

  // One product writes "Color / Navy", the next "color / navy", and Odoo would
  // create two attributes out of that. Each name and value is folded into the
  // first spelling the file uses.
  const attrName=new Map(), valueName=new Map();
  const fold=(seen,key,text)=>{ if(!seen.has(key)) seen.set(key,text); return seen.get(key); };
  for(const p of products.values())
    for(const v of p.variants)
      v.pairs=v.pairs.map(([a,x])=>{
        const attr=fold(attrName,a.toLowerCase(),a);
        return [attr,fold(valueName,attr.toLowerCase()+"\u0000"+x.toLowerCase(),x)];
      });

  // Every distinct image URL the export carries, fetched by the browser and
  // delivered as a .zip. The products file imports the main photo and the
  // variant photos by URL; the .zip is what covers the gallery, which no column
  // of that file can reach.
  //
  // Shopify spreads a product's photos over two columns:
  //  - Image Src is the gallery, written on the product's first rows and on
  //    extra image-only rows past them. Becomes Odoo's "Extra Media"
  //    (product.image).
  //  - Variant Image is the photo bound to one variant, Odoo's
  //    image_variant_1920 on product.product.
  //
  // The .zip mirrors that shape:
  //   <product>/<main photo>
  //   <product>/Extra Media/<gallery>
  //   <product>/<variant>/<variant photo>
  const images=[], byUrl=new Map(), usedNames=new Map();   // folder -> names taken

  // A zip entry name becomes a real path on extraction: "/" separates folders,
  // the rest are illegal on Windows, and Explorer drops a trailing dot or space.
  // Truncated too, so a long product title cannot blow the path limit.
  const safeName = s => String(s||"").replace(/[\/\\:*?"<>|\x00-\x1F]+/g," ")
    .replace(/\s+/g," ")
    .slice(0,80)                              // cut BEFORE trimming: the cut
    .replace(/^[.\s]+|[.\s]+$/g,"")           // can leave a trailing space
    || "untitled";

  // One record per distinct URL, so a photo shared by four sizes is downloaded
  // once, but it can land at several paths since each product.product needs its
  // own copy. Names are deduped per folder, not globally: two products can both
  // own an "image.jpg" now that folders keep them apart.
  function registerImage(u,dir){
    if(!u) return;
    let rec=byUrl.get(u);
    if(!rec){ rec={url:u,dirs:new Set(),paths:[]}; byUrl.set(u,rec); images.push(rec); }
    if(rec.dirs.has(dir)) return;               // already placed in this folder
    rec.dirs.add(dir);
    if(!usedNames.has(dir)) usedNames.set(dir,new Set());
    const used=usedNames.get(dir), base=imageFileName(u), dot=base.lastIndexOf(".");
    let name=base;
    for(let i=2; used.has(name.toLowerCase()); i++)   // two different URLs, same basename
      name = dot>0 ? base.slice(0,dot)+"_"+i+base.slice(dot) : base+"_"+i;
    used.add(name.toLowerCase());
    rec.paths.push(dir?dir+"/"+name:name);
  }

  for(const p of products.values()){
    const dir=safeName(p.head.Title||p.handle);

    // Main photo at the root of the product folder: the one the products file
    // points to, and the one Odoo writes to image_1920.
    registerImage(p.imageUrl,dir);

    // Rest of the gallery. The main photo is already placed, so skip it here
    // rather than repeat it inside Extra Media.
    for(const r of p.variants.concat(p.gallery)){
      const u=cleanImageUrl(r["Image Src"]);
      if(u && u!==p.imageUrl) registerImage(u,dir+"/Extra Media");
    }

    // One folder per variant, named after its option values, as Odoo names it.
    // With no options the variant is the template, so its photo stays at the root
    // instead of sitting in a pointless subfolder.
    for(const v of p.variants){
      const u=cleanImageUrl(v["Variant Image"]);
      if(!u) continue;
      const vals=v.pairs.map(([,x])=>x);
      registerImage(u, vals.length ? dir+"/"+safeName(vals.join(" - ")) : dir);
    }
  }

  // --- commas are forbidden (they separate the pairs) ---
  const bad=new Set();
  for(const p of products.values())
    for(const v of p.variants)
      for(const [a,x] of v.pairs){ if(a.includes(","))bad.add(a); if(x.includes(","))bad.add(x); }
  if(bad.size) return {errors:[
    "Odoo separates attribute values with commas, so a value cannot contain one. "+
    "Rename these values in Shopify, for example “Navy blue” or “Navy - blue”, "+
    "then export again:"], badValues:[...bad]};

  // --- attribute reference data ---
  const attrVals=new Map();
  for(const p of products.values())
    for(const v of p.variants)
      for(const [a,x] of v.pairs){
        if(!attrVals.has(a)) attrVals.set(a,[]);
        if(!attrVals.get(a).includes(x)) attrVals.get(a).push(x);
      }

  // --- external ids ---
  // The key is slugified whole: a handle and a category path are each unique
  // within the export, so nothing needs appending to keep two ids apart. A deep
  // path makes a long id, which is fine since an id is read, not typed.
  const readableId=(model,key)=>ID_SOURCE+"_"+model+"_"+slugify(key);

  // --- product categories ---
  // Neither category column is repeated on the variant rows, so the whole handle
  // is scanned for the first one filled:
  //  - "Product Category" is Shopify's standard taxonomy, written as a path
  //    ("Apparel & Accessories > Clothing > Shirts & Tops"). Preferred, as it is
  //    the only one carrying a hierarchy.
  //  - "Type" is the merchant's own wording, usually a single word.
  const CAT_COLS=["Product Category","Type","Product Type"];
  const catPath = p => {
    for(const r of [p.head,...p.variants,...p.gallery])
      for(const c of CAT_COLS){
        const v=(r[c]||"").trim();
        if(v) return v.split(">").map(x=>norm(x)).filter(Boolean);
      }
    return [];
  };

  // One record per level of the path, ancestors before their children: the Map
  // keeps that order, and the file needs it since a row points at its parent by
  // external id and load() walks the rows from the top.
  // The id is keyed on the full path, so re-importing updates the tree instead
  // of creating a second one, and "Clothing" under two parents stays two
  // categories.
  const catNodes=new Map();        // full path -> {name,parent,id}
  const usedCatIds=new Set();
  const categories=new Map();      // full path -> product count, for the summary
  for(const p of products.values()){
    const path=catPath(p);
    p.catId="";
    if(!path.length) continue;
    let parent="";
    for(let i=0;i<path.length;i++){
      const key=path.slice(0,i+1).join(" / ");
      if(!catNodes.has(key)){
        // A category has no Shopify id, so the key is its full path and the id
        // reads as that path: shopify_categ_apparel_clothing_shirts. Two
        // spellings can still land on the same slug ("Men & Women" and "Men
        // Women"), so a suffix keeps them apart.
        const base=readableId("categ",key);
        let xmlid=base;
        for(let n=2; usedCatIds.has(xmlid); n++) xmlid=base+"_"+n;
        usedCatIds.add(xmlid);
        catNodes.set(key,{name:path[i],parent,id:xmlid});
      }
      parent=key;
    }
    p.catId=catNodes.get(parent).id;
    categories.set(parent,(categories.get(parent)||0)+1);
  }

  // --- product ids ---
  // Keyed on the Shopify handle: a title is rewritten and a price changes, the
  // handle stays for the life of the store. A second import then updates the
  // products instead of laying down a second catalogue.
  // The id carries that handle (shopify_product_cotton_polo), so it reads as the
  // product itself, which matters when an import fails to match one: the id is
  // all Odoo then shows of the record it was looking for.
  // Two handles can still slugify to the same id, and a duplicate id is the one
  // thing an import refuses, so each is checked against those already given.
  const usedProductIds=new Set();
  for(const p of products.values()){
    const base=readableId("product",p.handle);
    let xmlid=base;
    for(let n=2; usedProductIds.has(xmlid); n++) xmlid=base+"_"+n;
    usedProductIds.add(xmlid);
    p.xmlid=xmlid;
  }

  const files=[];
  let fileNo=0;

  // 1. eCommerce categories: the tree the shop is browsed by, not the internal
  // Product Category behind the accounting and stock rules, which Shopify says
  // nothing about and which stays at Odoo's default. Nothing else can rebuild
  // the tree, and the products file names its category by external id, so this
  // file goes in first.
  const C0=["id","Name","parent_id/id"];
  const R0=[...catNodes.values()].map(c=>({
    id:c.id, Name:c.name,
    "parent_id/id": c.parent ? catNodes.get(c.parent).id : "",
  }));
  if(R0.length) files.push({name:(++fileNo)+"_categories.xlsx",model:"product.public.category",
    note:"eCommerce → Products → eCommerce Categories. Creates the categories Shopify wrote on the "+
      "products, parents before their children. The id column makes a second import update them "+
      "rather than duplicate them.",
    cols:C0,rows:R0});

  // 2. attributes. Optional (Odoo creates missing ones) but it sets the order of
  // the values and the colour swatches, which auto-creation ignores. Only the
  // first row of a block names the attribute; the rest add its values.
  // The value column is headed "Values / Value", the wording Odoo's own
  // documentation gives this file, so the import screen maps it on its own.
  const C1=["Attribute","Display Type","Variant Creation Mode","Values / Value",
    "value_ids/html_color"];
  const R1=[];
  for(const [a,vals] of attrVals)
    sortValues(vals).forEach((x,i)=>R1.push({
      Attribute: i?"":a,
      "Display Type": i?"":(isColorAttr(a,vals)?"Color":"Radio"),
      "Variant Creation Mode": i?"":"Instantly",
      "Values / Value":x,
      "value_ids/html_color":hexOf(x),
    }));
  if(R1.length) files.push({name:(++fileNo)+"_attributes.xlsx",model:"product.attribute",
    note:"Sales → Configuration → Attributes. Sets the order of the values and the colour swatches.",
    cols:C1,rows:R1});

  // 3. products and variants. Headers and vocabulary copied from Odoo's official
  // import template: human labels, "Goods" not "consu", Track Inventory as 1/0
  // not TRUE/FALSE. Technical names prevented the grouping. Barcode is the only
  // addition.
  const C2=["id","Name*","Product Type*","Track Inventory","Product Values",
    "Quantity on Hand","Sales Price","Cost","Internal Reference","Barcode",
    "Description"];
  // No category column in the export, none here: it would be empty on every row.
  if(catNodes.size) C2.splice(3,0,"public_categ_ids/id");
  // The column is dropped, not blanked: an empty Image cell is a value Odoo
  // still reads, and the sheet is written from this list of columns alone.
  if(withImages) C2.push("Image");
  const R2=[];
  for(const p of products.values()){
    const h=p.head;
    const firstRow=R2.length;        // where this product's rows start
    // Template fields repeated on every row: an empty cell would erase the value
    // written by the previous row. public_categ_ids/id is the Website Product
    // Category and points at the external id from file 1, not at the name: a
    // name is matched against the whole tree, and a wording such as "Bags /
    // Totes" would be read as a path Odoo does not have.
    const template=()=>({"Name*":h.Title,"Product Type*":"Goods",
      "public_categ_ids/id":p.catId,"Track Inventory":"1"});

    // Odoo groups the variants sharing a Name* under one template, which is why
    // the template columns are repeated rather than left blank. A row with no
    // "Product Values" is the template itself, so the template photo has to
    // arrive on such a row. It is also what makes the variant photos work:
    // product.product's image setter only redirects to image_variant_1920 once
    // the template already holds an image.
    if(withImages && p.imageUrl && p.variants.some(v=>v.pairs.length))
      R2.push({...template(), Image:p.imageUrl});

    // Descending price: the cheapest variant goes last, and since every row
    // rewrites the template price, the template inherits the entry price.
    // Stable sort, so variants at the same price keep their Shopify order.
    const vars=p.variants.slice().sort((a,b)=>
      (parseFloat(b["Variant Price"])||0)-(parseFloat(a["Variant Price"])||0));
    for(const v of vars){
      const values=v.pairs.map(([a,x])=>a+": "+x).join(", ");
      const row={...template(),
        Description:stripHTML(h["Body (HTML)"]),
        "Product Values":values,
        "Quantity on Hand":(v["Variant Inventory Qty"]||"").trim(),
        "Sales Price":v["Variant Price"],
        Cost:v["Cost per item"],
        "Internal Reference":v["Variant SKU"],
        Barcode:v["Variant Barcode"],
      };
      // The variant's own photo, Odoo's image_variant_1920. It reaches
      // product.product.image_1920, whose setter redirects it once the template
      // carries an image (guaranteed by the row above) and the product has
      // several variants. The fallback to the product photo is not a courtesy:
      // an empty cell is replaced by the template's image anyway, deeper in
      // _load_records_create, so better the right URL.
      if(withImages) row.Image = cleanImageUrl(v["Variant Image"]) || p.imageUrl;
      R2.push(row);
    }
    // The external id goes on the product's first row only: the image row when
    // there is one, the dearest variant otherwise. The rows below are its other
    // variants, which Odoo gathers into the same template through the repeated
    // Name. Repeating the id would hand one external id to several rows, which
    // an import refuses.
    R2[firstRow].id=p.xmlid;
  }

  files.push({name:(++fileNo)+"_products.xlsx",model:"product.template",imageOpt:true,
    note:"Sales → Products. Creates the templates, variants, categories, prices, costs, references and stock in a single pass"+
      (withImages?", and downloads the photos from Shopify as it goes":", without the photos: no Image column, so nothing is downloaded")+
      ". Each product carries an id built from its Shopify handle, so importing this file again "+
      "updates the same products instead of duplicating them"+
      ". Do not tick “update”."+
      (R2.length>IMPORT_BATCH ? " This file is "+R2.length+" rows: set the import batch size "+
        "above that number first, or Odoo cuts it into batches of "+IMPORT_BATCH+
        " and the variants of a product split across the cut import as two products." : ""),
    cols:C2,rows:R2});

  // Odoo splits a large import into batches, and the variants of one product are
  // grouped by name inside a batch: a product straddling the cut comes out twice.
  if(R2.length>IMPORT_BATCH) warnings.push(
    "The products file is "+R2.length+" rows, more than the "+IMPORT_BATCH+" Odoo imports in "+
    "one batch. Before importing, set the batch size above "+R2.length+", otherwise a product "+
    "whose variants fall on either side of the cut is created twice.");

  // on-screen summary: the totals only, not the per-product breakdown
  const variants=[...products.values()].reduce((n,p)=>n+p.variants.length,0);

  // Each count opens the list behind it, so the totals can be checked against
  // the file instead of being taken on trust.
  const variantList=[];
  for(const p of products.values()){
    const title=p.head.Title||p.handle;
    for(const v of p.variants){
      const vals=v.pairs.map(([a,x])=>a+": "+x).join(", ");
      const sku=(v["Variant SKU"]||"").trim();
      variantList.push(title+(vals?" — "+vals:"")+(sku?"  ["+sku+"]":""));
    }
  }
  const detail=[
    {label:plural(products.size,"product"),
     items:[...products.values()].map(p=>
       (p.head.Title||p.handle)+"  ("+plural(p.variants.length,"variant")+")")},
    {label:plural(variants,"variant"), items:variantList},
    // The tree as file 1 writes it, ancestors included, so the count matches that
    // file's rows rather than only the categories the products sit in.
    {label:catNodes.size+" categor"+(catNodes.size===1?"y":"ies"),
     items:[...catNodes.keys()].map(k=>
       k+(categories.has(k)?"  ("+plural(categories.get(k),"product")+")":"")),
     empty:"No \u201cProduct Category\u201d or \u201cType\u201d column is filled in this export."},
  ];

  // Handed to the Inventory tab, which matches its quantities on these
  // references and can then name the SKUs this export never mentioned.
  const skus=new Set();
  for(const p of products.values())
    for(const v of p.variants){ const s=(v["Variant SKU"]||"").trim(); if(s) skus.add(s); }

  return {files,warnings,images,skus,detail,withImages,
    summary:detail.map(d=>d.label).join(" · ")};
}
