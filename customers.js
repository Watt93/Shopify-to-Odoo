// Customers tab: contacts, addresses and the opt-out list.
// Port of shopify_to_odoo.py, with its command-line switches settled here:
// external ids on, countries written as XML ids, Shopify order stats left out
// of the notes, companies not split into parent contacts. The opt-out list is
// the one addition, a second file the user is free to ignore.

const CUSTOMER_ALIASES = {
  customer_id:["customerid","id"],
  first_name:["firstname"],
  last_name:["lastname"],
  email:["email"],
  accepts_email:["acceptsemailmarketing","acceptsmarketing"],
  company:["defaultaddresscompany","company"],
  address1:["defaultaddressaddress1","address1"],
  address2:["defaultaddressaddress2","address2"],
  city:["defaultaddresscity","city"],
  province:["defaultaddressprovincecode","provincecode","province"],
  country:["defaultaddresscountrycode","countrycode","country"],
  zip:["defaultaddresszip","zip","postalcode"],
  address_phone:["defaultaddressphone"],
  phone:["phone"],
  total_spent:["totalspent"],
  total_orders:["totalorders"],
  note:["note","notes"],
  tags:["tags"],
};

// Odoo ships every country in the `base` module under an XML id that is the
// lowercased ISO-3166-1 alpha-2 code, with a handful of exceptions. Importing
// country_id/id = "base.be" is exact, with no name matching involved.
const COUNTRY_XMLID_EXCEPTIONS = {GB:"base.uk"};

// Odoo matches state_id on the state NAME, not the code, so translate the ones
// Shopify writes as codes. Codes for other countries pass through untouched.
const STATE_NAMES = {
  US:{AL:"Alabama",AK:"Alaska",AZ:"Arizona",AR:"Arkansas",CA:"California",
    CO:"Colorado",CT:"Connecticut",DE:"Delaware",DC:"District of Columbia",
    FL:"Florida",GA:"Georgia",HI:"Hawaii",ID:"Idaho",IL:"Illinois",IN:"Indiana",
    IA:"Iowa",KS:"Kansas",KY:"Kentucky",LA:"Louisiana",ME:"Maine",MD:"Maryland",
    MA:"Massachusetts",MI:"Michigan",MN:"Minnesota",MS:"Mississippi",
    MO:"Missouri",MT:"Montana",NE:"Nebraska",NV:"Nevada",NH:"New Hampshire",
    NJ:"New Jersey",NM:"New Mexico",NY:"New York",NC:"North Carolina",
    ND:"North Dakota",OH:"Ohio",OK:"Oklahoma",OR:"Oregon",PA:"Pennsylvania",
    PR:"Puerto Rico",RI:"Rhode Island",SC:"South Carolina",SD:"South Dakota",
    TN:"Tennessee",TX:"Texas",UT:"Utah",VT:"Vermont",VA:"Virginia",
    WA:"Washington",WV:"West Virginia",WI:"Wisconsin",WY:"Wyoming"},
  CA:{AB:"Alberta",BC:"British Columbia",MB:"Manitoba",NB:"New Brunswick",
    NL:"Newfoundland and Labrador",NS:"Nova Scotia",NT:"Northwest Territories",
    NU:"Nunavut",ON:"Ontario",PE:"Prince Edward Island",QC:"Quebec",
    SK:"Saskatchewan",YT:"Yukon"},
  AU:{ACT:"Australian Capital Territory",NSW:"New South Wales",
    NT:"Northern Territory",QLD:"Queensland",SA:"South Australia",
    TAS:"Tasmania",VIC:"Victoria",WA:"Western Australia"},
};

const CONTACT_COLS = ["id","name","company_type","ref","email","phone","mobile",
  "street","street2","city","zip","state_id","country_id/id","comment","customer_rank"];

// Shopify writes "Accepts Email Marketing" a dozen different ways.
const truthy = v => ["yes","true","1","y","subscribed"].includes(clean(v).toLowerCase());

function convertCustomers(text){
  const rows=parseRows(text);
  if(!rows.length) return {errors:["The file is empty or unreadable."]};
  const head=rows.shift(), width=head.length;

  // Later duplicate headers win, as in the Python original.
  const seenHeaders={};
  head.forEach((h,i)=>{ seenHeaders[normHeader(h)]=i; });
  const index={};
  for(const [field,aliases] of Object.entries(CUSTOMER_ALIASES))
    for(const a of aliases) if(a in seenHeaders){ index[field]=seenHeaders[a]; break; }

  const missing=["first_name","last_name","email"].filter(f=>!(f in index));
  if(missing.length===3) return {errors:[
    "This file does not look like a Shopify customer export: none of the First Name, "+
    "Last Name or Email columns were found. Check that it is a Customers export "+
    "(not Orders or Products)."]};

  const get=(row,field)=>{
    const i=index[field];
    return i==null||i>=row.length ? "" : clean(row[i]);
  };

  // Everything worth telling the user at the end, in the shape the warning box wants.
  const warnings=[], skipped=[], badEmails=[], ragged=[], duplicateIds=[];
  const unknownCountries=new Map(), unknownStates=new Map();
  const bump=(map,key)=>map.set(key,(map.get(key)||0)+1);

  if(missing.length) warnings.push(
    "These expected Shopify columns were not found: "+missing.join(", ")+
    ". The contacts built from this file will be missing that information.");

  const countryXmlId = code => {
    code=clean(code).toUpperCase();
    if(!code) return "";
    // An unusable code leaves the country empty rather than writing something
    // Odoo would reject on import; it is reported instead.
    if(code.length!==2 || !/^[A-Z]{2}$/.test(code)){ bump(unknownCountries,code); return ""; }
    return COUNTRY_XMLID_EXCEPTIONS[code] || "base."+code.toLowerCase();
  };
  const stateName = (code,countryCode) => {
    code=clean(code).toUpperCase();
    if(!code) return "";
    const country=clean(countryCode).toUpperCase();
    const table=STATE_NAMES[country]||{};
    if(code in table) return table[code];
    bump(unknownStates,(country||"??")+"-"+code);
    return code;
  };

  const contacts=[], blacklist=[], usedIds=new Set();
  let rowsIn=0;

  rows.forEach((row,i)=>{
    const line=i+2;                                   // +1 for the header, +1 to be 1-based
    if(!row.some(c=>c.trim())) return;
    rowsIn++;
    if(row.length!==width) ragged.push(line);

    const first=get(row,"first_name"), last=get(row,"last_name");
    let email=get(row,"email").toLowerCase();
    if(email && !EMAIL_RE.test(email)){ badEmails.push("line "+line+": "+email); email=""; }
    const company=get(row,"company");

    const name=[first,last].filter(Boolean).join(" ") || company || email;
    if(!name){ skipped.push("line "+line+": no name, no company and no email"); return; }

    // A stable external id keyed on the Shopify Customer ID
    // (shopify_partner_1045), so re-importing the same file updates the contacts
    // instead of creating a second set. A row with no Customer ID falls back to
    // the email, then the name, which externalId() shortens to a digest.
    const customerId=get(row,"customer_id");
    const baseId=externalId("partner",customerId||email||name);
    let xmlid=baseId;
    for(let n=2; usedIds.has(xmlid); n++) xmlid=baseId+"_"+n;
    if(xmlid!==baseId && customerId) duplicateIds.push(customerId);
    usedIds.add(xmlid);

    // Shopify's "Phone" is the customer's own number, usually a mobile;
    // "Default Address Phone" belongs to the shipping address.
    let mobile=get(row,"phone"), phone=get(row,"address_phone");
    if(!phone){ phone=mobile; mobile=""; }

    const countryCode=get(row,"country");
    contacts.push({
      id:xmlid,
      name,
      company_type:(first||last) ? "person" : "company",
      ref:customerId,
      email,
      phone,
      mobile,
      street:get(row,"address1"),
      street2:get(row,"address2"),
      city:get(row,"city"),
      zip:get(row,"zip"),
      state_id:stateName(get(row,"province"),countryCode),
      "country_id/id":countryXmlId(countryCode),
      comment:get(row,"note"),
      customer_rank:"1",
    });

    if(email && !truthy(get(row,"accepts_email"))) blacklist.push(email);
  });

  if(!contacts.length) return {errors:[
    "No contact could be built: every row was missing a name, a company and an email."]};

  const files=[{name:"odoo_1_contacts.xlsx",model:"res.partner",
    note:"Contacts → Import records. Creates the contacts with their address, phone and country. "+
      "The id column makes a second import update them rather than duplicate them.",
    cols:CONTACT_COLS,rows:contacts}];

  const optOuts=[...new Set(blacklist)];
  if(optOuts.length) files.push({name:"odoo_2_optout_emails.xlsx",model:"mail.blacklist",
    note:"Settings → Technical → Email → Blacklisted Email Addresses. The people who refused "+
      "email marketing in Shopify. Import this before sending anything.",
    cols:["email"],rows:optOuts.map(email=>({email}))});

  // Counted lists first, then the free-form notes.
  const counted=map=>[...map.entries()].sort((a,b)=>b[1]-a[1])
    .map(([k,n])=>k+" ("+plural(n,"row")+")").join(", ");

  if(skipped.length) warnings.push("Skipped "+plural(skipped.length,"row")+
    ": "+cap(skipped,10,"rows")+".");
  if(unknownCountries.size) warnings.push(
    "Country codes with no Odoo equivalent, left empty. Set them by hand after the import: "+
    counted(unknownCountries)+".");
  if(unknownStates.size) warnings.push(
    "Province codes written as-is, because Odoo matches states on their name: "+
    counted(unknownStates)+". Check them in Odoo if the import complains.");
  if(badEmails.length) warnings.push("Dropped "+plural(badEmails.length,"malformed email")+
    ": "+cap(badEmails,10,"emails")+".");
  if(ragged.length) warnings.push(plural(ragged.length,"row")+
    " had a different column count than the header (lines "+ragged.slice(0,10).join(", ")+
    (ragged.length>10?", …":"")+"). Usually an unescaped quote or newline in the export, so "+
    "check those contacts after import.");
  if(duplicateIds.length) warnings.push(plural(duplicateIds.length,"duplicate Customer ID")+
    " ("+cap(duplicateIds,10,"ids")+"). Each got a suffixed external id, so they import as "+
    "separate contacts. Merge them in Odoo if that is wrong.");

  // Handed to the Orders tab, which places each order on a contact by email,
  // falling back to the billing name, and can then name the customers this
  // export never mentioned.
  const partners=new Set();
  for(const c of contacts){
    if(c.email) partners.add(c.email.toLowerCase());
    if(c.name)  partners.add(c.name.toLowerCase());
  }

  return {files,warnings,partners,
    summary:plural(contacts.length,"contact")+" · "+plural(rowsIn,"row")+" read"+
      (optOuts.length?" · "+plural(optOuts.length,"opt-out"):"")};
}

