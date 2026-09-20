// Orders tab: one row per line item, folded into orders by Odoo's importer.
// Shopify writes one CSV row per line item: the first row of an order carries
// the order's own columns, every following row only its "Lineitem …" cells.
// Odoo's importer reads exactly that shape, folding a row whose only filled
// columns are order_line/… into the order above it, so the file keeps one row
// per line item.
//
// Lines meet their variant on the SKU, as on the Inventory tab: name_search on
// a variant reads default_code and barcode, never the attribute values in its
// display name, so "Blazer - Beige / S" matches nothing.
//
// The orders are written straight into the confirmed state, which is the point
// of a history import: no delivery order, so the stock loaded by the Inventory
// tab already reflects what Shopify shipped and is not deducted twice, and no
// invoice is raised for a sale paid months ago.

const ORDER_COLS=["id","name","partner_id","date_order","state","note",
  "order_line/product_id","order_line/name","order_line/product_uom_qty",
  "order_line/price_unit","order_line/discount"];

const SERVICE_COLS=["name","default_code","type","list_price","invoice_policy"];
// Deliberately unlikely references: the lines match on them, and an existing
// "Delivery" product must not be caught by accident.
const SHIP_REF="SHOPIFY-SHIPPING", DISC_REF="SHOPIFY-DISCOUNT";

// The order's own columns, repeated by Shopify on some rows and left empty on
// others. The first filled one wins.
const ORDER_HEAD_FIELDS=["id","email","financialstatus","fulfillmentstatus","currency",
  "subtotal","shipping","taxes","total","discountcode","discountamount","shippingmethod",
  "createdat","paidat","billingname","shippingname","shippingcompany","billingcompany",
  "notes","cancelledat","refundedamount","duties"];

// Shopify's exports carry "1 234,56", "'0.00" and "€12.00" alike, and a comma
// is a thousands separator or a decimal point depending on the store.
function money(v){
  let t=String(v==null?"":v).trim();
  if(t.startsWith("'")) t=t.slice(1);
  t=t.replace(/[\s ]/g,"").replace(/[^\d.,+-]/g,"");
  if(!t || !/\d/.test(t)) return 0;
  if(/^[+-]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) t=t.replace(/,/g,"");   // 1,234.56
  else if(t.includes(",") && !t.includes(".")) t=t.replace(",",".");     // 1234,56
  else t=t.replace(/,/g,"");
  const n=Number(t);
  return Number.isFinite(n)?n:0;
}
const round2 = n => Math.round((n+Number.EPSILON)*100)/100;
// Trailing zeros are noise in a text cell Odoo parses as a number anyway.
const num = n => String(round2(n));
const num4 = n => String(Math.round((n+Number.EPSILON)*1e4)/1e4);
// plural() only agrees the noun; a warning needs its verb agreed too.
const isAre=n=>n===1?"is":"are", wasWere=n=>n===1?"was":"were",
      doesDo=n=>n===1?"does":"do", hasHave=n=>n===1?"has":"have";

// Shopify stamps the store's own offset: "2026-09-11 17:42:58 +0200". Odoo
// reads a naked datetime in the importing user's timezone, so the offset is
// dropped rather than converted to UTC: the wall-clock time is the one the
// staff remember, and it lands right as long as that user's timezone is the
// store's. The offsets found are reported so a mismatch shows before the
// import.
function orderDate(v, seen){
  const m=clean(v).match(
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?\s*([+-]\d{2}:?\d{2}|Z)?/);
  if(!m) return "";
  if(m[7]) seen.add(m[7]==="Z" ? "+00:00"
    : m[7].length===5 ? m[7].slice(0,3)+":"+m[7].slice(3) : m[7]);
  return m[1]+"-"+m[2]+"-"+m[3]+" "+m[4]+":"+m[5]+":"+(m[6]||"00");
}

function convertOrders(text){
  const all=parseRows(text);
  if(!all.length) return {errors:["The file is empty or unreadable."]};
  const head=all.shift().map(h=>String(h||"").trim());
  const body=all.filter(r=>r.some(c=>String(c||"").trim()!==""));

  const idx={};
  head.forEach((h,i)=>{ const n=normHeader(h); if(n && !(n in idx)) idx[n]=i; });
  const cell=(row,f)=>{ const i=idx[f]; return i==null||i>=row.length?"":clean(row[i]); };

  if(!("name" in idx) || !("lineitemname" in idx)) return {errors:[
    "This file does not look like a Shopify order export: the Name and Lineitem name "+
    "columns were not both found. Export it from Orders → Export, all columns."]};
  if(!body.length) return {errors:["The file has a header but not a single row."]};

  // --- group the rows back into orders ---------------------------------------
  const orders=new Map();
  const offsets=new Set();
  const orphans=[];
  const hasQty="lineitemquantity" in idx;
  let current=null;

  body.forEach((row,i)=>{
    const line=i+2;                                 // +1 header, +1 to be 1-based
    const name=cell(row,"name");
    if(name){
      // Same order exported twice, or rows out of order: the line items join the
      // order already open rather than starting a new one.
      current=orders.get(name);
      if(!current){ current={name,line,head:{},lines:[]}; orders.set(name,current); }
    }
    if(!current){ orphans.push(line); return; }

    for(const f of ORDER_HEAD_FIELDS)
      if(!current.head[f]){ const v=cell(row,f); if(v) current.head[f]=v; }

    const liName=cell(row,"lineitemname"), sku=cell(row,"lineitemsku");
    if(!liName && !sku) return;                     // a row carrying only order totals
    const qty=hasQty ? money(cell(row,"lineitemquantity")) : 1;
    current.lines.push({line,sku,name:liName||sku,
      qty:qty||1, price:money(cell(row,"lineitemprice")), disc:money(cell(row,"lineitemdiscount"))});
  });

  // --- build the order rows --------------------------------------------------
  const rows=[], warnings=[];
  const noSku=[], unknownSkus=new Set(), emptyOrders=[], mismatched=[];
  const noPartner=[], strangers=new Set(), currencies=new Map(), otherShipTo=new Set();
  const usedIds=new Set();
  let shipLines=0, discLines=0, cancelled=0, refunds=0, taxTotal=0, dutyTotal=0, unpaid=0;
  let roughDisc=0;

  for(const o of orders.values()){
    const h=o.head;
    if(!o.lines.length){ emptyOrders.push(o.name); continue; }

    // Keyed on Shopify's own order id (shopify_order_5821), so re-importing the
    // same export updates the orders instead of laying down a second set.
    const base=externalId("order",h.id||o.name);
    let xmlid=base;
    for(let n=2; usedIds.has(xmlid); n++) xmlid=base+"_"+n;
    usedIds.add(xmlid);

    // Odoo matches a contact on its display name, its email or its reference.
    // The email is the one of the three Shopify is sure about.
    const email=(h.email||"").toLowerCase();
    const partner=EMAIL_RE.test(email) ? email : (h.billingname||h.shippingname||"");
    if(!partner) noPartner.push(o.name);
    else if(knownPartners && knownPartners.size && !knownPartners.has(partner.toLowerCase()))
      strangers.add(partner);

    if(h.currency) currencies.set(h.currency,(currencies.get(h.currency)||0)+1);
    taxTotal+=money(h.taxes); dutyTotal+=money(h.duties);
    if(money(h.refundedamount)>0) refunds++;
    if(h.financialstatus && !/^(paid|partially_refunded|refunded)$/i.test(h.financialstatus)) unpaid++;
    // A delivery address of its own is not imported: it would need a child
    // contact this file cannot safely create or match.
    const shipTo=h.shippingname||"";
    if(shipTo && h.billingname && shipTo!==h.billingname) otherShipTo.add(o.name);

    const built=[];
    let net=0;
    for(const l of o.lines){
      if(!l.sku) noSku.push(o.name+" · "+l.name);
      else if(knownSkus && knownSkus.size && !knownSkus.has(l.sku)) unknownSkus.add(l.sku);
      const gross=l.price*l.qty;
      // Shopify allocates a discount as an amount on the line, Odoo as a
      // percentage of that line. Same money, but only if the percentage has the
      // decimals to say it, and Odoo keeps two by default.
      const pct=(l.disc>0 && gross>0) ? l.disc/gross*100 : 0;
      if(pct && Math.abs(gross*round2(pct)/100-l.disc)>=0.005) roughDisc++;
      built.push({
        "order_line/product_id": l.sku||l.name,
        "order_line/name": l.name,
        "order_line/product_uom_qty": num(l.qty),
        "order_line/price_unit": num(l.price),
        "order_line/discount": num4(pct),
      });
      net+=gross-l.disc;
    }

    // Shipping is a line in Odoo, not a field on the order.
    const ship=money(h.shipping);
    if(ship>0){
      shipLines++;
      built.push({"order_line/product_id":SHIP_REF,
        "order_line/name":"Shipping"+(h.shippingmethod?" — "+h.shippingmethod:""),
        "order_line/product_uom_qty":"1","order_line/price_unit":num(ship),
        "order_line/discount":"0"});
    }

    // "Discount Amount" is the order's whole discount, line allocations included,
    // so only what the lines did not absorb becomes a line of its own. Otherwise
    // the discount would be taken twice.
    const lineDisc=o.lines.reduce((s,l)=>s+l.disc,0);
    const rest=round2(money(h.discountamount)-lineDisc);
    if(rest>0.004){
      discLines++;
      built.push({"order_line/product_id":DISC_REF,
        "order_line/name":"Discount"+(h.discountcode?" — "+h.discountcode:""),
        "order_line/product_uom_qty":"1","order_line/price_unit":num(-rest),
        "order_line/discount":"0"});
      net-=rest;
    }

    // Shopify's Subtotal is what the lines come to after their discounts. A gap
    // means the export holds something this file does not model.
    if(h.subtotal && Math.abs(round2(net)-money(h.subtotal))>0.011)
      mismatched.push(o.name+" ("+num(net)+" vs "+num(money(h.subtotal))+")");

    if(h.cancelledat) cancelled++;
    const first={
      id:xmlid, name:o.name, partner_id:partner,
      date_order:orderDate(h.createdat||h.paidat,offsets),
      state:h.cancelledat ? "cancel" : "sale",
      note:h.notes||"",
    };
    const empty={id:"",name:"",partner_id:"",date_order:"",state:"",note:""};
    built.forEach((b,i)=>rows.push(Object.assign({},i?empty:first,b)));
  }

  if(!rows.length) return {errors:[
    "No order could be built: not one row carried a line item. Check that the export "+
    "still has its Lineitem columns."]};

  // --- files -----------------------------------------------------------------
  const files=[];
  const services=[];
  if(shipLines) services.push({name:"Shipping",default_code:SHIP_REF,type:"service",
    list_price:"0",invoice_policy:"order"});
  if(discLines) services.push({name:"Discount",default_code:DISC_REF,type:"service",
    list_price:"0",invoice_policy:"order"});
  if(services.length) files.push({name:"odoo_1_order_services.xlsx",model:"product.template",
    note:"Sales → Products → Import records. Two service products the orders file needs: "+
      "Odoo carries shipping and an order-wide discount as ordinary lines, and a line "+
      "cannot exist without a product. They are matched on their Internal Reference, so "+
      "nothing you already sell is touched.",
    cols:SERVICE_COLS,rows:services});

  files.push({name:"odoo_"+(services.length?2:1)+"_orders.xlsx",model:"sale.order",
    note:"Sales → Orders → Import records. One row per line item, exactly as Shopify "+
      "exported it: Odoo folds every row that fills only the order_line columns into the "+
      "order above it. The orders arrive confirmed, with no delivery and no invoice.",
    cols:ORDER_COLS,rows});

  // --- what the user needs told ----------------------------------------------
  warnings.push("The orders are written straight into the confirmed state, so importing "+
    "them creates no delivery order and no invoice. That is deliberate: the Inventory tab "+
    "loads the stock Shopify holds today, which is already net of everything these orders "+
    "shipped, and confirming them properly would deduct it twice. They will read “To "+
    "invoice” in Odoo, as expected for a sale paid months ago.");

  warnings.push("Status is a read-only field, and some Odoo versions keep it out of the "+
    "import screen. If yours offers no field for the state column, leave that one column "+
    "unmapped: the orders then arrive as quotations, with everything else unchanged. Do "+
    "not confirm them afterwards unless you want the deliveries too.");

  warnings.push("Taxes are not carried over. Odoo recomputes them from each product's own "+
    "tax settings, so a total here can differ from Shopify's"+
    (taxTotal>0.004?" (this export holds "+num(taxTotal)+" of tax)":"")+
    ". Open one imported order and compare it with the same order in Shopify before "+
    "trusting the rest; if the totals are off, clear the taxes on the imported lines.");

  if(knownPartners && knownPartners.size){
    if(strangers.size) warnings.push("Not in the customer export converted on the Customers "+
      "tab: "+plural(strangers.size,"customer")+" ("+cap([...strangers],8,"customers")+
      "). Odoo will stop on those orders unless the contacts already exist.");
  }else{
    warnings.push("The Customers tab has not been used in this session, so the customers "+
      "could not be checked against your contact export. Each order matches its contact on "+
      "the email address, falling back to the billing name: import the Customers tab's file "+
      "first, or Odoo will stop on the first order it cannot place.");
  }

  if(knownSkus && knownSkus.size){
    if(unknownSkus.size) warnings.push("Not in the product export converted on the Products "+
      "tab: "+plural(unknownSkus.size,"SKU")+" ("+cap([...unknownSkus],10,"SKUs")+
      "). Those lines fail unless the variants already exist under exactly these Internal "+
      "References.");
  }else{
    warnings.push("The Products tab has not been used in this session, so the SKUs could "+
      "not be checked. Every line matches its variant on the Internal Reference: import the "+
      "products first.");
  }

  if(noSku.length) warnings.push("No SKU on "+plural(noSku.length,"line")+
    ", written with the Shopify line name instead: "+cap(noSku,6,"lines")+
    ". Odoo almost certainly will not find those: a variant's display name is not "+
    "searchable. Give them a SKU in Shopify and export again, or fix the lines in the file.");

  if(noPartner.length) warnings.push(plural(noPartner.length,"order")+
    " "+hasHave(noPartner.length)+" neither an email nor a billing name ("+cap(noPartner,8,"orders")+
    "), so no customer could be written. Odoo refuses an order without one, so fill the "+
    "Customer column in the file before importing.");

  if(offsets.size>1) warnings.push("The dates carry "+plural(offsets.size,"different UTC offset")+
    " ("+[...offsets].sort().join(", ")+"), which happens across a daylight-saving change. "+
    "Odoo reads a date in the importing user's timezone, so some orders land an hour out. "+
    "Harmless for history, worth knowing for a date-based report.");
  else if(offsets.size===1) warnings.push("The dates are the store's local time ("+
    [...offsets][0]+" from UTC) and are imported as written, because Odoo reads them in the "+
    "timezone of the user doing the import. Set that user's timezone to the store's in "+
    "Settings → Users before importing, or every order shifts by the difference.");

  if(currencies.size>1) warnings.push("The export mixes "+currencies.size+" currencies ("+[...currencies.entries()].sort((a,b)=>b[1]-a[1]).map(([c,n])=>c+" ("+plural(n,"order")+")")
    .join(", ")+"). Every price is imported as a plain number and Odoo reads it in the "+
    "currency of the order's pricelist, so the foreign ones will be wrong until you set "+
    "their pricelist by hand.");
  else if(currencies.size===1) warnings.push("Prices are imported as plain numbers, in "+
    [...currencies.keys()][0]+". Odoo reads them in the currency of the order's pricelist, "+
    "so check that your default pricelist is in that currency.");

  if(mismatched.length) warnings.push(plural(mismatched.length,"order")+
    " "+doesDo(mismatched.length)+" not add up to the Subtotal Shopify exported: "+
    cap(mismatched,6,"orders")+
    ". Usually a tip, a gift card or a tax-inclusive price list; check those orders after "+
    "the import.");

  if(cancelled) warnings.push(plural(cancelled,"cancelled order")+" "+isAre(cancelled)+
    " imported in the Cancelled state, for the record.");

  if(roughDisc) warnings.push("Odoo holds a line discount as a percentage with two "+
    "decimals, which cannot reproduce Shopify's discount to the cent on "+
    plural(roughDisc,"line")+". The file carries four decimals, so raising Discount under "+
    "Settings → Technical → Decimal Accuracy before importing keeps the money exact.");

  if(refunds) warnings.push(plural(refunds,"order")+" "+wasWere(refunds)+" refunded in "+
    "Shopify, in part or in full. The refund is not imported, as there is no credit note to "+
    "attach it to, so they read as if they had been paid in full.");

  if(unpaid) warnings.push(plural(unpaid,"order")+" "+wasWere(unpaid)+" not marked paid in "+
    "Shopify (pending, voided or authorised). Nothing in this file records a payment either "+
    "way, so they import like the rest.");

  if(dutyTotal>0.004) warnings.push("Duties of "+num(dutyTotal)+" are left out: Odoo has "+
    "no field for them on a sales order.");

  if(otherShipTo.size) warnings.push("The delivery name differs from the billing name on "+
    plural(otherShipTo.size,"order")+" ("+cap([...otherShipTo],6,"orders")+
    "). The delivery address is not imported: it would need a child contact this file "+
    "cannot match. Add it by hand where it matters.");

  if(emptyOrders.length) warnings.push("Skipped "+plural(emptyOrders.length,"order")+
    " with no line item at all ("+cap(emptyOrders,8,"orders")+").");

  if(orphans.length) warnings.push(plural(orphans.length,"row")+
    " came before any order name and "+wasWere(orphans.length)+" dropped (lines "+
    orphans.slice(0,10).join(", ")+
    (orphans.length>10?", …":"")+").");

  const lineCount=rows.length-shipLines-discLines;
  return {files,warnings,
    summary:plural(usedIds.size,"order")+" · "+plural(lineCount,"line")+
      (shipLines?" · "+plural(shipLines,"shipping line"):"")+
      (discLines?" · "+plural(discLines,"discount line"):"")};
}

