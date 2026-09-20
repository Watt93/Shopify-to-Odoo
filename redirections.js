// Redirections tab: the old Shopify addresses, turned into Odoo redirect rules.
//
// A migrated store keeps its domain but changes every address behind it:
// /products/<handle> becomes /shop/<product>, /collections/<handle> becomes
// /shop/category/<category>. Every link a search engine, a newsletter or a
// bookmark still holds points at a page Odoo answers 404 on. A website.rewrite
// record turns that 404 into a 301, which also hands the old page's ranking
// over to the new one.
//
// Only one half of each rule can be written here. The left-hand side is the
// Shopify address, taken from the sitemap. The right-hand side is the Odoo
// address, which does not exist yet: Odoo appends the record's own id to the
// slug (/shop/classic-cotton-crew-tee-42), so the URL is only knowable once the
// products are imported. The url_to column is left empty, to be filled in from
// the Odoo shop before the file is imported.

// Addresses with no counterpart in Odoo: the cart, the customer account, the
// checkout, and what the theme or an app serves rather than the shop.
const REDIR_SKIP=[
  /^\/cart(\/|$)/i, /^\/account(s)?(\/|$)/i, /^\/checkout(s)?(\/|$)/i,
  /^\/orders(\/|$)/i, /^\/search(\/|$)/i, /^\/password(\/|$)/i,
  /^\/apps(\/|$)/i, /^\/tools(\/|$)/i, /^\/services(\/|$)/i,
  /^\/cdn(\/|$)/i, /^\/wpm(@|\/|$)/i, /^\/\.well-known(\/|$)/i,
];
// A sitemap also lists the files beside the pages: agents.md, sitemap.xml, a
// collection's .atom feed. Redirecting those leads nowhere.
const REDIR_FILE=/\.(md|txt|xml|json|atom|rss|js|css|ico)$/i;

// What Shopify's address shapes become in Odoo. The hint is shown on screen but
// never written into the file, since the slug Odoo gives a record is only
// settled once that record exists.
const REDIR_KINDS=[
  {key:"product",    one:"product",    many:"products",
   test:p=>/^\/products\/[^/]+$/i.test(p)||/^\/collections\/[^/]+\/products\/[^/]+$/i.test(p),
   hint:"/shop/<product>-<id>"},
  {key:"collection", one:"collection", many:"collections",
   test:p=>/^\/collections\/[^/]+$/i.test(p),
   hint:"/shop/category/<category>-<id>"},
  {key:"page",       one:"page",       many:"pages",
   test:p=>/^\/pages\/[^/]+$/i.test(p),
   hint:"/<page>"},
  {key:"article",    one:"blog post",  many:"blog posts",
   test:p=>/^\/blogs\/[^/]+\/[^/]+$/i.test(p),
   hint:"/blog/<blog>-<id>/<post>-<id>"},
  {key:"blog",       one:"blog",       many:"blogs",
   test:p=>/^\/blogs\/[^/]+$/i.test(p),
   hint:"/blog/<blog>-<id>"},
  {key:"policy",     one:"policy page",many:"policy pages",
   test:p=>/^\/policies\/[^/]+$/i.test(p),
   hint:"/<page>"},
  {key:"other",      one:"other page", many:"other pages",
   test:()=>true,
   hint:"the matching page in Odoo"},
];
const redirKind = p => REDIR_KINDS.find(k=>k.test(p));
// plural() adds an s, and "address" needs two.
const addresses = n => n+" address"+(n===1?"":"es");

const REDIR_ENTITIES={amp:"&",lt:"<",gt:">",quot:'"',apos:"'","#39":"'"};
const unentity = s => String(s).replace(/&(amp|lt|gt|quot|apos|#39);/g,(_,e)=>REDIR_ENTITIES[e]);

// Three shapes reach this tab: an XML sitemap, a sitemap index, and the plain
// list of addresses a crawler or a spreadsheet produces. The XML ones are told
// apart by their <loc> tags; anything else is read line by line, and a line
// with several columns gives up its first address. The rest of the row is the
// crawler's own (status, depth, title).
function redirUrls(text){
  const out=[];
  const loc=/<loc>([\s\S]*?)<\/loc>/gi;
  let m;
  while((m=loc.exec(text))) out.push(unentity(m[1]).trim());
  if(out.length) return out;
  for(const line of String(text).split(/\r?\n/)){
    const cells = line.includes('"') ? (parseRows(line)[0]||[line]) : line.split(/[,;\t]/);
    for(const c of cells){
      const t=clean(c);
      if(/^https?:\/\//i.test(t)||/^\//.test(t)){ out.push(t); break; }
    }
  }
  return out;
}

// The address as Odoo stores it: a path, no host, no query, no trailing slash.
// A query string is dropped: ?variant=123 and ?ref=newsletter are the same
// page, and Odoo matches url_from on the path alone.
function redirPath(url){
  let t=String(url).trim().replace(/^https?:\/\/[^/?#]*/i,"");
  t=t.split("#")[0].split("?")[0];
  if(!t.startsWith("/")) t="/"+t;
  t=t.replace(/\/{2,}/g,"/");
  if(t.length>1) t=t.replace(/\/+$/,"");
  return t;
}
const redirHost = url => { const m=/^https?:\/\/([^/?#]+)/i.exec(String(url).trim());
  return m?m[1].toLowerCase():""; };

function convertRedirections(text){
  const urls=redirUrls(text);
  if(!urls.length) return {errors:[
    "No address could be read from this file. It should be a sitemap: the "+
    "sitemap.xml of the Shopify store, or a plain list with one address per line."]};

  const hosts=new Map(), rows=new Map(), skipped=[];
  let root=0, dupes=0;

  for(const url of urls){
    const host=redirHost(url);
    if(host) hosts.set(host,(hosts.get(host)||0)+1);
    const path=redirPath(url);
    if(path==="/"){ root++; continue; }
    if(REDIR_FILE.test(path) || REDIR_SKIP.some(re=>re.test(path))){ skipped.push(path); continue; }
    if(rows.has(path)){ dupes++; continue; }
    rows.set(path,{path,kind:redirKind(path)});
  }

  // A Shopify sitemap.xml is often only an index: it lists the sitemaps of the
  // products, the collections and the pages, and not a single page of its own.
  if(!rows.size && skipped.length && skipped.every(p=>/\.xml$/i.test(p))) return {errors:[
    "This file is a sitemap index: it lists "+plural(skipped.length,"other sitemap")+
    " and no page of its own. Open each of them ("+cap(skipped,4,"sitemaps")+
    ") and drop them here one by one, or paste all their addresses into a single file."]};
  if(!rows.size) return {errors:[
    "Every address in this file was left out: only the home page, the cart, the "+
    "customer account and files such as sitemap.xml were found. Export the store's "+
    "full sitemap.xml, which lists the products, collections and pages."]};

  // Grouped by kind, in the order the kinds are declared, then by address: the
  // file is filled in by hand, so all the products sit together.
  const order=new Map(REDIR_KINDS.map((k,i)=>[k.key,i]));
  const list=[...rows.values()].sort((a,b)=>
    order.get(a.kind.key)-order.get(b.kind.key) || a.path.localeCompare(b.path));

  const files=[{name:"odoo_1_redirections.xlsx",model:"website.rewrite",
    note:"Website → Configuration → Redirects. One 301 per old Shopify address. "+
      "Fill the url_to column first: it is left empty on purpose, because the Odoo "+
      "address only exists once the products and pages are imported, and Odoo refuses "+
      "a 301 with no destination. Each row carries an id built from its Shopify path, "+
      "so importing the file again updates the same redirects instead of duplicating them.",
    cols:["id","name","redirect_type","url_from","url_to"],
    rows:list.map(r=>({
      id:externalId("redirect",r.path),
      name:"Shopify "+r.kind.one+": "+r.path,
      redirect_type:"301",
      url_from:r.path,
      url_to:""}))}];

  // --- what the user needs told ----------------------------------------------
  const warnings=[];

  warnings.push("The url_to column is empty and has to be filled in before the file is "+
    "imported: Odoo refuses a 301 without a destination. Odoo ends a slug with the "+
    "record's own id (/shop/classic-cotton-crew-tee-42), so the addresses can only be "+
    "copied from the Odoo shop once the products and pages are there.");

  if(hosts.size>1) warnings.push("The file mixes "+plural(hosts.size,"domain")+" ("+
    cap([...hosts.keys()],5,"domains")+"). Only the path is kept, so addresses from "+
    "another domain land here as redirects of your own site. Remove them if they do "+
    "not belong to the store you are migrating.");

  if(dupes) warnings.push(addresses(dupes)+" appeared more than once: the same page "+
    "under a query string, or listed twice by the sitemap. Only the first was kept, as two "+
    "rows with the same url_from would fight over the same request.");

  const counts=new Map();
  for(const r of list) counts.set(r.kind.key,(counts.get(r.kind.key)||0)+1);
  const detail=[{label:plural(list.length,"redirect"),
    items:list.map(r=>r.path+"  →  "+r.kind.hint)}];
  for(const k of REDIR_KINDS){
    const n=counts.get(k.key);
    if(!n) continue;
    detail.push({label:n+" "+(n===1?k.one:k.many),
      items:list.filter(r=>r.kind.key===k.key).map(r=>r.path)});
  }
  if(skipped.length||root) detail.push({label:addresses(skipped.length+root)+" left out",
    items:(root?["/  (the home page, which Odoo already answers on)"]:[]).concat(skipped),
    empty:"Nothing was left out."});

  return {files,warnings,detail,summary:detail.map(d=>d.label).join(" · ")};
}
