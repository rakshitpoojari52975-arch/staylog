/* StayLog — Homestay Manager App
   v7: ID proof attachment in bookings, warm PDF house rules, check-in/out times
   v8: Staff registry + staff loan module — repayment schedule, payout deduction, loan analysis */
'use strict';

// ─── Build ────────────────────────────────────────────────────────────────────
// Bump BOTH of these together. This date sat at 28 Sept through a dozen
// releases and was read, reasonably, as proof the upload had not landed.
const APP_VERSION='v53', APP_BUILT='28 Oct 2026';
// The CACHE_NAME of the sw.js released with this app.js. Every release bumps
// APP_VERSION and CACHE_NAME together, so one is derived from the other rather
// than being a fourth thing to forget; the tests fail if they ever disagree.
const SW_CACHE='staylog-'+APP_VERSION;
window.STAYLOG_APP_VERSION=APP_VERSION;   // stamped (in plain) on each encrypted backup

// ─── Auth ─────────────────────────────────────────────────────────────────────
const AUTH_KEY   = 'staylog_auth';
const PIN_LENGTH = 4;

// ─── Storage ──────────────────────────────────────────────────────────────────
const DB_NAME='staylog_db', DB_VERSION=1, STORE_NAME='appdata';
const DATA_KEY='staylog_main', LS_KEY='staylog_v2';
const defaultData={ properties:[], bookings:[], expenses:[], staff:[], loans:[], attendance:[] };

// Ensures older saved data (pre-loan-module) gains the new collections
function normalizeData(d){
  if(!d||typeof d!=='object')return{...defaultData};
  if(!Array.isArray(d.properties))d.properties=[];
  if(!Array.isArray(d.bookings))d.bookings=[];
  if(!Array.isArray(d.expenses))d.expenses=[];
  if(!Array.isArray(d.staff))d.staff=[];
  if(!Array.isArray(d.loans))d.loans=[];
  // Marks already turned into expenses. Kept so a mark can never be spent
  // twice, even if stamping the server failed after the expense was made.
  if(!Array.isArray(d.attendance))d.attendance=[];
  d.loans.forEach(l=>{if(!Array.isArray(l.repayments))l.repayments=[];});
  return d;
}

let _db=null;
function openDB(){
  return new Promise((res,rej)=>{
    if(_db){res(_db);return;}
    const r=indexedDB.open(DB_NAME,DB_VERSION);
    r.onupgradeneeded=e=>{if(!e.target.result.objectStoreNames.contains(STORE_NAME))e.target.result.createObjectStore(STORE_NAME);};
    r.onsuccess=e=>{_db=e.target.result;res(_db);}; r.onerror=()=>rej(r.error);
  });
}
function idbGet(k){return openDB().then(db=>new Promise((res,rej)=>{const r=db.transaction(STORE_NAME,'readonly').objectStore(STORE_NAME).get(k);r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error);}));}
function idbSet(k,v){return openDB().then(db=>new Promise((res,rej)=>{const r=db.transaction(STORE_NAME,'readwrite').objectStore(STORE_NAME).put(v,k);r.onsuccess=()=>res();r.onerror=()=>rej(r.error);}));}

function saveData(d){
  try{localStorage.setItem(LS_KEY,JSON.stringify(d));}catch{}
  idbSet(DATA_KEY,JSON.parse(JSON.stringify(d))).catch(()=>{});
  // The phone is written first and always; the cloud catches up afterwards.
  try{window.StayLogCloud&&window.StayLogCloud.markDirty(()=>state.data);}catch{}
}
window.STAYLOG_GET_DATA=()=>state.data;
// cloud.js asks before a sync would delete an unusual number of rows
window.STAYLOG_CONFIRM_TOMBSTONE=({message})=>confirm(message);
// cloud.js turns her attendance marks into unpaid wage expenses through this.
// It goes through mutateData so the write is saved and the screen repaints
// exactly as it would for an expense typed by hand.
window.STAYLOG_APPLY=fn=>{try{mutateData(fn);return true;}catch(e){return false;}};
async function loadDataFromIDB(){
  try{const d=await idbGet(DATA_KEY);if(d&&d.properties)return normalizeData(d);}catch{}
  try{const ls=JSON.parse(localStorage.getItem(LS_KEY));if(ls&&ls.properties){const n=normalizeData(ls);saveData(n);return n;}}catch{}
  return{...defaultData,staff:[],loans:[]};
}
async function loadAuth(){
  try{const a=await idbGet(AUTH_KEY);if(a)return a;}catch{}
  try{const ls=localStorage.getItem(AUTH_KEY);if(ls)return JSON.parse(ls);}catch{}
  return null;
}
function saveAuth(a){try{localStorage.setItem(AUTH_KEY,JSON.stringify(a));}catch{} idbSet(AUTH_KEY,a).catch(()=>{});}
function uid(){return Date.now().toString(36)+Math.random().toString(36).slice(2);}

// ─── Formatters ───────────────────────────────────────────────────────────────
const MONTH_NAMES=['January','February','March','April','May','June','July','August','September','October','November','December'];
const MONTH_SHORT=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const DAY_SHORT  =['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const fmtDate    =s=>s?new Date(s+'T00:00:00').toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'}):'—';
const fmtDateLong=s=>s?new Date(s+'T00:00:00').toLocaleDateString('en-IN',{weekday:'long',day:'numeric',month:'long',year:'numeric'}):'—';
// Whole rupees as they are; an amount with paise always shows two places (₹250.50).
const moneyDigits=n=>Number(n)%1?{minimumFractionDigits:2,maximumFractionDigits:2}:{};
const fmtCur     =n=>'₹'+Number(n||0).toLocaleString('en-IN',moneyDigits(n||0));
const diffDays   =(a,b)=>Math.max(0,Math.ceil((new Date(b)-new Date(a))/86400000));
const isoOf      =d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const today      =()=>isoOf(new Date());          // local, not UTC
const addDaysISO =(iso,n)=>{const d=new Date(iso+'T00:00:00');d.setDate(d.getDate()+n);return isoOf(d);};

// ─── State ────────────────────────────────────────────────────────────────────
let state={
  data:{...defaultData}, auth:null, loggedIn:false,
  swMismatch:null, swBannerHidden:false,   // the running service worker is not this release's
  tab:'dashboard', modal:null, editItem:null, sendFocus:null,
  filterProp:'all', bookingFilter:'all', expandedBooking:null,
  loanFilter:'active', expandedLoan:null, showStaffPanel:false, expandedExpense:null,
  dashMonth:{year:new Date().getFullYear(),month:new Date().getMonth()},
  reportMonth:null,
  calMonth:{year:new Date().getFullYear(),month:new Date().getMonth()},
  _loading:true,
};
function setState(p){Object.assign(state,typeof p==='function'?p(state):p);render();}
// Every change can move a wage: a booking added, moved or cancelled turns a day
// into a checkout day or out of one. So every change re-prices (cheap, and a
// no-op when nothing moved). See repriceWages.
function mutateData(fn){fn(state.data);repriceWages(state.data);saveData(state.data);render();}

// ─── Attendance wages ─────────────────────────────────────────────────────────
// A marked day pays the daily wage, or the checkout-day wage if any booking
// that is not cancelled checks out that day — one flat rate for the day,
// however many checkouts, turnover days included. A blank (or non-positive)
// checkout-day wage means the daily wage. cloud.js prices new days with this;
// repriceWages keeps unpaid ones right as bookings change.
const CHECKOUT_TAG=' · checkout day';
const checkoutDates=bookings=>new Set((bookings||[]).filter(b=>b.status!=='cancelled'&&b.checkOut).map(b=>b.checkOut));
function wageFor(staff,date,bookings,dates){
  const daily=Number(staff&&staff.dailyWage)||0;
  const co=Number(staff&&staff.checkoutWage);
  const isCheckout=(dates||checkoutDates(bookings)).has(date);
  return isCheckout?{kind:'checkout',amount:co>0?co:daily}:{kind:'daily',amount:daily};
}
window.STAYLOG_WAGE_FOR=wageFor;
const withCheckoutTag=(desc,on)=>String(desc||'').replace(/ · checkout day$/,'')+(on?CHECKOUT_TAG:'');
// A wage expense made from her mark. The id is the durable sign: fromAttendance
// is a phone-side field; it travels in the encrypted backup, not in the cloud mirror.
const isAttendanceWage=e=>e.category==='staff'&&(!!e.fromAttendance||/^wag_/.test(String(e.id||'')));
// "Still at the amount the app set". autoAmount records it (synced as
// auto_amount). A day made before it existed was priced at the daily wage —
// the only rate there was — so that is the only amount taken as the app's.
// Anything else is a hand edit, and so is any loan cut taken on the expense.
function isAppPriced(e,staff){
  if(Number(e.loanDeduction||0)>0)return false;
  if(e.autoAmount!==undefined&&e.autoAmount!==null&&e.autoAmount!=='')return Number(e.amount)===Number(e.autoAmount);
  return Number(staff.dailyWage)>0&&Number(e.amount)===Number(staff.dailyWage);
}
// Unpaid, app-priced attendance days get the rate their date calls for now.
// Paid days and hand-edited amounts are never touched. Returns how many
// expenses it wrote to (including ones only given their autoAmount record).
function repriceWages(d){
  const dates=checkoutDates(d.bookings);
  let touched=0;
  for(const e of d.expenses||[]){
    if(e.paid||!isAttendanceWage(e))continue;
    const st=(d.staff||[]).find(s=>s.id===e.staffId);
    if(!st||!isAppPriced(e,st))continue;
    const w=wageFor(st,e.date,null,dates);
    if(!(w.amount>0))continue;                 // never price a day to nothing
    const desc=withCheckoutTag(e.description,w.kind==='checkout');
    if(Number(e.amount)===w.amount&&e.wageKind===w.kind&&Number(e.autoAmount)===w.amount&&e.description===desc)continue;
    touched++;
    e.amount=w.amount; e.grossAmount=w.amount; e.autoAmount=w.amount; e.wageKind=w.kind; e.description=desc;
  }
  return touched;
}

// ─── DOM helpers ──────────────────────────────────────────────────────────────
// Properties that legitimately take a bare number; everything else gets px appended,
// otherwise numeric values (fontSize:14, width:44…) are silently dropped in standards mode.
const UNITLESS_CSS=new Set(['opacity','zIndex','fontWeight','lineHeight','flex','flexGrow','flexShrink',
  'order','zoom','columnCount','tabSize','gridRow','gridColumn','aspectRatio','strokeWidth','fillOpacity']);
function applyStyle(el,v){
  for(const[k,val] of Object.entries(v))
    el.style[k]=(typeof val==='number'&&!UNITLESS_CSS.has(k))?val+'px':val;
}
const h=(tag,attrs={}, ...children)=>{
  const el=document.createElement(tag);
  for(const [k,v] of Object.entries(attrs)){
    if(k==='style'&&typeof v==='object')applyStyle(el,v);
    else if(k.startsWith('on')&&typeof v==='function')el.addEventListener(k.slice(2).toLowerCase(),v);
    else if(k==='className')el.className=v;
    else if(k==='checked'||k==='disabled'||k==='selected')el[k]=v;
    else el.setAttribute(k,v);
  }
  for(const c of children.flat(Infinity)){
    if(c==null||c===false)continue;
    el.appendChild(typeof c==='string'||typeof c==='number'?document.createTextNode(c):c);
  }
  return el;
};
const div =(a,...c)=>h('div',a,...c);
const span=(a,...c)=>h('span',a,...c);
const btn =(a,...c)=>h('button',a,...c);
const ico =(name,extra={})=>h('i',{className:`ti ti-${name}`,'aria-hidden':'true',...extra});

// ─── Conflict checker ─────────────────────────────────────────────────────────
function hasConflict(propertyId,checkIn,checkOut,excludeId=null){
  return state.data.bookings.some(b=>{
    if(b.id===excludeId)return false;
    if(b.propertyId!==propertyId)return false;
    if(b.status==='cancelled')return false;
    return b.checkIn<checkOut && b.checkOut>checkIn;
  });
}

// ─── Month selector ───────────────────────────────────────────────────────────
function monthSelector(current,onChange){
  const now=new Date(),yr=now.getFullYear(),isAll=current===null;
  const wrap=div({style:{display:'flex',alignItems:'center',gap:6}});
  const prevBtn=btn({style:{background:'none',border:'none',padding:'4px 6px',cursor:'pointer',color:'var(--muted)',fontSize:20},
    onClick:()=>{if(isAll)return;let{year,month}=current;month--;if(month<0){month=11;year--;}onChange({year,month});}
  },'‹');
  const label=btn({style:{background:isAll?'var(--accent)':'var(--white)',color:isAll?'var(--on-accent)':'var(--text)',border:'1.5px solid '+(isAll?'var(--accent)':'var(--border)'),borderRadius:20,padding:'5px 14px',fontSize:13,fontWeight:600,minWidth:110,textAlign:'center',cursor:'pointer'}},
    isAll?'All Time':`${MONTH_SHORT[current.month]} ${current.year}`);
  label.addEventListener('click',()=>{
    const existing=document.getElementById('month-picker-overlay');
    if(existing){existing.remove();return;}
    const overlay=div({id:'month-picker-overlay',style:{position:'fixed',inset:0,zIndex:500}});
    overlay.addEventListener('click',e=>{if(e.target===overlay)overlay.remove();});
    const rect=label.getBoundingClientRect();
    const picker=div({style:{position:'absolute',top:(rect.bottom+6)+'px',left:Math.max(8,rect.left-40)+'px',background:'var(--white)',border:'1px solid var(--border)',borderRadius:14,padding:'12px',boxShadow:'var(--shadow)',minWidth:240,zIndex:501}});
    picker.appendChild(btn({style:{width:'100%',padding:'8px 12px',textAlign:'left',background:isAll?'var(--accent-light)':'none',color:isAll?'var(--accent)':'var(--text)',border:'none',borderRadius:8,fontWeight:isAll?600:400,fontSize:14,cursor:'pointer',marginBottom:6},onClick:()=>{onChange(null);overlay.remove();}},'All Time'));
    [yr,yr-1].forEach(y=>{
      picker.appendChild(div({style:{fontSize:11,color:'var(--muted)',fontWeight:600,textTransform:'uppercase',letterSpacing:'0.06em',margin:'8px 0 6px 4px'}},String(y)));
      const grid=div({style:{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:4}});
      MONTH_SHORT.forEach((m,i)=>{
        const isCur=!isAll&&current.year===y&&current.month===i;
        grid.appendChild(btn({style:{padding:'7px 4px',borderRadius:8,border:'none',background:isCur?'var(--accent)':'var(--cream)',color:isCur?'var(--on-accent)':'var(--text)',fontSize:13,fontWeight:isCur?600:400,cursor:'pointer'},onClick:()=>{onChange({year:y,month:i});overlay.remove();}},m));
      });
      picker.appendChild(grid);
    });
    overlay.appendChild(picker);document.body.appendChild(overlay);
  });
  const nextBtn=btn({style:{background:'none',border:'none',padding:'4px 6px',cursor:'pointer',color:'var(--muted)',fontSize:20},
    onClick:()=>{if(isAll)return;let{year,month}=current;month++;if(month>11){month=0;year++;}onChange({year,month});}
  },'›');
  wrap.appendChild(prevBtn);wrap.appendChild(label);wrap.appendChild(nextBtn);
  return wrap;
}

// ─── Badge ────────────────────────────────────────────────────────────────────
const STATUS_META={
  confirmed:{label:'Confirmed',bg:'var(--accent-light)',color:'var(--accent)'},
  checkedin:{label:'Checked In',bg:'var(--info-light)',color:'var(--info)'},
  checkedout:{label:'Checked Out',bg:'var(--border-soft)',color:'var(--muted)'},
  cancelled:{label:'Cancelled',bg:'var(--danger-light)',color:'var(--danger)'},
};
function badge(status){const m=STATUS_META[status]||{label:status,bg:'var(--border-soft)',color:'var(--muted)'};return span({style:{background:m.bg,color:m.color,borderRadius:20,padding:'4px 11px',fontSize:12,fontWeight:600}},m.label);}

// Expense paid badge
function expPaidBadge(paid){
  const m=paid?{label:'Paid',bg:'var(--accent-light)',color:'var(--accent)'}:{label:'Unpaid',bg:'var(--warn-light)',color:'var(--warn)'};
  return span({style:{background:m.bg,color:m.color,borderRadius:20,padding:'3px 10px',fontSize:11,fontWeight:600}},m.label);
}

// ─── Modal ────────────────────────────────────────────────────────────────────
function modal(title,contentFn){
  const overlay=div({style:{position:'fixed',inset:0,background:'var(--scrim)',zIndex:999,display:'flex',alignItems:'flex-end',justifyContent:'center',backdropFilter:'blur(2px)'},onClick:e=>{if(e.target===overlay)closeModal();}});
  const sheet=div({style:{background:'var(--white)',borderRadius:'20px 20px 0 0',padding:'20px 16px env(safe-area-inset-bottom,24px)',width:'100%',maxWidth:480,maxHeight:'90vh',overflowY:'auto',boxShadow:'var(--shadow-lift)'}});
  sheet.appendChild(div({style:{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:18}},
    h('span',{style:{fontFamily:'var(--display)',fontSize:20,fontWeight:400}},title),
    btn({style:{background:'none',border:'none',fontSize:24,color:'var(--light)',cursor:'pointer',padding:'2px 8px',lineHeight:1},onClick:closeModal},'×')
  ));
  sheet.appendChild(contentFn());
  overlay.appendChild(sheet);
  sheet.style.transform='translateY(100%)';
  requestAnimationFrame(()=>{sheet.style.transition='transform .28s cubic-bezier(.32,.72,0,1)';sheet.style.transform='translateY(0)';});
  return overlay;
}
function closeModal(){setState({modal:null,editItem:null,sendFocus:null});}

// ─── Face ID ──────────────────────────────────────────────────────────────────
// A second key to the same local lock as the PIN, never a replacement for it.
// WebAuthn with the phone's own authenticator: Face ID (or Touch ID) has to
// succeed for navigator.credentials.get to return, and the assertion must say
// the user was verified. Nothing goes to a server — there is none to check a
// signature against, exactly as the PIN is checked on the phone — so only the
// credential id is kept, in this browser's storage, never in data or backups.
//
// The relying party is the full host: github.io is a public suffix, so it
// cannot be the RP ID. Anywhere else (a Safari tab on another host, a local
// copy) the option is hidden; a credential made for one RP never works on
// another.
const FACEID_KEY='staylog_faceid', FACEID_RP='rakshitpoojari52975-arch.github.io';
let faceIdAvail=null;            // null until asked; then true / false
let faceIdAuto=true;             // one automatic prompt per lock screen
let faceIdBusy=null;             // the AbortController of a prompt in flight
const b64uBytes=b=>btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const bytesB64u=s=>Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-s.length%4)%4)),c=>c.charCodeAt(0));
function faceIdId(){try{const v=JSON.parse(localStorage.getItem(FACEID_KEY)||'null');return v&&v.id||'';}catch(e){return '';}}
function faceIdSet(id){try{id?localStorage.setItem(FACEID_KEY,JSON.stringify({id})):localStorage.removeItem(FACEID_KEY);}catch(e){}}
const faceIdOn=()=>!!(faceIdAvail&&state.auth&&faceIdId());
function checkFaceId(){
  if(faceIdAvail!==null)return Promise.resolve(faceIdAvail);
  const P=window.PublicKeyCredential;
  if(location.hostname!==FACEID_RP||!P||!navigator.credentials||!navigator.credentials.get||
     typeof P.isUserVerifyingPlatformAuthenticatorAvailable!=='function'){faceIdAvail=false;return Promise.resolve(false);}
  const ask=P.isUserVerifyingPlatformAuthenticatorAvailable()
    .then(v=>{faceIdAvail=!!v;},()=>{faceIdAvail=false;})
    .then(()=>faceIdAvail);
  // The PIN screen never waits on this for long. A late answer still counts
  // from the next lock and in the menu.
  return Promise.race([ask,new Promise(r=>setTimeout(()=>r(false),1500))]);
}
const challenge=()=>crypto.getRandomValues(new Uint8Array(32));
// Called straight from the tap that confirmed the PIN: iOS wants a gesture.
function faceIdCreate(){
  return navigator.credentials.create({publicKey:{
    challenge:challenge(), rp:{id:FACEID_RP,name:'StayLog'},
    user:{id:crypto.getRandomValues(new Uint8Array(16)),name:'StayLog',displayName:'StayLog'},
    pubKeyCredParams:[{type:'public-key',alg:-7},{type:'public-key',alg:-257}],
    authenticatorSelection:{authenticatorAttachment:'platform',userVerification:'required',residentKey:'discouraged'},
    attestation:'none', timeout:60000,
  }}).then(c=>{if(!c||!c.rawId)throw new Error('no credential');faceIdSet(b64uBytes(c.rawId));return true;});
}
// True only for an assertion from this credential with user verification
// (flag UV, bit 2 of the authenticator data's flags byte).
function faceIdVerify(){
  const id=faceIdId();
  if(!id)return Promise.resolve(false);
  const ac=window.AbortController?new AbortController():null;
  faceIdBusy=ac;
  return navigator.credentials.get({publicKey:{challenge:challenge(),rpId:FACEID_RP,
      allowCredentials:[{type:'public-key',id:bytesB64u(id),transports:['internal']}],
      userVerification:'required',timeout:60000},...(ac?{signal:ac.signal}:{})})
    .then(a=>{
      if(!a||!a.response||b64uBytes(a.rawId)!==id)return false;
      const ad=new Uint8Array(a.response.authenticatorData||[]);
      return ad.length>32&&!!(ad[32]&0x04);
    },()=>false)
    .finally(()=>{if(faceIdBusy===ac)faceIdBusy=null;});
}
function faceIdCancel(){ if(faceIdBusy){try{faceIdBusy.abort();}catch(e){} faceIdBusy=null;} }
function lockApp(){ faceIdAuto=true; state.modal=null; state.loggedIn=false; render(); }

// Menu → Unlock with Face ID: the PIN first, both to turn it on and off.
function renderFaceIdModal(){
  const on=!!faceIdId();
  const content=()=>{
    const wrap=div({style:{display:'flex',flexDirection:'column',gap:12}});
    wrap.appendChild(div({style:{fontSize:13.5,color:'var(--text-mid)',lineHeight:1.55}},
      on?'Enter your PIN to turn Face ID off. The PIN keeps working as before.'
        :'Enter your PIN, then confirm with Face ID. The PIN stays as the fallback, and nothing leaves this phone.'));
    const inp=h('input',{type:'password',inputmode:'numeric',pattern:'[0-9]*',maxlength:String(PIN_LENGTH),
      autocomplete:'off','data-faceid-pin':'1',placeholder:'Current PIN',style:{fontSize:18,letterSpacing:'0.3em',textAlign:'center'}});
    const msg=div({'data-faceid-msg':'1',style:{fontSize:12.5,color:'var(--danger)',minHeight:18}});
    const go=btn({className:'btn-primary','data-faceid-go':'1',style:{width:'100%',minHeight:46},onClick:()=>{
      if(inp.value!==(state.auth&&state.auth.pin)){msg.textContent='That is not your PIN.';inp.value='';inp.focus();return;}
      if(on){faceIdSet('');closeModal();return;}
      msg.style.color='var(--muted)';msg.textContent='Look at your iPhone…';go.disabled=true;
      faceIdCreate().then(()=>closeModal(),()=>{
        go.disabled=false;msg.style.color='var(--danger)';
        msg.textContent='Face ID was not set up. You can try again, or keep using the PIN.';});
    }},on?'Turn off Face ID':'Turn on Face ID');
    inp.addEventListener('keydown',e=>{if(e.key==='Enter')go.click();});
    wrap.appendChild(inp); wrap.appendChild(msg); wrap.appendChild(go);
    wrap.appendChild(btn({className:'btn-ghost',style:{width:'100%'},onClick:closeModal},'Cancel'));
    setTimeout(()=>inp.focus(),80);
    return wrap;
  };
  return modal('Unlock with Face ID',content);
}

// ─── PIN Screen ───────────────────────────────────────────────────────────────
function injectPinCSS(){
  if(document.getElementById('pin-style'))return;
  const s=document.createElement('style');
  s.id='pin-style';
  s.textContent=`
    .pin-cell{width:56px;height:68px;border-radius:14px;border:2.5px solid var(--border);background:var(--white);
      display:flex;align-items:center;justify-content:center;font-size:26px;font-weight:700;color:var(--accent);
      transition:all .15s;box-shadow:0 2px 8px rgba(0,0,0,0.06);}
    .pin-cell.filled{border-color:var(--accent);background:var(--accent-light);}
    .pin-cell.active{border-color:var(--accent);box-shadow:0 0 0 4px var(--accent-light);transform:scale(1.07);}
    .pin-cell.error{border-color:var(--danger);background:var(--danger-light);animation:pinShake .4s ease;}
    .pin-cell.success{border-color:var(--accent);background:var(--accent);color:#fff;}
    @keyframes pinShake{0%,100%{transform:translateX(0)}20%{transform:translateX(-7px)}40%{transform:translateX(7px)}60%{transform:translateX(-4px)}80%{transform:translateX(4px)}}
    .numkey{width:76px;height:76px;border-radius:50%;border:1.5px solid var(--border);background:var(--white);
      font-size:24px;font-weight:600;color:var(--text);cursor:pointer;
      display:flex;align-items:center;justify-content:center;
      box-shadow:0 2px 8px rgba(0,0,0,0.08);transition:all .12s;
      -webkit-tap-highlight-color:transparent;user-select:none;}
    .numkey:active,.numkey.pressed{transform:scale(0.90);background:var(--accent-light);border-color:var(--accent);box-shadow:none;}
    .numkey.back-key{background:var(--cream);font-size:20px;}
    .numkey.empty-key{visibility:hidden;pointer-events:none;}
  `;
  document.head.appendChild(s);
}

function renderLoginScreen(){
  injectPinCSS();
  const isSetup=!state.auth;
  const app=document.getElementById('app');
  app.innerHTML='';
  let pinEntry='', confirmPin='', phase=isSetup?'create':'enter';

  const wrap=div({style:{display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',minHeight:'100vh',padding:'32px 20px',background:'var(--cream)'}});

  wrap.appendChild(div({style:{fontFamily:'var(--display)',fontSize:34,color:'var(--accent)',marginBottom:4}},'StayLog'));
  wrap.appendChild(div({style:{fontSize:13,color:'var(--muted)',marginBottom:32,textAlign:'center',maxWidth:260,lineHeight:1.6}},
    isSetup?'Create a 4-digit PIN to keep your homestay data private':'Welcome back — enter your PIN to unlock'));

  const phaseLabel=div({style:{fontSize:15,fontWeight:600,color:'var(--text-mid)',marginBottom:22,textAlign:'center',letterSpacing:'0.01em'}},
    isSetup?'Create your PIN':'Enter PIN');
  wrap.appendChild(phaseLabel);

  // 4 visible PIN cells
  const cellsWrap=div({style:{display:'flex',gap:14,marginBottom:20}});
  const cells=[];
  for(let i=0;i<PIN_LENGTH;i++){const c=div({className:'pin-cell'});cells.push(c);cellsWrap.appendChild(c);}
  wrap.appendChild(cellsWrap);

  const msgEl=div({style:{fontSize:13,color:'var(--danger)',minHeight:22,marginBottom:12,fontWeight:500,textAlign:'center'}});
  wrap.appendChild(msgEl);

  let flashTimers=[];
  function curPin(){return phase==='confirm'?confirmPin:pinEntry;}
  function setCurPin(v){if(phase==='confirm')confirmPin=v;else pinEntry=v;}

  function updateCells(pin,mode='normal'){
    flashTimers.forEach(clearTimeout);flashTimers=[];
    cells.forEach((c,i)=>{
      c.className='pin-cell';c.textContent='';
      if(mode==='error'){c.classList.add('error');}
      else if(mode==='success'){c.classList.add('filled','success');c.textContent='✓';}
      else{
        if(i<pin.length){
          c.classList.add('filled','active');
          c.textContent=pin[i]; // flash digit
          const t=setTimeout(()=>{c.textContent='●';c.classList.remove('active');},320);
          flashTimers.push(t);
        } else if(i===pin.length){
          c.classList.add('active'); // cursor highlight on next empty cell
        }
      }
    });
  }
  updateCells('');

  function handleDigit(d){
    const cur=curPin();
    if(cur.length>=PIN_LENGTH)return;
    const next=cur+d;
    setCurPin(next);
    updateCells(next);
    msgEl.textContent='';

    if(next.length===PIN_LENGTH){
      if(phase==='enter'){
        if(next===state.auth.pin){
          updateCells(next,'success');
          faceIdCancel();
          setTimeout(()=>{state.loggedIn=true;render();},380);
        } else {
          updateCells(next,'error');
          msgEl.style.color='var(--danger)';msgEl.textContent='Incorrect PIN — please try again';
          setTimeout(()=>{pinEntry='';updateCells('');msgEl.textContent='';},700);
        }
      } else if(phase==='create'){
        setTimeout(()=>{phase='confirm';phaseLabel.textContent='Confirm your PIN';confirmPin='';updateCells('');},280);
      } else {
        if(confirmPin===pinEntry){
          updateCells(next,'success');
          setTimeout(()=>{const a={pin:pinEntry};state.auth=a;state.loggedIn=true;saveAuth(a);render();},380);
        } else {
          updateCells(next,'error');
          msgEl.textContent='PINs don\'t match — please start over';
          setTimeout(()=>{pinEntry='';confirmPin='';phase='create';phaseLabel.textContent='Create your PIN';updateCells('');msgEl.textContent='';},800);
        }
      }
    }
  }

  function handleBack(){
    const cur=curPin();if(!cur.length)return;
    setCurPin(cur.slice(0,-1));updateCells(curPin());msgEl.textContent='';
  }

  // Circular numpad
  const padWrap=div({style:{display:'flex',flexDirection:'column',gap:16,alignItems:'center',marginTop:8}});
  [['1','2','3'],['4','5','6'],['7','8','9'],['','0','⌫']].forEach(row=>{
    const rowEl=div({style:{display:'flex',gap:16}});
    row.forEach(k=>{
      if(k===''){rowEl.appendChild(div({className:'numkey empty-key'}));return;}
      const key=div({className:'numkey'+(k==='⌫'?' back-key':'')});
      key.textContent=k==='⌫'?'⌫':k;
      // press visual feedback
      key.addEventListener('pointerdown',()=>key.classList.add('pressed'));
      key.addEventListener('pointerup',  ()=>{key.classList.remove('pressed');k==='⌫'?handleBack():handleDigit(k);});
      key.addEventListener('pointerleave',()=>key.classList.remove('pressed'));
      rowEl.appendChild(key);
    });
    padWrap.appendChild(rowEl);
  });
  wrap.appendChild(padWrap);

  // Face ID, when set up: asked once as the screen opens. A tap on the button
  // asks again — needed when Safari will not prompt without one. A cancel or a
  // failure only says so; the PIN pad never stops working.
  if(!isSetup&&faceIdOn()){
    const tryFaceId=()=>{
      if(faceIdBusy||state.loggedIn)return;
      faceIdVerify().then(yes=>{
        if(state.loggedIn)return;
        if(yes){updateCells('0'.repeat(PIN_LENGTH),'success');setTimeout(()=>{state.loggedIn=true;render();},300);}
        else{msgEl.style.color='var(--muted)';msgEl.textContent='Face ID did not unlock — enter your PIN';}
      });
    };
    wrap.appendChild(btn({'data-faceid-unlock':'1',style:{marginTop:24,display:'flex',alignItems:'center',gap:8,
      padding:'10px 18px',minHeight:44,borderRadius:22,border:'1.5px solid var(--accent)',background:'transparent',
      color:'var(--accent)',fontSize:14,fontWeight:600},onClick:()=>{msgEl.textContent='';tryFaceId();}},
      ico('face-id',{style:{fontSize:18}}),'Unlock with Face ID'));
    if(faceIdAuto){faceIdAuto=false;setTimeout(tryFaceId,250);}
  }
  if(!isSetup){
    wrap.appendChild(div({style:{marginTop:faceIdOn()?14:32}},
      btn({style:{background:'none',border:'none',color:'var(--muted)',fontSize:13,cursor:'pointer',textDecoration:'underline'},
        onClick:()=>{if(confirm('Reset PIN? You will need to create a new one.')){faceIdCancel();faceIdSet('');state.auth=null;state.loggedIn=false;saveAuth(null);renderLoginScreen();}}
      },'Forgot / Reset PIN')
    ));
  }
  app.appendChild(wrap);
}

// ─── Prop filter chips ────────────────────────────────────────────────────────
function propFilterChips(){
  const{data,filterProp}=state;
  if(data.properties.length<2)return null;
  const row=div({style:{display:'flex',gap:6,marginTop:10,overflowX:'auto',paddingBottom:2,scrollbarWidth:'none'}});
  const chip=(id,label)=>btn({style:{padding:'5px 14px',borderRadius:20,whiteSpace:'nowrap',border:`1.5px solid ${filterProp===id?'var(--accent)':'var(--border)'}`,background:filterProp===id?'var(--accent-light)':'var(--white)',color:filterProp===id?'var(--accent)':'var(--muted)',fontSize:13,fontWeight:filterProp===id?600:400},onClick:()=>setState({filterProp:id})},label);
  row.appendChild(chip('all','All Properties'));
  data.properties.forEach(p=>row.appendChild(chip(p.id,p.name)));
  return row;
}

// ─── Header ───────────────────────────────────────────────────────────────────
const CHIP={padding:'6px 11px',minHeight:34,borderRadius:20,border:'1px solid var(--border)',
  background:'var(--surface-2)',color:'var(--text-mid)',fontSize:12.5,fontWeight:600,
  display:'flex',alignItems:'center',gap:4,maxWidth:190,overflow:'hidden',whiteSpace:'nowrap'};

function renderHeader(){
  const{data,filterProp}=state;
  const cur=filterProp==='all'?null:data.properties.find(p=>p.id===filterProp);
  const header=div({style:{background:'var(--white)',borderBottom:'1px solid var(--border)',
    padding:'9px 10px',position:'sticky',top:0,zIndex:100,display:'flex',alignItems:'center',gap:8}});
  header.appendChild(h('div',{className:'display',style:{fontSize:21,paddingLeft:4,flexShrink:0}},'StayLog'));
  if(data.properties.length>0){
    header.appendChild(btn({style:CHIP,onClick:()=>setState({modal:'propPicker'})},
      span({style:{overflow:'hidden',textOverflow:'ellipsis'}},cur?cur.name:'All properties'),
      ico('chevron-down',{style:{fontSize:13,color:'var(--muted)',flexShrink:0}})));
  }
  header.appendChild(div({style:{marginLeft:'auto'}}));
  if(state.tab==='dashboard'){
    const n=inboxUnread();
    header.appendChild(btn({className:'btn-icon','data-bell':String(n),'aria-label':n?`Notifications, ${n} unread`:'Notifications',
      style:{position:'relative'},onClick:()=>setState({modal:'inbox'})},
      ico('bell',{style:{fontSize:19}}),
      n?span({'data-bell-count':'1',style:{position:'absolute',top:2,right:2,minWidth:17,height:17,padding:'0 4px',borderRadius:9,
        background:'var(--danger)',color:'#fff',fontSize:10.5,fontWeight:700,lineHeight:'17px',textAlign:'center'}},n>99?'99+':String(n)):null));
  }
  header.appendChild(btn({className:'btn-icon','aria-label':'Menu',onClick:()=>setState({modal:'menu'})},
    ico('dots-vertical',{style:{fontSize:19}})));
  return header;
}

// ─── Which service worker is running ──────────────────────────────────────────
function swVersion(){
  return new Promise(res=>{
    try{
      const c=navigator.serviceWorker&&navigator.serviceWorker.controller;
      if(!c)return res('');
      const ch=new MessageChannel();
      const t=setTimeout(()=>res('(older, no version reply)'),1500);
      ch.port1.onmessage=e=>{clearTimeout(t);res((e.data&&e.data.cache)||'');};
      c.postMessage({type:'version'},[ch.port2]);
    }catch(e){res('');}
  });
}

// ─── Part-updated? ────────────────────────────────────────────────────────────
// app.js and sw.js are fetched, cached and activated separately, so a phone can
// end up running one release's app with another release's worker. A new worker
// takes over on its own within seconds and the page reloads, so the question is
// asked only after that has had time to happen — otherwise every ordinary
// update would flash the banner.
const SW_CHECK_DELAY=4000;
function checkSwMatch(){
  return swVersion().then(v=>{
    if(!v)return;                     // no worker yet (first visit, private window): nothing to compare
    const was=state.swMismatch;
    state.swMismatch = v===SW_CACHE ? null : v;
    // never repaint the PIN screen under his fingers; the banner waits for the app
    if(state.swMismatch!==was&&state.loggedIn)render();
  });
}
function swBanner(){
  if(!state.swMismatch||state.swBannerHidden)return null;
  const running=state.swMismatch.startsWith('(')?'an older offline cache':`offline cache ${state.swMismatch}`;
  return div({'data-sw-banner':'1',role:'status',style:{display:'flex',alignItems:'center',gap:10,
      margin:'8px 12px 0',padding:'8px 12px',background:'var(--surface-2)',border:'1px solid var(--border)',
      borderRadius:'var(--radius-sm)',fontSize:12.5,color:'var(--text-mid)',lineHeight:1.45}},
    div({style:{flex:1,minWidth:0}},
      `StayLog is part-updated: ${APP_VERSION} is running with ${running}. Close and reopen the app to finish updating.`),
    btn({'aria-label':'Dismiss',style:{background:'none',border:'none',color:'var(--light)',fontSize:18,
      padding:'0 4px',cursor:'pointer',lineHeight:1,flexShrink:0},
      onClick:()=>{state.swBannerHidden=true;render();}},'×'));
}

// ─── Menu + property picker ───────────────────────────────────────────────────
function menuRow(icon,label,sub,onClick,danger){
  return btn({style:{display:'flex',alignItems:'center',gap:12,width:'100%',textAlign:'left',
    padding:'13px 12px',minHeight:52,borderRadius:'var(--radius-sm)',background:'transparent',
    color:danger?'var(--danger)':'var(--text)',fontSize:15,fontWeight:600},onClick},
    div({style:{width:34,height:34,borderRadius:9,background:danger?'var(--danger-light)':'var(--accent-light)',
      display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0}},
      ico(icon,{style:{fontSize:17,color:danger?'var(--danger)':'var(--accent)'}})),
    div({style:{minWidth:0}},div({},label),
      sub?div({style:{fontSize:12,fontWeight:400,color:'var(--muted)',marginTop:1}},sub):null)
  );
}
// ─── Appearance ───────────────────────────────────────────────────────────────
// index.html sets the attribute before the first paint so the app never flashes
// the wrong colour. The working copy lives HERE, though, and does not depend on
// that script existing: index.html and app.js are uploaded separately, and a
// control that silently does nothing because the other file is a version behind
// is worse than no control at all.
const THEME_KEY='staylog_theme';
function getTheme(){
  if(window.getTheme&&window.getTheme!==getTheme){try{return window.getTheme();}catch(e){}}
  try{return localStorage.getItem(THEME_KEY)||'system';}catch(e){return 'system';}
}
function applyTheme(t){
  ensureDarkTokens();
  const root=document.documentElement;
  if(t==='light'||t==='dark')root.setAttribute('data-theme',t);
  else root.removeAttribute('data-theme');
  const dark=t==='dark'||(t==='system'&&window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.querySelectorAll('meta[name="theme-color"]').forEach((m,i)=>{
    if(t==='system'){
      m.setAttribute('media','(prefers-color-scheme: '+(i===0?'light':'dark')+')');
      m.setAttribute('content',i===0?'#F5F1E8':'#16180F');
    }else{
      m.removeAttribute('media');
      m.setAttribute('content',dark?'#16180F':'#F5F1E8');
    }
  });
}
function setTheme(t){
  try{localStorage.setItem(THEME_KEY,t);}catch(e){}
  applyTheme(t);
}
// If the stylesheet in index.html predates the toggle, :root[data-theme="dark"]
// matches nothing and setting the attribute changes no colour. Rather than
// leave a dead button, test for it once and supply the rule if it is missing.
let _darkChecked=false;
function ensureDarkTokens(){
  if(_darkChecked)return; _darkChecked=true;
  const root=document.documentElement, had=root.getAttribute('data-theme');
  const read=()=>getComputedStyle(root).getPropertyValue('--cream').trim().toLowerCase();
  try{
    const light=read();
    root.setAttribute('data-theme','dark');
    const dark=read();
    if(had===null)root.removeAttribute('data-theme'); else root.setAttribute('data-theme',had);
    if(dark&&dark!==light)return;                 // the stylesheet already handles it
  }catch(e){ return; }
  const st=document.createElement('style');
  st.id='staylog-dark-fallback';
  st.textContent=':root[data-theme="dark"]{color-scheme: dark;--cream:       #16180F;--white:       #1E2118;--surface-2:   #23261B;--border:      #2F3324;--border-soft: #262A1E;--text:        #F0ECDF;--text-mid:    #CFCBBB;--muted:       #948F7C;--light:       #7C7768;--accent:      #7CC49A;--accent-hov:  #94D3AD;--accent-light:#20301F;--accent-line: #2C4430;--accent-mid:  #5FA97F;--on-accent:   #14170F;--gold:        #D8AC5B;--gold-light:  #2E2718;--gold-line:   #45391F;--danger:      #E58479;--danger-light:#33201D;--danger-line: #4A2E29;--warn:        #E0A45C;--warn-light:  #2F2718;--warn-line:   #46381F;--info:        #86C9AE;--info-light:  #1D2E28;--shadow: 0 1px 2px rgba(0,0,0,.4), 0 8px 26px rgba(0,0,0,.32);--shadow-sm: 0 1px 2px rgba(0,0,0,.35);--shadow-lift: 0 -6px 30px rgba(0,0,0,.5);--scrim: rgba(0,0,0,.55);}';
  document.head.appendChild(st);
}
const THEMES=[['system','device-mobile','Phone'],['light','sun','Light'],['dark','moon','Dark']];
function themeRow(){
  const cur=getTheme();
  const pill=(value,icon,label)=>{
    const on=cur===value;
    return btn({style:{flex:'1',display:'flex',alignItems:'center',justifyContent:'center',gap:6,
      minHeight:40,borderRadius:8,fontSize:13,fontWeight:on?700:600,
      background:on?'var(--white)':'transparent',
      color:on?'var(--text)':'var(--muted)',
      boxShadow:on?'var(--shadow)':'none',
      border:on?'1px solid var(--border)':'1px solid transparent'},
      onClick:()=>{ setTheme(value); render(); }},
      ico(icon,{style:{fontSize:15,color:on?'var(--accent)':'var(--light)'}}),
      label);
  };
  return div({style:{padding:'10px 12px 4px'}},
    div({className:'kicker',style:{marginBottom:8}},'Appearance'),
    div({style:{display:'flex',gap:4,padding:4,background:'var(--surface-2)',
      border:'1px solid var(--border-soft)',borderRadius:10}},
      ...THEMES.map(t=>pill(t[0],t[1],t[2])))
  );
}

// ─── Notifications ────────────────────────────────────────────────────────────
// Reminders pushed by the notify Edge Function (supabase/functions/notify).
// They are only reminders: nothing in the app depends on one arriving, and
// everything a notification points at is on its card or Home anyway.
//
// iPhone rules (iOS 16.4+): push exists only in the Home Screen app, never in
// a Safari tab, and the permission prompt may only come from a tap. iOS can
// also drop a subscription without saying so, so every open quietly checks it
// and re-saves it to the cloud.
const PUSH_ALERTS=[
  ['attendance','Laxmi marks attendance'],
  ['utensils','Laxmi reports utensil cleaning'],
  ['newBookings','New bookings','From the Airbnb and Booking.com calendars'],
  ['arrivals','Guests arriving tomorrow','9 AM, ready to send the arrival message'],
  ['balances','Balance due at check-out tomorrow','9 AM · Direct and Booking.com only'],
  ['stale','App not synced in 2 days','9 AM'],
  ['backup','No encrypted backup in 3 days','9 AM'],
];
const pushUI={sub:null,checked:false,busy:false,msg:'',msgBad:false,prefs:null,prefsErr:''};
const isIOS=()=>/iPad|iPhone|iPod/.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
const isStandalone=()=>navigator.standalone===true||
  !!(window.matchMedia&&window.matchMedia('(display-mode: standalone)').matches);
const deviceName=()=>/iPad/.test(navigator.userAgent)?'iPad':isIOS()?'iPhone':'this device';
function vapidKeyBytes(){
  const s=String((window.STAYLOG_CLOUD||{}).vapidPublicKey||'').trim();
  if(!s)return null;
  const b=atob(s.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-s.length%4)%4));
  return Uint8Array.from(b,c=>c.charCodeAt(0));
}
// A Home Screen app is resumed, not reloaded, so the cloud-config.js it
// loaded can predate the key being added. When the key is blank, read the
// deployed file once more, straight from the server, and take it from there.
let configKeyCheck=null;
function refreshConfigKey(){
  if((window.STAYLOG_CLOUD||{}).vapidPublicKey)return Promise.resolve(true);
  if(!configKeyCheck)configKeyCheck=fetch('cloud-config.js',{cache:'no-store'})
    .then(r=>r.ok?r.text():'')
    .then(t=>{
      const k=(String(t).match(/vapidPublicKey:\s*['"]([^'"]*)['"]/)||[])[1]||'';
      if(!/^B[A-Za-z0-9_-]{86}$/.test(k)){setTimeout(()=>{configKeyCheck=null;},60000);return false;}
      (window.STAYLOG_CLOUD=window.STAYLOG_CLOUD||{}).vapidPublicKey=k;
      pushUI.checked=false;              // the key is new: check the subscription again
      pushRefresh(); return true;
    }).catch(()=>{setTimeout(()=>{configKeyCheck=null;},60000);return false;});
  return configKeyCheck;
}
// Why notifications cannot be on here, or '' if they can.
function pushBlocker(){
  if(isIOS()&&!isStandalone())return 'safari';
  if(!('serviceWorker' in navigator)||!('PushManager' in window)||!('Notification' in window))return 'unsupported';
  if(!(window.STAYLOG_CLOUD||{}).vapidPublicKey){refreshConfigKey();return 'nokey';}
  const cs=cloudStatus();
  if(!cs.configured||!cs.signedIn)return 'signin';
  if(Notification.permission==='denied')return 'denied';
  return '';
}
const sameKey=(a,b)=>{
  if(!a||!b)return false;
  const x=new Uint8Array(a),y=new Uint8Array(b);
  return x.length===y.length&&x.every((v,i)=>v===y[i]);
};
// The browser's subscription, made if permission is already given. A key
// change (new VAPID pair) means the old subscription can never be sent to.
async function currentSub(make){
  // ready never settles when no worker is running; say so rather than hang.
  const reg=await Promise.race([navigator.serviceWorker.ready,
    new Promise((_,no)=>setTimeout(()=>no(new Error('the app’s service worker is not running — reopen StayLog')),5000))]);
  let sub=await reg.pushManager.getSubscription();
  const key=vapidKeyBytes();
  if(sub&&key&&sub.options&&sub.options.applicationServerKey&&!sameKey(sub.options.applicationServerKey,key)){
    const old=sub.endpoint; await sub.unsubscribe().catch(()=>{}); sub=null;
    window.StayLogCloud.pushRemove(old).catch(()=>{});
  }
  if(!sub&&make)sub=await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:key});
  return sub;
}
function pushRefresh(){ if(state.modal==='menu')render(); }
// Every app open: quiet. Never prompts; only acts if permission was given.
async function resubscribeQuietly(){
  try{
    await refreshConfigKey();
    if(pushBlocker()||Notification.permission!=='granted'){pushUI.checked=true;return;}
    const sub=await currentSub(true);
    pushUI.sub=sub;
    if(sub)await window.StayLogCloud.pushSave(sub.toJSON(),deviceName());
  }catch(e){ /* a reminder that cannot be armed is reported in the menu, not here */ }
  pushUI.checked=true; pushRefresh();
}
// From the button. requestPermission is the first thing the tap does: iOS
// only shows the prompt when it comes straight from a user gesture.
function turnOnPush(){
  const ask=Notification.permission==='granted'?Promise.resolve('granted'):Notification.requestPermission();
  pushUI.busy=true; pushUI.msg=''; pushRefresh();
  return Promise.resolve(ask).then(async perm=>{
    if(perm!=='granted'){pushUI.msg=perm==='denied'?'':'Not turned on — the iPhone asked and it was not allowed.';pushUI.msgBad=true;return;}
    const sub=await currentSub(true);
    await window.StayLogCloud.pushSave(sub.toJSON(),deviceName());
    pushUI.sub=sub; pushUI.msg='On. Tap Send test to check one arrives.'; pushUI.msgBad=false;
  }).catch(e=>{pushUI.msg='Could not turn on: '+(e.message||e);pushUI.msgBad=true;})
    .finally(()=>{pushUI.busy=false;pushUI.checked=true;pushRefresh();});
}
async function turnOffPush(){
  pushUI.busy=true; pushRefresh();
  try{
    const sub=pushUI.sub||await currentSub(false);
    if(sub){const ep=sub.endpoint;await sub.unsubscribe();await window.StayLogCloud.pushRemove(ep);}
    pushUI.sub=null; pushUI.msg=`Off for this ${deviceName()}.`; pushUI.msgBad=false;
  }catch(e){pushUI.msg='Could not turn off: '+(e.message||e);pushUI.msgBad=true;}
  pushUI.busy=false; pushRefresh();
}
async function sendTestPush(){
  pushUI.busy=true; pushUI.msg='Sending…'; pushUI.msgBad=false; pushRefresh();
  try{
    const r=await window.StayLogCloud.pushTest();
    if(r.sent)pushUI.msg=`Sent to ${r.sent} device${r.sent===1?'':'s'} — it should arrive in a few seconds.`;
    else{pushUI.msg=r.gone?'Apple says this subscription has ended. Tap Turn on notifications again.':'No device is registered in the cloud yet. Tap Turn on notifications.';pushUI.msgBad=true;}
  }catch(e){pushUI.msg='Test not sent: '+(e.message||e);pushUI.msgBad=true;}
  pushUI.busy=false; pushRefresh();
}
function loadPushPrefs(){
  if(pushUI.prefs||pushUI._loading)return;
  pushUI._loading=true;
  window.StayLogCloud.pushPrefs()
    .then(p=>{pushUI.prefs=Object.fromEntries(PUSH_ALERTS.map(([k])=>[k,p[k]!==false]));pushUI.prefsErr='';})
    .catch(e=>{pushUI.prefsErr=e.message||String(e);})
    .finally(()=>{pushUI._loading=false;pushRefresh();});
}
function togglePushPref(k){
  const was=pushUI.prefs, next={...was,[k]:!was[k]};
  pushUI.prefs=next; pushRefresh();
  window.StayLogCloud.savePushPrefs(next)
    .catch(e=>{pushUI.prefs=was;pushUI.prefsErr='Not saved: '+(e.message||e);pushRefresh();});
}
function notificationsSection(){
  const why=pushBlocker();
  if(!why&&!pushUI.checked&&!pushUI._checking){pushUI._checking=true;resubscribeQuietly().finally(()=>{pushUI._checking=false;});}
  const on=!why&&Notification.permission==='granted'&&!!pushUI.sub;
  const dev=deviceName();
  const status=on?`On for this ${dev}`:
    why==='safari'?'Not available in a Safari tab':
    why==='unsupported'?(isIOS()?'Needs iOS 16.4 or later':'This browser cannot receive notifications'):
    why==='nokey'?'Not set up yet — no public key in cloud-config.js':
    why==='signin'?'Sign in to Cloud sync first — reminders are sent from the cloud':
    why==='denied'?`Blocked for StayLog in the ${dev}’s Settings`:
    !pushUI.checked?'Checking…':`Off for this ${dev}`;
  const wrap=div({'data-push':'1',style:{padding:'10px 12px 4px'}},
    div({className:'kicker',style:{marginBottom:6}},'Notifications'),
    div({'data-push-status':'1',style:{display:'flex',alignItems:'center',gap:7,fontSize:13.5,fontWeight:600,
      color:on?'var(--accent)':'var(--text-mid)'}},
      ico(on?'bell-ringing':'bell-off',{style:{fontSize:16}}),status));
  const note=t=>wrap.appendChild(div({style:{fontSize:12,color:'var(--muted)',lineHeight:1.5,marginTop:6}},t));
  if(why==='safari')note('iPhone only sends notifications to StayLog opened from the Home Screen. In Safari tap Share (the square with an arrow), then Add to Home Screen. Open StayLog from that new icon and come back to this menu.');
  if(why==='nokey')note('If you have just added it: the deployed file was checked too and had none yet. GitHub Pages takes a minute or two after a commit; close StayLog fully and open it again.');
  if(why==='denied')note(`Open Settings → Notifications → StayLog and allow notifications, then come back here.`);
  const row=div({style:{display:'flex',gap:8,marginTop:10}});
  const b=(label,onClick,attr,primary)=>btn({...attr,disabled:pushUI.busy,className:primary?'btn-primary btn-sm':'btn-ghost btn-sm',
    style:{flex:'1',minHeight:40},onClick},label);
  if(!why&&!on)row.appendChild(b('Turn on notifications',turnOnPush,{'data-push-on':'1'},true));
  if(on){
    row.appendChild(b('Send test',sendTestPush,{'data-push-test':'1'},true));
    row.appendChild(b('Turn off',turnOffPush,{'data-push-off':'1'}));
  }
  if(row.childNodes.length)wrap.appendChild(row);
  if(pushUI.msg)wrap.appendChild(div({'data-push-msg':'1',style:{fontSize:12,marginTop:6,lineHeight:1.5,
    color:pushUI.msgBad?'var(--danger)':'var(--muted)'}},pushUI.msg));
  if(on){
    loadPushPrefs();
    if(pushUI.prefsErr)note(pushUI.prefsErr);
    const p=pushUI.prefs;
    if(p)PUSH_ALERTS.forEach(([k,label,sub])=>{
      const yes=p[k]!==false;
      wrap.appendChild(btn({'data-push-pref':k,role:'switch','aria-checked':String(yes),
        style:{display:'flex',alignItems:'center',gap:10,width:'100%',textAlign:'left',padding:'9px 2px',
          background:'transparent',color:'var(--text)',fontSize:13.5,fontWeight:600},onClick:()=>togglePushPref(k)},
        div({style:{flex:1,minWidth:0}},label,
          sub?div({style:{fontSize:11.5,fontWeight:400,color:'var(--muted)',marginTop:1}},sub):null),
        div({style:{width:40,height:24,borderRadius:12,flexShrink:0,position:'relative',
          background:yes?'var(--accent)':'var(--border)',transition:'background .15s'}},
          div({style:{position:'absolute',top:3,left:yes?19:3,width:18,height:18,borderRadius:9,
            background:'var(--white)',boxShadow:'var(--shadow)',transition:'left .15s'}}))));
    });
    note('Reminders only — everything they point at is on Home and on the booking anyway.');
  }
  return wrap;
}

// ─── Opening a booking or screen from a notification ─────────────────────────
// A tap arrives as ./#open=<booking id>&send=arrival|payment, #open=cloud or
// #open=menu — in the address when the app starts, or from the service worker
// when it is already open. It waits behind the PIN.
let pendingOpen=null, privacyToastShown=false;
function parseOpen(hash){
  const q=new URLSearchParams(String(hash||'').replace(/^#/,''));
  const open=q.get('open');
  return open?{open,send:q.get('send')||'',prop:q.get('prop')||'',in:q.get('in')||'',out:q.get('out')||'',n:q.get('n')||''}:null;
}
// "New booking": the stay came in through the calendar import, which only
// becomes a booking on the phone at its next sync. So sync first (the drain
// runs inside it), then open the booking. Not there yet (no signal, or the
// import linked it differently): the bookings list at that check-in date.
const ISO_DAY=/^\d{4}-\d{2}-\d{2}$/;
const findStay=o=>state.data.bookings.find(b=>b.propertyId===o.prop&&b.checkIn===o.in&&b.checkOut===o.out&&b.status!=='cancelled');
async function openStay(o){
  if(!ISO_DAY.test(o.in)||!ISO_DAY.test(o.out)){setState({tab:'bookings',modal:null,editItem:null});return;}
  let b=findStay(o);
  if(!b&&window.StayLogCloud){
    setState({tab:'bookings',bookingFilter:'all',filterProp:'all',modal:null,editItem:null,stayHint:'Fetching the new booking…'});
    try{
      await window.StayLogCloud.checkIn(true);
      for(let i=0;i<60&&window.StayLogCloud.status().pushing;i++)await new Promise(r=>setTimeout(r,250));
    }catch(e){}
    b=findStay(o);
  }
  if(b){setState({tab:'bookings',bookingFilter:'all',filterProp:'all',expandedBooking:b.id,modal:null,editItem:null,stayHint:null});return;}
  setState({tab:'bookings',bookingFilter:'all',filterProp:'all',modal:null,editItem:null,expandedBooking:null,
    stayHint:`The new booking for ${fmtDate(o.in)} is not on this phone yet. It is added at the next sync with a connection.`});
  // The list runs newest check-in first: scroll to where that date falls.
  setTimeout(()=>{const at=[...document.querySelectorAll('[data-checkin]')].find(el=>el.dataset.checkin<=o.in);
    if(at&&at.scrollIntoView)at.scrollIntoView({block:'start'});},60);
}
function takeOpen(hash){
  const o=parseOpen(hash);
  if(!o)return;
  pendingOpen=o;
  try{history.replaceState(null,'',location.pathname+location.search);}catch(e){}
  if(state.loggedIn&&!state._loading)applyPendingOpen();
}
function applyPendingOpen(){
  const o=pendingOpen; pendingOpen=null;
  if(!o)return;
  if(o.n)inboxMarkRead([o.n]);     // the push's own inbox row: tapping the phone's notification reads it
  if(o.open==='menu'||o.open==='cloud'||o.open==='backup'){setState({modal:o.open,editItem:null});return;}
  if(o.open==='stay'){openStay(o);return;}
  const b=state.data.bookings.find(x=>x.id===o.open);
  if(!b){setState({tab:'bookings',modal:null,editItem:null});return;}
  const send=['arrival','payment'].includes(o.send)?o.send:'';
  setState({tab:'bookings',bookingFilter:'all',expandedBooking:b.id,
    modal:send?'sendConfirm':null,editItem:send?b:null,sendFocus:send?{id:b.id,kind:send}:null});
}

// ─── Notification inbox ───────────────────────────────────────────────────────
// Every reminder the notify function sends is kept in push_log (inbox.sql),
// delivered or not, so one missed or cleared on the phone is still here. The
// cloud holds what was said; whether it is done is worked out here, from the
// phone's own data, every time, and never stored. The last list loaded is kept
// in localStorage for offline ("as of …"), with any reads not yet sent.
const INBOX_KEY='staylog_inbox', INBOX_DAYS=30;
const inbox=(()=>{let c=null;try{c=JSON.parse(localStorage.getItem(INBOX_KEY)||'null');}catch(e){c=null;}
  c=c&&typeof c==='object'?c:{};
  return {rows:Array.isArray(c.rows)?c.rows:null,at:c.at||'',pending:Array.isArray(c.pending)?c.pending:[],
    fresh:false,err:'',loading:false,filter:'all',lastTry:0};})();
function inboxSave(){try{localStorage.setItem(INBOX_KEY,JSON.stringify({rows:inbox.rows,at:inbox.at,pending:inbox.pending}));}catch(e){}}
function inboxRows(){
  const since=Date.now()-INBOX_DAYS*86400e3;
  return (inbox.rows||[]).filter(r=>r&&r.title&&Date.parse(r.sent_at)>=since)
    .sort((a,b)=>String(b.sent_at).localeCompare(String(a.sent_at)));
}
const inboxUnread=()=>inboxRows().filter(r=>!r.read_at).length;
// The number on the app icon: the same unread count as the bell.
function inboxBadge(){
  try{
    const n=inboxUnread();
    if(n>0&&navigator.setAppBadge)navigator.setAppBadge(n).catch(()=>{});
    else if(n===0&&navigator.clearAppBadge)navigator.clearAppBadge().catch(()=>{});
  }catch(e){}
}
function inboxRepaint(){if(state.loggedIn&&(state.modal==='inbox'||(!state.modal&&state.tab==='dashboard')))render();}
async function refreshInbox(){
  const C=window.StayLogCloud;
  if(!C||!C.inboxList||!cloudStatus().signedIn||inbox.loading)return;
  inbox.loading=true; inbox.lastTry=Date.now();
  try{
    if(inbox.pending.length){const keys=[...inbox.pending];await C.inboxRead(keys);
      inbox.pending=inbox.pending.filter(k=>!keys.includes(k));}
    const rows=await C.inboxList();
    const local=new Map((inbox.rows||[]).filter(r=>r.read_at).map(r=>[r.key,r.read_at]));
    inbox.rows=rows.map(r=>!r.read_at&&(inbox.pending.includes(r.key)||local.has(r.key))?{...r,read_at:local.get(r.key)||new Date().toISOString()}:r);
    inbox.at=new Date().toISOString(); inbox.fresh=true; inbox.err='';
  }catch(e){inbox.err=(e&&e.message)||String(e);}
  finally{inbox.loading=false;}
  inboxSave(); inboxBadge(); inboxRepaint();
}
// Marks rows read on the phone at once, then in the cloud (read_at only).
// Offline, the keys wait in localStorage and go with the next refresh.
function inboxMarkRead(keys){
  const now=new Date().toISOString();
  const want=keys?new Set(keys):null, hit=[];
  inbox.rows=(inbox.rows||[]).map(r=>{if(r.read_at||(want&&!want.has(r.key)))return r;hit.push(r.key);return {...r,read_at:now};});
  const send=keys?[...new Set(keys)]:hit;
  inbox.pending=[...new Set([...inbox.pending,...send])];
  inboxSave(); inboxBadge();
  const C=window.StayLogCloud;
  // Mark all read asks the cloud for every unread row, not only those listed here.
  if(C&&C.inboxRead&&cloudStatus().signedIn&&(send.length||!keys))
    C.inboxRead(keys?send:null).then(()=>{inbox.pending=inbox.pending.filter(k=>!send.includes(k));inboxSave();},()=>{});
}
// Done, worked out from the phone's data now. null: nothing to do for it.
function inboxDone(r){
  const k=String(r.key||''), D=state.data, at=Date.parse(r.sent_at)||0;
  let m;
  if((m=/^arrival:(.+):(\d{4}-\d{2}-\d{2})$/.exec(k))){
    const b=D.bookings.find(x=>x.id===m[1]);
    return {done:!b||!dueMessages([b]).some(x=>x.kind==='arrival'),label:'Done'};
  }
  if((m=/^balance:(.+):(\d{4}-\d{2}-\d{2})$/.exec(k))){
    const b=D.bookings.find(x=>x.id===m[1]);
    return {done:!b||b.status==='cancelled'||balanceDue(b)===0,label:'Done'};
  }
  if((m=/^mark:(.+)$/.exec(k))){
    const exp=/^att_/.test(m[1])?'wag_'+m[1].slice(4):m[1];
    return {done:D.expenses.some(e=>e.id===exp),label:'Recorded'};
  }
  if(/^stale:/.test(k))return {done:(Date.parse(cloudStatus().lastSync)||0)>at,label:'Cleared'};
  if(/^backup:/.test(k))return {done:(Date.parse(bkStatus().lastAt)||0)>at,label:'Cleared'};
  if((m=/^stay:([^:]*):(\d{4}-\d{2}-\d{2}):(\d{4}-\d{2}-\d{2})$/.exec(k)))
    return {done:!!findStay({prop:m[1],in:m[2],out:m[3]}),label:'Imported'};
  return null;
}
const inboxTime=iso=>new Date(iso).toLocaleTimeString('en-IN',{hour:'numeric',minute:'2-digit'});
function openInboxRow(r){
  inboxMarkRead([r.key]);
  const u=String(r.url||''), i=u.indexOf('#');
  setState({modal:null,editItem:null});
  if(i>=0)takeOpen(u.slice(i));
}
function renderInboxModal(){
  if((!inbox.fresh||Date.now()-Date.parse(inbox.at)>60e3)&&!inbox.loading&&Date.now()-inbox.lastTry>5000)refreshInbox();
  const content=()=>{
    const wrap=div({'data-inbox':'1',style:{display:'flex',flexDirection:'column',gap:10}});
    const all=inboxRows(), todo=all.filter(r=>{const d=inboxDone(r);return d&&!d.done;});
    const chip=(f,l)=>{const on=inbox.filter===f;
      return btn({'data-inbox-filter':f,style:{padding:'6px 12px',minHeight:34,borderRadius:20,whiteSpace:'nowrap',
        border:`1.5px solid ${on?'var(--accent)':'var(--border)'}`,background:on?'var(--accent-light)':'var(--white)',
        color:on?'var(--accent)':'var(--muted)',fontSize:12.5,fontWeight:on?700:600},
        onClick:()=>{inbox.filter=f;render();}},l);};
    const unread=all.filter(r=>!r.read_at).length;
    wrap.appendChild(div({style:{display:'flex',gap:6,alignItems:'center',flexWrap:'wrap'}},
      chip('all',`All ${all.length}`),chip('todo',`Still to do ${todo.length}`),
      div({style:{marginLeft:'auto'}}),
      btn({'data-inbox-all-read':'1',className:'btn-sm',disabled:!unread,
        style:{background:'none',border:'none',color:unread?'var(--accent)':'var(--light)',fontWeight:700,fontSize:13,padding:'6px 4px'},
        onClick:()=>{inboxMarkRead(null);render();}},'Mark all read')));
    if(inbox.at&&!inbox.fresh)
      wrap.appendChild(div({'data-inbox-asof':'1',style:{fontSize:12,color:'var(--muted)'}},
        `As of ${bkWhen(inbox.at)}${navigator.onLine===false?' · offline':''}`));
    if(inbox.err&&!/not signed in/.test(inbox.err))
      wrap.appendChild(div({style:{fontSize:12.5,color:'var(--warn)',lineHeight:1.5}},`Could not load: ${inbox.err}`));
    if(!cloudStatus().signedIn&&!inbox.rows)
      wrap.appendChild(div({style:{fontSize:13.5,color:'var(--muted)',lineHeight:1.6,padding:'8px 2px'}},
        'Reminders are sent from the cloud. Sign in to Cloud sync to see them here.'));
    const list=inbox.filter==='todo'?todo:all;
    if(inbox.rows&&!list.length)
      wrap.appendChild(div({style:{fontSize:13.5,color:'var(--muted)',padding:'18px 2px',textAlign:'center'}},
        inbox.filter==='todo'?'Nothing still to do.':'No notifications in the last 30 days.'));
    if(!inbox.rows&&inbox.loading)wrap.appendChild(div({style:{fontSize:13,color:'var(--muted)'}},'Loading…'));
    const t=today(), y=addDaysISO(t,-1);
    let group='';
    list.forEach(r=>{
      const day=isoOf(new Date(r.sent_at)), g=day===t?'Today':day===y?'Yesterday':'Earlier';
      if(g!==group){group=g;wrap.appendChild(div({'data-inbox-group':g,style:{fontSize:11.5,fontWeight:700,color:'var(--muted)',
        textTransform:'uppercase',letterSpacing:'.06em',marginTop:6}},g));}
      const d=inboxDone(r), unreadRow=!r.read_at;
      const row=div({'data-inbox-row':r.key,style:{border:'1px solid var(--border)',borderRadius:'var(--radius-sm)',
        background:unreadRow?'var(--accent-light)':'var(--white)',padding:'10px 12px'}});
      row.appendChild(btn({'data-inbox-open':r.key,style:{display:'block',width:'100%',textAlign:'left',background:'none',border:'none',
        padding:0,color:'var(--text)'},onClick:()=>openInboxRow(r)},
        div({style:{display:'flex',gap:8,alignItems:'baseline'}},
          div({style:{fontSize:14.5,fontWeight:unreadRow?700:600,flex:1,minWidth:0}},r.title),
          div({style:{fontSize:11.5,color:'var(--muted)',flexShrink:0}},g==='Earlier'?`${fmtDate(day)}, ${inboxTime(r.sent_at)}`:inboxTime(r.sent_at))),
        r.body?div({style:{fontSize:13,color:'var(--text-mid)',marginTop:2,lineHeight:1.45}},r.body):null,
        d?div({'data-inbox-state':d.done?d.label:'todo',style:{fontSize:11.5,fontWeight:700,marginTop:5,
          color:d.done?'var(--accent)':'var(--warn)'}},d.done?`✓ ${d.label}`:'Still to do'):null));
      if(r.delivered===false)
        row.appendChild(btn({'data-inbox-undelivered':'1',style:{display:'block',background:'none',border:'none',padding:'6px 0 0',
          textAlign:'left',fontSize:12.5,color:'var(--warn)',fontWeight:600},
          onClick:()=>{setState({modal:'menu'});setTimeout(()=>{const el=document.querySelector('[data-push]');
            if(el&&el.scrollIntoView)el.scrollIntoView({block:'center'});},80);}},
          'Not delivered — turn notifications on again?'));
      wrap.appendChild(row);
    });
    return wrap;
  };
  return modal('Notifications',content);
}

function renderMenuModal(){
  const{data}=state;
  const content=()=>div({style:{display:'flex',flexDirection:'column',gap:2}},
    menuRow('plus','Add property','Rooms, base tariff and location',()=>setState({modal:'addProp',editItem:null})),
    // The only backup there is: encrypted on this phone (backup.js). There is no
    // plain export — a readable file would carry guest names, phone and ID numbers.
    menuRow('lock','Encrypted backup',bkSubtitle(),openBackupPanel),
    menuRow('cloud','Cloud sync',cloudMenuSub(),()=>setState({modal:'cloud'})),
    menuRow('notes','House notes PDF','The instructions guests get after check-in',()=>{
      downloadHouseNotes(data.properties.find(p=>p.id===state.filterProp)||data.properties[0]);closeModal();}),
    notificationsSection(),
    themeRow(),
    div({style:{height:6}}),
    faceIdAvail&&state.auth?menuRow('face-id','Unlock with Face ID',faceIdId()?'On · the PIN still works':'Off · uses this iPhone’s Face ID',
      ()=>setState({modal:'faceId'})):null,
    menuRow('lock','Lock app','Ask for the PIN again',lockApp,true),
    div({style:{textAlign:'center',fontSize:11.5,color:'var(--muted)',padding:'14px 0 2px',
      borderTop:'1px solid var(--border-soft)',marginTop:6}},
      `StayLog ${APP_VERSION} · built ${APP_BUILT}`,
      // Asks the service worker which version is actually running. app.js and
      // sw.js are uploaded separately, and the worker is what decides whether
      // the app sees live data — so it is the one worth seeing on screen.
      (()=>{const el=div({style:{fontSize:10.5,color:'var(--light)',marginTop:3}},'Checking offline cache…');
        swVersion().then(v=>{el.textContent=v?`Offline cache ${v}`:'Offline cache not active';});
        return el;})())
  );
  return modal('StayLog',content);
}
function renderPropPickerModal(){
  const{data,filterProp}=state;
  const row=(id,name,sub)=>{
    const on=filterProp===id;
    return btn({style:{display:'flex',alignItems:'center',justifyContent:'space-between',gap:10,width:'100%',
      textAlign:'left',padding:'13px 14px',minHeight:54,borderRadius:'var(--radius-sm)',
      background:on?'var(--accent-light)':'transparent',color:on?'var(--accent)':'var(--text)',
      fontSize:15,fontWeight:on?700:600},onClick:()=>{state.filterProp=id;closeModal();}},
      div({style:{minWidth:0}},div({},name),
        sub?div({style:{fontSize:12,fontWeight:400,color:'var(--muted)',marginTop:1}},sub):null),
      on?ico('check',{style:{fontSize:18,flexShrink:0}}):null);
  };
  const content=()=>{
    const wrap=div({style:{display:'flex',flexDirection:'column',gap:2}});
    wrap.appendChild(row('all','All properties',`${data.properties.length} in total`));
    data.properties.forEach(p=>{
      const n=data.bookings.filter(b=>b.propertyId===p.id&&b.status!=='cancelled').length;
      const line=div({style:{display:'flex',alignItems:'center',gap:4}});
      const r=row(p.id,p.name,`${p.location||'No location'} · ${n} booking${n===1?'':'s'}`);
      r.style.flex='1';
      line.appendChild(r);
      line.appendChild(btn({className:'btn-icon','aria-label':`Edit ${p.name}`,
        onClick:()=>setState({modal:'addProp',editItem:p})},ico('edit',{style:{fontSize:16}})));
      wrap.appendChild(line);
    });
    wrap.appendChild(div({style:{height:1,background:'var(--border-soft)',margin:'6px 0'}}));
    wrap.appendChild(menuRow('plus','Add property','',()=>setState({modal:'addProp',editItem:null})));
    return wrap;
  };
  return modal('Property',content);
}

// ─── Bottom Nav ───────────────────────────────────────────────────────────────
function renderNav(){
  const tabs=[['dashboard','home','Home'],['bookings','calendar','Bookings'],
    ['expenses','receipt','Expenses'],['loans','wallet','Loans'],['reports','chart-bar','Reports']];
  const nav=div({style:{position:'fixed',bottom:0,left:'50%',transform:'translateX(-50%)',width:'100%',
    maxWidth:480,background:'var(--white)',borderTop:'1px solid var(--border)',display:'flex',gap:3,
    zIndex:100,padding:'6px 8px calc(env(safe-area-inset-bottom, 0px) + 8px)'}});
  tabs.forEach(([t,icon,label])=>{
    const active=state.tab===t||(t==='bookings'&&state.tab==='calendar');
    nav.appendChild(btn({style:{flex:1,minWidth:0,minHeight:50,padding:'7px 2px 5px',borderRadius:'var(--radius-sm)',
      background:active?'var(--accent-light)':'transparent',color:active?'var(--accent)':'var(--muted)',
      fontSize:9.5,fontWeight:active?700:600,letterSpacing:'.01em',display:'flex',flexDirection:'column',
      alignItems:'center',gap:3},onClick:()=>setState({tab:t})},
      ico(icon,{style:{fontSize:20}}),span({style:{overflow:'hidden',textOverflow:'ellipsis',maxWidth:'100%'}},label)));
  });
  return nav;
}

// ─── Filter by month ──────────────────────────────────────────────────────────
function filterByMonth(items,dateKey,mf){
  if(!mf)return items;
  return items.filter(x=>{const d=new Date(x[dateKey]+'T00:00:00');return d.getFullYear()===mf.year&&d.getMonth()===mf.month;});
}

// ─── Calendar view ────────────────────────────────────────────────────────────
function renderCalendar(){
  const{data,filterProp,calMonth}=state;
  const{year,month}=calMonth;
  const allBookings=filterProp==='all'?data.bookings:data.bookings.filter(b=>b.propertyId===filterProp);
  const active=allBookings.filter(b=>b.status!=='cancelled');
  const firstDay=new Date(year,month,1).getDay();
  const daysInMonth=new Date(year,month+1,0).getDate();
  const dayMap={};
  for(let d=1;d<=daysInMonth;d++){
    const ds=`${year}-${String(month+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    dayMap[ds]=active.filter(b=>b.checkIn<=ds&&b.checkOut>ds);
  }
  const STATUS_COL={confirmed:'var(--accent-mid)',checkedin:'var(--info)',checkedout:'var(--light)'};
  const wrap=div({style:{padding:'14px 12px 100px'}});
  wrap.appendChild(div({style:{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:14}},
    h('div',{style:{fontFamily:'var(--display)',fontSize:20}},'Calendar'),
    div({style:{display:'flex',alignItems:'center',gap:8}},
      btn({style:{background:'none',border:'none',fontSize:22,cursor:'pointer',color:'var(--muted)',padding:'4px 8px'},onClick:()=>{let{year:y,month:m}=calMonth;m--;if(m<0){m=11;y--;}setState({calMonth:{year:y,month:m}});}},'‹'),
      span({style:{fontWeight:600,fontSize:15}},`${MONTH_NAMES[month]} ${year}`),
      btn({style:{background:'none',border:'none',fontSize:22,cursor:'pointer',color:'var(--muted)',padding:'4px 8px'},onClick:()=>{let{year:y,month:m}=calMonth;m++;if(m>11){m=0;y++;}setState({calMonth:{year:y,month:m}});}},'›')
    )
  ));
  const calWrap=div({style:{background:'var(--white)',borderRadius:'var(--radius)',border:'1px solid var(--border)',overflow:'hidden',marginBottom:16}});
  const dayHeader=div({style:{display:'grid',gridTemplateColumns:'repeat(7,1fr)',borderBottom:'1px solid var(--border)'}});
  DAY_SHORT.forEach(d=>dayHeader.appendChild(div({style:{textAlign:'center',padding:'8px 0',fontSize:11,fontWeight:600,color:'var(--muted)',letterSpacing:'0.04em'}},d)));
  calWrap.appendChild(dayHeader);
  const grid=div({style:{display:'grid',gridTemplateColumns:'repeat(7,1fr)'}});
  for(let i=0;i<firstDay;i++)grid.appendChild(div({style:{borderRight:'1px solid var(--border-soft)',borderBottom:'1px solid var(--border-soft)',minHeight:52}}));
  for(let d=1;d<=daysInMonth;d++){
    const ds=`${year}-${String(month+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const bods=dayMap[ds]||[];
    const isToday=ds===today();
    const isLastCol=((firstDay+d-1)%7)===6;
    const cell=div({style:{borderRight:isLastCol?'none':'1px solid var(--border-soft)',borderBottom:'1px solid var(--border-soft)',minHeight:52,padding:'4px',cursor:bods.length>0?'pointer':'default',background:isToday?'var(--accent-light)':'var(--white)',transition:'background .12s'},
      onClick:()=>{if(bods.length>0)setState({modal:'calDay',editItem:{date:ds,bookings:bods}});}
    });
    cell.appendChild(div({style:{fontSize:12,fontWeight:isToday?700:400,marginBottom:3,width:22,height:22,display:'flex',alignItems:'center',justifyContent:'center',borderRadius:'50%',background:isToday?'var(--accent)':'transparent',color:isToday?'var(--on-accent)':'var(--text)'}},String(d)));
    bods.slice(0,2).forEach(b=>{
      const prop=data.properties.find(p=>p.id===b.propertyId);
      cell.appendChild(div({style:{fontSize:9,background:STATUS_COL[b.status]||'var(--accent)',color:'var(--on-accent)',borderRadius:3,padding:'1px 4px',marginBottom:2,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis',maxWidth:'100%'}},b.guestName.split(' ')[0]+(prop?` · ${prop.name.slice(0,6)}`:'')));
    });
    if(bods.length>2)cell.appendChild(div({style:{fontSize:9,color:'var(--muted)',paddingLeft:2}},`+${bods.length-2} more`));
    grid.appendChild(cell);
  }
  const rem=(7-(firstDay+daysInMonth)%7)%7;
  for(let i=0;i<rem;i++)grid.appendChild(div({style:{borderBottom:'1px solid var(--border-soft)',minHeight:52}}));
  calWrap.appendChild(grid);wrap.appendChild(calWrap);
  wrap.appendChild(div({style:{display:'flex',gap:14,fontSize:12,marginBottom:16,flexWrap:'wrap'}},
    ...[['var(--accent)','Confirmed'],['var(--info)','Checked In'],['var(--light)','Checked Out']].map(([c,l])=>
      div({style:{display:'flex',alignItems:'center',gap:5}},div({style:{width:10,height:10,borderRadius:2,background:c}}),l))
  ));
  const monthBks=active.filter(b=>{const d=new Date(b.checkIn+'T00:00:00');return d.getFullYear()===year&&d.getMonth()===month;}).sort((a,b2)=>new Date(a.checkIn)-new Date(b2.checkIn));
  if(monthBks.length>0){
    wrap.appendChild(h('div',{style:{fontFamily:'var(--display)',fontSize:16,marginBottom:10}},`Bookings this month (${monthBks.length})`));
    monthBks.forEach(b=>wrap.appendChild(bookingCard(b)));
  }
  return wrap;
}

// ─── Booking row ──────────────────────────────────────────────────────────────
function dateBlock(iso,tone){
  const d=new Date(iso+'T00:00:00');
  return div({style:{flex:'0 0 40px',textAlign:'center',borderRadius:'var(--radius-sm)',padding:'5px 0',
    background:tone==='accent'?'var(--accent-light)':'var(--surface-2)',
    color:tone==='accent'?'var(--accent)':'var(--text-mid)'}},
    div({className:'num',style:{fontSize:15,fontWeight:700,lineHeight:1.1}},String(d.getDate()).padStart(2,'0')),
    div({style:{fontSize:9,textTransform:'uppercase',letterSpacing:'.07em',fontWeight:600}},MONTH_SHORT[d.getMonth()])
  );
}

// ─── Double bookings ──────────────────────────────────────────────────────────
// Two live stays on one property whose nights overlap (check-out day is free).
// Only stays not yet over: a clash last spring is history, not a problem.
// Worked out once per render, not once per card.
function bookingClashes(bookings){
  const t=today(), out={};
  const live=(bookings||[]).filter(b=>b.status!=='cancelled'&&b.checkIn&&b.checkOut&&b.checkOut>t&&b.propertyId);
  for(let i=0;i<live.length;i++)for(let j=i+1;j<live.length;j++){
    const x=live[i],y=live[j];
    if(x.propertyId===y.propertyId&&x.checkIn<y.checkOut&&y.checkIn<x.checkOut){
      (out[x.id]=out[x.id]||[]).push(y); (out[y.id]=out[y.id]||[]).push(x);
    }
  }
  return out;
}
const clashesFor=b=>(state._clashes||{})[b.id]||[];
// Nights a platform can still sell, from the last calendar check (cloud.js
// coverageGaps). Read once per render; cancelled and past stays never count.
const openGapsFor=b=>b.status==='cancelled'||!(b.checkOut>today())?[]:((state._gaps||{})[b.id]||[]);
const MOVED_SHOWN_DAYS=7;
function movedRecently(b){
  if(!b.icalMoved||!b.icalMovedFrom)return false;
  const [y,m,d]=b.icalMoved.split('-').map(Number);
  return (new Date()-new Date(y,m-1,d))/86400000<MOVED_SHOWN_DAYS;
}
const isImported=b=>/^ics_/.test(String(b.id||''));

function bookingCard(b){   // dense row; expands into the full detail
  const prop=state.data.properties.find(p=>p.id===b.propertyId);
  const nights=diffDays(b.checkIn,b.checkOut);
  const isExpanded=state.expandedBooking===b.id;
  const paid=Number(b.paid||0),total=Number(b.totalAmount||0),due=balanceDue(b);
  const card=div({className:'card','data-checkin':b.checkIn,style:{marginBottom:8,overflow:'hidden'}});

  const row=div({style:{display:'flex',alignItems:'center',gap:11,padding:'10px 12px',cursor:'pointer',
    opacity:b.status==='cancelled'?.6:1},
    onClick:()=>setState({expandedBooking:isExpanded?null:b.id})});
  row.appendChild(dateBlock(b.checkIn,b.status==='checkedin'?'accent':''));
  row.appendChild(div({style:{flex:1,minWidth:0}},
    div({style:{fontSize:13.5,fontWeight:700,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}},b.guestName),
    div({style:{fontSize:11.5,color:'var(--muted)',marginTop:1,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}},
      `${nights} night${nights===1?'':'s'} · ${b.source||'Direct'}${isImported(b)?' · imported':''}${prop&&state.filterProp==='all'?' · '+prop.name:''}`)
  ));
  // An imported stay arrives with no amount; "₹0 paid" would be a false statement.
  const noAmount=isImported(b)&&(b.totalAmount===''||b.totalAmount==null);
  row.appendChild(div({style:{textAlign:'right',flexShrink:0}},
    div({className:'num',style:{fontSize:13.5,fontWeight:700}},noAmount?'—':fmtCur(total)),
    div({style:{fontSize:10,color:noAmount?'var(--gold)':due>0?'var(--warn)':'var(--muted)',fontWeight:600,marginTop:1}},
      b.status==='cancelled'?'cancelled':noAmount?'add amount':due>0?fmtCur(due)+' due':'paid')
  ));
  if(waNumber(b.phone)&&b.status!=='cancelled'){
    const pending=dueMessages([b]).length;
    const sent=pending===0;
    row.appendChild(btn({
      'data-msgbtn':String(pending),
      'aria-label':sent?`Message ${b.guestName}`:`${pending} message${pending>1?'s':''} to send to ${b.guestName}`,
      title:sent?'Nothing outstanding':`${pending} message${pending>1?'s':''} due`,
      style:{flexShrink:0,minWidth:38,minHeight:38,borderRadius:'50%',display:'flex',alignItems:'center',
        justifyContent:'center',border:`1.5px solid ${sent?'var(--border)':'var(--accent)'}`,
        background:sent?'transparent':'var(--accent-light)',color:sent?'var(--light)':'var(--accent)'},
      onClick:e=>{e.stopPropagation();setState({modal:'sendConfirm',editItem:b});}},
      ico('brand-whatsapp',{style:{fontSize:17}})));
  }
  card.appendChild(row);

  // Shown folded or not: these are the reasons to open the card.
  const clashes=b.status==='cancelled'?[]:clashesFor(b);
  const warn=(color,bg,icon,text,attr)=>div({[attr]:'1',style:{display:'flex',alignItems:'center',gap:7,
    padding:'6px 12px',fontSize:12,fontWeight:600,color,background:bg,borderTop:'1px solid var(--border-soft)'}},
    ico(icon,{style:{fontSize:14,flexShrink:0}}),div({},text));
  clashes.forEach(o=>card.appendChild(warn('var(--danger)','var(--danger-light)','alert-triangle',
    `Double booking: overlaps ${o.guestName} (${fmtDate(o.checkIn)} → ${fmtDate(o.checkOut)}, ${o.source||'Direct'})`,'data-clash')));
  openGapsFor(b).forEach(g=>card.appendChild(warn('var(--warn)','var(--warn-light)','calendar-exclamation',
    `Still open on ${g.platform}: ${g.open===g.nights?(g.nights===1?'the night':`all ${g.nights} nights`):`${g.open} of ${g.nights} nights`} from ${fmtDate(g.from)} — it could be booked twice. Close the dates there.`,'data-open')));
  if(movedRecently(b)&&b.status!=='cancelled')card.appendChild(warn('var(--info)','var(--info-light)','calendar-event',
    `${b.source} moved this stay on ${fmtDate(b.icalMoved)} (was ${fmtDate(b.icalMovedFrom.checkIn)} → ${fmtDate(b.icalMovedFrom.checkOut)})`,'data-moved'));
  if(b.icalGone&&b.status!=='cancelled')card.appendChild(warn('var(--gold)','var(--gold-light)','calendar-x',
    `No longer on ${b.source} — cancelled? Check, then cancel it here.`,'data-gone'));

  if(isExpanded){
    const detail=div({style:{borderTop:'1px solid var(--border-soft)',padding:'11px 12px 12px',background:'var(--surface-2)'}});
    detail.appendChild(div({style:{display:'flex',alignItems:'center',justifyContent:'space-between',gap:8,marginBottom:9}},
      div({style:{fontSize:12.5,color:'var(--text-mid)',display:'flex',alignItems:'center',gap:6}},
        ico('calendar',{style:{fontSize:14,color:'var(--light)'}}),`${fmtDate(b.checkIn)} → ${fmtDate(b.checkOut)}`),
      badge(b.status)));
    const infoRow=(icon,text)=>text?div({style:{fontSize:12.5,color:'var(--text-mid)',marginBottom:6,display:'flex',alignItems:'center',gap:8}},ico(icon,{style:{fontSize:15,color:'var(--light)'}}),text):null;
    [infoRow('home',prop?.name),
     infoRow('phone',b.phone),
     waNumber(b.phone)&&b.status!=='cancelled'
       ? (()=>{const pend=dueMessages([b]);
           return div({style:{fontSize:12.5,marginBottom:6,display:'flex',alignItems:'center',gap:8,
             color:pend.length?'var(--warn)':'var(--accent)',fontWeight:600}},
             ico(pend.length?'alert-circle':'circle-check',{style:{fontSize:15}}),
             pend.length?`To send: ${pend.map(x=>MSG_META[x.kind].label.toLowerCase()).join(', ')}`
                        :'All messages sent');})()
       : null,
     infoRow('users',b.guests?`${b.guests} guest${b.guests>1?'s':''}`:''),
     infoRow('currency-rupee',paid>0?`Paid ${fmtCur(paid)} · ${due>0?'Due '+fmtCur(due):'fully paid'}`:null)
    ].forEach(r=>r&&detail.appendChild(r));
    if(b.idProofType||b.idProofImage){
      const idRow=div({style:{marginBottom:8}});
      if(b.idProofType||b.idProofNumber){
        idRow.appendChild(div({style:{fontSize:12.5,color:'var(--text-mid)',marginBottom:b.idProofImage?6:0,display:'flex',alignItems:'center',gap:8}},
          ico('id-badge',{style:{fontSize:15,color:'var(--light)'}}),
          `${b.idProofType||'ID'} ${b.idProofNumber?'— '+b.idProofNumber:''}`));
      }
      if(b.idProofImage){
        const imgThumb=h('img',{src:b.idProofImage,style:{width:'100%',maxHeight:160,objectFit:'contain',borderRadius:8,border:'1px solid var(--border)',background:'var(--white)',cursor:'pointer'}});
        imgThumb.addEventListener('click',()=>window.open(b.idProofImage,'_blank'));
        idRow.appendChild(imgThumb);
      }
      detail.appendChild(idRow);
    }
    if(b.notes)detail.appendChild(div({style:{fontSize:12.5,color:'var(--muted)',fontStyle:'italic',margin:'6px 0 10px',lineHeight:1.5,background:'var(--white)',padding:'8px 10px',borderRadius:8,border:'1px solid var(--border)'}},`"${b.notes}"`));
    const actions=div({style:{display:'flex',gap:7,flexWrap:'wrap',marginTop:8}});
    if(b.status==='confirmed')actions.appendChild(btn({className:'btn-primary btn-sm',onClick:()=>updateStatus(b.id,'checkedin')},ico('door-enter',{style:{marginRight:5}}),'Check In'));
    if(b.status==='checkedin')actions.appendChild(btn({className:'btn-primary btn-sm',onClick:()=>updateStatus(b.id,'checkedout')},ico('door-exit',{style:{marginRight:5}}),'Check Out'));
    if(b.status!=='cancelled'&&b.status!=='checkedout')actions.appendChild(btn({className:'btn-ghost btn-sm',onClick:()=>updateStatus(b.id,'cancelled')},'Cancel'));
    actions.appendChild(btn({className:'btn-ghost btn-sm',onClick:()=>setState({modal:'addBooking',editItem:b})},ico('edit',{style:{marginRight:4}}),'Edit'));
    if(waNumber(b.phone))actions.appendChild(btn({className:'btn-ghost btn-sm',style:{color:'var(--accent)',borderColor:'var(--accent-line)'},onClick:()=>setState({modal:'sendConfirm',editItem:b})},ico('brand-whatsapp',{style:{marginRight:4,fontSize:15}}),'Send'));
    actions.appendChild(btn({className:'btn-gold btn-sm',onClick:()=>downloadConfirmation(b)},ico('file-text',{style:{marginRight:4,fontSize:14}}),'PDF'));
    if(canReceipt(b)&&b.status!=='cancelled'&&balanceDue(b)>0)actions.appendChild(btn({className:'btn-primary btn-sm','data-mark-paid':'1',
      onClick:()=>markBookingPaid(b)},ico('circle-check',{style:{marginRight:4,fontSize:14}}),'Mark paid'));
    // Airbnb and the other platforms pay out the full amount themselves.
    if(!paysUsDirectly(b)&&b.status!=='cancelled'&&balanceDue(b)>0)actions.appendChild(btn({className:'btn-primary btn-sm','data-mark-payout':'1',
      onClick:()=>markPayoutReceived(b)},ico('circle-check',{style:{marginRight:4,fontSize:14}}),'Mark payout received'));
    if(canReceipt(b))actions.appendChild(btn({className:'btn-gold btn-sm',onClick:()=>shareReceipt(b)},
      ico('receipt',{style:{marginRight:4,fontSize:14}}),b.receiptNo?'Receipt again':'Receipt'));
    actions.appendChild(btn({className:'btn-danger btn-sm',onClick:()=>{if(confirm('Delete this booking?')){mutateData(d=>d.bookings=d.bookings.filter(x=>x.id!==b.id));setState({expandedBooking:null});}}},ico('trash',{style:{marginRight:4}}),'Delete'));
    detail.appendChild(actions);card.appendChild(detail);
  }
  return card;
}

// ─── Guest Confirmation: PDF + WhatsApp ───────────────────────────────────────
const CHECKIN_TIME='1:00 PM', CHECKOUT_TIME='11:00 AM';
const ID_LABELS={Aadhaar:'Aadhaar Card',Passport:'Passport',DrivingLicense:'Driving Licence',
  VoterID:'Voter ID',PAN:'PAN Card',Other:'ID Proof'};

const HOUSE_RULES=[
  ['Home by 10 PM','Ours is a quiet neighbourhood and the evenings here are wonderfully serene. We kindly ask that everyone is back at the house by 10 PM. It keeps us on good terms with our neighbours and gives you the restful night you deserve after a day of exploring.'],
  ['A home, not a party venue','This house is meant as a calm, intimate retreat. Please keep gatherings to your own group and avoid large get-togethers or loud events. Good conversation and laughter are always welcome — just keep it cosy.'],
  ['A smoke-free home','The entire property, indoors and outdoors, is strictly non-smoking. If you do need a smoke, we kindly ask that you step outside the property gates. Thank you for understanding.'],
  ['Switch off when you step out','When you head out, please turn off the lights, fans and air conditioners. A small habit that makes a real difference — to the environment and to keeping things running smoothly.'],
  ['A clean kitchen is a happy kitchen','The kitchen is yours to use and enjoy. We only ask that utensils, pots, pans and dishes are washed and put back after use, so the space stays ready for your next meal.'],
  ['Shoes off at the door','We follow the lovely tradition of leaving footwear outside the entrance. There is a dedicated spot for shoes right at the door — step in and feel at home.'],
];

// ─── jsPDF, shipped with the app so no CDN is involved ────────────────────────
const JSPDF_SRC='./vendor/jspdf.umd.min.js';
let _jspdfPromise=null;
function loadJsPDF(){
  if(window.jspdf?.jsPDF)return Promise.resolve(window.jspdf.jsPDF);
  if(_jspdfPromise)return _jspdfPromise;
  _jspdfPromise=new Promise((res,rej)=>{
    const s=document.createElement('script');
    s.src=JSPDF_SRC;
    s.onload=()=>window.jspdf?.jsPDF?res(window.jspdf.jsPDF):rej(new Error('jsPDF failed to initialise'));
    s.onerror=()=>{_jspdfPromise=null;rej(new Error('missing'));};
    document.head.appendChild(s);
  });
  return _jspdfPromise;
}

function confirmationFileName(b){
  return `Confirmation-${(b.guestName||'Guest').replace(/[^\w]+/g,'-')}-${b.checkIn}.pdf`;
}

// ─── The confirmation document ────────────────────────────────────────────────
async function buildConfirmationPDF(b){
  const jsPDF=await loadJsPDF();
  const prop=state.data.properties.find(p=>p.id===b.propertyId);
  const nights=diffDays(b.checkIn,b.checkOut);
  const ref='SL-'+b.id.slice(-6).toUpperCase();

  const doc=new jsPDF({unit:'pt',format:'a4'});
  const W=doc.internal.pageSize.getWidth(), H=doc.internal.pageSize.getHeight();
  const M=46, CW=W-M*2;
  const GREEN=[47,107,79], INK=[31,36,32], GREY=[124,120,105], LINE=[231,223,206],
        CREAM=[250,246,238];
  let y=0;

  const ensure=need=>{ if(y+need>H-52){doc.addPage();y=M;} };
  const text=(t,x,size,{font='helvetica',style='normal',color=INK,align='left',width=CW,lead=1.35}={})=>{
    doc.setFont(font,style); doc.setFontSize(size); doc.setTextColor(...color);
    const lines=doc.splitTextToSize(String(t),width);
    lines.forEach(ln=>{ ensure(size*lead); doc.text(ln,x,y,{align}); y+=size*lead; });
  };
  const rule=()=>{ doc.setDrawColor(...LINE); doc.setLineWidth(.7); doc.line(M,y,W-M,y); y+=1; };
  const sectionLabel=t=>{ ensure(96); y+=6;
    doc.setFont('helvetica','bold'); doc.setFontSize(8.5); doc.setTextColor(...GREEN);
    doc.text(String(t).toUpperCase(),M,y,{charSpace:1.1}); y+=7; rule(); y+=13; };

  // Header
  y=M+12;
  doc.setFont('times','normal'); doc.setFontSize(25); doc.setTextColor(...GREEN);
  doc.text(prop?.name||'Raaya Vasyam',W/2,y,{align:'center'}); y+=15;
  doc.setFont('helvetica','normal'); doc.setFontSize(8.5); doc.setTextColor(...GREY);
  doc.text('BOOKING CONFIRMATION',W/2,y,{align:'center',charSpace:1.6}); y+=16;
  rule(); y+=22;

  // Greeting
  doc.setFont('times','normal'); doc.setFontSize(17); doc.setTextColor(...INK);
  doc.text(`Welcome, ${b.guestName}`,M,y); y+=20;
  text(`We are delighted to have you with us at ${prop?.name||'our home'}. Your booking is confirmed and everything is being made ready for your arrival. We hope this stay gives you the chance to slow down, rest well, and take something lovely home with you.`,
    M,10.5,{color:[78,84,73],lead:1.5}); y+=10;

  // Reference pill
  ensure(30);
  doc.setFillColor(...GREEN); doc.roundedRect(M,y-1,150,22,11,11,'F');
  doc.setFont('helvetica','bold'); doc.setFontSize(9); doc.setTextColor(255,253,248);
  doc.text(`BOOKING REF  ${ref}`,M+14,y+13.5,{charSpace:.4}); y+=36;

  // Stay details
  sectionLabel('Your stay at a glance');
  const cell=(label,value,x,w)=>{
    doc.setFillColor(...CREAM); doc.roundedRect(x,y,w,44,7,7,'F');
    doc.setFont('helvetica','bold'); doc.setFontSize(7.5); doc.setTextColor(...GREY);
    doc.text(String(label).toUpperCase(),x+12,y+15,{charSpace:.7});
    doc.setFont('helvetica','bold'); doc.setFontSize(11); doc.setTextColor(...INK);
    doc.text(doc.splitTextToSize(String(value),w-24)[0],x+12,y+32);
  };
  const half=(CW-12)/2;
  const pairs=[
    ['Guest name',b.guestName],['Property',prop?.name||'Our home'],
    ['Check-in',fmtDateLong(b.checkIn)],['Check-out',fmtDateLong(b.checkOut)],
    [`Duration`,`${nights} night${nights===1?'':'s'}`],['Guests',`${b.guests||1} person${(b.guests||1)>1?'s':''}`],
  ];
  if(b.phone)pairs.push(['Contact',b.phone]);
  if(b.idProofType)pairs.push(['ID on record',ID_LABELS[b.idProofType]||b.idProofType]);
  for(let i=0;i<pairs.length;i+=2){
    ensure(56);
    cell(pairs[i][0],pairs[i][1],M,half);
    if(pairs[i+1])cell(pairs[i+1][0],pairs[i+1][1],M+half+12,half);
    y+=56;
  }
  if(prop?.location){ ensure(56); cell('Address',prop.location,M,CW); y+=56; }

  // Arrival / departure banner
  ensure(76); y+=4;
  doc.setFillColor(...GREEN); doc.roundedRect(M,y,CW,62,10,10,'F');
  const block=(label,time,date,cx)=>{
    doc.setFont('helvetica','bold'); doc.setFontSize(7.5); doc.setTextColor(210,230,218);
    doc.text(String(label).toUpperCase(),cx,y+20,{align:'center',charSpace:.9});
    doc.setFont('helvetica','bold'); doc.setFontSize(17); doc.setTextColor(255,253,248);
    doc.text(time,cx,y+41,{align:'center'});
    doc.setFont('helvetica','normal'); doc.setFontSize(8.5); doc.setTextColor(205,226,213);
    doc.text(date,cx,y+53,{align:'center'});
  };
  block('Check-in from',CHECKIN_TIME,fmtDate(b.checkIn),M+CW*0.27);
  block('Check-out by',CHECKOUT_TIME,fmtDate(b.checkOut),M+CW*0.73);
  doc.setDrawColor(120,170,142); doc.setLineWidth(.8); doc.line(M+CW/2,y+14,M+CW/2,y+48);
  y+=78;

  // House notes
  sectionLabel('A few things to keep in mind');
  text('These are simple guidelines that keep the stay comfortable for you, for guests after you, and for our neighbours. We appreciate your thoughtfulness.',
    M,10,{color:[78,84,73],lead:1.5}); y+=12;
  HOUSE_RULES.forEach(([title,desc])=>{
    ensure(58);
    doc.setFillColor(...GREEN); doc.circle(M+3,y-3.5,2.6,'F');
    text(title,M+16,10.5,{style:'bold',color:GREEN,width:CW-16});
    y+=1;
    text(desc,M+16,9.5,{color:[78,84,73],width:CW-16,lead:1.42});
    y+=11;
  });

  // Footer
  ensure(70); y+=8; rule(); y+=18;
  // centred lines anchor on the page centre, not the left margin
  text(`We hope your stay at ${prop?.name||'our home'} is everything you have been looking forward to.`,
    W/2,10.5,{align:'center',color:INK,width:CW});
  y+=2;
  text('With warm regards — your hosts',W/2,10.5,{align:'center',style:'bold',color:GREEN,width:CW});
  y+=6;
  text(`Generated by StayLog on ${new Date().toLocaleDateString('en-IN',{day:'numeric',month:'long',year:'numeric'})}  ·  Ref ${ref}`,
    W/2,8,{align:'center',color:GREY,width:CW});
  return doc;
}

async function confirmationBlob(b){
  const doc=await buildConfirmationPDF(b);
  return doc.output('blob');
}

function pdfError(err){
  alert(err&&err.message==='missing'
    ? 'The PDF builder (vendor/jspdf.umd.min.js) did not load. Make sure the vendor folder was uploaded with the app, then reopen StayLog.'
    : 'Could not build the PDF: '+(err?.message||err));
}

async function downloadConfirmation(b){
  try{ (await buildConfirmationPDF(b)).save(confirmationFileName(b)); }
  catch(err){ pdfError(err); }
}

// ─── Signature ────────────────────────────────────────────────────────────────
// The signature lives in the property record, not in this file. This repository
// is public; a signature committed into it is a signature anybody can lift and
// put on a document of their own. Kept as data it syncs through Supabase, where
// the row-level policies already restrict it to the owner, and it never appears
// in anything that gets uploaded to GitHub.
//
// It is set from Property settings. The receipt falls back to a plain ruled
// line when none is set, so nothing breaks by leaving it empty.
const SIG_MAX_W = 520;          // plenty for 86pt on the page at print density
const SIG_MAX_BYTES = 260000;   // a guard, not a target: a photo would be far larger

// Trims to the ink, drops the paper, and re-inks to a dark blue-black, so a
// photograph of a signature on white paper comes out as a clean transparent
// mark rather than a grey rectangle.
function prepareSignature(file){
  return new Promise((resolve,reject)=>{
    if(!file)return reject(new Error('No file chosen.'));
    if(file.size>8*1024*1024)return reject(new Error('That image is very large. Please use a photo or scan under 8 MB.'));
    const img=new Image();
    const url=URL.createObjectURL(file);
    img.onload=()=>{
      URL.revokeObjectURL(url);
      try{
        const c=document.createElement('canvas');
        c.width=img.naturalWidth; c.height=img.naturalHeight;
        const x=c.getContext('2d');
        x.fillStyle='#fff'; x.fillRect(0,0,c.width,c.height);   // flatten any alpha onto paper
        x.drawImage(img,0,0);
        const px=x.getImageData(0,0,c.width,c.height).data;
        // Find the ink.
        let minX=c.width,minY=c.height,maxX=-1,maxY=-1;
        for(let yy=0;yy<c.height;yy++)for(let xx=0;xx<c.width;xx++){
          const i=(yy*c.width+xx)*4;
          const lum=0.299*px[i]+0.587*px[i+1]+0.114*px[i+2];
          if(lum<200){ if(xx<minX)minX=xx; if(xx>maxX)maxX=xx; if(yy<minY)minY=yy; if(yy>maxY)maxY=yy; }
        }
        if(maxX<0)return reject(new Error('That image looks blank — no dark strokes were found in it.'));
        const pad=4;
        minX=Math.max(0,minX-pad); minY=Math.max(0,minY-pad);
        maxX=Math.min(c.width-1,maxX+pad); maxY=Math.min(c.height-1,maxY+pad);
        const cw=maxX-minX+1, ch=maxY-minY+1;
        const scale=Math.min(1,SIG_MAX_W/cw);
        const out=document.createElement('canvas');
        out.width=Math.max(1,Math.round(cw*scale)); out.height=Math.max(1,Math.round(ch*scale));
        const o=out.getContext('2d');
        o.drawImage(c,minX,minY,cw,ch,0,0,out.width,out.height);
        const d=o.getImageData(0,0,out.width,out.height);
        const q=d.data;
        for(let i=0;i<q.length;i+=4){
          const lum=0.299*q[i]+0.587*q[i+1]+0.114*q[i+2];
          const alpha=Math.max(0,Math.min(1,(235-lum)/235*1.4));
          q[i]=26; q[i+1]=32; q[i+2]=46; q[i+3]=Math.round(alpha*255);
        }
        o.putImageData(d,0,0);
        const uri=out.toDataURL('image/png');
        if(uri.length>SIG_MAX_BYTES)return reject(new Error('That image is too detailed to store. A plain scan on white paper works best.'));
        resolve({uri,ratio:out.height/out.width});
      }catch(err){ reject(new Error('Could not read that image.')); }
    };
    img.onerror=()=>{ URL.revokeObjectURL(url); reject(new Error('That file is not an image this phone can read.')); };
    img.src=url;
  });
}

// ─── Receipt ──────────────────────────────────────────────────────────────────
// Deliberately a RECEIPT and not a tax invoice: no GSTIN, no tax lines, and it
// says so on its face. A guest who files a document showing tax that was never
// charged is the one way this feature could cause real trouble, so the document
// cannot be mistaken for one.
//
// A Booking.com stay gets the same document with "Booked via Booking.com" on
// it. Booking.com guests here pay at the property, exactly like direct guests,
// so the money line reads "Amount received" for both.

// Only these two. The guest pays us directly on both — a Booking.com booking
// here is pay-at-property, so the money genuinely passes from guest to us and a
// receipt is the honest document. On the platforms that collect payment
// themselves the guest never paid us, so we have nothing to receipt and the
// button does not appear.
const RECEIPT_SOURCES = new Set(['Direct','Booking.com']);
const bookingSource = b => String(b.source||'').trim();
const canReceipt = b => RECEIPT_SOURCES.has(bookingSource(b));

// ─── Who pays us, and what they still owe ─────────────────────────────────────
// The one rule for anything about money in a guest message. Direct and
// Booking.com guests pay us at the property; the guest messages were first
// written assuming Booking.com collects payment and that its guests are never
// told they owe money — that was wrong here, and it is gone. Airbnb and the
// other platforms take payment themselves: their guests are never told a
// balance and never sent payment details. A booking with no source is direct.
const paysUsDirectly = b => RECEIPT_SOURCES.has(bookingSource(b)||'Direct');
// ─── The money rule ───────────────────────────────────────────────────────────
// Round off, for guests who pay us directly: signed rupees settled without
// being paid. Positive = what we let go (₹4,632.47 billed, ₹4,630 taken),
// negative = what the guest paid over (₹4,995 billed, ₹5,000 taken). A
// difference of up to ROUND_OFF_LIMIT either way is filled in automatically;
// above it, it is a real balance. Airbnb and the rest collect payment
// themselves: their round off is always 0.
const ROUND_OFF_LIMIT = 5;
const r2 = n => Math.round(Number(n)*100)/100;
const roundOffOf = b => paysUsDirectly(b) ? (Number(b.roundOff)||0) : 0;
// The round off for this total and payment, or null when the gap is a balance.
const autoRoundOff = (total,received) => { const gap=r2(Number(total||0)-Number(received||0));
  return Math.abs(gap) <= ROUND_OFF_LIMIT ? gap : null; };
// What a stay earns: the total, less what we let go (plus what was paid over).
const bookingRevenue = b => r2(Number(b.totalAmount||0) - roundOffOf(b));
const sumRevenue = list => r2(list.reduce((s,b)=>s+bookingRevenue(b),0));
// THE balance of a booking; every balance shown, stamped, exported or asked
// for comes from here: total − paid − round off. Under ₹1 still counts as
// fully paid, a safety net for bookings made before round off existed.
// Stored amounts are never rounded; a real balance keeps its paise (₹250.50).
// supabase/functions/notify/index.ts has the same formula for its 9 AM alert.
const PAID_UNDER = 1;
const balanceDue = b => {
  const d = r2(Number(b.totalAmount||0)-Number(b.paid||0)-roundOffOf(b));
  return d < PAID_UNDER ? 0 : d;
};
// What cloud.js mirrors for the checkout-tomorrow alert instead of the amounts:
// the balance, by this rule, for guests who pay us; nothing for the rest.
window.STAYLOG_BALANCE_DUE = b => paysUsDirectly(b) ? balanceDue(b) : null;
// Payment details go out only when all of these hold: the guest pays us, the
// booking is live, something is actually owed, and there is something to send.
const hasPaymentDetails = p => !!(p && (p.upiId || p.bankDetails));
function canAskForPayment(b){
  const prop=state.data.properties.find(p=>p.id===b.propertyId);
  return paysUsDirectly(b) && b.status!=='cancelled' && balanceDue(b)>0 && hasPaymentDetails(prop);
}
// The block every payment message carries. The UPI ID sits alone on its own
// line, unformatted, so a long-press copies exactly the ID and nothing else.
function paymentBlock(b){
  if(!canAskForPayment(b))return [];
  const prop=state.data.properties.find(p=>p.id===b.propertyId);
  const L=[`*Balance due:* ${fmtCur(balanceDue(b))}`];
  if(prop.upiId){
    L.push('','*Pay by UPI* to this ID:',prop.upiId);
    if(prop.upiPayee)L.push(`Payee name: ${prop.upiPayee}`);
    if(prop.upiQr)L.push('A QR code to scan follows in the next message.');
  }
  if(prop.bankDetails)L.push('',prop.upiId?'*Or by bank transfer:*':'*Pay by bank transfer:*',String(prop.bankDetails).trim());
  return L;
}
// A message just for this, sent from the Send sheet whenever it is needed.
function paymentRequestText(b){
  if(!canAskForPayment(b))return null;
  const prop=state.data.properties.find(p=>p.id===b.propertyId);
  const L=[`*Payment for your stay — ${prop?.name||'our homestay'}*`,''];
  L.push(`Namaste ${firstNameOf(b)}, here are the details to settle the balance for your stay (${fmtDate(b.checkIn)} → ${fmtDate(b.checkOut)}).`,'');
  L.push(...paymentBlock(b));
  L.push('','Once it is done, just reply here and I will send your receipt. Thank you!');
  return L.join('\n');
}
const bookedVia = b => bookingSource(b)==='Direct' ? '' : bookingSource(b);

// Indian financial year, April to March: 4 Oct 2026 falls in 2026-27.
function financialYear(iso){
  const d=new Date(String(iso)+'T00:00:00');
  if(isNaN(d))return 'unknown';
  const start = d.getMonth()>=3 ? d.getFullYear() : d.getFullYear()-1;
  return `${start}-${String((start+1)%100).padStart(2,'0')}`;
}
function receiptPrefix(prop){
  const initials=String(prop?.name||'').split(/\s+/).filter(Boolean)
    .map(w=>w[0]).join('').replace(/[^A-Za-z]/g,'').toUpperCase().slice(0,3);
  return initials||'RV';
}
// Sequential within the financial year, and never reused: the highest number
// already issued decides the next one, so deleting a booking leaves a gap
// rather than handing its number to somebody else.
function nextReceiptNo(d,prop,iso){
  const fy=financialYear(iso), px=receiptPrefix(prop);
  const used=(d.bookings||[]).map(x=>x.receiptNo).filter(Boolean)
    .filter(n=>String(n).indexOf('/'+fy+'/')>=0)
    .map(n=>parseInt(String(n).split('/').pop(),10))
    .filter(n=>!isNaN(n));
  return `${px}/${fy}/${String((used.length?Math.max(...used):0)+1).padStart(3,'0')}`;
}
// Assigned once, on first issue, and stored on the booking. Re-sending the
// same stay must hand the guest the same number as the first time.
function ensureReceiptNo(b){
  if(b.receiptNo)return b.receiptNo;
  const iso=today();
  const prop=state.data.properties.find(p=>p.id===b.propertyId);
  let no=null;
  mutateData(d=>{
    const row=(d.bookings||[]).find(x=>x.id===b.id);
    if(row&&row.receiptNo){no=row.receiptNo;return;}
    no=nextReceiptNo(d,prop,iso);
    if(row){row.receiptNo=no;row.receiptOn=iso;}
  });
  if(no){b.receiptNo=no;b.receiptOn=b.receiptOn||iso;}
  return no;
}

// jsPDF's built-in fonts are WinAnsi encoded and have no rupee glyph, so a
// bare ₹ comes out as a blank box. Spelled out instead.
const fmtCurPdf=n=>'Rs. '+Number(n||0).toLocaleString('en-IN',moneyDigits(n||0));

// Which stamp a booking earns. Kept out of the PDF builder so it can be
// checked directly: rotated, letter-spaced text does not survive extraction
// from a PDF reliably enough to assert on.
const STAMP_INK={green:[47,107,79],deep:[32,74,55],gold:[168,118,44],red:[166,58,52]};
function receiptStamp(b){
  const total=round2(b.totalAmount), paid=round2(b.paid), due=balanceDue(b);
  if(total>0&&due===0)        return {line:'PAID',      sub:'with thanks',            tone:'green'};
  if(paid>0)                  return {line:'PART PAID', sub:fmtCurPdf(due)+' due',    tone:'gold'};
  return                             {line:'UNPAID',    sub:'balance due',            tone:'red'};
}

function receiptFileName(b){
  return `Receipt-${(b.guestName||'Guest').replace(/[^\w]+/g,'-')}-${b.checkIn}.pdf`;
}

async function buildReceiptPDF(b){
  const jsPDF=await loadJsPDF();
  const prop=state.data.properties.find(p=>p.id===b.propertyId);
  const nights=diffDays(b.checkIn,b.checkOut);
  const total=round2(b.totalAmount), paid=round2(b.paid), due=balanceDue(b);
  const via=bookedVia(b);
  const no=ensureReceiptNo(b)||'—';
  const issued=b.receiptOn||today();

  const doc=new jsPDF({unit:'pt',format:'a4'});
  const W=doc.internal.pageSize.getWidth(), H=doc.internal.pageSize.getHeight();
  const M=58, CW=W-M*2;
  const GREEN=[47,107,79], DEEP=[32,74,55], INK=[31,36,32], GREY=[124,120,105],
        LINE=[223,213,192], CREAM=[250,246,238], GOLD=[168,118,44], RED=[166,58,52];

  // ── Page furniture ─────────────────────────────────────────────────────────
  // A double hairline frame, the outer one heavier. It costs two draw calls and
  // is most of what separates a printed document from a screenshot of one.
  doc.setDrawColor(...LINE); doc.setLineWidth(1.1);
  doc.rect(26,26,W-52,H-52);
  doc.setLineWidth(.4);
  doc.rect(31,31,W-62,H-62);

  let y=0;
  const text=(t,x,size,{font='helvetica',style='normal',color=INK,align='left',width=CW,lead=1.35,space=0}={})=>{
    doc.setFont(font,style); doc.setFontSize(size); doc.setTextColor(...color);
    doc.splitTextToSize(String(t),width).forEach(ln=>{ doc.text(ln,x,y,{align,charSpace:space}); y+=size*lead; });
  };
  // Label above a rule, the rule running the full width — the spine of the layout.
  const sectionLabel=(t,color=GREEN)=>{
    doc.setFont('helvetica','bold'); doc.setFontSize(7.5); doc.setTextColor(...color);
    doc.text(String(t).toUpperCase(),M,y,{charSpace:1.4}); y+=6;
    doc.setDrawColor(...LINE); doc.setLineWidth(.6); doc.line(M,y,W-M,y); y+=15;
  };

  // ── Masthead ───────────────────────────────────────────────────────────────
  y=M+6;
  doc.setFont('times','normal'); doc.setFontSize(29); doc.setTextColor(...DEEP);
  doc.text(prop?.name||'Raaya Vasyam',W/2,y,{align:'center'});
  y+=13;
  if(prop?.location){
    doc.setFont('helvetica','normal'); doc.setFontSize(8); doc.setTextColor(...GREY);
    doc.text(prop.location,W/2,y,{align:'center',charSpace:.5}); y+=15;
  } else y+=6;

  // "RECEIPT" set between two rules, the way a letterhead would do it.
  const word='RECEIPT', wSize=10.5;
  doc.setFont('helvetica','bold'); doc.setFontSize(wSize);
  const halfWord=doc.getTextWidth(word)/2 + word.length*1.5;
  doc.setDrawColor(...GREEN); doc.setLineWidth(.8);
  doc.line(M,y-3.5,W/2-halfWord-14,y-3.5);
  doc.line(W/2+halfWord+14,y-3.5,W-M,y-3.5);
  doc.setTextColor(...GREEN);
  doc.text(word,W/2,y,{align:'center',charSpace:3});
  y+=24;

  // ── Reference strip ────────────────────────────────────────────────────────
  doc.setFillColor(...CREAM); doc.roundedRect(M,y,CW,46,6,6,'F');
  doc.setFont('helvetica','bold'); doc.setFontSize(7); doc.setTextColor(...GREY);
  doc.text('RECEIPT NO.',M+16,y+17,{charSpace:1});
  doc.text('DATE OF ISSUE',W-M-16,y+17,{align:'right',charSpace:1});
  doc.setFont('helvetica','bold'); doc.setFontSize(12.5); doc.setTextColor(...INK);
  doc.text(String(no),M+16,y+34);
  doc.setFont('helvetica','normal');
  doc.text(fmtDateLong(issued),W-M-16,y+34,{align:'right'});
  y+=63;

  // ── Who ────────────────────────────────────────────────────────────────────
  sectionLabel('Received with thanks from');
  doc.setFont('times','normal'); doc.setFontSize(19); doc.setTextColor(...INK);
  doc.text(String(b.guestName||'Guest'),M,y); y+=15;
  if(b.phone){ doc.setFont('helvetica','normal'); doc.setFontSize(9.5); doc.setTextColor(...GREY);
    doc.text(String(b.phone),M,y); y+=4; }
  y+=19;

  // ── The stay, as one panel rather than four boxes ──────────────────────────
  sectionLabel('For the stay');
  const panelTop=y;
  const rows=[
    ['Check-in',fmtDateLong(b.checkIn)],
    ['Check-out',fmtDateLong(b.checkOut)],
    ['Duration',`${nights} night${nights===1?'':'s'}`],
    ['Guests',`${b.guests||1} ${(b.guests||1)>1?'guests':'guest'}`],
  ];
  // Where the booking came from, not where the money came from.
  if(via)rows.push(['Booked via',via]);
  const panelH=rows.length*24+14;
  doc.setFillColor(...CREAM); doc.roundedRect(M,panelTop,CW,panelH,6,6,'F');
  let ry=panelTop+22;
  rows.forEach(([k,v],i)=>{
    doc.setFont('helvetica','bold'); doc.setFontSize(7.5); doc.setTextColor(...GREY);
    doc.text(String(k).toUpperCase(),M+16,ry,{charSpace:1});
    doc.setFont('helvetica','normal'); doc.setFontSize(10.5); doc.setTextColor(...INK);
    doc.text(String(v),W-M-16,ry,{align:'right'});
    if(i<rows.length-1){ doc.setDrawColor(...LINE); doc.setLineWidth(.4);
      doc.line(M+16,ry+8,W-M-16,ry+8); }
    ry+=24;
  });
  y=panelTop+panelH+21;

  // ── Amount ─────────────────────────────────────────────────────────────────
  sectionLabel('Amount');
  const money=(label,value,{bold=false,color=INK,size=10.5}={})=>{
    doc.setFont('helvetica',bold?'bold':'normal'); doc.setFontSize(size); doc.setTextColor(...color);
    doc.text(String(label),M,y);
    doc.text(fmtCurPdf(value),W-M,y,{align:'right'});
    y+=19;
  };
  money(`Accommodation · ${nights} night${nights===1?'':'s'}`,total);
  y+=2;
  // A double rule under the subtotal: thin, then thicker. Reads as a total line
  // without needing the word.
  doc.setDrawColor(...LINE); doc.setLineWidth(.4); doc.line(M,y,W-M,y);
  doc.setLineWidth(1.0); doc.line(M,y+2.5,W-M,y+2.5);
  y+=20;
  const ro=roundOffOf(b);
  if(ro){                                     // what we let go reads as a deduction
    doc.setFont('helvetica','normal'); doc.setFontSize(10.5); doc.setTextColor(...GREY);
    doc.text('Round off',M,y);
    doc.text((ro>0?'-':'+')+fmtCurPdf(Math.abs(ro)),W-M,y,{align:'right'});   // built-in fonts have no U+2212
    y+=19;
  }
  money('Amount received',paid,{bold:true,color:DEEP,size:13});
  if(due>0)money('Balance outstanding',due,{bold:true,color:RED,size:11});

  // ── The stamp ──────────────────────────────────────────────────────────────
  // Rotated by hand: the corners are computed rather than relying on a
  // transformation matrix, which is not in every build of jsPDF.
  const stamp=receiptStamp(b);
  const drawStamp=(cx,cy,deg)=>{
    const rad=deg*Math.PI/180;
    const rot=(x,yy)=>[cx+(x-cx)*Math.cos(rad)-(yy-cy)*Math.sin(rad),
                       cy+(x-cx)*Math.sin(rad)+(yy-cy)*Math.cos(rad)];
    const SP=2;                       // the letter-spacing the word is set with
    doc.setFont('helvetica','bold'); doc.setFontSize(stamp.line.length>6?17:21);
    // getTextWidth does not know about charSpace, so the box has to be widened
    // by hand or a long word walks straight through its own border.
    const wordW=doc.getTextWidth(stamp.line)+(stamp.line.length-1)*SP;
    doc.setFont('helvetica','normal'); doc.setFontSize(8);
    const subW=doc.getTextWidth(stamp.sub)+(stamp.sub.length-1)*0.6;
    const halfW=Math.max(wordW,subW)/2+24, halfH=30;
    doc.setFont('helvetica','bold'); doc.setFontSize(stamp.line.length>6?17:21);
    doc.setDrawColor(...STAMP_INK[stamp.tone]);
    [[0,0.9],[4,0.5]].forEach(([inset,width])=>{
      doc.setLineWidth(width);
      const c=[rot(cx-halfW+inset,cy-halfH+inset),rot(cx+halfW-inset,cy-halfH+inset),
               rot(cx+halfW-inset,cy+halfH-inset),rot(cx-halfW+inset,cy+halfH-inset)];
      for(let i=0;i<4;i++)doc.line(c[i][0],c[i][1],c[(i+1)%4][0],c[(i+1)%4][1]);
    });
    doc.setTextColor(...STAMP_INK[stamp.tone]);
    const t1=rot(cx,cy+1);
    doc.text(stamp.line,t1[0],t1[1],{align:'center',angle:-deg,charSpace:SP});
    doc.setFont('helvetica','normal'); doc.setFontSize(8);
    const t2=rot(cx,cy+15);
    doc.text(stamp.sub,t2[0],t2[1],{align:'center',angle:-deg,charSpace:.6});
  };
  y+=8;
  const bandTop=y;
  drawStamp(W-M-96,bandTop+32,-11);

  // Balancing the stamp: the signature block an Indian receipt is expected to
  // carry, and the reason the left of this band is not simply empty.
  doc.setFont('helvetica','normal'); doc.setFontSize(9); doc.setTextColor(...GREY);
  doc.text(`For ${prop?.name||'Raaya Vasyam'}`,M,bandTop+16);
  const sigUri=prop?.signature||'', sigRatio=Number(prop?.signatureRatio)||1.1;
  const SIG_W=86, SIG_H=Math.round(SIG_W*sigRatio);
  let lineY=bandTop+54, labelGap=13;
  if(sigUri){
    // The signature sits ON the rule, just crossing it, the way a pen would.
    // Only just: this signature has a long descender, and any more overlap
    // runs the tail straight through the words below. addImage is wrapped
    // because a malformed data URI must cost the receipt its signature and
    // nothing else.
    try{
      doc.addImage(sigUri,'PNG',M+4,bandTop+20,SIG_W,SIG_H);
      lineY=bandTop+20+SIG_H-5;
      labelGap=16;
    }catch(e){}
  }
  doc.setDrawColor(...LINE); doc.setLineWidth(.6);
  doc.line(M,lineY,M+176,lineY);
  doc.setFont('helvetica','normal'); doc.setFontSize(7.5); doc.setTextColor(...GREY);
  doc.text('AUTHORISED SIGNATORY',M,lineY+labelGap,{charSpace:1});
  y=lineY+labelGap+20;

  // ── What this document is, and is not ──────────────────────────────────────
  const note = ['This is a receipt for payment received towards accommodation.',
                'It is not a tax invoice.'];
  const noteH=note.length*13+22;
  doc.setFillColor(...CREAM); doc.roundedRect(M,y,CW,noteH,6,6,'F');
  // A thin accent on the left edge, so the box reads as a note and not a panel.
  doc.setFillColor(...GREEN); doc.rect(M,y+8,2.4,noteH-16,'F');
  doc.setFont('helvetica','normal'); doc.setFontSize(8.8); doc.setTextColor(...GREY);
  let ny=y+20;
  note.forEach(ln=>{ doc.text(ln,M+18,ny); ny+=13; });
  y+=noteH+26;

  // ── Footer ─────────────────────────────────────────────────────────────────
  // Three diamonds on a rule: the one piece of ornament in the document.
  doc.setDrawColor(...LINE); doc.setLineWidth(.5);
  doc.line(M,y,W/2-26,y); doc.line(W/2+26,y,W-M,y);
  doc.setFillColor(...GREEN);
  [-9,0,9].forEach((dx,i)=>{
    const r=i===1?2.6:1.7, cx=W/2+dx;
    doc.lines([[r,-r],[r,r],[-r,r],[-r,-r]],cx-r,y,[1,1],'F',true);
  });
  y+=22;
  text(`Thank you for staying with us at ${prop?.name||'our home'}.`,
    W/2,10.5,{font:'times',align:'center',color:INK,width:CW});
  y+=3;
  text('We hope the house gave you the rest you came for.',
    W/2,9,{align:'center',color:GREY,width:CW});
  return doc;
}

async function receiptBlob(b){ return (await buildReceiptPDF(b)).output('blob'); }

function receiptGuard(b){
  if(!canReceipt(b)){
    alert(`${bookingSource(b)||'This source'} collects payment from the guest, so there is nothing for us to receipt. Receipts are for direct and Booking.com stays.`);
    return false;
  }
  const total=round2(b.totalAmount), paid=round2(b.paid);
  if(total<=0&&paid<=0){
    alert('This booking has no amount on it, so a receipt would be blank. Add the tariff on the booking first.');
    return false;
  }
  return true;
}
async function downloadReceipt(b){
  if(!receiptGuard(b))return;
  try{ (await buildReceiptPDF(b)).save(receiptFileName(b)); }catch(err){ pdfError(err); }
}
async function shareReceipt(b){
  if(!receiptGuard(b))return;
  let blob;
  try{ blob=await receiptBlob(b); }catch(err){ pdfError(err); return; }
  const file=new File([blob],receiptFileName(b),{type:'application/pdf'});
  if(navigator.canShare&&navigator.canShare({files:[file]})){
    try{ await navigator.share({files:[file],title:`Receipt — ${b.guestName}`}); }
    catch(err){ if(err&&err.name!=='AbortError')pdfError(err); }
  } else {
    const a=document.createElement('a');
    a.href=URL.createObjectURL(blob); a.download=receiptFileName(b); a.click();
    setTimeout(()=>URL.revokeObjectURL(a.href),4000);
    alert('Your browser cannot open the share sheet, so the receipt has been saved to Files. Attach it from there in WhatsApp.');
  }
}

// ─── WhatsApp ─────────────────────────────────────────────────────────────────
// India-first: bare 10-digit numbers get +91; anything already carrying a country code is left alone
function waNumber(phone){
  let d=String(phone||'').replace(/[^\d]/g,'');
  if(!d)return null;
  d=d.replace(/^0+/,'');
  if(d.length===10)d='91'+d;
  return d.length>=11&&d.length<=15?d:null;
}
function whatsappText(b){
  const prop=state.data.properties.find(p=>p.id===b.propertyId);
  const nights=diffDays(b.checkIn,b.checkOut);
  const firstName=String(b.guestName||'').trim().split(/\s+/)[0]||'there';
  // Direct and Booking.com guests pay us (paysUsDirectly); other platforms' guests
  // paid the platform, so quoting them a balance would be wrong at the door.
  const isDirect=paysUsDirectly(b);
  const total=Number(b.totalAmount||0), due=balanceDue(b);
  const L=[];
  L.push(`*Booking confirmed — ${prop?.name||'our homestay'}*`,'');
  L.push(`Namaste ${firstName}, your stay is confirmed. We're looking forward to hosting you.`,'');
  L.push(`*Reference:* SL-${b.id.slice(-6).toUpperCase()}`);
  L.push(`*Check-in:* ${fmtDate(b.checkIn)} from ${CHECKIN_TIME}`);
  L.push(`*Check-out:* ${fmtDate(b.checkOut)} by ${CHECKOUT_TIME}`);
  L.push(`*Stay:* ${nights} night${nights===1?'':'s'} · ${b.guests||1} guest${(b.guests||1)>1?'s':''}`);
  if(prop?.location)L.push(`*Address:* ${prop.location}`);
  if(isDirect&&total>0)L.push(`*Total:* ${fmtCur(total)}${due>0?` · *Balance due:* ${fmtCur(due)} (payable at check-in)`:' · fully paid'}`);
  L.push('',"I'll send the detailed confirmation right after this. Do reach out any time before your arrival.");
  return L.join('\n');
}
// ─── Guest messages through the stay ──────────────────────────────────────────
const MSG_KINDS=[
  ['confirm',  'Booking confirmation','file-check',  'When the booking is made'],
  ['arrival',  'Directions & arrival', 'map-pin',    'The day before check-in'],
  ['stay',     'Welcome & house info', 'home',       'Once they have checked in'],
  ['departure','Check-out reminder',   'door-exit',  'The day before check-out'],
];
const MSG_META=Object.fromEntries(MSG_KINDS.map(([k,label,icon,when])=>[k,{label,icon,when}]));

function msgSentOn(b,kind){
  if(kind==='confirm')return (b.msgSent&&b.msgSent.confirm)||b.confirmSentOn||'';
  return (b.msgSent&&b.msgSent[kind])||'';
}
function markMsgSent(id,kind){
  const stamp=today();
  mutateData(d=>d.bookings=d.bookings.map(x=>x.id===id
    ?{...x,msgSent:{...(x.msgSent||{}),[kind]:stamp},...(kind==='confirm'?{confirmSentOn:stamp}:{})}:x));
  if(state.editItem&&state.editItem.id===id)
    state.editItem={...state.editItem,msgSent:{...(state.editItem.msgSent||{}),[kind]:stamp}};
}

// What needs sending today, in the order it becomes urgent
function dueMessages(bookings){
  const t=today(), soon=addDaysISO(t,1), out=[];
  bookings.forEach(b=>{
    if(b.status==='cancelled'||!waNumber(b.phone))return;
    const sent=k=>!!msgSentOn(b,k);
    if((b.status==='confirmed'||b.status==='checkedin')&&b.checkOut>=t&&!sent('confirm'))
      out.push({b,kind:'confirm',on:b.checkIn});
    if(b.status==='confirmed'&&b.checkIn<=soon&&b.checkIn>=t&&!sent('arrival'))
      out.push({b,kind:'arrival',on:b.checkIn});
    if(b.status==='checkedin'&&!sent('stay'))
      out.push({b,kind:'stay',on:b.checkIn});
    if(b.status==='checkedin'&&b.checkOut<=soon&&!sent('departure'))
      out.push({b,kind:'departure',on:b.checkOut});
  });
  const rank={departure:0,stay:1,arrival:2,confirm:3};
  return out.sort((x,y)=>String(x.on).localeCompare(String(y.on))||rank[x.kind]-rank[y.kind]);
}

const firstNameOf=b=>String(b.guestName||'').trim().split(/\s+/)[0]||'there';

function arrivalText(b){
  const prop=state.data.properties.find(p=>p.id===b.propertyId);
  const when=b.checkIn===today()?'today':b.checkIn===addDaysISO(today(),1)?'tomorrow':`on ${fmtDate(b.checkIn)}`;
  const L=[];
  L.push(`*Seeing you ${when} \u2014 ${prop?.name||'our homestay'}*`,'');
  L.push(`Namaste ${firstNameOf(b)}, everything is ready for your arrival ${when}, any time after ${CHECKIN_TIME}.`,'');
  if(prop?.mapsLink)L.push(`*Getting here:* ${prop.mapsLink}`);
  else if(prop?.location)L.push(`*Address:* ${prop.location}`);
  L.push('','It\u2019s a self checkin property. You can find the key behind the pot beside the door, the key need to be put in the slot in the lock handle.');
  L.push('','Just for Identification of the house while you reach the destination via Map:');
  L.push('- House name Vrudhi is written on compound wall');
  L.push('- House is in the left side just 2 house before the end of the road.');
  L.push('','Safe travels.');
  return L.join('\n');
}

function stayText(b){
  const prop=state.data.properties.find(p=>p.id===b.propertyId);
  const L=[];
  L.push(`*Welcome in, ${firstNameOf(b)}*`,'');
  L.push('A few things to make the stay easy:','');
  if(prop?.wifiName)L.push(`*Wi-Fi:* ${prop.wifiName}${prop.wifiPassword?` · password *${prop.wifiPassword}*`:''}`);
  L.push('*Kitchen:* yours to use — we only ask that everything is washed and put back after each use.');
  L.push('*Stepping out:* please switch off the lights, fans and AC, and pull the door shut behind you.');
  L.push('*Evenings:* the neighbourhood turns in early, so do keep things quiet and plan to be back by 10 PM.');
  L.push('*Footwear:* there is a spot at the entrance — shoes stay outside.');
  L.push('','The house is entirely non-smoking, indoors and out.');
  L.push('','Anything you cannot find, just message here. Enjoy Udupi.');
  return L.join('\n');
}

function departureText(b){
  const prop=state.data.properties.find(p=>p.id===b.propertyId);
  const when=b.checkOut===today()?'today':b.checkOut===addDaysISO(today(),1)?'tomorrow':`on ${fmtDate(b.checkOut)}`;
  const isDirect=paysUsDirectly(b);
  const due=balanceDue(b);
  const pay=paymentBlock(b);
  const L=[];
  L.push(`*Checking out ${when}*`,'');
  L.push(`${firstNameOf(b)}, a small reminder that check-out is by ${CHECKOUT_TIME} ${when}.`,'');
  L.push('On your way out, it would help us a lot if you could:');
  L.push('• Switch off the lights, fans, AC and geyser');
  L.push('• Wash up anything used in the kitchen');
  L.push('• Pull the main door shut behind you');
  L.push('','Leave the keys where you found it.');
  // With payment details set, the balance comes with how to pay it; without
  // them, the same one-line reminder as before.
  if(pay.length)L.push('',`A balance of ${fmtCur(due)} is pending — you can settle it before you leave:`,'',...pay);
  else if(isDirect&&due>0&&b.status!=='cancelled')L.push('',`A balance of ${fmtCur(due)} is pending — you can settle it before you leave.`);
  L.push('','It has been lovely having you. If the stay was good to you, a review would mean a great deal — and do come back.');
  return L.join('\n');
}

const MSG_BUILDERS={confirm:whatsappText,arrival:arrivalText,stay:stayText,departure:departureText,payment:paymentRequestText};

function sendMessage(b,kind){
  const num=waNumber(b.phone);
  if(!num){alert('This booking has no usable phone number. Add one and try again.');return;}
  const text=MSG_BUILDERS[kind](b);
  if(!text)return;                     // a payment request with nothing owed, or to a platform guest: never sent
  window.open(`https://wa.me/${num}?text=${encodeURIComponent(text)}`,'_blank');
  markMsgSent(b.id,kind);
}

function openWhatsApp(b){
  const num=waNumber(b.phone);
  if(!num){alert('This booking has no usable phone number. Add one with the country code and try again.');return;}
  window.open(`https://wa.me/${num}?text=${encodeURIComponent(whatsappText(b))}`,'_blank');
  markMsgSent(b.id,'confirm');
}
async function shareConfirmation(b){
  let blob;
  try{ blob=await confirmationBlob(b); }catch(err){ pdfError(err); return; }
  const file=new File([blob],confirmationFileName(b),{type:'application/pdf'});
  if(navigator.canShare&&navigator.canShare({files:[file]})){
    try{ await navigator.share({files:[file],title:`Booking confirmation — ${b.guestName}`}); markMsgSent(b.id,'confirm'); }
    catch(err){ if(err&&err.name!=='AbortError')pdfError(err); }
  } else {
    const a=document.createElement('a');
    a.href=URL.createObjectURL(blob); a.download=confirmationFileName(b); a.click();
    setTimeout(()=>URL.revokeObjectURL(a.href),4000);
    alert('Your browser cannot open the share sheet, so the PDF has been saved to Files. Attach it from there in WhatsApp.');
  }
}


// The UPI QR goes through the share sheet, as the PDFs do: a wa.me link cannot
// carry a file. Same guard as the message, so it can never reach a guest who
// does not pay us or owes nothing.
async function sharePaymentQR(b){
  if(!canAskForPayment(b))return;
  const prop=state.data.properties.find(p=>p.id===b.propertyId);
  if(!prop||!prop.upiQr)return;
  let blob;
  try{ blob=await (await fetch(prop.upiQr)).blob(); }
  catch(err){ alert('Could not read the QR image. Upload it again in the property settings.'); return; }
  const name=`UPI-QR-${String(prop.name||'payment').replace(/[^A-Za-z0-9]+/g,'-')}.png`;
  const file=new File([blob],name,{type:blob.type||'image/png'});
  if(navigator.canShare&&navigator.canShare({files:[file]})){
    try{ await navigator.share({files:[file],title:`Pay ${prop.upiPayee||prop.name||''}`.trim()}); }
    catch(err){ if(err&&err.name!=='AbortError')alert('Could not share the QR code: '+(err.message||err)); }
  } else {
    const a=document.createElement('a');
    a.href=URL.createObjectURL(blob); a.download=name; a.click();
    setTimeout(()=>URL.revokeObjectURL(a.href),4000);
    alert('Your browser cannot open the share sheet, so the QR code has been saved to Files. Attach it from there in WhatsApp.');
  }
}

// ─── Paid → offer the receipt ─────────────────────────────────────────────────
// After a booking is marked paid in full, the receipt is offered on a sheet of
// its own, so the share starts from a fresh tap (a share sheet opened after a
// confirm() and a PDF build can be refused by the browser).
const justPaidInFull=b=>canReceipt(b)&&b.status!=='cancelled'&&Number(b.totalAmount||0)>0&&balanceDue(b)===0;
function markBookingPaid(b){
  const due=balanceDue(b);
  if(!(due>0))return;
  const ans=prompt(`Amount received? (balance ${fmtCur(due)})`,String(due));
  if(ans==null)return;
  const amt=r2(String(ans).replace(/[₹,\s]/g,''));
  if(!(amt>0)){alert('Enter the amount received, in rupees.');return;}
  mutateData(d=>{const x=d.bookings.find(y=>y.id===b.id); if(!x)return;
    x.paid=r2(Number(x.paid||0)+amt);
    // The same ₹5 round off as the booking form, unless one was typed by hand.
    const ro=x.roundOffHand?null:autoRoundOff(x.totalAmount,x.paid);
    if(ro!==null)x.roundOff=ro;});
  const now=state.data.bookings.find(y=>y.id===b.id);
  if(now&&justPaidInFull(now))setState({modal:'paidReceipt',editItem:{...now}});
}
// Airbnb and every other platform collect from the guest and pay us the whole
// amount, so there is nothing to ask and nothing to round: one tap records the
// payout in full, with a few seconds to take it back. No receipt (the platform
// gives the guest theirs) and no message to the guest.
const UNDO_MS=5000;
function markPayoutReceived(b){
  if(paysUsDirectly(b))return;
  const was=state.data.bookings.find(y=>y.id===b.id);
  if(!was||was.status==='cancelled'||!(balanceDue(was)>0))return;
  const before={paid:was.paid,roundOff:was.roundOff};
  mutateData(d=>{const x=d.bookings.find(y=>y.id===b.id); if(x){x.paid=Number(x.totalAmount||0);x.roundOff=0;}});
  showToast('Marked paid','Undo',()=>mutateData(d=>{const x=d.bookings.find(y=>y.id===b.id); if(!x)return;
    x.paid=before.paid; if(before.roundOff===undefined)delete x.roundOff; else x.roundOff=before.roundOff;}));
}
// A strip above the tab bar, outside #app so a re-render leaves it be.
let toastEl=null, toastTimer=null;
function showToast(text,action,onAction){
  if(toastEl)toastEl.remove(); clearTimeout(toastTimer);
  const el=div({'data-toast':'1',role:'status',style:{position:'fixed',left:16,right:16,bottom:'calc(84px + env(safe-area-inset-bottom,0px))',
    zIndex:1000,display:'flex',alignItems:'center',gap:12,padding:'11px 14px',borderRadius:12,maxWidth:448,margin:'0 auto',
    background:'var(--text)',color:'var(--white)',boxShadow:'var(--shadow-lift)',fontSize:13.5,fontWeight:600}},
    span({style:{flex:1}},text));
  const done=()=>{clearTimeout(toastTimer); if(toastEl===el)toastEl=null; el.remove();};
  if(action)el.appendChild(btn({'data-toast-action':'1',style:{background:'transparent',border:'none',color:'var(--gold-light)',
    fontSize:13.5,fontWeight:700,padding:'4px 6px',minHeight:32},onClick:()=>{done();onAction();}},action));
  document.body.appendChild(el); toastEl=el;
  toastTimer=setTimeout(done,UNDO_MS);
}
function renderPaidReceiptModal(){
  const b=state.editItem;
  if(!b)return modal('Paid',()=>div({}));
  return modal('Paid in full',()=>{
    const wrap=div({style:{display:'flex',flexDirection:'column',gap:10}});
    wrap.appendChild(div({style:{textAlign:'center',padding:'6px 4px 2px'}},
      ico('circle-check',{style:{fontSize:38,color:'var(--accent)',display:'block',marginBottom:8}}),
      div({style:{fontSize:15,fontWeight:700}},`${fmtCur(b.paid)} received from ${b.guestName}`),
      div({style:{fontSize:12.5,color:'var(--muted)',marginTop:4}},'Send the receipt now?')));
    wrap.appendChild(btn({className:'btn-gold','data-offer-receipt':'1',style:{width:'100%',justifyContent:'center',display:'flex',
      alignItems:'center',gap:7,minHeight:46},onClick:()=>{shareReceipt(b);closeModal();}},
      ico('receipt',{style:{fontSize:16}}),'Send receipt'));
    wrap.appendChild(btn({className:'btn-ghost',style:{width:'100%'},onClick:closeModal},'Not now'));
    return wrap;
  });
}

// ─── House notes — the document guests get once they are in ───────────────────
const HOUSE_NOTES=[
  ['Hot Water','We rely on solar heating, so on sunny days you\u2019ll have hot water in all bathrooms. As a backup, geysers are installed in the living room bathroom and the 1st floor bedroom bathroom. Their switches (marked 16A) are located just outside the respective bedrooms \u2014 please switch them on about 20\u201330 minutes before use if the solar water isn\u2019t warm enough.'],
  ['Water Supply','If the water flow stops, it likely means the overhead tank has run dry. Simply switch on the motor, located above the washing machine in the kitchen area. If water still doesn\u2019t resume, please also check the corresponding switch on the MCB board.'],
  ['Vessels & Utensils','As mentioned in the house rules, please clean vessels after use. If you\u2019d prefer, our househelp can do this for you at a nominal charge of Rs. 100, payable directly to her.'],
  ['Housekeeping','Our househelp comes daily to clean the house. Please let us know your convenient time \u2014 we\u2019d suggest either 7:30\u20138:00 AM or after 2:00 PM.'],
  ['Main Gate','Please keep the main gate closed, especially through the night. It keeps the house secure and keeps stray animals out of the compound.'],
  ['Footwear','Please leave shoes and chappals in the shoe rack rather than outside the door \u2014 stray dogs in the area are known to carry footwear away.'],
];

async function buildHouseNotesPDF(prop){
  const jsPDF=await loadJsPDF();
  const doc=new jsPDF({unit:'pt',format:'a4'});
  const W=doc.internal.pageSize.getWidth(), H=doc.internal.pageSize.getHeight();
  const M=52, CW=W-M*2;
  const GREEN=[47,107,79], INK=[31,36,32], GREY=[124,120,105], LINE=[231,223,206], CREAM=[250,246,238];
  let y=0;
  const ensure=need=>{ if(y+need>H-58){doc.addPage();y=M;} };
  const text=(t,x,size,{font='helvetica',style='normal',color=INK,align='left',width=CW,lead=1.42}={})=>{
    doc.setFont(font,style); doc.setFontSize(size); doc.setTextColor(...color);
    doc.splitTextToSize(String(t),width).forEach(ln=>{ ensure(size*lead); doc.text(ln,x,y,{align}); y+=size*lead; });
  };

  y=M+10;
  doc.setFont('times','normal'); doc.setFontSize(25); doc.setTextColor(...GREEN);
  doc.text(prop?.name||'Raaya Vasyam',W/2,y,{align:'center'}); y+=16;
  doc.setFont('helvetica','normal'); doc.setFontSize(8.5); doc.setTextColor(...GREY);
  doc.text('GUEST INSTRUCTIONS & HOUSE NOTES',W/2,y,{align:'center',charSpace:1.5}); y+=16;
  doc.setDrawColor(...LINE); doc.setLineWidth(.7); doc.line(M,y,W-M,y); y+=24;

  text(`Welcome to ${prop?.name||'Raaya Vasyam'}! We\u2019re so glad to have you here. A few quick notes to help make your stay smooth and comfortable:`,
    M,11,{color:[78,84,73],lead:1.55}); y+=14;

  HOUSE_NOTES.forEach(([title,body],i)=>{
    ensure(70);
    doc.setFillColor(...CREAM); doc.circle(M+8,y-3.5,9,'F');
    doc.setFont('helvetica','bold'); doc.setFontSize(10); doc.setTextColor(...GREEN);
    doc.text(String(i+1),M+8,y,{align:'center'});
    doc.setFontSize(12.5); doc.setTextColor(...INK);
    doc.text(title,M+26,y); y+=17;
    text(body,M+26,10.5,{color:[78,84,73],width:CW-26,lead:1.5}); y+=16;
  });

  ensure(80); y+=6;
  doc.setDrawColor(...LINE); doc.line(M,y,W-M,y); y+=20;
  text('For anything else during your stay, please feel free to reach out to us \u2014 happy to help!',
    W/2,10.5,{align:'center',color:INK});
  y+=8;
  text('With warm hospitality,',W/2,10,{align:'center',color:GREY});
  text(prop?.name||'Raaya Vasyam',W/2,12,{align:'center',font:'times',color:GREEN});
  return doc;
}

function houseNotesFileName(prop){
  return `${(prop?.name||'Raaya-Vasyam').replace(/[^\w]+/g,'-')}-House-Notes.pdf`;
}
async function downloadHouseNotes(prop){
  try{ (await buildHouseNotesPDF(prop)).save(houseNotesFileName(prop)); }
  catch(err){ pdfError(err); }
}
async function shareHouseNotes(prop){
  let blob;
  try{ blob=(await buildHouseNotesPDF(prop)).output('blob'); }catch(err){ pdfError(err); return; }
  const file=new File([blob],houseNotesFileName(prop),{type:'application/pdf'});
  if(navigator.canShare&&navigator.canShare({files:[file]})){
    try{ await navigator.share({files:[file],title:`House notes \u2014 ${prop?.name||'Raaya Vasyam'}`}); }
    catch(err){ if(err&&err.name!=='AbortError')pdfError(err); }
  } else {
    const a=document.createElement('a');
    a.href=URL.createObjectURL(blob); a.download=houseNotesFileName(prop); a.click();
    setTimeout(()=>URL.revokeObjectURL(a.href),4000);
    alert('Your browser cannot open the share sheet, so the notes have been saved to Files. Attach them from there in WhatsApp.');
  }
}


// ─── Cloud sync ───────────────────────────────────────────────────────────────
function cloudStatus(){
  return (window.StayLogCloud&&window.StayLogCloud.status())||{configured:false,signedIn:false};
}
function fmtAgo(iso){
  if(!iso)return 'never';
  const mins=Math.round((Date.now()-new Date(iso).getTime())/60000);
  if(mins<1)return 'just now';
  if(mins<60)return `${mins} min ago`;
  const hrs=Math.round(mins/60);
  if(hrs<24)return `${hrs} hour${hrs>1?'s':''} ago`;
  return fmtDate(iso.slice(0,10));
}
function cloudMenuSub(){
  const s=cloudStatus();
  if(!s.configured)return 'Not configured';
  if(!s.signedIn)  return 'Not signed in — this phone only';
  if(!s.online)    return s.dirty?'Offline · changes waiting':'Offline';
  if(s.pushing)    return 'Syncing…';
  if(s.lastError)  return 'Last sync failed';
  if(s.dirty)      return 'Changes waiting to sync';
  return `Synced ${fmtAgo(s.lastSync)}`;
}

// ─── Calendar sync ────────────────────────────────────────────────────────────
// Two boxes in the cloud panel. "Calendar sync" reports, feed by feed, what the
// function fetched (from ical_feeds, written by the function) and what this
// phone did with it (from the import log, kept on disk). "Calendar links" is
// where the links are edited. The links live only in the cloud (ical_feeds):
// never in the app's data, its backups, or this repository.
const ICAL_PLATFORMS=['Airbnb','Booking.com'];
const whenShort=iso=>new Date(iso).toLocaleString('en-IN',{day:'numeric',month:'short',hour:'numeric',minute:'2-digit'});
const plural=(n,one,many)=>`${n} ${n===1?one:(many||one+'s')}`;
const icalMissing=err=>/does not exist|schema cache|PGRST205|42P01/i.test(`${err&&err.code||''} ${err&&err.message||err}`);
const icalBox=attr=>div({[attr]:'1',style:{background:'var(--surface-2)',border:'1px solid var(--border)',
  borderRadius:'var(--radius-sm)',padding:'11px 13px'}});

function icalSummary(log){
  if(!log)return null;
  if(log.error)return{tone:'var(--danger)',text:log.error};
  const bits=[];
  if(log.created)bits.push(plural(log.created,'new booking'));
  if(log.updated)bits.push(`${log.updated} with new dates`);
  if(log.gone)bits.push(`${log.gone} no longer listed`);
  if(log.held)bits.push(`${log.held} waiting for a property`);
  return{tone:bits.length?'var(--accent)':'var(--muted)',
    text:(bits.length?bits.join(' · '):'Nothing new from the calendars')+` · checked ${whenShort(log.at)}`};
}

// One feed: what was fetched, what it led to here, and the error if any.
function icalFeedReport(f,stats,log){
  const proven=log&&log.proven?log.proven[f.id]:undefined;
  const openHere=Object.entries((log&&log.gaps)||{}).filter(([bid,gs])=>{
    const b=state.data.bookings.find(x=>x.id===bid);
    return b&&b.propertyId===f.property_id&&openGapsFor(b).some(g=>g.platform===f.platform);}).length;
  const prop=state.data.properties.find(p=>p.id===f.property_id);
  const wrap=div({'data-feed-report':f.id,style:{paddingTop:10,marginTop:10,borderTop:'1px solid var(--border-soft)'}});
  wrap.appendChild(div({style:{fontSize:13,fontWeight:700}},`${f.platform}${prop?' · '+prop.name:''}`));
  // the fetch, as the function recorded it
  let fetchLine;
  if(f.last_error&&f.last_fetched_at){
    wrap.appendChild(div({'data-feed-error':'1',style:{fontSize:12.5,color:'var(--danger)',lineHeight:1.5,marginTop:3}},
      `Last fetch failed ${whenShort(f.last_fetched_at)}: ${f.last_error}`));
    fetchLine=f.last_ok_at?`Last good fetch ${whenShort(f.last_ok_at)}`:'It has not been fetched successfully yet.';
  }else if(f.last_ok_at){
    fetchLine=`Fetched ${whenShort(f.last_ok_at)} · ${plural(f.last_count||0,'event')} in the feed`;
  }else fetchLine='Not fetched yet — tap Check now.';
  wrap.appendChild(div({'data-feed-fetch':'1',style:{fontSize:12,color:'var(--muted)',marginTop:3,lineHeight:1.45}},fetchLine));
  if(!stats)return wrap;
  // what it led to here
  const tile=(label,n,attr,tone)=>div({style:{flex:1}},div({className:'kicker'},label),
    div({className:'num',[attr]:String(n),style:{fontSize:17,fontWeight:700,marginTop:2,color:n>0?tone:'var(--muted)'}},String(n)));
  wrap.appendChild(div({style:{display:'flex',gap:14,marginTop:8}},
    tile('Added',stats.added,'data-n-added','var(--accent)'),
    tile('Updated',stats.updated,'data-n-updated','var(--text)'),
    tile('Removed',stats.removed,'data-n-removed','var(--gold)')));
  const notes=[];
  if(stats.removed)notes.push(`Removed means no longer on ${f.platform}: ${stats.removed===1?'its booking is':'their bookings are'} flagged to check, not cancelled.`);
  if(stats.matched)notes.push(`${plural(stats.matched,'stay')} matched to bookings you already had (typed in, or seen on the other platform).`);
  if(stats.deleted)notes.push(`${plural(stats.deleted,'booking')} from this feed deleted here afterwards. ${stats.deleted===1?'It stays':'They stay'} deleted.`);
  if(proven===false&&stats.events)notes.push(`Still-open check: waiting until this feed shows a stay that began elsewhere, so it is not guessing what ${f.platform}'s export includes.`);
  if(proven&&openHere)notes.push(`${plural(openHere,'stay')} still open on ${f.platform}: see Bookings.`);
  if(stats.blocks)notes.push(`${plural(stats.blocks,'blocked date range')} with no stay behind ${stats.blocks===1?'it':'them'}: not imported.`);
  notes.forEach(t=>wrap.appendChild(div({style:{fontSize:11.5,color:'var(--muted)',marginTop:5,lineHeight:1.45}},t)));
  const lc=stats.lastChange;
  if(lc){
    const bits=[lc.added?`${lc.added} added`:'',lc.updated?`${lc.updated} updated`:'',lc.removed?`${lc.removed} removed`:''].filter(Boolean);
    wrap.appendChild(div({'data-feed-last':'1',style:{fontSize:11.5,color:'var(--accent)',marginTop:6}},`Last change ${whenShort(lc.at)}: ${bits.join(', ')}`));
  }
  return wrap;
}

function calendarSyncBox(s){
  const box=icalBox('data-ical');
  const go=btn({className:'btn-ghost btn-sm','data-ical-check':'1',style:{padding:'4px 10px',fontSize:12}},'Check now');
  box.appendChild(div({style:{display:'flex',alignItems:'center',justifyContent:'space-between',gap:10}},
    div({className:'kicker'},'Calendar sync'),go));
  const sum=icalSummary(s.icalLog);
  if(sum)box.appendChild(div({'data-ical-log':'1',style:{fontSize:12.5,color:sum.tone,lineHeight:1.5,marginTop:6}},sum.text));
  const body=div({},div({style:{fontSize:12.5,color:'var(--muted)',marginTop:6}},'Loading…'));
  box.appendChild(body);
  // Fetches every feed now (the function), then syncs, which imports.
  go.addEventListener('click',async()=>{
    go.disabled=true;go.textContent='Checking…';
    try{ await window.StayLogCloud.importNow(); render(); }
    catch(err){ go.disabled=false;go.textContent='Check now'; alert('Calendar check failed: '+(err.message||err)); }
  });
  window.StayLogCloud.listFeeds().then(feeds=>{
    body.innerHTML='';
    if(!feeds.length){
      body.appendChild(div({style:{fontSize:12.5,color:'var(--muted)',marginTop:6,lineHeight:1.5}},
        'No calendar links yet. Add them below.'));
      go.disabled=true; return;
    }
    const stats=(s.icalLog&&s.icalLog.feeds)||{};
    feeds.slice().sort((x,y)=>(x.property_id+x.platform).localeCompare(y.property_id+y.platform))
      .forEach(f=>body.appendChild(icalFeedReport(f,stats[f.id],s.icalLog)));
  }).catch(err=>{
    body.innerHTML='';
    body.appendChild(div({style:{fontSize:12.5,color:icalMissing(err)?'var(--muted)':'var(--danger)',marginTop:6,lineHeight:1.5}},
      icalMissing(err)?'Not set up in Supabase yet: run supabase/ical.sql and deploy the ical-sync function.'
                      :'Could not load the calendar status — '+(err.message||err)));
    go.disabled=true;
  });
  return box;
}

function calendarLinksBox(){
  const box=icalBox('data-ical-links');
  box.appendChild(div({className:'kicker'},'Calendar links'));
  const body=div({style:{marginTop:6}},div({style:{fontSize:12.5,color:'var(--muted)'}},'Loading your calendar links…'));
  box.appendChild(body);
  async function load(){
    let feeds;
    try{ feeds=await window.StayLogCloud.listFeeds(); }
    catch(err){ box.style.display=icalMissing(err)?'none':''; body.innerHTML='';
      body.appendChild(div({style:{fontSize:12.5,color:'var(--danger)'}},'Could not load the calendar links — '+(err.message||err))); return; }
    body.innerHTML='';
    body.appendChild(div({style:{fontSize:12,color:'var(--muted)',lineHeight:1.5}},
      'Paste each platform\'s calendar export link. They are kept in your Supabase project only, and read every 30 minutes.'));
    state.data.properties.forEach(p=>{
      body.appendChild(div({style:{fontSize:12.5,fontWeight:700,marginTop:10}},p.name));
      ICAL_PLATFORMS.forEach(pl=>{
        const f=feeds.find(x=>x.property_id===p.id&&x.platform===pl);
        const inp=h('input',{type:'url','data-feed':`${p.id}|${pl}`,placeholder:`${pl} export link (https://…)`,
          value:f?.url||'',style:{flex:1,minWidth:0,fontSize:12.5,padding:'7px 9px'}});
        const save=btn({className:'btn-ghost btn-sm','data-feed-save':`${p.id}|${pl}`,style:{padding:'5px 10px',flexShrink:0}},'Save');
        save.addEventListener('click',async()=>{
          save.disabled=true;save.textContent='Saving…';
          try{ await window.StayLogCloud.saveFeed(p.id,pl,inp.value); render(); }
          catch(err){ save.disabled=false;save.textContent='Save'; alert(err.message||err); }
        });
        body.appendChild(div({style:{fontSize:11.5,color:'var(--muted)',marginTop:6}},pl));
        body.appendChild(div({style:{display:'flex',gap:6,marginTop:3}},inp,save));
      });
    });
  }
  load();
  return box;
}

// ─── Encrypted backup ─────────────────────────────────────────────────────────
// backup.js does the cryptography; this is the sheet (Cloud sync → Encrypted
// backup). The passphrase is typed here and handed straight to backup.js; it
// is never kept in state, storage or a log.
const bk={view:'',busy:false,msg:'',bad:false,list:null,listErr:''};
const BK=()=>window.StayLogBackup;
const bkStatus=()=>(BK()&&BK().status())||{hasKey:false};
function bkSay(msg,bad){bk.msg=msg;bk.bad=!!bad;bk.busy=false;if(state.modal==='backup')render();}
function bkWork(msg){bk.msg=msg;bk.bad=false;bk.busy=true;if(state.modal==='backup')render();}
function bkLoadList(){
  if(bk.list||bk._loading)return;
  bk._loading=true;
  BK().list().then(l=>{bk.list=l;bk.listErr='';},e=>{bk.listErr=e.message||String(e);})
    .finally(()=>{bk._loading=false;if(state.modal==='backup')render();});
}
function bkWhen(iso){
  if(!iso)return 'never';
  const d=new Date(iso);
  return `${fmtDate(isoOf(d))}, ${d.toLocaleTimeString('en-IN',{hour:'numeric',minute:'2-digit'})}`;
}
// Replaces this phone's data with a decrypted backup. ID photographs were
// never in it, so this phone's own are carried across by booking id, and what
// was here is kept aside on the phone first (IndexedDB 'staylog_before_restore').
function replaceWithBackup(fresh){
  const imgs={};state.data.bookings.forEach(b=>{if(b.idProofImage)imgs[b.id]=b.idProofImage;});
  idbSet('staylog_before_restore',JSON.parse(JSON.stringify(state.data))).catch(()=>{});
  const d=normalizeData(fresh);
  d.bookings.forEach(b=>{if(imgs[b.id])b.idProofImage=imgs[b.id];});
  state.data=d;repriceWages(state.data);saveData(state.data);
}
function bkSubtitle(){
  const b=bkStatus();
  return !b.hasKey?'Off · set a passphrase':b.lastError?'Last backup failed — open to see why':`Last backup ${bkWhen(b.lastAt)}`;
}
function openBackupPanel(){bk.view='';bk.msg='';bk.list=null;setState({modal:'backup'});}
function renderBackupModal(){
  const content=()=>{
    const wrap=div({'data-backup':'1',style:{display:'flex',flexDirection:'column',gap:10}});
    const s=bkStatus(), cs=cloudStatus();
    const note=(t,color)=>wrap.appendChild(div({style:{fontSize:12.5,color:color||'var(--muted)',lineHeight:1.55}},t));
    const pass=(ph,attr)=>h('input',{type:'password',autocomplete:'off',placeholder:ph,...attr});
    const button=(label,attr,onClick,primary)=>btn({...attr,disabled:bk.busy,className:primary?'btn-primary':'btn-ghost',
      style:{width:'100%',minHeight:44},onClick},label);
    const msgLine=()=>{ if(bk.msg)wrap.appendChild(div({'data-backup-msg':'1',style:{fontSize:13,fontWeight:600,lineHeight:1.5,
      color:bk.bad?'var(--danger)':'var(--accent)'}},bk.msg)); };
    if(!BK()){note('Encrypted backup is not available in this copy of the app. Reopen StayLog.');return wrap;}
    if(!cs.signedIn){note('Sign in to Cloud sync first: the encrypted copy is kept there.');
      wrap.appendChild(button('Cloud sync',{},()=>setState({modal:'cloud'}),true));return wrap;}

    // ── The panels: test restore, restore, change passphrase ────────────────
    if(bk.view==='verify'){
      note('Type the passphrase. The latest backup is decrypted on this phone and compared with what is here. Nothing on the phone changes.');
      const p=pass('Backup passphrase',{'data-bk-pass':'1'});wrap.appendChild(p);
      msgLine();
      wrap.appendChild(button('Test restore',{'data-bk-verify':'1'},async()=>{
        bkWork('Decrypting…');
        try{
          const r=await BK().verify(p.value,state.data);
          if(r.ok)bkSay(`Backup verified · ${bkWhen(r.createdAt)} · ${r.counts.bookings} bookings, ${r.counts.expenses} expenses, ${r.counts.loans} loans.`);
          else bkSay(`Decrypted, but the backup of ${bkWhen(r.createdAt)} differs from this phone: `+
            r.diffs.map(x=>`${x.table} ${x.backup} in the backup, ${x.phone} here`).join('; ')+'. Back up now, then test again.',true);
        }catch(e){bkSay(e.message||String(e),true);}
      },true));
      wrap.appendChild(button('Back',{},()=>{bk.view='';bk.msg='';render();}));
      return wrap;
    }
    if(bk.view==='restore'){
      note('Replaces everything on this phone with a backup. Use it on a new phone, or to go back to a saved copy. The data here now is kept aside on the phone first.',
        'var(--text-mid)');
      const p=pass('Backup passphrase',{'data-bk-pass':'1'});wrap.appendChild(p);
      bkLoadList();
      let chosen=bk.chosen||'latest', fileDoc=null;
      const pick=h('select',{'data-bk-pick':'1'});
      pick.appendChild(h('option',{value:'latest'},'The latest backup'));
      (bk.list||[]).forEach((r,i)=>{if(i>0)pick.appendChild(h('option',{value:r.id,selected:chosen===r.id},bkWhen(r.created_at)));});
      pick.addEventListener('change',e=>{bk.chosen=e.target.value;});
      if(bk.list&&bk.list.length)wrap.appendChild(div({},div({className:'label'},`From the cloud (${bk.list.length} kept)`),pick));
      else if(bk.listErr)note(bk.listErr,'var(--danger)');
      else if(bk.list)note('There is no backup in the cloud.');
      const fileInp=h('input',{type:'file','data-bk-file':'1',style:{fontSize:12.5}});
      const fileName=div({style:{fontSize:12,color:'var(--muted)'}});
      fileInp.addEventListener('change',e=>{const f=e.target.files[0];if(!f)return;
        f.text().then(t=>{try{fileDoc=BK().readFile(t);fileName.textContent=`Using the file ${f.name}`;}catch(err){fileDoc=null;fileName.textContent=err.message;}});});
      wrap.appendChild(div({},div({className:'label'},'Or a saved backup file'),fileInp,fileName));
      msgLine();
      wrap.appendChild(button('Replace this phone’s data',{'data-bk-restore':'1'},async()=>{
        bkWork('Decrypting…');
        let r;
        try{ r=await BK().restore(p.value,fileDoc||(chosen=(bk.chosen||'latest'),chosen==='latest'?null:{id:chosen})); }
        catch(e){bkSay(e.message||String(e),true);return;}
        const c=BK()._counts(r.data);
        if(!confirm(`Replace everything on this phone with the backup of ${bkWhen(r.createdAt)}?\n\n${c.bookings} bookings, ${c.expenses} expenses, ${c.loans} loans.`)){bkSay('Nothing was changed.');return;}
        replaceWithBackup(r.data);
        bk.view='';bkSay(`Restored the backup of ${bkWhen(r.createdAt)}: ${c.bookings} bookings, ${c.expenses} expenses, ${c.loans} loans.`);
      },false));
      wrap.lastChild.className='btn-danger';
      wrap.appendChild(button('Back',{},()=>{bk.view='';bk.msg='';render();}));
      return wrap;
    }
    if(bk.view==='change'){
      note('Every backup in the cloud is re-encrypted with the new passphrase, and this phone keeps the new key. The new one cannot be recovered either.');
      const cur=pass('Current passphrase',{'data-bk-cur':'1'}), p1=pass(`New passphrase (at least ${BK().MIN_PASS} characters)`,{'data-bk-p1':'1'}),
            p2=pass('New passphrase again',{'data-bk-p2':'1'});
      wrap.appendChild(cur);wrap.appendChild(p1);wrap.appendChild(p2);
      msgLine();
      wrap.appendChild(button('Change passphrase',{'data-bk-change':'1'},async()=>{
        bkWork('Re-encrypting…');
        try{ const r=await BK().changePassphrase(cur.value,p1.value,p2.value,state.data);
          bk.view='';bk.list=null;
          bkSay(`Passphrase changed. ${r.rewritten+1} backup${r.rewritten?'s':''} now open with the new one`+
            (r.kept?`; ${r.kept} older could not be rewritten and still open with the old one until they expire.`:'.'));
        }catch(e){bkSay(e.message||String(e),true);}
      },true));
      wrap.appendChild(button('Back',{},()=>{bk.view='';bk.msg='';render();}));
      return wrap;
    }

    // ── First time on this phone: set the passphrase ─────────────────────────
    if(!s.hasKey){
      wrap.appendChild(div({style:{fontSize:13,lineHeight:1.55,color:'var(--text-mid)',background:'var(--warn-light)',
        border:'1px solid var(--warn-line)',borderRadius:'var(--radius-sm)',padding:'10px 12px'}},
        h('b',{},'If you forget this passphrase, the backups cannot be opened — by you, by Supabase, or by anyone. '),
        'It is not your PIN and is never stored or sent; only a key made from it stays on this phone. Write it down somewhere safe.'));
      const p1=pass(`Passphrase (at least ${BK().MIN_PASS} characters)`,{'data-bk-p1':'1'}), p2=pass('Passphrase again',{'data-bk-p2':'1'});
      wrap.appendChild(p1);wrap.appendChild(p2);
      msgLine();
      wrap.appendChild(button('Turn on encrypted backup',{'data-bk-set':'1'},async()=>{
        bkWork('Making the key and the first backup…');
        try{ await BK().setPassphrase(p1.value,p2.value,state.data); bkSay('Encrypted backup is on. The first backup is in the cloud.'); }
        catch(e){bkSay(e.message||String(e),true);}
      },true));
      note('Setting up a new phone? Sign in, then restore with the passphrase you already use:');
      wrap.appendChild(button('Restore from backup',{'data-bk-open-restore':'1'},()=>{bk.view='restore';bk.msg='';render();}));
      return wrap;
    }

    // ── On ───────────────────────────────────────────────────────────────────
    wrap.appendChild(div({'data-bk-status':'1',style:{background:'var(--surface-2)',border:'1px solid var(--border)',
      borderRadius:'var(--radius-sm)',padding:'11px 13px'}},
      div({style:{fontSize:13.5,fontWeight:700,color:s.lastError?'var(--danger)':'var(--accent)'}},
        s.running?'Backing up…':`Last backup: ${bkWhen(s.lastAt)}`),
      s.lastError?div({style:{fontSize:12,color:'var(--danger)',marginTop:4,lineHeight:1.45}},`Last try failed: ${s.lastError}`):null,
      div({style:{fontSize:12,color:'var(--muted)',marginTop:4,lineHeight:1.45}},
        'Encrypted on this phone after each sync. The cloud keeps the latest and one a day for 30 days; it cannot read them. Guest ID photos are never included.')));
    msgLine();
    wrap.appendChild(button('Back up now',{'data-bk-now':'1'},async()=>{
      bkWork('Backing up…');
      try{ await BK().backupNow(state.data,{force:true}); bk.list=null; bkSay('Backed up.'); }catch(e){bkSay(e.message||String(e),true);}
    },true));
    wrap.appendChild(button('Test restore',{'data-bk-open-verify':'1'},()=>{bk.view='verify';bk.msg='';render();}));
    wrap.appendChild(button('Restore from backup',{'data-bk-open-restore':'1'},()=>{bk.view='restore';bk.msg='';bk.list=null;render();}));
    wrap.appendChild(button('Save backup file',{'data-bk-file-save':'1'},async()=>{
      bkWork('Encrypting…');
      try{
        const f=await BK().file(state.data);
        if(navigator.canShare&&navigator.canShare({files:[f]}))await navigator.share({files:[f],title:'StayLog backup'});
        else{const a=document.createElement('a');a.href=URL.createObjectURL(f);a.download=f.name;a.click();}
        bkSay('Saved. The file is encrypted with the same passphrase.');
      }catch(e){ if(e&&e.name==='AbortError')bkSay(''); else bkSay(e.message||String(e),true); }
    }));
    wrap.appendChild(button('Change passphrase',{'data-bk-open-change':'1'},()=>{bk.view='change';bk.msg='';render();}));
    return wrap;
  };
  return modal('Encrypted backup',content);
}

function renderCloudModal(){
  const content=()=>{
    const wrap=div({style:{display:'flex',flexDirection:'column',gap:11}});
    const s=cloudStatus();

    const tone = !s.signedIn ? 'var(--muted)'
               : s.lastError ? 'var(--danger)'
               : s.dirty     ? 'var(--warn)' : 'var(--accent)';
    wrap.appendChild(div({style:{background:'var(--surface-2)',border:'1px solid var(--border)',
      borderRadius:'var(--radius-sm)',padding:'12px 13px'}},
      div({style:{fontSize:13.5,fontWeight:700,color:tone}},cloudMenuSub()),
      s.signedIn?div({style:{fontSize:12,color:'var(--muted)',marginTop:3}},s.email):null,
      s.lastError?div({style:{fontSize:12,color:'var(--danger)',marginTop:5,lineHeight:1.45}},s.lastError):null,
      s.schemaBehind?div({'data-schema-behind':'1',style:{fontSize:12,color:'var(--gold)',marginTop:5,lineHeight:1.45}},
        `Run ${s.schemaBehind} in the Supabase SQL editor. Until then the newest wage fields are kept on this phone only, and sync once it has run.`):null
    ));

    // ── The first minimal sync: said once ────────────────────────────────────
    if(s.privacyNote&&s.privacyNote.length){
      const n=s.privacyNote.reduce((t,x)=>t+x.count,0);
      wrap.appendChild(div({'data-privacy-note':'1',style:{background:'var(--accent-light)',border:'1px solid var(--accent-line)',
        borderRadius:'var(--radius-sm)',padding:'11px 13px',fontSize:12.5,lineHeight:1.55,color:'var(--text-mid)'}},
        div({style:{fontSize:13.5,fontWeight:700,color:'var(--accent)',marginBottom:3}},'Removing private details from the cloud'),
        `${n} row${n===1?'':'s'} (${s.privacyNote.map(x=>`${x.count} ${x.table.replace('_',' ')}`).join(', ')}) no longer have a cloud copy, `+
        'and guest names, phone numbers, amounts and notes are no longer sent. Nothing is deleted from this phone, and all of it is in your encrypted backup.'));
    }

    // ── Attendance ───────────────────────────────────────────────────────────
    // Always shown, never only on trouble. A mark that does not become an
    // expense used to be silent, which left no way to tell a sync that had
    // not run from one that had failed.
    if(s.signedIn){
      const log=s.attLog||{}, box=div({style:{background:'var(--surface-2)',
        border:'1px solid var(--border)',borderRadius:'var(--radius-sm)',padding:'11px 13px'}});
      box.appendChild(div({style:{display:'flex',alignItems:'center',justifyContent:'space-between',gap:10}},
        div({className:'kicker'},'Attendance'),
        btn({className:'btn-ghost btn-sm',style:{padding:'4px 10px',fontSize:12},
          onClick:async()=>{
            try{ await window.StayLogCloud.push(state.data,{manual:true}); }catch(err){}
            render();
          }},'Check now')));

      // Report what the last check SAW, not only what it changed. A mark that
      // was found but not converted used to read the same as no mark at all.
      const last=s.attLast||{};
      let line, tone='var(--text-mid)';
      if(s.attError){ line=s.attError; tone='var(--danger)'; }
      else if(s.heldMarks>0){
        const who=state.data.staff.filter(x=>!(Number(x.dailyWage)>0)).map(x=>x.name).join(', ');
        line=`${s.heldMarks} ${s.heldMarks===1?'mark is':'marks are'} waiting — no daily wage is set${who?` for ${who}`:''}. Set it in the staff screen and ${s.heldMarks===1?'it converts':'they convert'} at the next sync.`;
        tone='var(--gold)';
      }
      else if(log.created>0){ line=`${log.created} wage ${log.created===1?'expense':'expenses'} added: ${(log.names||[]).join(', ')}`; tone='var(--accent)'; }
      else if(log.pending>0){ line=`${log.pending} ${log.pending===1?'mark is':'marks are'} already in your expenses but not yet ticked off in the cloud. The next sync retries it.`; tone='var(--gold)'; }
      else if(log.stamped>0){ line=`${log.stamped} mark${log.stamped===1?'':'s'} ticked off in the cloud. The expense${log.stamped===1?' was':'s were'} already in your list.`; tone='var(--accent)'; }
      else if(!log.at){ line='Not checked yet on this phone. Tap Check now.'; tone='var(--muted)'; }
      else { line='Nothing waiting — every mark has become an expense.'; tone='var(--muted)'; }

      box.appendChild(div({style:{fontSize:12.5,color:tone,lineHeight:1.5,marginTop:6}},line));

      // Utensil cleaning, reported beside attendance (cloud.js drainUtensils).
      const ut=s.utensils||{};
      if(ut.held>0){
        const who=state.data.staff.filter(x=>!(Number(x.utensilRate)>0)).map(x=>x.name).join(', ');
        box.appendChild(div({'data-ute-held':String(ut.held),style:{fontSize:12.5,color:'var(--gold)',lineHeight:1.5,marginTop:6}},
          `${ut.held} utensil cleaning ${ut.held===1?'mark is':'marks are'} waiting — no utensil cleaning rate is set${who?` for ${who}`:''}. Set it in the staff screen and ${ut.held===1?'it converts':'they convert'} at the next sync.`));
      }
      if(ut.error)box.appendChild(div({style:{fontSize:12.5,color:'var(--danger)',lineHeight:1.5,marginTop:6}},ut.error));
      if(ut.last&&ut.last.created>0)box.appendChild(div({'data-ute-last':'1',style:{fontSize:11.5,color:'var(--accent)',marginTop:6,lineHeight:1.45}},
        `Utensil cleaning last added ${new Date(ut.last.at).toLocaleString('en-IN',{day:'numeric',month:'short',hour:'numeric',minute:'2-digit'})}: ${(ut.last.names||[]).join(', ')}`));

      // The durable answer to "did her mark become an expense?". A log is a
      // record of one moment and resets; these are the expenses themselves,
      // sitting in the data, and they are still here tomorrow.
      const born=state.data.expenses.filter(e=>e.fromAttendance)
        .sort((a,b)=>String(b.date).localeCompare(String(a.date)));

      // The two numbers that matter, together. A mismatch was the complaint;
      // it should be visible without a database query.
      if(log.cloudMarks>0||born.length){
        const gap=Math.max(0,(log.cloudMarks||0)-born.length-(log.removed||0));
        box.appendChild(div({style:{display:'flex',gap:14,marginTop:11,paddingTop:10,
          borderTop:'1px solid var(--border-soft)'}},
          div({style:{flex:1}},div({className:'kicker'},'Marks in cloud'),
            div({className:'num',style:{fontSize:17,fontWeight:700,marginTop:2}},String(log.cloudMarks||0))),
          div({style:{flex:1}},div({className:'kicker'},'Recorded here'),
            div({className:'num',style:{fontSize:17,fontWeight:700,marginTop:2,
              color:gap>0?'var(--gold)':'var(--accent)'}},String(born.length)))));
        if(log.removed>0)box.appendChild(div({style:{fontSize:11.5,color:'var(--muted)',marginTop:5,lineHeight:1.45}},
          `${log.removed} ${log.removed===1?'day was':'days were'} converted and the expense deleted here afterwards. That stays deleted.`));
        if(gap>0)box.appendChild(div({style:{fontSize:11.5,color:'var(--gold)',marginTop:5,lineHeight:1.45}},
          `${gap} ${gap===1?'day has':'days have'} not been recorded here yet. Tap Check now.`));
      }

      if(born.length){
        box.appendChild(div({style:{fontSize:11,color:'var(--muted)',marginTop:10,marginBottom:3,
          fontWeight:700,letterSpacing:'.06em',textTransform:'uppercase'}},
          `${born.length} day${born.length===1?'':'s'} recorded from her marks`));
        born.slice(0,5).forEach(e=>{
          box.appendChild(div({style:{display:'flex',justifyContent:'space-between',gap:10,
            fontSize:12,color:'var(--text-mid)',padding:'3px 0'}},
            div({},`${fmtDate(e.date)} · ${staffName(e.staffId)||'Staff'}`),
            div({className:'num',style:{fontWeight:600,color:e.paid?'var(--muted)':'var(--text)'}},
              `${fmtCur(e.amount)}${e.paid?' · paid':''}`)));
        });
        if(born.length>5)box.appendChild(div({style:{fontSize:11,color:'var(--light)',marginTop:3}},
          `and ${born.length-5} earlier`));
      }

      if(last.created>0&&!(log.created>0))
        box.appendChild(div({style:{fontSize:11.5,color:'var(--accent)',marginTop:8,lineHeight:1.45}},
          `Last added ${new Date(last.at).toLocaleString('en-IN',{day:'numeric',month:'short',hour:'numeric',minute:'2-digit'})}: ${(last.names||[]).join(', ')}`));

      if(log.at)box.appendChild(div({style:{fontSize:11,color:'var(--light)',marginTop:6}},
        `Last checked ${new Date(log.at).toLocaleString('en-IN',{day:'numeric',month:'short',hour:'numeric',minute:'2-digit'})}`
        +` · ${log.found} mark${log.found===1?'':'s'} found to process`));
      wrap.appendChild(box);
      wrap.appendChild(calendarSyncBox(s));
      wrap.appendChild(calendarLinksBox());
    }

    if(!s.configured){
      wrap.appendChild(div({style:{fontSize:13,color:'var(--muted)',lineHeight:1.5}},
        'cloud-config.js has no project URL or key in it.'));
      wrap.appendChild(btn({className:'btn-ghost',style:{width:'100%'},onClick:closeModal},'Close'));
      return wrap;
    }

    if(!s.signedIn){
      wrap.appendChild(div({style:{fontSize:12.5,color:'var(--muted)',lineHeight:1.5}},
        'Sign in to keep a copy in the cloud and to give your house help her own view. StayLog works the same either way — this phone stays the master copy.'));
      const em=h('input',{type:'email',placeholder:'Email',autocomplete:'username'});
      const pw=h('input',{type:'password',placeholder:'Password',autocomplete:'current-password'});
      wrap.appendChild(em);wrap.appendChild(pw);
      const go=btn({className:'btn-primary',style:{width:'100%'}},'Sign in');
      go.addEventListener('click',async()=>{
        if(!em.value||!pw.value)return;
        go.disabled=true;go.textContent='Signing in…';
        try{
          await window.StayLogCloud.signIn(em.value,pw.value);
          render();
        }catch(err){
          go.disabled=false;go.textContent='Sign in';
          alert('Could not sign in: '+(err.message||err));
        }
      });
      wrap.appendChild(go);
      wrap.appendChild(btn({className:'btn-ghost',style:{width:'100%'},onClick:closeModal},'Not now'));
      return wrap;
    }

    const sync=btn({className:'btn-primary',style:{width:'100%'}},
      ico('cloud-upload',{style:{marginRight:7,fontSize:17}}),'Sync now');
    sync.addEventListener('click',async()=>{
      sync.disabled=true;sync.textContent='Syncing…';
      try{ await window.StayLogCloud.push(state.data,{manual:true}); render(); }
      catch(err){
        // A paused sync is his own Cancel, and the panel already says what it would delete.
        if(cloudStatus().brake){ render(); return; }
        sync.disabled=false; sync.textContent='Sync now'; alert('Sync failed: '+(err.message||err)); }
    });
    wrap.appendChild(sync);

    wrap.appendChild(div({style:{fontSize:12,color:'var(--muted)',lineHeight:1.5}},
      'Syncs on its own a few seconds after any change, and again when you come back online. Only dates, guest counts, property names and Laxmi\u2019s wages go up; names, phone numbers, amounts and notes stay on this phone and in the encrypted backup.'));

    // ── Encrypted backup ─────────────────────────────────────────────────────
    { const b=bkStatus();
      wrap.appendChild(btn({'data-open-backup':'1',style:{display:'flex',alignItems:'center',gap:11,width:'100%',textAlign:'left',
        padding:'11px 12px',border:'1px solid var(--border)',borderRadius:'var(--radius-sm)',background:'var(--surface-2)'},
        onClick:openBackupPanel},
        ico('lock',{style:{fontSize:18,color:'var(--accent)'}}),
        div({style:{flex:1,minWidth:0}},div({style:{fontSize:13.5,fontWeight:700}},'Encrypted backup'),
          div({style:{fontSize:12,color:b.lastError?'var(--danger)':'var(--muted)',marginTop:1}},bkSubtitle())),
        ico('chevron-right',{style:{fontSize:16,color:'var(--light)'}}))); }

    // No "replace this phone from the cloud": the cloud holds only what Laxmi's
    // page and the reminders need, so a pull would wipe the phone.
    wrap.appendChild(div({'data-new-phone':'1',style:{fontSize:12,color:'var(--muted)',lineHeight:1.5}},
      'New phone? Sign in, then Encrypted backup → Restore from backup. The cloud itself keeps only what Laxmi\u2019s page and the reminders need.'));

    wrap.appendChild(btn({className:'btn-danger',style:{width:'100%'},onClick:async()=>{
      if(!confirm('Sign out of the cloud? Your data stays on this phone.'))return;
      await window.StayLogCloud.signOut();render();
    }},'Sign out'));
    wrap.appendChild(btn({className:'btn-ghost',style:{width:'100%'},onClick:closeModal},'Close'));
    return wrap;
  };
  return modal('Cloud sync',content);
}

// ─── Guest message sheet ──────────────────────────────────────────────────────
function hintLine(t){
  return div({style:{fontSize:11.5,color:'var(--muted)',lineHeight:1.45,padding:'0 4px',marginTop:-4}},t);
}
function renderSendModal(){
  const b=state.editItem;
  if(!b)return modal('Send to guest',()=>div({}));
  const prop=state.data.properties.find(p=>p.id===b.propertyId);
  const num=waNumber(b.phone);
  const due=new Set(dueMessages([b]).map(x=>x.kind));
  // Opened from a reminder: that message is the one waiting to be sent.
  const focus=state.sendFocus&&state.sendFocus.id===b.id?state.sendFocus.kind:'';
  if(focus)due.add(focus);

  const content=()=>{
    const wrap=div({style:{display:'flex',flexDirection:'column',gap:10}});
    wrap.appendChild(div({style:{background:'var(--surface-2)',border:'1px solid var(--border)',
      borderRadius:'var(--radius-sm)',padding:'12px 13px'}},
      div({style:{fontSize:14.5,fontWeight:700}},b.guestName),
      div({style:{fontSize:12.5,color:'var(--muted)',marginTop:2}},
        `${fmtDate(b.checkIn)} → ${fmtDate(b.checkOut)} · ${prop?.name||''}`),
      div({style:{fontSize:12.5,color:num?'var(--accent)':'var(--danger)',fontWeight:600,marginTop:4}},
        num?`+${num}`:'No usable phone number on this booking')
    ));

    MSG_KINDS.forEach(([kind,label,icon,when])=>{
      const sent=msgSentOn(b,kind);
      const isDue=due.has(kind);
      const row=div({...(focus===kind?{'data-send-focus':'1'}:{}),style:{display:'flex',alignItems:'center',gap:11,padding:'11px 12px',
        border:`1.5px solid ${isDue?'var(--accent)':'var(--border)'}`,borderRadius:'var(--radius-sm)',
        background:isDue?'var(--accent-light)':'transparent'}});
      row.appendChild(div({style:{width:34,height:34,borderRadius:9,flexShrink:0,display:'flex',
        alignItems:'center',justifyContent:'center',background:'var(--white)',border:'1px solid var(--border)'}},
        ico(icon,{style:{fontSize:16,color:isDue?'var(--accent)':'var(--muted)'}})));
      row.appendChild(div({style:{flex:1,minWidth:0}},
        div({style:{fontSize:13.5,fontWeight:700}},label),
        div({style:{fontSize:11.5,color:'var(--muted)',marginTop:1}},
          sent?`Opened ${fmtDate(sent)}`:isDue?'Due now':when)
      ));
      row.appendChild(btn({disabled:!num,'data-send':kind,style:{flexShrink:0,minHeight:36,padding:'7px 13px',fontSize:12.5,
        fontWeight:700,borderRadius:20,border:`1.5px solid ${num?'var(--accent)':'var(--border)'}`,
        background:isDue&&!sent?'var(--accent)':'transparent',
        color:isDue&&!sent?'var(--on-accent)':num?'var(--accent)':'var(--light)'},
        onClick:()=>sendMessage(b,kind)},sent?'Resend':'Send'));
      wrap.appendChild(row);

      if(kind==='arrival'&&!prop?.mapsLink)
        wrap.appendChild(hintLine('No Google Maps link on this property — the arrival message falls back to the address. Add one from the property list.'));
      if(kind==='stay'&&!prop?.wifiName)
        wrap.appendChild(hintLine('No Wi-Fi details on this property — the welcome message skips that line.'));
    });

    // ── Payment request: any time, but only to a guest who pays us and owes ──
    const askable=canAskForPayment(b);
    if(askable){
      const sent=msgSentOn(b,'payment');
      const row=div({'data-pay-row':'1',...(focus==='payment'?{'data-send-focus':'1'}:{}),style:{display:'flex',alignItems:'center',gap:11,padding:'11px 12px',
        border:'1.5px solid var(--gold-line)',borderRadius:'var(--radius-sm)',background:'var(--gold-light)'}});
      row.appendChild(div({style:{width:34,height:34,borderRadius:9,flexShrink:0,display:'flex',
        alignItems:'center',justifyContent:'center',background:'var(--white)',border:'1px solid var(--border)'}},
        ico('currency-rupee',{style:{fontSize:16,color:'var(--gold)'}})));
      row.appendChild(div({style:{flex:1,minWidth:0}},
        div({style:{fontSize:13.5,fontWeight:700}},'Payment request'),
        div({style:{fontSize:11.5,color:'var(--muted)',marginTop:1}},
          `${fmtCur(balanceDue(b))} due${sent?` · opened ${fmtDate(sent)}`:''}`)));
      row.appendChild(btn({disabled:!num,'data-send':'payment',style:{flexShrink:0,minHeight:36,padding:'7px 13px',fontSize:12.5,
        fontWeight:700,borderRadius:20,border:`1.5px solid ${num?'var(--gold)':'var(--border)'}`,background:'transparent',
        color:num?'var(--gold)':'var(--light)'},onClick:()=>sendMessage(b,'payment')},sent?'Resend':'Send'));
      wrap.appendChild(row);
    } else if(!paysUsDirectly(b)){
      wrap.appendChild(hintLine(`${bookingSource(b)} collects payment from the guest, so no balance or payment details are ever sent for this stay.`));
    } else if(b.status!=='cancelled'&&balanceDue(b)>0){
      wrap.appendChild(hintLine(`${fmtCur(balanceDue(b))} is due, but this property has no payment details yet. Add a UPI ID or bank details in the property settings to send a payment request.`));
    }

    wrap.appendChild(div({className:'kicker',style:{marginTop:8,marginBottom:-2}},'Attachments'));
    if(askable&&prop.upiQr)wrap.appendChild(btn({className:'btn-gold','data-pay-qr-share':'1',style:{width:'100%',justifyContent:'center',display:'flex',
      alignItems:'center',gap:7,minHeight:46},onClick:()=>sharePaymentQR(b)},
      ico('qrcode',{style:{fontSize:16}}),'UPI QR code'));
    wrap.appendChild(btn({className:'btn-gold',style:{width:'100%',justifyContent:'center',display:'flex',
      alignItems:'center',gap:7,minHeight:46},onClick:()=>shareConfirmation(b)},
      ico('file-text',{style:{fontSize:16}}),'Booking confirmation PDF'));
    wrap.appendChild(btn({className:'btn-gold',style:{width:'100%',justifyContent:'center',display:'flex',
      alignItems:'center',gap:7,minHeight:46},onClick:()=>shareHouseNotes(prop)},
      ico('notes',{style:{fontSize:16}}),'House notes PDF'));
    if(canReceipt(b))wrap.appendChild(btn({className:'btn-gold',style:{width:'100%',justifyContent:'center',display:'flex',
      alignItems:'center',gap:7,minHeight:46},onClick:()=>shareReceipt(b)},
      ico('receipt',{style:{fontSize:16}}),b.receiptNo?`Receipt ${b.receiptNo}`:'Receipt'));
    else wrap.appendChild(hintLine(`${bookingSource(b)||'This platform'} collects payment from the guest, so there is no receipt to give for this stay.`));
    wrap.appendChild(div({style:{fontSize:12,color:'var(--muted)',lineHeight:1.55,background:'var(--warn-light)',
      border:'1px solid var(--warn-line)',borderRadius:'var(--radius-sm)',padding:'10px 12px'}},
      'WhatsApp links cannot carry a file. Send a message first, then tap an attachment above and pick the same chat from the share sheet. The house notes are the ones to send once they have checked in.'));
    wrap.appendChild(btn({className:'btn-ghost',style:{width:'100%'},onClick:closeModal},'Close'));
    if(focus)setTimeout(()=>{const el=wrap.querySelector('[data-send-focus="1"]');
      if(el&&el.scrollIntoView)el.scrollIntoView({block:'center'});},60);
    return wrap;
  };
  return modal('Send to guest',content);
}

function renderCalDayModal(){
  const{date,bookings:dayBookings}=state.editItem;
  const content=()=>{
    const wrap=div({style:{display:'flex',flexDirection:'column',gap:10}});
    wrap.appendChild(div({style:{fontSize:13,color:'var(--muted)',marginBottom:4}},fmtDateLong(date)));
    dayBookings.forEach(b=>{
      const prop=state.data.properties.find(p=>p.id===b.propertyId);
      const nights=diffDays(b.checkIn,b.checkOut);
      const card=div({style:{background:'var(--cream)',borderRadius:10,padding:'12px',border:'1px solid var(--border)'}});
      card.appendChild(div({style:{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:6}},
        div({},div({style:{fontWeight:600,fontSize:14}},b.guestName),div({style:{fontSize:12,color:'var(--muted)',marginTop:2}},`${prop?.name||'—'} · ${nights} nights`)),
        badge(b.status)
      ));
      card.appendChild(div({style:{fontSize:12,color:'var(--muted)'}},`${fmtDate(b.checkIn)} → ${fmtDate(b.checkOut)}`));
      const acts=div({style:{display:'flex',gap:6,marginTop:8,flexWrap:'wrap'}});
      acts.appendChild(btn({className:'btn-ghost btn-sm',onClick:()=>{closeModal();setState({modal:'addBooking',editItem:b});}},ico('edit',{style:{marginRight:3}}),'Edit'));
      if(waNumber(b.phone))acts.appendChild(btn({className:'btn-ghost btn-sm',style:{padding:'6px 10px',fontSize:12,color:'var(--accent)',borderColor:'var(--accent-line)'},onClick:()=>{closeModal();setState({modal:'sendConfirm',editItem:b});}},ico('brand-whatsapp',{style:{marginRight:3,fontSize:14}}),'Send'));
      acts.appendChild(btn({className:'btn-gold btn-sm',style:{padding:'6px 10px',fontSize:12},onClick:()=>downloadConfirmation(b)},ico('file-text',{style:{marginRight:3,fontSize:13}}),'PDF'));
      card.appendChild(acts);wrap.appendChild(card);
    });
    return wrap;
  };
  return modal(`Bookings — ${MONTH_SHORT[new Date(date+'T00:00:00').getMonth()]} ${new Date(date+'T00:00:00').getDate()}`,content);
}

// ─── Dashboard ────────────────────────────────────────────────────────────────
function nightsInMonth(b,y,m){
  const s=new Date(b.checkIn+'T00:00:00'), e=new Date(b.checkOut+'T00:00:00');
  const ms=new Date(y,m,1), me=new Date(y,m+1,1);
  const from=s>ms?s:ms, to=e<me?e:me;
  return Math.max(0,Math.round((to-from)/86400000));
}
function monthTotals(bookings,expenses,y,m){
  const rev=bookings.filter(b=>b.status!=='cancelled').filter(b=>{
    const d=new Date(b.checkIn+'T00:00:00');return d.getFullYear()===y&&d.getMonth()===m;
  }).reduce((s,b)=>s+bookingRevenue(b),0);
  const exp=expenses.filter(e=>{
    const d=new Date(e.date+'T00:00:00');return d.getFullYear()===y&&d.getMonth()===m;
  }).reduce((s,e)=>s+Number(e.amount||0),0);
  return{rev,exp,net:rev-exp};
}

function renderDashboard(){
  const{data,filterProp,dashMonth}=state;
  const allB=filterProp==='all'?data.bookings:data.bookings.filter(b=>b.propertyId===filterProp);
  const allE=filterProp==='all'?data.expenses:data.expenses.filter(e=>e.propertyId===filterProp);
  const props=filterProp==='all'?data.properties:data.properties.filter(p=>p.id===filterProp);
  const wrap=div({style:{padding:'12px 12px 104px',display:'flex',flexDirection:'column',gap:11}});

  if(data.properties.length===0){
    wrap.appendChild(div({style:{textAlign:'center',padding:'64px 20px'}},
      ico('home',{style:{fontSize:48,color:'var(--light)',display:'block',marginBottom:16}}),
      h('div',{className:'display',style:{fontSize:23,marginBottom:8}},'Welcome to StayLog'),
      h('div',{style:{color:'var(--muted)',fontSize:14,marginBottom:24,lineHeight:1.6}},'Add a property to get started.'),
      btn({className:'btn-primary',onClick:()=>setState({modal:'addProp'})},ico('plus',{style:{marginRight:6}}),'Add First Property')
    ));
    return wrap;
  }

  // Month selector
  wrap.appendChild(div({style:{display:'flex',justifyContent:'center',alignItems:'center',paddingTop:2}},
    monthSelector(dashMonth,m=>setState({dashMonth:m}))));

  // ── Hero: one figure, with the trend behind it ─────────────────────────────
  const bookings=filterByMonth(allB,'checkIn',dashMonth);
  const expenses=filterByMonth(allE,'date',dashMonth);
  const revenue=sumRevenue(bookings.filter(b=>b.status!=='cancelled'));
  const spend=expenses.reduce((s,e)=>s+Number(e.amount||0),0);
  const net=revenue-spend;

  const hero=div({className:'card',style:{padding:'14px 15px 13px',borderColor:'var(--gold-line)'}});
  hero.appendChild(div({className:'kicker'},dashMonth?'Net this month':'Net · all time'));
  hero.appendChild(div({className:'display num',style:{fontSize:31,lineHeight:1.15,marginTop:3,
    color:net<0?'var(--danger)':'var(--text)'}},fmtCur(net)));

  if(dashMonth){
    const prev=new Date(dashMonth.year,dashMonth.month-1,1);
    const p=monthTotals(allB,allE,prev.getFullYear(),prev.getMonth());
    if(p.net!==0){
      const pct=Math.round((net-p.net)/Math.abs(p.net)*100);
      hero.appendChild(div({style:{fontSize:12,fontWeight:700,marginTop:2,color:pct>=0?'var(--info)':'var(--danger)'}},
        `${pct>=0?'▲':'▼'} ${Math.abs(pct)}% `,
        span({style:{color:'var(--muted)',fontWeight:400}},`vs ${MONTH_SHORT[prev.getMonth()]}`)));
    }
    // 6-month sparkline
    const buckets=[];
    for(let i=5;i>=0;i--){
      const d=new Date(dashMonth.year,dashMonth.month-i,1);
      buckets.push({m:d.getMonth(),...monthTotals(allB,allE,d.getFullYear(),d.getMonth())});
    }
    const peak=Math.max(...buckets.map(b=>Math.abs(b.net)),1);
    const bars=div({style:{display:'flex',alignItems:'flex-end',gap:5,height:36,marginTop:10}});
    buckets.forEach((b,i)=>bars.appendChild(div({style:{flex:1,background:b.net<0?'var(--danger)':'var(--gold)',
      opacity:i===5?1:.32,borderRadius:'3px 3px 0 0',height:Math.max(3,Math.abs(b.net)/peak*36)+'px'}})));
    hero.appendChild(bars);
    hero.appendChild(div({style:{display:'flex',gap:5,marginTop:4}},
      ...buckets.map(b=>div({style:{flex:1,textAlign:'center',fontSize:8.5,color:'var(--muted)'}},MONTH_SHORT[b.m]))));
  }
  const split=div({style:{display:'flex',gap:14,borderTop:'1px solid var(--border-soft)',marginTop:11,paddingTop:10}});
  [['Revenue',revenue,'var(--text)'],['Expenses',spend,'var(--text)']].forEach(([l,v,c])=>{
    split.appendChild(div({style:{flex:1}},div({className:'kicker'},l),
      div({className:'num',style:{fontSize:15,fontWeight:700,color:c,marginTop:2}},fmtCur(v))));
  });
  hero.appendChild(split);
  wrap.appendChild(hero);

  // ── Calendar trouble ───────────────────────────────────────────────────────
  {
    const clashed=allB.filter(b=>b.status!=='cancelled'&&clashesFor(b).length);
    const gone=allB.filter(b=>b.icalGone&&b.status!=='cancelled'&&b.checkOut>today());
    const open=allB.filter(b=>openGapsFor(b).length);
    if(clashed.length||gone.length||open.length){
      const pairs=Math.round(clashed.reduce((n,b)=>n+clashesFor(b).length,0)/2);
      wrap.appendChild(div({className:'card','data-cal-alert':'1',style:{padding:'11px 13px',cursor:'pointer',
        borderColor:clashed.length?'var(--danger)':open.length?'var(--warn)':'var(--gold-line)'},
        onClick:()=>setState({tab:'bookings',bookingFilter:'all'})},
        clashed.length?div({style:{fontSize:13,fontWeight:700,color:'var(--danger)',display:'flex',alignItems:'center',gap:7}},
          ico('alert-triangle',{style:{fontSize:16}}),`${pairs} double booking${pairs===1?'':'s'}`):null,
        clashed.length?div({style:{fontSize:12,color:'var(--text-mid)',marginTop:3,lineHeight:1.5}},
          clashed.map(b=>`${b.guestName} ${fmtDate(b.checkIn)}`).join(' · ')):null,
        open.length?div({'data-open-count':String(open.length),style:{fontSize:12.5,fontWeight:600,color:'var(--warn)',marginTop:clashed.length?7:0}},
          `${open.length} stay${open.length===1?' is':'s are'} still open on another platform — `
          +[...new Set(open.flatMap(b=>openGapsFor(b).map(g=>g.platform)))].join(' and ')):null,
        gone.length?div({style:{fontSize:12.5,fontWeight:600,color:'var(--gold)',marginTop:clashed.length||open.length?7:0}},
          `${gone.length} imported stay${gone.length===1?' is':'s are'} no longer on the platform — cancelled?`):null));
    }
  }

  // ── Today ──────────────────────────────────────────────────────────────────
  const t=today();
  const todayIn=allB.filter(b=>b.checkIn===t&&b.status==='confirmed');
  const todayOut=allB.filter(b=>b.checkOut===t&&b.status==='checkedin');
  if(todayIn.length||todayOut.length){
    const card=div({className:'card',style:{overflow:'hidden'}});
    card.appendChild(div({style:{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'10px 13px 8px'}},
      div({style:{fontSize:12.5,fontWeight:700}},`Today · ${fmtDate(t).replace(/,.*$/,'')}`),
      div({style:{fontSize:11,color:'var(--muted)',fontWeight:600}},`${todayIn.length+todayOut.length} to handle`)));
    const line=(b,kind)=>{
      const prop=data.properties.find(p=>p.id===b.propertyId);
      const due=balanceDue(b);
      return div({style:{display:'flex',alignItems:'center',gap:11,padding:'9px 13px',borderTop:'1px solid var(--border-soft)'}},
        dateBlock(t,'accent'),
        div({style:{flex:1,minWidth:0}},
          div({style:{fontSize:13,fontWeight:700,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}},b.guestName),
          div({style:{fontSize:11.5,color:'var(--muted)',marginTop:1,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}},
            kind==='in'?`Arriving · ${b.guests||1} guest${(b.guests||1)>1?'s':''} · ${diffDays(b.checkIn,b.checkOut)} nights`
                       :`Checking out${due>0?` · ${fmtCur(due)} due`:''}${prop&&filterProp==='all'?' · '+prop.name:''}`)),
        btn({style:{flexShrink:0,minHeight:36,padding:'7px 12px',fontSize:12,fontWeight:700,borderRadius:20,
          border:'1.5px solid var(--accent)',background:'transparent',color:'var(--accent)'},
          onClick:()=>updateStatus(b.id,kind==='in'?'checkedin':'checkedout')},kind==='in'?'Check in':'Check out'));
    };
    todayOut.forEach(b=>card.appendChild(line(b,'out')));
    todayIn.forEach(b=>card.appendChild(line(b,'in')));
    wrap.appendChild(card);
  }

  // ── Three stats ────────────────────────────────────────────────────────────
  if(dashMonth){
    const rooms=props.reduce((s,p)=>s+(Number(p.rooms)||0),0);
    const daysIn=new Date(dashMonth.year,dashMonth.month+1,0).getDate();
    const nights=allB.filter(b=>b.status!=='cancelled')
      .reduce((s,b)=>s+nightsInMonth(b,dashMonth.year,dashMonth.month),0);
    const occ=rooms>0?Math.round(nights/(rooms*daysIn)*100):null;
    const avg=nights>0?Math.round(revenue/nights):0;
    const stats=div({style:{display:'flex',gap:8}});
    [['Occupancy',occ===null?'—':occ+'%'],['Nights',String(nights)],['Avg tariff',avg?fmtCur(avg):'—']]
      .forEach(([l,v])=>stats.appendChild(div({className:'card',style:{flex:1,padding:'9px 11px'}},
        div({className:'kicker'},l),
        div({className:'num',style:{fontSize:15,fontWeight:700,marginTop:2}},v))));
    wrap.appendChild(stats);
  }

  // ── Staff loans ────────────────────────────────────────────────────────────
  const openLoans=data.loans.filter(l=>l.status!=='writtenoff'&&loanBalance(l)>0.5);
  if(openLoans.length>0){
    const outstanding=round2(openLoans.reduce((s,l)=>s+loanBalance(l),0));
    const overdue=round2(openLoans.reduce((s,l)=>s+loanOverdue(l),0));
    wrap.appendChild(div({style:{display:'flex',alignItems:'center',gap:11,padding:'11px 13px',
      borderRadius:'var(--radius)',background:'var(--gold-light)',border:'1px solid var(--gold-line)',cursor:'pointer'},
      onClick:()=>setState({tab:'loans'})},
      div({style:{width:32,height:32,borderRadius:9,background:'var(--white)',display:'flex',alignItems:'center',
        justifyContent:'center',flexShrink:0}},ico('wallet',{style:{fontSize:17,color:'var(--gold)'}})),
      div({style:{flex:1,minWidth:0}},
        div({style:{fontSize:12.5,fontWeight:700}},`Staff loans · ${openLoans.length} running`),
        div({style:{fontSize:11.5,color:overdue>0?'var(--danger)':'var(--muted)',marginTop:1}},
          overdue>0?`${fmtCur(overdue)} behind schedule`:'On schedule')),
      div({style:{textAlign:'right',flexShrink:0}},
        div({className:'num',style:{fontSize:15,fontWeight:700,color:'var(--gold)'}},fmtCur(outstanding)),
        div({style:{fontSize:9.5,color:'var(--muted)'}},'outstanding'))
    ));
  }

  // ── Upcoming ───────────────────────────────────────────────────────────────
  const upcoming=allB.filter(b=>b.status!=='cancelled'&&b.checkOut>=t)
    .sort((a,b)=>String(a.checkIn).localeCompare(String(b.checkIn))).slice(0,4);
  wrap.appendChild(div({style:{display:'flex',justifyContent:'space-between',alignItems:'baseline',padding:'6px 2px 0'}},
    h('div',{className:'display',style:{fontSize:16}},'Upcoming'),
    btn({style:{fontSize:12,fontWeight:700,color:'var(--accent)',padding:'4px 2px',minHeight:0},
      onClick:()=>setState({tab:'bookings'})},'See all')));
  if(upcoming.length===0){
    wrap.appendChild(div({className:'card',style:{padding:'22px',textAlign:'center'}},
      div({style:{color:'var(--muted)',fontSize:13.5,marginBottom:12}},'Nothing on the calendar yet'),
      btn({className:'btn-primary btn-sm',onClick:()=>setState({modal:'addBooking',editItem:null})},'Add booking')));
  } else {
    const list=div({});
    upcoming.forEach(b=>list.appendChild(bookingCard(b)));
    wrap.appendChild(list);
  }

  wrap.appendChild(btn({className:'btn-primary',style:{width:'100%',marginTop:4},
    onClick:()=>setState({modal:'addBooking',editItem:null})},ico('plus',{style:{marginRight:7}}),'New Booking'));
  return wrap;
}

// ─── Bookings Tab ─────────────────────────────────────────────────────────────
function renderBookings(){
  const{data,filterProp,bookingFilter}=state;
  const all=filterProp==='all'?data.bookings:data.bookings.filter(b=>b.propertyId===filterProp);
  const filtered=bookingFilter==='all'?all:all.filter(b=>b.status===bookingFilter);
  const sorted=[...filtered].sort((a,b)=>new Date(b.checkIn)-new Date(a.checkIn));
  const wrap=div({style:{padding:'12px 12px 104px'}});
  wrap.appendChild(div({style:{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:11}},
    h('div',{className:'display',style:{fontSize:21}},'Bookings'),
    div({style:{display:'flex',gap:7}},
      btn({className:'btn-ghost btn-sm','aria-label':'Calendar',onClick:()=>setState({tab:'calendar',stayHint:null})},
        ico('calendar-month',{style:{fontSize:16}})),
      btn({className:'btn-primary btn-sm',onClick:()=>setState({modal:'addBooking',editItem:null})},
        ico('plus',{style:{marginRight:4}}),'Add'))
  ));
  const counts=s=>s==='all'?all.length:all.filter(b=>b.status===s).length;
  const chips=div({style:{display:'flex',gap:6,marginBottom:12,overflowX:'auto',paddingBottom:2,scrollbarWidth:'none'}});
  [['all','All'],['confirmed','Confirmed'],['checkedin','In'],['checkedout','Out'],['cancelled','Cancelled']].forEach(([s,l])=>{
    const on=bookingFilter===s;
    chips.appendChild(btn({style:{padding:'6px 12px',minHeight:34,borderRadius:20,whiteSpace:'nowrap',
      border:`1.5px solid ${on?'var(--accent)':'var(--border)'}`,background:on?'var(--accent-light)':'var(--white)',
      color:on?'var(--accent)':'var(--muted)',fontSize:12.5,fontWeight:on?700:600},
      onClick:()=>setState({bookingFilter:s})},`${l} ${counts(s)}`));
  });
  wrap.appendChild(chips);
  if(state.stayHint)wrap.appendChild(div({'data-stay-hint':'1',style:{fontSize:12.5,color:'var(--text-mid)',lineHeight:1.5,
    background:'var(--surface-2)',border:'1px solid var(--border)',borderRadius:'var(--radius-sm)',padding:'9px 12px',marginBottom:12}},
    state.stayHint));
  if(sorted.length===0)wrap.appendChild(div({style:{textAlign:'center',padding:'40px 20px',color:'var(--muted)',fontSize:14}},'No bookings found'));
  else sorted.forEach(b=>wrap.appendChild(bookingCard(b)));
  return wrap;
}

// ─── Expenses Tab ─────────────────────────────────────────────────────────────
const CAT_META={
  maintenance:{label:'Maintenance',icon:'tool'},
  utilities  :{label:'Utilities',  icon:'bulb'},
  supplies   :{label:'Supplies',   icon:'shopping-cart'},
  staff      :{label:'Staff',      icon:'user'},
  marketing  :{label:'Marketing',  icon:'speakerphone'},
  other      :{label:'Other',      icon:'package'},
};
function catIcon(cat,size){
  const m=CAT_META[cat]||CAT_META.other;
  return div({style:{width:size||34,height:size||34,borderRadius:9,flexShrink:0,background:'var(--surface-2)',
    display:'flex',alignItems:'center',justifyContent:'center'}},
    ico(m.icon,{style:{fontSize:16,color:'var(--text-mid)'}}));
}

function renderExpenses(){
  const{data,filterProp,expandedExpense}=state;
  const expenses=(filterProp==='all'?data.expenses:data.expenses.filter(e=>e.propertyId===filterProp))
    .sort((a,b)=>String(b.date).localeCompare(String(a.date)));
  const total=expenses.reduce((s,e)=>s+Number(e.amount||0),0);
  const totalPaid=expenses.filter(e=>e.paid).reduce((s,e)=>s+Number(e.amount||0),0);
  const wrap=div({style:{padding:'12px 12px 104px'}});
  wrap.appendChild(div({style:{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:11}},
    h('div',{className:'display',style:{fontSize:21}},'Expenses'),
    btn({className:'btn-primary btn-sm',onClick:()=>setState({modal:'addExpense',editItem:null})},
      ico('plus',{style:{marginRight:4}}),'Add')
  ));
  const sg=div({style:{display:'flex',gap:8,marginBottom:12}});
  [['Total',total,'var(--text)'],['Paid',totalPaid,'var(--accent)'],['Unpaid',total-totalPaid,'var(--warn)']].forEach(([l,v,c])=>{
    sg.appendChild(div({className:'card',style:{flex:1,padding:'9px 11px'}},
      div({className:'kicker'},l),
      div({className:'num',style:{fontSize:15,fontWeight:700,color:c,marginTop:2}},fmtCur(v))));
  });
  wrap.appendChild(sg);

  if(expenses.length===0){
    wrap.appendChild(div({style:{textAlign:'center',padding:'40px 20px',color:'var(--muted)',fontSize:14}},'No expenses logged yet'));
    return wrap;
  }
  expenses.forEach(e=>{
    const prop=data.properties.find(p=>p.id===e.propertyId);
    const ded=round2(e.loanDeduction);
    const open=expandedExpense===e.id;
    const card=div({className:'card',style:{marginBottom:8,overflow:'hidden'}});
    const row=div({style:{display:'flex',alignItems:'center',gap:11,padding:'10px 12px',cursor:'pointer'},
      onClick:()=>setState({expandedExpense:open?null:e.id})});
    row.appendChild(catIcon(e.category));
    row.appendChild(div({style:{flex:1,minWidth:0}},
      div({style:{fontSize:13.5,fontWeight:700,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}},e.description),
      div({style:{fontSize:11.5,color:'var(--muted)',marginTop:1,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}},
        `${fmtDate(e.date)}${e.staffId?' · '+staffName(e.staffId):''}${prop&&filterProp==='all'?' · '+prop.name:''}`)
    ));
    row.appendChild(div({style:{textAlign:'right',flexShrink:0}},
      div({className:'num',style:{fontSize:13.5,fontWeight:700}},fmtCur(e.amount)),
      div({style:{fontSize:10,fontWeight:700,marginTop:1,color:e.paid?'var(--muted)':'var(--warn)'}},e.paid?'paid':'unpaid')
    ));
    card.appendChild(row);

    if(e.loanId&&ded>0){
      card.appendChild(div({style:{display:'flex',justifyContent:'space-between',alignItems:'center',gap:8,
        padding:'7px 12px',fontSize:11.5,borderTop:'1px solid var(--border-soft)',
        background:e.paid?'var(--accent-light)':'var(--warn-light)',color:e.paid?'var(--accent)':'var(--warn)'}},
        div({style:{display:'flex',alignItems:'center',gap:6,minWidth:0}},ico('wallet',{style:{fontSize:14}}),
          `Payout ${fmtCur(e.grossAmount||round2(Number(e.amount||0)+ded))} − loan ${fmtCur(ded)}`),
        span({style:{fontWeight:700,flexShrink:0}},e.paid?'credited':'pending')));
    }

    if(open){
      const detail=div({style:{borderTop:'1px solid var(--border-soft)',padding:'11px 12px 12px',background:'var(--surface-2)'}});
      if(e.notes)detail.appendChild(div({style:{fontSize:12.5,color:'var(--muted)',fontStyle:'italic',marginBottom:10,
        background:'var(--white)',padding:'8px 10px',borderRadius:8,border:'1px solid var(--border)'}},`"${e.notes}"`));
      detail.appendChild(div({style:{fontSize:12,color:'var(--muted)',marginBottom:10}},
        `${(CAT_META[e.category]||CAT_META.other).label} · ${prop?.name||'—'}`));
      const acts=div({style:{display:'flex',gap:7,flexWrap:'wrap'}});
      acts.appendChild(btn({className:e.paid?'btn-ghost btn-sm':'btn-primary btn-sm',
        onClick:()=>mutateData(d=>{
          const upd={...e,paid:!e.paid};
          d.expenses=d.expenses.map(x=>x.id===e.id?upd:x);
          syncExpenseLoan(d,upd);
        })},ico(e.paid?'circle':'circle-check',{style:{marginRight:5,fontSize:14}}),e.paid?'Mark unpaid':'Mark as paid'));
      acts.appendChild(btn({className:'btn-ghost btn-sm',onClick:()=>setState({modal:'addExpense',editItem:e})},
        ico('edit',{style:{marginRight:4,fontSize:14}}),'Edit'));
      acts.appendChild(btn({className:'btn-danger btn-sm',onClick:()=>{
        if(!confirm(e.loanId&&ded>0?`Delete this payout? The ${fmtCur(ded)} credited against ${staffName(e.staffId)}'s loan will be reversed.`:'Delete this expense?'))return;
        mutateData(d=>{d.expenses=d.expenses.filter(x=>x.id!==e.id);unlinkExpenseLoan(d,e.id);});
        setState({expandedExpense:null});
      }},ico('trash',{style:{marginRight:4,fontSize:14}}),'Delete'));
      detail.appendChild(acts);
      card.appendChild(detail);
    }
    wrap.appendChild(card);
  });
  return wrap;
}

// ─── Reports Tab ──────────────────────────────────────────────────────────────
function renderReports(){
  const{data,filterProp,reportMonth}=state;
  let bookings=filterProp==='all'?data.bookings:data.bookings.filter(b=>b.propertyId===filterProp);
  let expenses=filterProp==='all'?data.expenses:data.expenses.filter(e=>e.propertyId===filterProp);
  bookings=filterByMonth(bookings,'checkIn',reportMonth);
  expenses=filterByMonth(expenses,'date',reportMonth);
  const yr=reportMonth?reportMonth.year:new Date().getFullYear();
  const monthlyRev=Array(12).fill(0),monthlyExp=Array(12).fill(0);
  bookings.filter(b=>b.status!=='cancelled'&&new Date(b.checkIn).getFullYear()===yr).forEach(b=>monthlyRev[new Date(b.checkIn).getMonth()]+=bookingRevenue(b));
  expenses.filter(e=>new Date(e.date).getFullYear()===yr).forEach(e=>monthlyExp[new Date(e.date).getMonth()]+=Number(e.amount||0));
  const maxVal=Math.max(...monthlyRev,...monthlyExp,1);
  const totalRev=monthlyRev.reduce((a,b)=>a+b,0),totalExp=monthlyExp.reduce((a,b)=>a+b,0);
  const periodLabel=reportMonth?`${MONTH_NAMES[reportMonth.month]}-${reportMonth.year}`:`${yr}-Full-Year`;
  const wrap=div({style:{padding:'14px 12px 100px'}});
  wrap.appendChild(div({style:{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:14}},
    h('div',{style:{fontFamily:'var(--display)',fontSize:20}},'Reports'),
    div({style:{display:'flex',alignItems:'center',gap:8}},
      monthSelector(reportMonth,m=>setState({reportMonth:m})),
      btn({title:'Download CSV',style:{background:'var(--accent-light)',border:'1.5px solid var(--accent)',color:'var(--accent)',borderRadius:'var(--radius-sm)',padding:'7px 10px',cursor:'pointer',display:'flex',alignItems:'center',gap:5,fontSize:13,fontWeight:600},onClick:()=>downloadReport(bookings,expenses,periodLabel)},ico('file-spreadsheet',{style:{fontSize:16}}),'CSV')
    )
  ));
  const summaryGrid=div({style:{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10,marginBottom:16}});
  [{label:'Revenue',val:fmtCur(totalRev),col:'var(--accent)'},{label:'Expenses',val:fmtCur(totalExp),col:'var(--danger)'},{label:'Net Profit',val:fmtCur(totalRev-totalExp),col:totalRev-totalExp>=0?'var(--accent)':'var(--danger)'},{label:'Bookings',val:bookings.filter(b=>b.status!=='cancelled').length,col:'var(--info)'}].forEach(s=>{
    summaryGrid.appendChild(div({className:'card',style:{padding:'14px'}},div({style:{fontSize:11,color:'var(--muted)',fontWeight:600,textTransform:'uppercase',letterSpacing:'0.06em',marginBottom:6}},s.label),div({style:{fontSize:22,fontWeight:700,color:s.col}},String(s.val))));
  });
  wrap.appendChild(summaryGrid);
  if(!reportMonth){
    const chartCard=div({className:'card',style:{padding:'16px',marginBottom:14}});
    chartCard.appendChild(div({style:{fontWeight:600,fontSize:14,marginBottom:14}},`Monthly Overview · ${yr}`));
    const bars=div({style:{display:'flex',alignItems:'flex-end',gap:4,height:100}});
    MONTH_SHORT.forEach((m,i)=>{
      const col=div({style:{flex:1,display:'flex',flexDirection:'column',alignItems:'center',gap:2}});
      const barW=div({style:{width:'100%',display:'flex',flexDirection:'column',justifyContent:'flex-end',gap:2,height:80}});
      barW.appendChild(div({style:{width:'70%',margin:'0 auto',background:'var(--accent)',borderRadius:'3px 3px 0 0',height:Math.max(2,(monthlyRev[i]/maxVal)*78)+'px',opacity:0.85}}));
      if(monthlyExp[i]>0)barW.appendChild(div({style:{width:'70%',margin:'0 auto',background:'var(--danger)',borderRadius:'3px 3px 0 0',height:Math.max(0,(monthlyExp[i]/maxVal)*78)+'px',opacity:0.65}}));
      col.appendChild(barW);col.appendChild(div({style:{fontSize:9,color:'var(--muted)',marginTop:4}},m));bars.appendChild(col);
    });
    chartCard.appendChild(bars);
    chartCard.appendChild(div({style:{display:'flex',gap:16,marginTop:10,fontSize:12}},div({style:{display:'flex',alignItems:'center',gap:5}},div({style:{width:10,height:10,background:'var(--accent)',borderRadius:2}}),'Revenue'),div({style:{display:'flex',alignItems:'center',gap:5}},div({style:{width:10,height:10,background:'var(--danger)',borderRadius:2}}),'Expenses')));
    wrap.appendChild(chartCard);
  }
  const perfCard=div({className:'card',style:{padding:'16px',marginBottom:14}});
  perfCard.appendChild(div({style:{fontWeight:600,fontSize:14,marginBottom:12}},'Property Performance'));
  if(data.properties.length===0)perfCard.appendChild(div({style:{color:'var(--muted)',fontSize:13}},'No properties yet'));
  else data.properties.forEach((p,i)=>{
    const bks=bookings.filter(b=>b.propertyId===p.id&&b.status!=='cancelled');
    const rev=sumRevenue(bks);
    const nights=bks.reduce((s,b)=>s+diffDays(b.checkIn,b.checkOut),0);
    const row=div({style:{paddingBottom:i<data.properties.length-1?12:0,marginBottom:i<data.properties.length-1?12:0,borderBottom:i<data.properties.length-1?'1px solid var(--border-soft)':'none'}});
    row.appendChild(div({style:{display:'flex',justifyContent:'space-between',marginBottom:4}},div({style:{fontWeight:600,fontSize:14}},p.name),div({style:{fontWeight:700,color:'var(--accent)',fontSize:14}},fmtCur(rev))));
    row.appendChild(div({style:{fontSize:12,color:'var(--muted)'}},`${bks.length} bookings · ${nights} nights`));
    perfCard.appendChild(row);
  });
  wrap.appendChild(perfCard);
  const bySource={};
  bookings.filter(b=>b.status!=='cancelled').forEach(b=>{const s=b.source||'Direct';bySource[s]=r2((bySource[s]||0)+bookingRevenue(b));});
  if(Object.keys(bySource).length>0){
    const srcCard=div({className:'card',style:{padding:'16px',marginBottom:14}});
    const srcTotal=Object.values(bySource).reduce((a,b)=>a+b,0);
    srcCard.appendChild(div({style:{fontWeight:600,fontSize:14,marginBottom:12}},'Revenue by Source'));
    Object.entries(bySource).sort((a,b)=>b[1]-a[1]).forEach(([s,v])=>{
      const pct=srcTotal>0?Math.round(v/srcTotal*100):0;
      srcCard.appendChild(div({style:{marginBottom:10}},div({style:{display:'flex',justifyContent:'space-between',fontSize:13,marginBottom:5}},div({style:{color:'var(--text-mid)',fontWeight:500}},s),span({style:{fontWeight:600}},`${fmtCur(v)} (${pct}%)`)),div({style:{height:5,background:'var(--border)',borderRadius:10,overflow:'hidden'}},div({style:{height:'100%',width:pct+'%',background:'var(--accent)',borderRadius:10,transition:'width .4s'}}))));
    });
    wrap.appendChild(srcCard);
  }
  const byCat={};
  expenses.forEach(e=>{byCat[e.category]=(byCat[e.category]||0)+Number(e.amount||0);});
  if(Object.keys(byCat).length>0){
    const catCard=div({className:'card',style:{padding:'16px'}});
    const catTotal=Object.values(byCat).reduce((a,b)=>a+b,0);
    catCard.appendChild(div({style:{fontWeight:600,fontSize:14,marginBottom:12}},'Expenses by Category'));
    Object.entries(byCat).sort((a,b)=>b[1]-a[1]).forEach(([c,v])=>{
      const pct=catTotal>0?Math.round(v/catTotal*100):0;
      catCard.appendChild(div({style:{marginBottom:10}},div({style:{display:'flex',justifyContent:'space-between',fontSize:13,marginBottom:5}},div({style:{display:'flex',alignItems:'center',gap:8,color:'var(--text-mid)',fontWeight:600}},catIcon(c,26),(CAT_META[c]||CAT_META.other).label),span({style:{fontWeight:600,color:'var(--danger)'}},`${fmtCur(v)} (${pct}%)`)),div({style:{height:5,background:'var(--border)',borderRadius:10,overflow:'hidden'}},div({style:{height:'100%',width:pct+'%',background:'var(--danger)',opacity:0.7,borderRadius:10}}))));
    });
    wrap.appendChild(catCard);
  }
  return wrap;
}

// ─── CSV Download ─────────────────────────────────────────────────────────────
function downloadReport(bookings,expenses,periodLabel){
  const{data}=state;
  const propName=pid=>data.properties.find(p=>p.id===pid)?.name||'—';
  const esc=s=>`"${String(s||'').replace(/"/g,'""')}"`;
  const totalRev=sumRevenue(bookings.filter(b=>b.status!=='cancelled'));
  const totalExp=expenses.reduce((s,e)=>s+Number(e.amount||0),0);
  let csv=`StayLog Report,${esc(periodLabel)}\nGenerated,${esc(new Date().toLocaleString('en-IN'))}\n\nSUMMARY\nTotal Revenue,${totalRev}\nTotal Expenses,${totalExp}\nNet Profit,${totalRev-totalExp}\n\nINCOME DETAILS\nDate,Guest Name,Property,Check-in,Check-out,Nights,Guests,Source,Total Amount,Amount Paid,Round Off,Balance Due,Status\n`;
  [...bookings].filter(b=>b.status!=='cancelled').sort((a,b)=>new Date(a.checkIn)-new Date(b.checkIn)).forEach(b=>{
    const nights=diffDays(b.checkIn,b.checkOut),due=balanceDue(b);
    csv+=[esc(b.checkIn),esc(b.guestName),esc(propName(b.propertyId)),esc(fmtDate(b.checkIn)),esc(fmtDate(b.checkOut)),nights,b.guests||1,esc(b.source||'Direct'),Number(b.totalAmount||0),Number(b.paid||0),roundOffOf(b),due,esc(b.status)].join(',')+'\n';
  });
  csv+='\nEXPENDITURE DETAILS\nDate,Description,Property,Category,Paid To,Gross Payout,Loan Deduction,Net Amount,Status,Notes\n';
  [...expenses].sort((a,b)=>new Date(a.date)-new Date(b.date)).forEach(e=>{
    const ded=round2(e.loanDeduction),gross=Number(e.grossAmount||0)||round2(Number(e.amount||0)+ded);
    csv+=[esc(e.date),esc(e.description),esc(propName(e.propertyId)),esc(e.category),esc(e.staffId?staffName(e.staffId):''),gross,ded,Number(e.amount||0),esc(e.paid?'Paid':'Unpaid'),esc(e.notes||'')].join(',')+'\n';
  });
  // Loan position — always the full picture, since a loan spans months
  if(data.loans.length>0){
    const disbursed=round2(data.loans.reduce((s,l)=>s+Number(l.principal||0),0));
    const recovered=round2(data.loans.reduce((s,l)=>s+loanRepaid(l),0));
    const outstanding=round2(data.loans.filter(l=>l.status!=='writtenoff').reduce((s,l)=>s+Math.max(0,loanBalance(l)),0));
    csv+=`\nSTAFF LOANS — POSITION AS ON ${esc(fmtDate(today()))}\nTotal Disbursed,${disbursed}\nTotal Recovered,${recovered}\nOutstanding,${outstanding}\n`;
    csv+='\nStaff,Role,Loan Amount,Given On,Monthly Instalment,Recovered,Outstanding,Overdue,Status,Next Due,Expected Close\n';
    data.loans.forEach(l=>{
      const rows=loanSchedule(l),next=loanNextDue(l);
      csv+=[esc(staffName(l.staffId)),esc(staffById(l.staffId)?.role||''),Number(l.principal||0),esc(l.disbursedOn),
        Number(l.installmentAmount||0),loanRepaid(l),Math.max(0,loanBalance(l)),loanOverdue(l),
        esc(l.status==='writtenoff'?'Written off':loanIsSettled(l)?'Closed':'Active'),
        esc(next?next.dueDate:''),esc(rows.length?rows[rows.length-1].dueDate:'')].join(',')+'\n';
    });
    const mf=state.reportMonth;
    const reps=[];
    data.loans.forEach(l=>(l.repayments||[]).forEach(r=>reps.push({...r,staffId:l.staffId})));
    const inPeriod=mf?reps.filter(r=>{const d=new Date(r.date+'T00:00:00');return d.getFullYear()===mf.year&&d.getMonth()===mf.month;}):reps;
    if(inPeriod.length>0){
      csv+=`\nLOAN REPAYMENTS — ${esc(periodLabel)}\nDate,Staff,Amount,Mode,Note\n`;
      inPeriod.sort((a,b)=>String(a.date).localeCompare(String(b.date))).forEach(r=>{
        csv+=[esc(r.date),esc(staffName(r.staffId)),Number(r.amount||0),esc(r.mode==='payout'?'Payout deduction':'Direct'),esc(r.note||'')].join(',')+'\n';
      });
    }
  }
  const blob=new Blob([csv],{type:'text/csv;charset=utf-8;'});
  const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`staylog-report-${periodLabel}.csv`;a.click();
}

// ═══ STAFF & LOANS ════════════════════════════════════════════════════════════

const round2 = n => Math.round((Number(n)||0)*100)/100;
const staffById  = id => state.data.staff.find(s=>s.id===id);
const staffName  = id => staffById(id)?.name || 'Unknown staff';
const loanById   = id => state.data.loans.find(l=>l.id===id);

// Add n months to an ISO date, clamping to the last valid day of the target month
function addMonthsISO(iso,n){
  if(!iso)return iso;
  const [y,m,d]=iso.split('-').map(Number);
  const t=new Date(y,m-1+n,1);
  const lastDay=new Date(t.getFullYear(),t.getMonth()+1,0).getDate();
  return `${t.getFullYear()}-${String(t.getMonth()+1).padStart(2,'0')}-${String(Math.min(d,lastDay)).padStart(2,'0')}`;
}

function loanRepaid(loan){return round2((loan.repayments||[]).reduce((s,r)=>s+Number(r.amount||0),0));}
function loanBalance(loan){return round2(Number(loan.principal||0)-loanRepaid(loan));}
function loanIsSettled(loan){return loan.status==='writtenoff'||loanBalance(loan)<=0.5;}

// Equal instalments until the principal is exhausted; the last one is the remainder
function loanSchedule(loan){
  const principal=Number(loan.principal||0), inst=Number(loan.installmentAmount||0);
  const start=loan.firstDueDate||loan.disbursedOn;
  if(!(principal>0)||!(inst>0)||!start)return[];
  const rows=[]; let rem=principal, i=0;
  while(rem>0.5 && i<240){
    const amt=round2(Math.min(inst,rem));
    rows.push({no:i+1,dueDate:addMonthsISO(start,i),amount:amt});
    rem=round2(rem-amt); i++;
  }
  return rows;
}

// Applies everything repaid against the schedule, oldest instalment first
function loanScheduleStatus(loan){
  const rows=loanSchedule(loan);
  let pool=loanRepaid(loan); const t=today();
  rows.forEach(r=>{
    const applied=Math.min(pool,r.amount); pool=round2(pool-applied);
    r.paid=round2(applied);
    if(applied>=r.amount-0.5)      r.status='paid';
    else if(applied>0)             r.status='partial';
    else                           r.status=r.dueDate<=t?'overdue':'upcoming';
  });
  return {rows,advance:round2(pool)};
}
function loanNextDue(loan){return loanScheduleStatus(loan).rows.find(r=>r.status!=='paid')||null;}
// Only instalments whose due date has passed count as arrears
function loanOverdue(loan){
  if(loan.status==='writtenoff')return 0;
  const t=today();
  return round2(loanScheduleStatus(loan).rows
    .filter(r=>r.status!=='paid'&&r.dueDate<=t)
    .reduce((s,r)=>s+(r.amount-r.paid),0));
}
function activeLoansForStaff(staffId){
  return state.data.loans.filter(l=>l.staffId===staffId&&l.status!=='writtenoff'&&loanBalance(l)>0.5);
}

// Keeps loan.status in step with the balance (never overrides a manual write-off)
function refreshLoanStatuses(d){
  d.loans.forEach(l=>{ if(l.status!=='writtenoff') l.status = loanBalance(l)<=0.5?'closed':'active'; });
}
// One expense owns at most one repayment row; rebuild it from the expense every time.
// The recovery only hits the loan once the payout is actually marked Paid.
function syncExpenseLoan(d,exp){
  d.loans.forEach(l=>{l.repayments=(l.repayments||[]).filter(r=>r.expenseId!==exp.id);});
  const amt=round2(exp.loanDeduction);
  if(exp.loanId&&amt>0&&exp.paid){
    const l=d.loans.find(x=>x.id===exp.loanId);
    if(l){
      (l.repayments=l.repayments||[]).push({
        id:uid(),date:exp.date,amount:amt,mode:'payout',expenseId:exp.id,
        note:`Deducted from ${exp.description||'staff payout'}`
      });
    }
  }
  refreshLoanStatuses(d);
}
function unlinkExpenseLoan(d,expenseId){
  d.loans.forEach(l=>{l.repayments=(l.repayments||[]).filter(r=>r.expenseId!==expenseId);});
  refreshLoanStatuses(d);
}
// What a payout should take off this loan: the unpaid part of the next
// instalment, never more than is still owed.
function loanInstalmentDue(loan){
  const nd=loanNextDue(loan);
  return round2(Math.min(nd?nd.amount-nd.paid:Number(loan.installmentAmount||0),Math.max(0,loanBalance(loan))));
}
// A month's instalment is more than any one day's wage, so on payday it is
// spread across the wages being paid, oldest first. Each wage then carries its
// share exactly as a single payout does (loanId, loanDeduction, grossAmount)
// and syncExpenseLoan turns each share into one repayment row — so deleting a
// day later reverses that day's share and nothing else.
function splitLoanDeduction(expenses,total){
  let left=round2(total); const out=[];
  [...expenses].sort((a,b)=>String(a.date).localeCompare(String(b.date))).forEach(e=>{
    const share=round2(Math.min(Number(e.amount||0),left));
    if(share>0){out.push({id:e.id,share});left=round2(left-share);}
  });
  return out;
}

const LOAN_ROW_META={
  paid    :{label:'Paid',    bg:'var(--accent-light)',color:'var(--accent)'},
  partial :{label:'Partial', bg:'var(--warn-light)',color:'var(--warn)'},
  overdue :{label:'Overdue', bg:'var(--danger-light)',color:'var(--danger)'},
  upcoming:{label:'Upcoming',bg:'var(--border-soft)',color:'var(--muted)'},
};
function progressBar(pct,color='var(--accent)'){
  return div({style:{height:6,background:'var(--border)',borderRadius:10,overflow:'hidden'}},
    div({style:{height:'100%',width:Math.max(0,Math.min(100,pct))+'%',background:color,borderRadius:10,transition:'width .4s'}}));
}

// ─── Loans Tab ────────────────────────────────────────────────────────────────
function renderLoans(){
  const{data,loanFilter,expandedLoan,showStaffPanel}=state;
  const wrap=div({style:{padding:'14px 12px 100px'}});

  wrap.appendChild(div({style:{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:12}},
    h('div',{style:{fontFamily:'var(--display)',fontSize:20}},'Staff Loans'),
    div({style:{display:'flex',gap:8}},
      btn({style:{background:showStaffPanel?'var(--accent-light)':'var(--white)',color:showStaffPanel?'var(--accent)':'var(--muted)',border:`1.5px solid ${showStaffPanel?'var(--accent)':'var(--border)'}`,borderRadius:'var(--radius-sm)',padding:'7px 12px',fontSize:13,fontWeight:600,cursor:'pointer',display:'flex',alignItems:'center',gap:5},
        onClick:()=>setState({showStaffPanel:!showStaffPanel})},ico('users',{style:{fontSize:15}}),'Staff'),
      btn({className:'btn-primary btn-sm',onClick:()=>{
        if(data.staff.length===0){alert('Add a staff member first — a loan has to belong to someone.');setState({modal:'addStaff',editItem:null});return;}
        setState({modal:'addLoan',editItem:null});
      }},ico('plus',{style:{marginRight:4}}),'Loan')
    )
  ));

  if(showStaffPanel)wrap.appendChild(staffPanel());

  const loans=data.loans;
  const disbursed=round2(loans.reduce((s,l)=>s+Number(l.principal||0),0));
  const recovered=round2(loans.reduce((s,l)=>s+loanRepaid(l),0));
  const writtenOff=round2(loans.filter(l=>l.status==='writtenoff').reduce((s,l)=>s+loanBalance(l),0));
  const outstanding=round2(loans.filter(l=>l.status!=='writtenoff').reduce((s,l)=>s+Math.max(0,loanBalance(l)),0));
  const overdueTotal=round2(loans.reduce((s,l)=>s+loanOverdue(l),0));

  if(loans.length===0&&data.staff.length===0){
    wrap.appendChild(div({style:{textAlign:'center',padding:'56px 20px'}},
      ico('wallet',{style:{fontSize:48,color:'var(--light)',display:'block',marginBottom:14}}),
      h('div',{style:{fontFamily:'var(--display)',fontSize:20,marginBottom:8}},'No staff yet'),
      h('div',{style:{color:'var(--muted)',fontSize:14,marginBottom:20,lineHeight:1.6}},'Add your staff first, then record any loan or advance you give them.'),
      btn({className:'btn-primary',onClick:()=>setState({modal:'addStaff',editItem:null})},ico('plus',{style:{marginRight:6}}),'Add Staff Member')
    ));
    return wrap;
  }

  // Summary
  const sg=div({style:{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10,marginBottom:14}});
  [{label:'Disbursed',val:fmtCur(disbursed),icon:'cash',bg:'var(--info-light)',col:'var(--info)'},
   {label:'Recovered',val:fmtCur(recovered),icon:'circle-check',bg:'var(--accent-light)',col:'var(--accent)'},
   {label:'Outstanding',val:fmtCur(outstanding),icon:'hourglass',bg:'var(--gold-light)',col:'var(--gold)'},
   {label:'Overdue',val:fmtCur(overdueTotal),icon:'alert-triangle',bg:overdueTotal>0?'var(--danger-light)':'var(--cream)',col:overdueTotal>0?'var(--danger)':'var(--muted)'}
  ].forEach(s=>{
    sg.appendChild(div({className:'card',style:{padding:'13px 14px'}},
      div({style:{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:7}},
        div({style:{fontSize:10,color:'var(--muted)',fontWeight:600,textTransform:'uppercase',letterSpacing:'0.06em'}},s.label),
        div({style:{background:s.bg,borderRadius:8,padding:'4px 6px'}},ico(s.icon,{style:{fontSize:15,color:s.col}}))),
      div({style:{fontSize:19,fontWeight:700,letterSpacing:'-0.02em'}},s.val)
    ));
  });
  wrap.appendChild(sg);

  // Overdue alert
  const overdueLoans=loans.filter(l=>loanOverdue(l)>0);
  if(overdueLoans.length>0){
    const al=div({style:{background:'var(--danger-light)',border:'1.5px solid var(--danger-line)',borderRadius:'var(--radius)',padding:'12px 14px',marginBottom:14}});
    al.appendChild(div({style:{fontWeight:600,fontSize:13,color:'var(--danger)',marginBottom:8,display:'flex',alignItems:'center',gap:6}},
      ico('alert-triangle',{style:{fontSize:16}}),`${overdueLoans.length} loan${overdueLoans.length>1?'s':''} behind schedule`));
    overdueLoans.forEach(l=>al.appendChild(div({style:{fontSize:13,marginBottom:4,display:'flex',justifyContent:'space-between'}},
      span({},staffName(l.staffId)),span({style:{fontWeight:600,color:'var(--danger)'}},fmtCur(loanOverdue(l))))));
    wrap.appendChild(al);
  }

  // Filter chips
  const counts={active:loans.filter(l=>!loanIsSettled(l)).length,closed:loans.filter(l=>loanIsSettled(l)).length,all:loans.length};
  const chips=div({style:{display:'flex',gap:6,marginBottom:14,overflowX:'auto',paddingBottom:2,scrollbarWidth:'none'}});
  [['active','Active'],['closed','Closed'],['all','All']].forEach(([v,l])=>{
    const on=loanFilter===v;
    chips.appendChild(btn({style:{padding:'5px 13px',borderRadius:20,whiteSpace:'nowrap',border:`1.5px solid ${on?'var(--accent)':'var(--border)'}`,background:on?'var(--accent-light)':'var(--white)',color:on?'var(--accent)':'var(--muted)',fontSize:13,fontWeight:on?600:400},
      onClick:()=>setState({loanFilter:v})},`${l} (${counts[v]})`));
  });
  wrap.appendChild(chips);

  const shown=loans.filter(l=>loanFilter==='all'?true:loanFilter==='closed'?loanIsSettled(l):!loanIsSettled(l))
    .sort((a,b)=>String(b.disbursedOn||'').localeCompare(String(a.disbursedOn||'')));
  if(shown.length===0)wrap.appendChild(div({style:{textAlign:'center',padding:'34px 20px',color:'var(--muted)',fontSize:14}},
    loanFilter==='active'?'No active loans':'Nothing here'));
  else shown.forEach(l=>wrap.appendChild(loanCard(l,expandedLoan===l.id)));

  if(loans.length>0)wrap.appendChild(loanAnalysis(loans,{disbursed,recovered,outstanding,overdueTotal,writtenOff}));
  return wrap;
}

// ─── Staff panel ──────────────────────────────────────────────────────────────
function staffPanel(){
  const{data}=state;
  const card=div({className:'card',style:{padding:'14px',marginBottom:14}});
  card.appendChild(div({style:{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:data.staff.length?12:0}},
    div({style:{fontWeight:600,fontSize:14}},`Staff (${data.staff.length})`),
    btn({className:'btn-ghost btn-sm',style:{padding:'5px 11px'},onClick:()=>setState({modal:'addStaff',editItem:null})},ico('plus',{style:{marginRight:4,fontSize:13}}),'Add')
  ));
  if(data.staff.length===0){
    card.appendChild(div({style:{fontSize:13,color:'var(--muted)',marginTop:8}},'No staff added yet.'));
    return card;
  }
  data.staff.forEach((s,i)=>{
    const bal=round2(data.loans.filter(l=>l.staffId===s.id&&l.status!=='writtenoff').reduce((t,l)=>t+Math.max(0,loanBalance(l)),0));
    const row=div({style:{display:'flex',justifyContent:'space-between',alignItems:'center',gap:8,paddingBottom:i<data.staff.length-1?11:0,marginBottom:i<data.staff.length-1?11:0,borderBottom:i<data.staff.length-1?'1px solid var(--border-soft)':'none'}});
    row.appendChild(div({style:{minWidth:0}},
      div({style:{fontWeight:600,fontSize:14}},s.name,s.active===false?span({style:{fontSize:11,color:'var(--muted)',fontWeight:400,marginLeft:6}},'· inactive'):null),
      div({style:{fontSize:12,color:'var(--muted)',marginTop:2}},
        [s.role,s.monthlySalary?`${fmtCur(s.monthlySalary)}/mo`:null,
         s.dailyWage?`${fmtCur(s.dailyWage)}/day`:null,Number(s.checkoutWage)>0?`${fmtCur(s.checkoutWage)} checkout day`:null,
         Number(s.utensilRate)>0?`${fmtCur(s.utensilRate)} utensils`:null,s.phone].filter(Boolean).join(' · ')||'—'),
      bal>0?div({style:{fontSize:12,color:'var(--gold)',fontWeight:600,marginTop:3}},`Loan outstanding: ${fmtCur(bal)}`):null,
      (()=>{const due=pendingWageTotal(data,s.id),n=pendingWages(data,s.id).length;
        return due>0?btn({className:'btn-ghost btn-sm',style:{marginTop:6,padding:'5px 10px',
          color:'var(--gold)',borderColor:'var(--gold-line)',background:'var(--gold-light)'},
          onClick:()=>setState({modal:'settleWages',editItem:s})},
          `Pay ${fmtCur(due)} · ${n} day${n>1?'s':''}`):null;})()
    ));
    row.appendChild(div({style:{display:'flex',gap:6,flexShrink:0,alignSelf:'flex-start'}},
      btn({className:'btn-ghost btn-sm',style:{padding:'5px 9px'},onClick:()=>setState({modal:'addStaff',editItem:s})},ico('edit',{style:{fontSize:14}})),
      btn({className:'btn-danger btn-sm',style:{padding:'5px 9px'},onClick:()=>{
        const nLoans=state.data.loans.filter(l=>l.staffId===s.id).length;
        if(nLoans>0){alert(`${s.name} has ${nLoans} loan record${nLoans>1?'s':''}. Delete or write off the loans first.`);return;}
        if(confirm(`Remove ${s.name} from the staff list?`))mutateData(d=>d.staff=d.staff.filter(x=>x.id!==s.id));
      }},ico('trash',{style:{fontSize:14}}))
    ));
    card.appendChild(row);
  });
  return card;
}

// ─── Loan card ────────────────────────────────────────────────────────────────
function loanCard(l,expanded){
  const principal=Number(l.principal||0);
  const repaid=loanRepaid(l), bal=Math.max(0,loanBalance(l));
  const pct=principal>0?Math.round(repaid/principal*100):0;
  const overdue=loanOverdue(l), next=loanNextDue(l);
  const settled=loanIsSettled(l), wo=l.status==='writtenoff';
  const prop=state.data.properties.find(p=>p.id===l.propertyId);

  const card=div({className:'card',style:{marginBottom:10,borderColor:overdue>0?'var(--danger-line)':'var(--border)'}});
  const head=div({style:{padding:'13px 14px',cursor:'pointer'},onClick:()=>setState({expandedLoan:expanded?null:l.id})});
  head.appendChild(div({style:{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:9}},
    div({style:{minWidth:0}},
      div({style:{fontWeight:600,fontSize:15}},staffName(l.staffId)),
      div({style:{fontSize:12,color:'var(--muted)',marginTop:3}},
        `${fmtCur(principal)} on ${fmtDate(l.disbursedOn)}${prop?' · '+prop.name:''}`)
    ),
    div({style:{textAlign:'right',flexShrink:0}},
      span({style:{background:wo?'var(--border-soft)':settled?'var(--accent-light)':overdue>0?'var(--danger-light)':'var(--gold-light)',
        color:wo?'var(--muted)':settled?'var(--accent)':overdue>0?'var(--danger)':'var(--gold)',borderRadius:20,padding:'4px 11px',fontSize:12,fontWeight:600}},
        wo?'Written off':settled?'Closed':overdue>0?'Overdue':'Active'),
      div({style:{fontSize:16,fontWeight:700,color:settled?'var(--muted)':'var(--gold)',marginTop:5}},fmtCur(bal)),
      div({style:{fontSize:10.5,color:overdue>0?'var(--danger)':'var(--muted)',marginTop:1}},
        overdue>0?`${fmtCur(overdue)} in arrears`:settled?'settled':'outstanding')
    )
  ));
  head.appendChild(progressBar(pct,settled&&!wo?'var(--accent)':overdue>0?'var(--danger)':'var(--accent-mid)'));
  head.appendChild(div({style:{display:'flex',justifyContent:'space-between',fontSize:11.5,color:'var(--muted)',marginTop:6}},
    span({},`${fmtCur(repaid)} recovered · ${pct}%`),
    span({},settled?(wo?'Written off':'Fully recovered'):next?`Next ${fmtCur(next.amount-next.paid)} due ${fmtDate(next.dueDate)}`:'—')
  ));
  card.appendChild(head);

  if(!expanded)return card;

  const body=div({style:{borderTop:'1px solid var(--border-soft)',padding:'12px 14px 14px',background:'var(--surface-2)',borderRadius:'0 0 var(--radius) var(--radius)'}});
  if(l.notes)body.appendChild(div({style:{fontSize:13,color:'var(--muted)',fontStyle:'italic',marginBottom:10,background:'var(--white)',padding:'8px 10px',borderRadius:8,border:'1px solid var(--border)'}},`"${l.notes}"`));

  // Key figures
  const kv=div({style:{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'7px 12px',marginBottom:12}});
  const {rows,advance}=loanScheduleStatus(l);
  const remainingRows=rows.filter(r=>r.status!=='paid').length;
  [['Instalment',fmtCur(l.installmentAmount)+' / month'],
   ['Total instalments',String(rows.length)],
   ['Paid so far',fmtCur(repaid)],
   ['Instalments left',settled?'0':String(remainingRows)],
   ['First due',fmtDate(l.firstDueDate||l.disbursedOn)],
   ['Expected close',rows.length?fmtDate(rows[rows.length-1].dueDate):'—']
  ].forEach(([k,v])=>kv.appendChild(div({},
    div({style:{fontSize:10.5,color:'var(--muted)',fontWeight:600,textTransform:'uppercase',letterSpacing:'0.05em'}},k),
    div({style:{fontSize:13.5,fontWeight:600,marginTop:2}},v))));
  body.appendChild(kv);
  if(advance>0.5)body.appendChild(div({style:{fontSize:12.5,color:'var(--accent)',fontWeight:600,marginBottom:10}},`Paid ${fmtCur(advance)} ahead of schedule`));

  // Schedule
  body.appendChild(div({className:'kicker',style:{marginBottom:10}},'Repayment schedule'));
  const railWrap=div({style:{marginBottom:13,maxHeight:268,overflowY:'auto'}});
  rows.forEach((r,i)=>{
    const m=LOAN_ROW_META[r.status];
    const dotCol=r.status==='paid'?'var(--info)':r.status==='partial'?'var(--gold)':r.status==='overdue'?'var(--danger)':null;
    railWrap.appendChild(div({style:{display:'flex',gap:11,alignItems:'stretch'}},
      div({style:{flex:'0 0 12px',display:'flex',flexDirection:'column',alignItems:'center',paddingTop:4}},
        div({style:{width:9,height:9,borderRadius:'50%',flexShrink:0,
          background:dotCol||'var(--white)',border:`2px solid ${dotCol||'var(--border)'}`}}),
        i<rows.length-1?div({style:{width:2,flex:1,minHeight:18,background:'var(--border)'}}):null),
      div({style:{flex:1,minWidth:0,display:'flex',justifyContent:'space-between',alignItems:'flex-start',
        gap:8,paddingBottom:i<rows.length-1?10:0}},
        div({style:{minWidth:0}},
          div({className:'num',style:{fontSize:13,fontWeight:700}},fmtCur(r.amount)),
          div({style:{fontSize:11,color:'var(--muted)',marginTop:1}},
            fmtDate(r.dueDate)+(r.status==='partial'?` · ${fmtCur(r.paid)} received`:'')+
            (i===rows.length-1&&r.status!=='paid'?' · closes the loan':''))),
        span({style:{background:m.bg,color:m.color,borderRadius:20,padding:'3px 10px',fontSize:10.5,
          fontWeight:700,flexShrink:0}},m.label)
      )));
  });
  body.appendChild(railWrap);

  // Repayment history
  const reps=[...(l.repayments||[])].sort((a,b)=>String(b.date).localeCompare(String(a.date)));
  body.appendChild(div({style:{fontSize:12,fontWeight:600,color:'var(--muted)',textTransform:'uppercase',letterSpacing:'0.06em',marginBottom:8}},`Repayments (${reps.length})`));
  if(reps.length===0)body.appendChild(div({style:{fontSize:13,color:'var(--muted)',marginBottom:12}},'Nothing recovered yet.'));
  else{
    const hist=div({style:{marginBottom:12}});
    reps.forEach(r=>{
      hist.appendChild(div({style:{display:'flex',justifyContent:'space-between',alignItems:'center',gap:8,background:'var(--white)',border:'1px solid var(--border)',borderRadius:9,padding:'8px 11px',marginBottom:6}},
        div({style:{minWidth:0}},
          div({style:{fontSize:13,fontWeight:600}},fmtCur(r.amount),
            span({style:{fontSize:11,fontWeight:600,marginLeft:7,padding:'2px 8px',borderRadius:20,background:r.mode==='payout'?'var(--info-light)':'var(--accent-light)',color:r.mode==='payout'?'var(--info)':'var(--accent)'}},
              r.mode==='payout'?'Payout deduction':'Direct')),
          div({style:{fontSize:11,color:'var(--muted)',marginTop:2}},fmtDate(r.date)+(r.note?` · ${r.note}`:''))
        ),
        r.mode==='payout'
          ? span({title:'Edit the linked expense to change this',style:{fontSize:11,color:'var(--light)',flexShrink:0}},ico('link',{style:{fontSize:14}}))
          : btn({className:'btn-danger btn-sm',style:{padding:'4px 8px',flexShrink:0},onClick:()=>{
              if(confirm(`Remove this ${fmtCur(r.amount)} repayment?`))mutateData(d=>{
                const loan=d.loans.find(x=>x.id===l.id);
                loan.repayments=loan.repayments.filter(x=>x.id!==r.id);refreshLoanStatuses(d);
              });
            }},ico('trash',{style:{fontSize:13}}))
      ));
    });
    body.appendChild(hist);
  }

  // Actions
  const acts=div({style:{display:'flex',gap:7,flexWrap:'wrap'}});
  if(!settled)acts.appendChild(btn({className:'btn-primary btn-sm',onClick:()=>setState({modal:'addRepayment',editItem:l})},ico('cash',{style:{marginRight:5}}),'Record Repayment'));
  acts.appendChild(btn({className:'btn-ghost btn-sm',onClick:()=>setState({modal:'addLoan',editItem:l})},ico('edit',{style:{marginRight:4}}),'Edit'));
  if(!settled)acts.appendChild(btn({className:'btn-ghost btn-sm',onClick:()=>{
    if(confirm(`Write off the remaining ${fmtCur(bal)}? The loan will be marked as written off and stop appearing as recoverable.`))
      mutateData(d=>{d.loans=d.loans.map(x=>x.id===l.id?{...x,status:'writtenoff',writtenOffOn:today()}:x);});
  }},'Write Off'));
  if(wo)acts.appendChild(btn({className:'btn-ghost btn-sm',onClick:()=>mutateData(d=>{d.loans=d.loans.map(x=>x.id===l.id?{...x,status:'active',writtenOffOn:''}:x);refreshLoanStatuses(d);})},'Reopen'));
  acts.appendChild(btn({className:'btn-danger btn-sm',onClick:()=>{
    const linked=(l.repayments||[]).filter(r=>r.expenseId).length;
    if(!confirm(`Delete this loan?${linked?`\n\n${linked} payout deduction${linked>1?'s':''} are linked to it — those expenses will stay, but the amounts deducted will no longer be tracked against any loan.`:''}`))return;
    mutateData(d=>{
      d.loans=d.loans.filter(x=>x.id!==l.id);
      d.expenses=d.expenses.map(e=>e.loanId===l.id?{...e,loanId:'',loanDeduction:0}:e);
    });
    setState({expandedLoan:null});
  }},ico('trash',{style:{marginRight:4}}),'Delete'));
  body.appendChild(acts);
  card.appendChild(body);
  return card;
}

// ─── Loan analysis ────────────────────────────────────────────────────────────
function loanAnalysis(loans,t){
  const wrap=div({});
  const active=loans.filter(l=>!loanIsSettled(l));
  const recoveryPct=t.disbursed>0?Math.round(t.recovered/t.disbursed*100):0;

  const card=div({className:'card',style:{padding:'16px',marginTop:4,marginBottom:14}});
  card.appendChild(div({style:{fontWeight:600,fontSize:14,marginBottom:14}},'Loan Analysis'));

  // Recovery progress
  card.appendChild(div({style:{marginBottom:16}},
    div({style:{display:'flex',justifyContent:'space-between',fontSize:13,marginBottom:6}},
      span({style:{color:'var(--text-mid)',fontWeight:500}},'Overall recovery'),
      span({style:{fontWeight:600}},`${fmtCur(t.recovered)} of ${fmtCur(t.disbursed)} · ${recoveryPct}%`)),
    progressBar(recoveryPct)
  ));

  // Key ratios
  const totalInst=round2(active.reduce((s,l)=>s+Number(l.installmentAmount||0),0));
  const monthsToClear=totalInst>0?Math.ceil(t.outstanding/totalInst):0;
  const payoutRecovered=round2(loans.reduce((s,l)=>s+(l.repayments||[]).filter(r=>r.mode==='payout').reduce((a,r)=>a+Number(r.amount||0),0),0));
  const cashRecovered=round2(t.recovered-payoutRecovered);
  const grid=div({style:{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'12px 14px',marginBottom:16}});
  [['Active loans',String(active.length)],
   ['Staff with a loan',String(new Set(active.map(l=>l.staffId)).size)],
   ['Monthly recovery run-rate',fmtCur(totalInst)],
   ['Months to clear',monthsToClear?`${monthsToClear} month${monthsToClear>1?'s':''}`:'—'],
   ['Avg loan size',loans.length?fmtCur(round2(t.disbursed/loans.length)):'—'],
   ['Written off',fmtCur(t.writtenOff)]
  ].forEach(([k,v])=>grid.appendChild(div({},
    div({style:{fontSize:10.5,color:'var(--muted)',fontWeight:600,textTransform:'uppercase',letterSpacing:'0.05em'}},k),
    div({style:{fontSize:15,fontWeight:700,marginTop:3}},v))));
  card.appendChild(grid);

  // Recovery route split
  if(t.recovered>0){
    const pPct=Math.round(payoutRecovered/t.recovered*100);
    card.appendChild(div({style:{marginBottom:16}},
      div({style:{fontSize:12,fontWeight:600,color:'var(--muted)',textTransform:'uppercase',letterSpacing:'0.06em',marginBottom:8}},'How it came back'),
      div({style:{display:'flex',justifyContent:'space-between',fontSize:13,marginBottom:5}},
        span({style:{color:'var(--text-mid)'}},'Deducted from payouts'),span({style:{fontWeight:600}},`${fmtCur(payoutRecovered)} (${pPct}%)`)),
      progressBar(pPct,'var(--info)'),
      div({style:{display:'flex',justifyContent:'space-between',fontSize:13,margin:'9px 0 5px'}},
        span({style:{color:'var(--text-mid)'}},'Paid directly'),span({style:{fontWeight:600}},`${fmtCur(cashRecovered)} (${100-pPct}%)`)),
      progressBar(100-pPct,'var(--accent)')
    ));
  }

  // Exposure per staff
  const byStaff={};
  loans.filter(l=>l.status!=='writtenoff').forEach(l=>{
    const b=Math.max(0,loanBalance(l)); if(b<=0.5)return;
    byStaff[l.staffId]=round2((byStaff[l.staffId]||0)+b);
  });
  const entries=Object.entries(byStaff).sort((a,b)=>b[1]-a[1]);
  if(entries.length>0){
    const max=entries[0][1];
    card.appendChild(div({style:{fontSize:12,fontWeight:600,color:'var(--muted)',textTransform:'uppercase',letterSpacing:'0.06em',marginBottom:9}},'Outstanding by staff'));
    entries.forEach(([sid,v])=>{
      const s=staffById(sid);
      const salary=Number(s?.monthlySalary||0);
      const inst=round2(activeLoansForStaff(sid).reduce((a,l)=>a+Number(l.installmentAmount||0),0));
      const burden=salary>0?Math.round(inst/salary*100):0;
      card.appendChild(div({style:{marginBottom:11}},
        div({style:{display:'flex',justifyContent:'space-between',fontSize:13,marginBottom:5}},
          span({style:{color:'var(--text-mid)',fontWeight:500}},staffName(sid)),
          span({style:{fontWeight:600,color:'var(--gold)'}},fmtCur(v))),
        progressBar(Math.round(v/max*100),'var(--gold)'),
        salary>0?div({style:{fontSize:11,color:burden>40?'var(--danger)':'var(--muted)',marginTop:4}},
          `${fmtCur(inst)}/mo instalment · ${burden}% of ${fmtCur(salary)} salary${burden>40?' — heavy deduction':''}`):null
      ));
    });
  }
  wrap.appendChild(card);

  // Recovery history — last 6 months
  const now=new Date(); const buckets=[];
  for(let i=5;i>=0;i--){const d=new Date(now.getFullYear(),now.getMonth()-i,1);buckets.push({y:d.getFullYear(),m:d.getMonth(),v:0});}
  loans.forEach(l=>(l.repayments||[]).forEach(r=>{
    if(!r.date)return;
    const d=new Date(r.date+'T00:00:00');
    const b=buckets.find(x=>x.y===d.getFullYear()&&x.m===d.getMonth());
    if(b)b.v=round2(b.v+Number(r.amount||0));
  }));
  if(buckets.some(b=>b.v>0)){
    const maxV=Math.max(...buckets.map(b=>b.v),1);
    const chart=div({className:'card',style:{padding:'16px',marginBottom:14}});
    chart.appendChild(div({style:{fontWeight:600,fontSize:14,marginBottom:14}},'Recovered · last 6 months'));
    const bars=div({style:{display:'flex',alignItems:'flex-end',gap:8,height:96}});
    buckets.forEach(b=>{
      bars.appendChild(div({style:{flex:1,display:'flex',flexDirection:'column',alignItems:'center',gap:3}},
        div({style:{fontSize:9.5,color:'var(--muted)',fontWeight:600,height:12}},b.v>0?'₹'+Math.round(b.v/1000)+'k':''),
        div({style:{width:'100%',display:'flex',alignItems:'flex-end',height:60}},
          div({style:{width:'64%',margin:'0 auto',background:'var(--accent)',opacity:0.85,borderRadius:'3px 3px 0 0',height:Math.max(2,(b.v/maxV)*58)+'px'}})),
        div({style:{fontSize:9.5,color:'var(--muted)'}},MONTH_SHORT[b.m])
      ));
    });
    chart.appendChild(bars);
    wrap.appendChild(chart);
  }
  return wrap;
}

// ─── Modals ───────────────────────────────────────────────────────────────────
// ─── Settling wages ───────────────────────────────────────────────────────────
// Payday is one action, not fifteen. Every unpaid staff payout for one person,
// ticked by default, with the total following what is ticked — so a part
// payment is a matter of unticking rather than editing amounts.
function pendingWages(d,staffId){
  return d.expenses
    .filter(e=>e.category==='staff'&&e.staffId===staffId&&!e.paid)
    .sort((a,b)=>String(b.date).localeCompare(String(a.date)));
}
function pendingWageTotal(d,staffId){
  return round2(pendingWages(d,staffId).reduce((t,e)=>t+Number(e.amount||0),0));
}
function renderSettleModal(){
  const{data,editItem:staff}=state;
  if(!staff)return modal('Pay wages',()=>div({},'No staff member selected.'));
  const rows=pendingWages(data,staff.id);
  const picked=new Set(rows.map(e=>e.id));     // everything, until he says otherwise
  // A wage that already carries a loan cut (set on the expense itself) keeps it;
  // the payday deduction is spread over the others.
  const hasCut=e=>!!e.loanId&&Number(e.loanDeduction||0)>0;
  const loans=activeLoansForStaff(staff.id);
  // Offered, never assumed: off until he switches it on.
  const ln={on:false,loanId:loans[0]?.id||'',amt:0};
  function defaultCut(loanId){
    const l=loanById(loanId); if(!l)return 0;
    // cuts already sitting on unpaid wages for this loan count towards this month
    const pending=round2(rows.filter(e=>picked.has(e.id)&&e.loanId===loanId).reduce((t,e)=>t+Number(e.loanDeduction||0),0));
    return round2(Math.max(0,loanInstalmentDue(l)-pending));
  }

  const content=()=>{
    const wrap=div({style:{display:'flex',flexDirection:'column',gap:0}});
    if(!rows.length){
      wrap.appendChild(div({style:{textAlign:'center',padding:'34px 8px',color:'var(--muted)',fontSize:14,lineHeight:1.6}},
        ico('circle-check',{style:{fontSize:38,color:'var(--accent)',display:'block',marginBottom:12}}),
        `Nothing pending for ${staff.name}.`));
      return wrap;
    }

    const totalLine=div({style:{fontSize:13,color:'var(--muted)'}});
    const payBtn=btn({className:'btn-primary',style:{width:'100%',marginTop:4}});
    const loanBlock=div({'data-loan':'1',style:{display:'flex',flexDirection:'column',gap:9,marginTop:12}});

    // Everything the sheet shows and does comes from here, so the screen and
    // the confirmation can never disagree.
    function figures(){
      const sel=rows.filter(e=>picked.has(e.id));
      const sum=round2(sel.reduce((t,e)=>t+Number(e.amount||0),0));
      const oldCut=round2(sel.reduce((t,e)=>t+(hasCut(e)?Number(e.loanDeduction||0):0),0));
      const room=round2(sel.filter(e=>!hasCut(e)).reduce((t,e)=>t+Number(e.amount||0),0));
      const newCut=ln.on?round2(ln.amt):0;
      return{sel,sum,oldCut,room,newCut,cash:round2(sum-newCut),tooBig:newCut>room+0.001};
    }

    function refreshTotals(){
      const F=figures(), cut=round2(F.oldCut+F.newCut);
      totalLine.textContent=F.sel.length
        ? `${F.sel.length} of ${rows.length} selected${cut>0?` · ${fmtCur(cut)} to loan`:''}`
        : 'Nothing selected';
      const can=F.sel.length>0&&!F.tooBig&&!(ln.on&&!(F.newCut>0));
      payBtn.textContent=F.sel.length?`Mark ${fmtCur(F.cash)} as paid`:'Mark as paid';
      payBtn.disabled=!can;
      payBtn.style.opacity=can?'1':'.5';
      paintLoanSummary(F);
    }

    const head=div({style:{display:'flex',alignItems:'center',justifyContent:'space-between',
      gap:10,paddingBottom:10,marginBottom:2,borderBottom:'1px solid var(--border-soft)'}});
    head.appendChild(totalLine);
    const toggleAll=btn({className:'btn-ghost btn-sm',style:{padding:'5px 10px',flexShrink:0},onClick:()=>{
      const all=picked.size===rows.length;
      picked.clear();
      if(!all)rows.forEach(e=>picked.add(e.id));
      wrap.querySelectorAll('[data-exp]').forEach(el=>paintRow(el,picked.has(el.getAttribute('data-exp'))));
      toggleAll.textContent=picked.size===rows.length?'Clear all':'Select all';
      refreshTotals();
    }},'Clear all');
    head.appendChild(toggleAll);
    wrap.appendChild(head);

    function paintRow(el,on){
      el.style.background=on?'var(--accent-light)':'transparent';
      const box=el.querySelector('[data-box]');
      box.style.background=on?'var(--accent)':'transparent';
      box.style.borderColor=on?'var(--accent)':'var(--border)';
      box.querySelector('i').style.opacity=on?'1':'0';
    }

    rows.forEach(e=>{
      const ded=e.loanId?round2(e.loanDeduction):0;
      const gross=Number(e.grossAmount||0)||round2(Number(e.amount||0)+ded);
      const row=div({'data-exp':e.id,style:{display:'flex',alignItems:'center',gap:11,
        padding:'11px 10px',borderRadius:'var(--radius-sm)',cursor:'pointer',
        borderBottom:'1px solid var(--border-soft)'}});
      const box=div({'data-box':'1',style:{width:22,height:22,borderRadius:6,flexShrink:0,
        border:'1.5px solid var(--border)',display:'flex',alignItems:'center',justifyContent:'center'}},
        ico('check',{style:{fontSize:14,color:'var(--on-accent)'}}));
      row.appendChild(box);
      row.appendChild(div({style:{minWidth:0,flex:1}},
        div({style:{fontSize:14,fontWeight:600}},fmtDate(e.date)),
        div({style:{fontSize:12,color:'var(--muted)',marginTop:2}},
          ded>0?`${fmtCur(gross)} − ${fmtCur(ded)} loan`:(e.description||'Staff payout'))));
      row.appendChild(div({className:'num',style:{fontSize:15,fontWeight:700,flexShrink:0}},fmtCur(e.amount)));
      row.addEventListener('click',()=>{
        if(picked.has(e.id))picked.delete(e.id); else picked.add(e.id);
        paintRow(row,picked.has(e.id));
        toggleAll.textContent=picked.size===rows.length?'Clear all':'Select all';
        refreshTotals();
      });
      wrap.appendChild(row);
      paintRow(row,true);
    });

    // ── Loan instalment ──────────────────────────────────────────────────────
    const loanSummary=div({'data-loan-summary':'1',style:{display:'none'}});
    function paintLoanSummary(F){
      if(!ln.on){loanSummary.style.display='none';loanSummary.innerHTML='';return;}
      loanSummary.innerHTML='';
      loanSummary.style.display='block';
      Object.assign(loanSummary.style,{background:'var(--accent-light)',border:'1px solid var(--accent-line)',borderRadius:'var(--radius-sm)',padding:'11px 13px',fontSize:13,lineHeight:1.6,color:'var(--accent)'});
      loanSummary.appendChild(div({style:{display:'flex',justifyContent:'space-between'}},span({},'Wages ticked'),span({style:{fontWeight:600}},fmtCur(F.sum))));
      loanSummary.appendChild(div({style:{display:'flex',justifyContent:'space-between'}},span({},'Less loan instalment'),span({style:{fontWeight:600}},'− '+fmtCur(F.newCut))));
      loanSummary.appendChild(div({style:{display:'flex',justifyContent:'space-between',borderTop:'1px solid var(--accent-line)',marginTop:5,paddingTop:5,fontWeight:700,color:F.tooBig?'var(--danger)':'var(--accent)'}},
        span({},'Cash to hand over'),span({},fmtCur(F.cash))));
      if(F.tooBig)loanSummary.appendChild(div({style:{color:'var(--danger)',marginTop:4}},
        `The deduction is larger than the ${fmtCur(F.room)} of wages ticked. Tick more days or deduct less.`));
    }
    function buildLoanBlock(){
      loanBlock.innerHTML='';
      if(!loans.length)return;
      const owes=round2(loans.reduce((a,l)=>a+Math.max(0,loanBalance(l)),0));
      const on=ln.on;
      const togRow=div({'data-loan-toggle':'1',style:{display:'flex',alignItems:'center',justifyContent:'space-between',gap:10,background:on?'var(--gold-light)':'var(--cream)',borderRadius:'var(--radius-sm)',padding:'11px 13px',border:`1.5px solid ${on?'var(--gold-line)':'var(--border)'}`,cursor:'pointer'}});
      togRow.appendChild(div({style:{minWidth:0}},
        div({style:{fontSize:14,fontWeight:600}},'Deduct loan instalment'),
        div({style:{fontSize:12,color:'var(--muted)',marginTop:2}},`${staff.name} owes ${fmtCur(owes)}`)));
      togRow.appendChild(div({style:{width:44,height:26,borderRadius:20,background:on?'var(--accent)':'var(--border)',flexShrink:0,position:'relative',transition:'background .15s'}},
        div({style:{width:20,height:20,borderRadius:'50%',background:'var(--on-accent)',position:'absolute',top:3,left:on?21:3,transition:'left .15s',boxShadow:'0 1px 3px rgba(0,0,0,0.2)'}})));
      togRow.addEventListener('click',()=>{
        ln.on=!ln.on;
        if(ln.on)ln.amt=defaultCut(ln.loanId);
        buildLoanBlock();refreshTotals();
      });
      loanBlock.appendChild(togRow);
      if(ln.on){
        const l=loanById(ln.loanId);
        if(loans.length>1){
          loanBlock.appendChild(div({className:'label'},'Against which loan'));
          const lSel=h('select',{'data-loan-pick':'1'});
          loans.forEach(x=>lSel.appendChild(h('option',{value:x.id,selected:ln.loanId===x.id},
            `${fmtCur(x.principal)} of ${fmtDate(x.disbursedOn)} · ${fmtCur(Math.max(0,loanBalance(x)))} left`)));
          lSel.addEventListener('change',e=>{ln.loanId=e.target.value;ln.amt=defaultCut(ln.loanId);buildLoanBlock();refreshTotals();});
          loanBlock.appendChild(lSel);
        }
        loanBlock.appendChild(div({className:'label'},'Instalment to deduct (₹)'));
        const dInp=h('input',{type:'number','data-loan-amt':'1',value:ln.amt||''});
        dInp.addEventListener('input',e=>{ln.amt=e.target.value;refreshTotals();});
        loanBlock.appendChild(dInp);
        const nd=loanNextDue(l);
        loanBlock.appendChild(div({style:{fontSize:12,color:'var(--muted)',lineHeight:1.5}},
          `Scheduled instalment ${fmtCur(l.installmentAmount)}${nd?` · due ${fmtDate(nd.dueDate)}`:''} · balance ${fmtCur(Math.max(0,loanBalance(l)))}. It is split across the days ticked, oldest first, and credited to the loan when you mark them paid.`));
        loanBlock.appendChild(loanSummary);
      }
    }
    if(loans.length){wrap.appendChild(loanBlock);buildLoanBlock();}

    payBtn.addEventListener('click',()=>{
      const F=figures();
      if(!F.sel.length)return;
      const ids=F.sel.map(e=>e.id);
      const cut=F.newCut;
      if(ln.on){
        if(!(cut>0)){alert('Enter the instalment amount to deduct, or switch the deduction off.');return;}
        if(F.tooBig){alert(`The ${fmtCur(cut)} deduction is more than the ${fmtCur(F.room)} of wages ticked.`);return;}
        const bal=Math.max(0,loanBalance(loanById(ln.loanId)));
        if(cut>bal+0.5&&!confirm(`${fmtCur(cut)} is more than the ${fmtCur(bal)} still outstanding on this loan. Continue?`))return;
      }
      const msg=`Mark ${ids.length} wage${ids.length>1?'s':''} totalling ${fmtCur(F.sum)} as paid to ${staff.name}?`
        +(cut>0?`\n\n${fmtCur(cut)} goes to the loan; ${fmtCur(F.cash)} is handed over.`:'');
      if(!confirm(msg))return;
      mutateData(d=>{
        const live=ids.map(id=>d.expenses.find(x=>x.id===id)).filter(e=>e&&!e.paid);  // never pay twice
        const shares=new Map(cut>0?splitLoanDeduction(live.filter(e=>!hasCut(e)),cut).map(s=>[s.id,s.share]):[]);
        live.forEach(e=>{
          const share=shares.get(e.id);
          if(share){
            const gross=round2(e.amount);
            e.grossAmount=gross;
            e.loanId=ln.loanId;
            e.loanDeduction=share;
            e.amount=round2(gross-share);
          }
          e.paid=true;
          syncExpenseLoan(d,e);                 // records the instalment against the loan
        });
      });
      closeModal();
    });
    wrap.appendChild(div({style:{marginTop:12}},payBtn));
    refreshTotals();
    return wrap;
  };
  return modal(`Pay ${staff.name}`,content);
}

function renderStaffModal(){
  const{editItem}=state; const isEdit=!!editItem;
  const f=isEdit?{...editItem}:{name:'',role:'',phone:'',monthlySalary:'',dailyWage:'',active:true,joinedOn:today()};
  const content=()=>{
    const wrap=div({style:{display:'flex',flexDirection:'column',gap:11}});
    [['name','Staff name *','text'],['role','Role (caretaker, cook…)','text'],['phone','Phone number','tel'],['monthlySalary','Monthly salary (₹)','number'],['dailyWage','Daily wage (₹)','number'],['checkoutWage','Checkout-day wage (₹)','number'],['utensilRate','Utensil cleaning rate (₹)','number']].forEach(([k,ph,t])=>{
      const inp=h('input',{type:t,placeholder:ph,value:f[k]??''});inp.addEventListener('input',e=>f[k]=e.target.value);wrap.appendChild(inp);
    });
    wrap.appendChild(div({style:{fontSize:12,color:'var(--muted)',marginTop:-4,lineHeight:'16px'}},
      'The daily wage is what one attendance mark becomes. Leave it blank and her marks are held until you set it. '+
      'On a day a guest checks out (turnover days too) the checkout-day wage is paid instead, once however many leave; leave it blank to pay the daily wage. '+
      'The utensil cleaning rate is paid on top, for a day she reports cleaning the utensils herself — only when a guest did not pay her for it. Leave it blank and those marks are held.'));
    const joinWrap=div({},div({className:'label'},'Joined on'));
    const joinInp=h('input',{type:'date',value:f.joinedOn||today()});joinInp.addEventListener('change',e=>f.joinedOn=e.target.value);joinWrap.appendChild(joinInp);wrap.appendChild(joinWrap);
    if(isEdit){
      const actRow=div({style:{display:'flex',alignItems:'center',justifyContent:'space-between',background:'var(--cream)',borderRadius:'var(--radius-sm)',padding:'10px 14px',border:'1.5px solid var(--border)'}});
      actRow.appendChild(div({style:{fontSize:14,fontWeight:500}},'Currently employed'));
      const tog=div({style:{display:'flex',gap:8}});
      [['Yes',true],['No',false]].forEach(([lbl,val])=>{
        tog.appendChild(btn({style:{padding:'5px 14px',borderRadius:20,border:`1.5px solid ${(f.active!==false)===val?'var(--accent)':'var(--border)'}`,background:(f.active!==false)===val?'var(--accent-light)':'var(--white)',color:(f.active!==false)===val?'var(--accent)':'var(--muted)',fontSize:13,fontWeight:(f.active!==false)===val?600:400},
          onClick:()=>{f.active=val;tog.querySelectorAll('button').forEach((b2,i)=>{const on=(f.active!==false)===(i===0);b2.style.borderColor=on?'var(--accent)':'var(--border)';b2.style.background=on?'var(--accent-light)':'var(--white)';b2.style.color=on?'var(--accent)':'var(--muted)';b2.style.fontWeight=on?600:400;});}},lbl));
      });
      actRow.appendChild(tog);wrap.appendChild(actRow);
    }
    wrap.appendChild(btn({className:'btn-primary',style:{marginTop:4,width:'100%'},onClick:()=>{
      if(!f.name)return;
      mutateData(d=>{if(isEdit)d.staff=d.staff.map(s=>s.id===f.id?f:s);else d.staff.push({...f,id:uid()});});
      closeModal();
    }},isEdit?'Update Staff':'Add Staff'));
    return wrap;
  };
  return modal(isEdit?'Edit Staff':'Add Staff',content);
}

function renderLoanModal(){
  const{data,editItem}=state; const isEdit=!!editItem;
  const f=isEdit?{...editItem}:{staffId:data.staff[0]?.id||'',propertyId:data.properties[0]?.id||'',principal:'',
    disbursedOn:today(),firstDueDate:addMonthsISO(today(),1),installmentAmount:'',notes:'',status:'active',repayments:[]};
  const content=()=>{
    const wrap=div({style:{display:'flex',flexDirection:'column',gap:11}});

    wrap.appendChild(div({className:'label'},'Staff member'));
    const stSel=h('select');
    data.staff.filter(s=>s.active!==false||s.id===f.staffId).forEach(s=>stSel.appendChild(h('option',{value:s.id,selected:f.staffId===s.id},s.name+(s.role?` — ${s.role}`:''))));
    stSel.addEventListener('change',e=>{f.staffId=e.target.value;refreshHint();});wrap.appendChild(stSel);

    if(data.properties.length>0){
      wrap.appendChild(div({className:'label'},'Charge to property'));
      const pSel=h('select');
      pSel.appendChild(h('option',{value:'',selected:!f.propertyId},'Not property-specific'));
      data.properties.forEach(p=>pSel.appendChild(h('option',{value:p.id,selected:f.propertyId===p.id},p.name)));
      pSel.addEventListener('change',e=>f.propertyId=e.target.value);wrap.appendChild(pSel);
    }

    const amtInp=h('input',{type:'number',placeholder:'Loan amount (₹) *',value:f.principal||''});
    amtInp.addEventListener('input',e=>{f.principal=e.target.value;refreshHint();});wrap.appendChild(amtInp);

    const instInp=h('input',{type:'number',placeholder:'Monthly instalment (₹) *',value:f.installmentAmount||''});
    instInp.addEventListener('input',e=>{f.installmentAmount=e.target.value;refreshHint();});wrap.appendChild(instInp);

    const dates=div({style:{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}});
    const dWrap=div({},div({className:'label'},'Given on'));
    const dInp=h('input',{type:'date',value:f.disbursedOn||today()});
    dInp.addEventListener('change',e=>{f.disbursedOn=e.target.value;if(!isEdit){f.firstDueDate=addMonthsISO(e.target.value,1);fdInp.value=f.firstDueDate;}refreshHint();});
    dWrap.appendChild(dInp);
    const fdWrap=div({},div({className:'label'},'First instalment due'));
    const fdInp=h('input',{type:'date',value:f.firstDueDate||addMonthsISO(today(),1)});
    fdInp.addEventListener('change',e=>{f.firstDueDate=e.target.value;refreshHint();});
    fdWrap.appendChild(fdInp);
    dates.appendChild(dWrap);dates.appendChild(fdWrap);wrap.appendChild(dates);

    const hint=div({style:{background:'var(--accent-light)',border:'1px solid var(--accent-line)',borderRadius:'var(--radius-sm)',padding:'11px 13px',fontSize:13,color:'var(--accent)',lineHeight:1.55,minHeight:20}});
    wrap.appendChild(hint);
    function refreshHint(){
      hint.innerHTML='';
      const p=Number(f.principal||0),i=Number(f.installmentAmount||0);
      if(!(p>0)||!(i>0)){hint.appendChild(document.createTextNode('Enter the amount and instalment to preview the schedule.'));return;}
      const rows=loanSchedule({principal:p,installmentAmount:i,firstDueDate:f.firstDueDate||f.disbursedOn,disbursedOn:f.disbursedOn});
      const last=rows[rows.length-1];
      hint.appendChild(div({style:{fontWeight:600,marginBottom:3}},`${rows.length} instalment${rows.length>1?'s':''} of ${fmtCur(i)}`));
      hint.appendChild(div({},`${fmtDate(rows[0].dueDate)} → ${fmtDate(last.dueDate)}${last.amount!==i?` (last one ${fmtCur(last.amount)})`:''}`));
      const s=staffById(f.staffId);
      if(s?.monthlySalary){
        const b=Math.round(i/Number(s.monthlySalary)*100);
        hint.appendChild(div({style:{marginTop:3,color:b>40?'var(--danger)':'var(--accent)'}},`${b}% of ${s.name}'s ${fmtCur(s.monthlySalary)} monthly salary`));
      }
    }
    refreshHint();

    const notesTA=h('textarea',{placeholder:'Purpose / notes (optional)',rows:2,style:{resize:'none'}});
    notesTA.textContent=f.notes||'';notesTA.addEventListener('input',e=>f.notes=e.target.value);wrap.appendChild(notesTA);

    if(isEdit&&loanRepaid(editItem)>0)
      wrap.appendChild(div({style:{fontSize:12.5,color:'var(--warn)',background:'var(--warn-light)',border:'1px solid var(--warn-line)',borderRadius:'var(--radius-sm)',padding:'9px 12px',lineHeight:1.5}},
        `${fmtCur(loanRepaid(editItem))} already recovered on this loan. Changing the amount or instalment re-draws the schedule; recorded repayments stay untouched.`));

    wrap.appendChild(btn({className:'btn-primary',style:{marginTop:4,width:'100%'},onClick:()=>{
      if(!f.staffId||!(Number(f.principal)>0)||!(Number(f.installmentAmount)>0)){alert('Staff, loan amount and monthly instalment are all required.');return;}
      if(Number(f.installmentAmount)>Number(f.principal)){alert('The instalment cannot be larger than the loan amount.');return;}
      f.principal=Number(f.principal);f.installmentAmount=Number(f.installmentAmount);
      mutateData(d=>{
        if(isEdit)d.loans=d.loans.map(l=>l.id===f.id?{...f,repayments:l.repayments||[]}:l);
        else d.loans.push({...f,id:uid(),repayments:[]});
        refreshLoanStatuses(d);
      });
      closeModal();
    }},isEdit?'Update Loan':'Add Loan'));
    return wrap;
  };
  return modal(isEdit?'Edit Loan':'New Staff Loan',content);
}

function renderRepaymentModal(){
  const loan=state.editItem; if(!loan)return modal('Record Repayment',()=>div({}));
  const next=loanNextDue(loan), bal=Math.max(0,loanBalance(loan));
  const f={date:today(),amount:next?round2(Math.min(next.amount-next.paid,bal)):bal,note:''};
  const content=()=>{
    const wrap=div({style:{display:'flex',flexDirection:'column',gap:11}});
    wrap.appendChild(div({style:{background:'var(--cream)',borderRadius:'var(--radius-sm)',padding:'11px 13px',fontSize:13,lineHeight:1.6,border:'1px solid var(--border)'}},
      div({style:{fontWeight:600,marginBottom:2}},staffName(loan.staffId)),
      div({style:{color:'var(--muted)'}},`Outstanding ${fmtCur(bal)}${next?` · instalment ${fmtCur(next.amount-next.paid)} due ${fmtDate(next.dueDate)}`:''}`)
    ));
    wrap.appendChild(div({style:{fontSize:12.5,color:'var(--muted)',lineHeight:1.5}},
      'Use this for cash or transfer repaid directly. Instalments cut from a salary payout are recorded from the expense entry instead.'));
    const amtInp=h('input',{type:'number',placeholder:'Amount received (₹) *',value:f.amount||''});
    amtInp.addEventListener('input',e=>f.amount=e.target.value);wrap.appendChild(amtInp);
    const dWrap=div({},div({className:'label'},'Received on'));
    const dInp=h('input',{type:'date',value:f.date});dInp.addEventListener('change',e=>f.date=e.target.value);dWrap.appendChild(dInp);wrap.appendChild(dWrap);
    const nInp=h('input',{type:'text',placeholder:'Note (optional)'});nInp.addEventListener('input',e=>f.note=e.target.value);wrap.appendChild(nInp);
    wrap.appendChild(btn({className:'btn-primary',style:{marginTop:4,width:'100%'},onClick:()=>{
      const amt=round2(f.amount);
      if(!(amt>0))return;
      if(amt>bal+0.5&&!confirm(`${fmtCur(amt)} is more than the ${fmtCur(bal)} outstanding. Record it anyway?`))return;
      mutateData(d=>{
        const l=d.loans.find(x=>x.id===loan.id);
        (l.repayments=l.repayments||[]).push({id:uid(),date:f.date,amount:amt,mode:'direct',note:f.note||''});
        refreshLoanStatuses(d);
      });
      closeModal();
    }},'Record Repayment'));
    return wrap;
  };
  return modal('Record Repayment',content);
}

// A UPI ID: name@handle. Mirrors the check in payment-details.sql.
const UPI_ID_RE=/^[A-Za-z0-9._-]{2,}@[A-Za-z0-9.-]{2,}$/;
// The QR is kept as a PNG data: URL (like the signature), scaled down so it
// syncs quickly but stays sharp enough to scan. PNG, not JPEG: JPEG blurs the
// square edges a scanner relies on.
function prepareQrImage(file){
  return new Promise((res,rej)=>{
    if(!/^image\//.test(file.type||''))return rej(new Error('Choose an image of the QR code.'));
    const r=new FileReader();
    r.onerror=()=>rej(new Error('Could not read that image.'));
    r.onload=()=>{
      const img=new Image();
      img.onerror=()=>rej(new Error('Could not read that image.'));
      img.onload=()=>{
        const max=640, k=Math.min(1,max/Math.max(img.width,img.height));
        const c=document.createElement('canvas');
        c.width=Math.max(1,Math.round(img.width*k)); c.height=Math.max(1,Math.round(img.height*k));
        const g=c.getContext('2d'); g.imageSmoothingEnabled=false;
        g.fillStyle='#fff'; g.fillRect(0,0,c.width,c.height); g.drawImage(img,0,0,c.width,c.height);
        res(c.toDataURL('image/png'));
      };
      img.src=r.result;
    };
    r.readAsDataURL(file);
  });
}

function renderPropertyModal(){
  const{editItem}=state; const isEdit=!!editItem;
  const f=isEdit?{...editItem}:{name:'',location:'',rooms:'',pricePerNight:'',description:'',
    mapsLink:'',wifiName:'',wifiPassword:'',signature:'',signatureRatio:'',
    upiId:'',upiPayee:'',upiQr:'',bankDetails:''};
  const content=()=>{
    const wrap=div({style:{display:'flex',flexDirection:'column',gap:11}});
    const field=(k,ph,t)=>{const inp=h('input',{type:t||'text',placeholder:ph,value:f[k]||''});
      inp.addEventListener('input',e=>f[k]=e.target.value);return inp;};
    const area=(k,ph,rows)=>{const ta=h('textarea',{placeholder:ph,rows:rows||2,style:{resize:'none'}});
      ta.textContent=f[k]||'';ta.addEventListener('input',e=>f[k]=e.target.value);return ta;};
    const heading=t=>div({className:'kicker',style:{marginTop:6}},t);

    [['name','Property name *','text'],['location','Location / Address','text'],
     ['rooms','Number of rooms','number'],['pricePerNight','Base price per night (₹)','number']]
      .forEach(([k,ph,t])=>wrap.appendChild(field(k,ph,t)));
    wrap.appendChild(area('description','Notes / description'));

    wrap.appendChild(heading('For guest messages'));
    wrap.appendChild(field('mapsLink','Google Maps link','url'));
    const wifi=div({style:{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}});
    wifi.appendChild(field('wifiName','Wi-Fi name'));
    wifi.appendChild(field('wifiPassword','Wi-Fi password'));
    wrap.appendChild(wifi);

    // ── Payment details ──────────────────────────────────────────────────────
    // For guests who pay at the property (Direct and Booking.com). Sent only to
    // them, only with a balance, in the check-out reminder or a Payment request.
    // Property data synced like the Wi-Fi — never in the code; the repo is public.
    wrap.appendChild(heading('Payment details'));
    wrap.appendChild(div({style:{fontSize:12,color:'var(--muted)',lineHeight:1.5,marginTop:-4}},
      'Sent to Direct and Booking.com guests who still owe a balance — never to Airbnb or other platforms that collect payment themselves. Stored with your property, never in the app\u2019s code.'));
    const upiRow=div({style:{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}});
    const upiInp=field('upiId','UPI ID (name@bank)'); upiInp.setAttribute('data-pay','upiId');
    upiInp.autocapitalize='none'; upiInp.spellcheck=false;
    const payeeInp=field('upiPayee','Payee name'); payeeInp.setAttribute('data-pay','upiPayee');
    upiRow.appendChild(upiInp); upiRow.appendChild(payeeInp);
    wrap.appendChild(upiRow);
    const bankTa=area('bankDetails','Bank details (optional) — account name, number, IFSC, bank',3);
    bankTa.setAttribute('data-pay','bankDetails');
    wrap.appendChild(bankTa);
    const qrBox=div({'data-pay-qr':'1',style:{border:'1.5px solid var(--border)',borderRadius:'var(--radius-sm)',
      padding:'12px',background:'var(--surface-2)'}});
    const qrInput=h('input',{type:'file',accept:'image/*','data-pay-qr-input':'1',style:{display:'none'}});
    function paintQr(){
      qrBox.innerHTML='';
      if(f.upiQr)qrBox.appendChild(h('img',{src:f.upiQr,alt:'UPI QR code',
        style:{display:'block',maxWidth:'150px',maxHeight:'150px',margin:'0 auto 10px'}}));
      else qrBox.appendChild(div({style:{fontSize:12.5,color:'var(--muted)',lineHeight:1.5,marginBottom:10,textAlign:'center'}},
        'No UPI QR image (optional). With one set, the Send sheet offers it to share alongside the payment message.'));
      const row=div({style:{display:'flex',gap:8,justifyContent:'center'}});
      row.appendChild(btn({className:'btn-ghost btn-sm',onClick:()=>qrInput.click()},
        ico('qrcode',{style:{marginRight:4,fontSize:14}}),f.upiQr?'Replace QR':'Upload QR'));
      if(f.upiQr)row.appendChild(btn({className:'btn-danger btn-sm',onClick:()=>{f.upiQr='';paintQr();}},'Remove'));
      qrBox.appendChild(row);
    }
    qrInput.addEventListener('change',async e=>{
      const file=e.target.files&&e.target.files[0];
      e.target.value='';
      if(!file)return;
      try{ f.upiQr=await prepareQrImage(file); paintQr(); }
      catch(err){ alert(err.message||'Could not use that image.'); }
    });
    wrap.appendChild(qrInput);
    paintQr();
    wrap.appendChild(qrBox);

    // ── Signature ────────────────────────────────────────────────────────────
    wrap.appendChild(heading('Signature on receipts'));
    const sigBox=div({style:{border:'1.5px solid var(--border)',borderRadius:'var(--radius-sm)',
      padding:'12px',background:'var(--surface-2)'}});
    const sigInput=h('input',{type:'file',accept:'image/*',style:{display:'none'}});
    function paintSig(){
      sigBox.innerHTML='';
      if(f.signature){
        const prev=h('img',{src:f.signature,alt:'Your signature',
          style:{display:'block',maxWidth:'170px',maxHeight:'90px',margin:'0 auto 10px'}});
        sigBox.appendChild(prev);
      } else {
        sigBox.appendChild(div({style:{fontSize:12.5,color:'var(--muted)',lineHeight:1.5,marginBottom:10,textAlign:'center'}},
          'No signature set. Receipts print a blank line to sign by hand.'));
      }
      const row=div({style:{display:'flex',gap:8,justifyContent:'center'}});
      row.appendChild(btn({className:'btn-ghost btn-sm',onClick:()=>sigInput.click()},
        ico('upload',{style:{marginRight:4,fontSize:14}}),f.signature?'Replace':'Upload'));
      if(f.signature)row.appendChild(btn({className:'btn-danger btn-sm',
        onClick:()=>{f.signature='';f.signatureRatio='';paintSig();}},'Remove'));
      sigBox.appendChild(row);
      sigBox.appendChild(div({style:{fontSize:11.5,color:'var(--muted)',lineHeight:1.5,marginTop:9,textAlign:'center'}},
        'Sign on white paper and photograph it. The app trims the paper away and keeps only the ink. It is stored with your property, never in the app\u2019s code.'));
    }
    sigInput.addEventListener('change',async e=>{
      const file=e.target.files&&e.target.files[0];
      e.target.value='';
      if(!file)return;
      try{
        const {uri,ratio}=await prepareSignature(file);
        f.signature=uri; f.signatureRatio=ratio;
        paintSig();
      }catch(err){ alert(err.message||'Could not use that image.'); }
    });
    wrap.appendChild(sigInput);
    paintSig();
    wrap.appendChild(sigBox);

    wrap.appendChild(btn({className:'btn-primary',style:{marginTop:4,width:'100%'},onClick:()=>{
      if(!f.name)return;
      f.upiId=String(f.upiId||'').trim(); f.upiPayee=String(f.upiPayee||'').trim();
      // A mistyped UPI ID sends a guest's money nowhere: refuse it here (SQL refuses it too).
      if(f.upiId&&!UPI_ID_RE.test(f.upiId)){alert('That UPI ID does not look right. It should look like name@bank.');return;}
      mutateData(d=>{if(isEdit)d.properties=d.properties.map(p=>p.id===f.id?f:p);else d.properties.push({...f,id:uid()});});
      closeModal();
    }},isEdit?'Update Property':'Save Property'));
    return wrap;
  };
  return modal(isEdit?'Edit Property':'Add Property',content);
}

function renderBookingModal(){
  const{data,editItem}=state;
  const isEdit=!!editItem;
  const f=isEdit?{...editItem}:{propertyId:data.properties[0]?.id||'',guestName:'',phone:'',checkIn:'',checkOut:'',guests:1,totalAmount:'',paid:'',source:'Direct',status:'confirmed',notes:'',idProofType:'',idProofNumber:'',idProofImage:''};
  const content=()=>{
    const wrap=div({style:{display:'flex',flexDirection:'column',gap:11}});
    const propSel=h('select');
    data.properties.forEach(p=>propSel.appendChild(h('option',{value:p.id,selected:f.propertyId===p.id},p.name)));
    propSel.addEventListener('change',e=>{f.propertyId=e.target.value;autoCalc();});wrap.appendChild(propSel);
    const guestInp=h('input',{type:'text',placeholder:'Guest name *',value:f.guestName||''});guestInp.addEventListener('input',e=>f.guestName=e.target.value);wrap.appendChild(guestInp);
    const phoneInp=h('input',{type:'tel',placeholder:'Phone number',value:f.phone||''});phoneInp.addEventListener('input',e=>f.phone=e.target.value);wrap.appendChild(phoneInp);
    const datesRow=div({style:{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}});
    const ciWrap=div({},div({className:'label'},'Check-in'));const ciInp=h('input',{type:'date',value:f.checkIn||''});ciInp.addEventListener('change',e=>{f.checkIn=e.target.value;validateDates();autoCalc();});ciWrap.appendChild(ciInp);
    const coWrap=div({},div({className:'label'},'Check-out'));const coInp=h('input',{type:'date',value:f.checkOut||''});coInp.addEventListener('change',e=>{f.checkOut=e.target.value;validateDates();autoCalc();});coWrap.appendChild(coInp);
    datesRow.appendChild(ciWrap);datesRow.appendChild(coWrap);wrap.appendChild(datesRow);
    const conflictMsg=div({style:{fontSize:13,color:'var(--danger)',fontWeight:500,minHeight:18,display:'flex',alignItems:'center',gap:5}});
    const nightsInfo=div({style:{fontSize:13,color:'var(--accent)',fontWeight:500,minHeight:18}});
    wrap.appendChild(conflictMsg);wrap.appendChild(nightsInfo);
    function validateDates(){
      conflictMsg.innerHTML='';
      if(f.checkIn&&f.checkOut&&f.propertyId){
        if(hasConflict(f.propertyId,f.checkIn,f.checkOut,isEdit?f.id:null)){
          conflictMsg.appendChild(ico('alert-circle',{style:{fontSize:15,color:'var(--danger)'}}));
          conflictMsg.appendChild(document.createTextNode(' These dates overlap with an existing booking!'));
        }
      }
    }
    // Total, Payment received and, for guests who pay us, Round off: a gap of
    // up to ROUND_OFF_LIMIT either way fills Round off; once it is typed by
    // hand (roundOffHand, kept on the booking) it is never filled again.
    const amtRow=div({style:{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}});
    const amtInp=h('input',{type:'number',step:'any',placeholder:'Total (₹)','data-total':'1',value:f.totalAmount||''});
    const paidInp=h('input',{type:'number',step:'any',placeholder:'Payment received (₹)','data-received':'1',value:f.paid||''});
    amtRow.appendChild(div({},div({className:'label'},'Total'),amtInp));
    amtRow.appendChild(div({},div({className:'label'},'Payment received'),paidInp));
    wrap.appendChild(amtRow);
    const roInp=h('input',{type:'number',step:'any',placeholder:'0.00','data-round-off':'1',
      value:Number(f.roundOff)?r2(f.roundOff).toFixed(2):''});
    const roWrap=div({'data-round-off-row':'1'},div({className:'label'},'Round off'),roInp,
      div({style:{fontSize:11.5,color:'var(--muted)',marginTop:3,lineHeight:1.45}},
        `A gap of up to ₹${ROUND_OFF_LIMIT} either way fills in by itself. + is what you let go, − what the guest paid over.`));
    const moneyLine=div({'data-money-line':'1',style:{fontSize:13,fontWeight:600,minHeight:18}});
    wrap.appendChild(roWrap); wrap.appendChild(moneyLine);
    const showMoney=()=>{
      const direct=paysUsDirectly(f);
      roWrap.style.display=direct?'':'none'; moneyLine.style.display=direct?'':'none';
      if(!direct)return;
      const due=balanceDue(f);
      moneyLine.style.color=due>0?'var(--warn)':'var(--accent)';
      moneyLine.textContent=Number(f.totalAmount)>0?(due>0?`Balance due ${fmtCur(due)}`:'Fully paid'):'';
    };
    const autoFill=()=>{
      if(f.roundOffHand||!paysUsDirectly(f)||f.paid===''||f.paid==null)return;
      const ro=autoRoundOff(f.totalAmount,f.paid);
      if(ro===null)return;                     // a real balance: leave Round off as it is
      f.roundOff=ro; roInp.value=ro?ro.toFixed(2):'';
    };
    amtInp.addEventListener('input',e=>{f.totalAmount=e.target.value;autoFill();showMoney();});
    paidInp.addEventListener('input',e=>{f.paid=e.target.value;autoFill();showMoney();});
    roInp.addEventListener('input',e=>{f.roundOffHand=true;f.roundOff=e.target.value===''?0:r2(e.target.value);showMoney();});
    function autoCalc(){
      if(f.checkIn&&f.checkOut&&!isEdit){
        const n=diffDays(f.checkIn,f.checkOut);
        const prop=data.properties.find(p=>p.id===f.propertyId);
        if(n>0&&prop?.pricePerNight){const s=n*Number(prop.pricePerNight);f.totalAmount=s;amtInp.value=s;autoFill();showMoney();nightsInfo.textContent=`${n} nights · Suggested: ₹${s.toLocaleString('en-IN')}`;}
        else if(n>0)nightsInfo.textContent=`${n} nights`;
      }
    }
    const guestsInp=h('input',{type:'number',placeholder:'No. of guests',value:f.guests||1});guestsInp.addEventListener('input',e=>f.guests=e.target.value);wrap.appendChild(guestsInp);
    const srcSel=h('select');
    ['Direct','Airbnb','Booking.com','MakeMyTrip','Goibibo','OYO','Other'].forEach(s=>srcSel.appendChild(h('option',{value:s,selected:f.source===s},s)));
    srcSel.addEventListener('change',e=>{f.source=e.target.value;autoFill();showMoney();});wrap.appendChild(srcSel);
    showMoney();
    const stSel=h('select');
    [['confirmed','Confirmed'],['checkedin','Checked In'],['checkedout','Checked Out'],['cancelled','Cancelled']].forEach(([v,l])=>stSel.appendChild(h('option',{value:v,selected:f.status===v},l)));
    stSel.addEventListener('change',e=>f.status=e.target.value);wrap.appendChild(stSel);
    const notesTA=h('textarea',{placeholder:'Notes (optional)',rows:2,style:{resize:'none'}});notesTA.textContent=f.notes||'';notesTA.addEventListener('input',e=>f.notes=e.target.value);wrap.appendChild(notesTA);

    // ── Identity Proof Section ────────────────────────────────────────────────
    wrap.appendChild(div({style:{fontSize:12,fontWeight:600,color:'var(--muted)',textTransform:'uppercase',letterSpacing:'0.06em',marginTop:6}},'Identity Proof'));
    const idRow=div({style:{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}});
    const idTypeSel=h('select');
    [['','Select ID type'],['Aadhaar','Aadhaar Card'],['Passport','Passport'],['DrivingLicense','Driving Licence'],['VoterID','Voter ID'],['PAN','PAN Card'],['Other','Other']].forEach(([v,l])=>idTypeSel.appendChild(h('option',{value:v,selected:(f.idProofType||'')===v},l)));
    idTypeSel.addEventListener('change',e=>f.idProofType=e.target.value);
    const idNumInp=h('input',{type:'text',placeholder:'ID number',value:f.idProofNumber||''});idNumInp.addEventListener('input',e=>f.idProofNumber=e.target.value);
    idRow.appendChild(idTypeSel);idRow.appendChild(idNumInp);wrap.appendChild(idRow);

    // Image upload + preview
    const imgPreviewWrap=div({style:{display:'flex',flexDirection:'column',gap:8}});
    const imgPreview=div({style:{display:f.idProofImage?'block':'none'}});
    if(f.idProofImage){
      const imgEl=h('img',{src:f.idProofImage,style:{width:'100%',maxHeight:'180px',objectFit:'contain',borderRadius:8,border:'1px solid var(--border)'}});
      imgPreview.appendChild(imgEl);
      imgPreview.appendChild(btn({style:{marginTop:6,background:'var(--danger-light)',color:'var(--danger)',border:'1.5px solid var(--danger-line)',borderRadius:'var(--radius-sm)',padding:'5px 12px',fontSize:12,fontWeight:600,cursor:'pointer',width:'100%'},onClick:()=>{f.idProofImage='';imgPreview.style.display='none';uploadBtn.style.display='flex';}},'Remove photo'));
    }
    const uploadBtn=div({style:{display:f.idProofImage?'none':'flex',alignItems:'center',justifyContent:'center',gap:8,background:'var(--cream)',border:'2px dashed var(--border)',borderRadius:'var(--radius-sm)',padding:'14px',cursor:'pointer',color:'var(--muted)',fontSize:13,fontWeight:500}});
    uploadBtn.appendChild(ico('camera',{style:{fontSize:18}}));
    uploadBtn.appendChild(document.createTextNode('Attach ID photo'));
    const fileInp=h('input',{type:'file',accept:'image/*',style:{display:'none'}});
    fileInp.addEventListener('change',e=>{
      const file=e.target.files[0];if(!file)return;
      if(file.size>5*1024*1024){alert('Image too large. Please use an image under 5 MB.');return;}
      const reader=new FileReader();
      reader.onload=ev=>{
        f.idProofImage=ev.target.result;
        imgPreview.innerHTML='';
        const imgEl=h('img',{src:f.idProofImage,style:{width:'100%',maxHeight:'180px',objectFit:'contain',borderRadius:8,border:'1px solid var(--border)'}});
        imgPreview.appendChild(imgEl);
        imgPreview.appendChild(btn({style:{marginTop:6,background:'var(--danger-light)',color:'var(--danger)',border:'1.5px solid var(--danger-line)',borderRadius:'var(--radius-sm)',padding:'5px 12px',fontSize:12,fontWeight:600,cursor:'pointer',width:'100%'},onClick:()=>{f.idProofImage='';imgPreview.style.display='none';uploadBtn.style.display='flex';}},'Remove photo'));
        imgPreview.style.display='block';
        uploadBtn.style.display='none';
      };
      reader.readAsDataURL(file);
    });
    uploadBtn.addEventListener('click',()=>fileInp.click());
    imgPreviewWrap.appendChild(uploadBtn);imgPreviewWrap.appendChild(imgPreview);imgPreviewWrap.appendChild(fileInp);
    wrap.appendChild(imgPreviewWrap);

    wrap.appendChild(btn({className:'btn-primary',style:{marginTop:8,width:'100%'},onClick:()=>{
      if(!f.guestName||!f.checkIn||!f.checkOut||!f.propertyId)return;
      if(hasConflict(f.propertyId,f.checkIn,f.checkOut,isEdit?f.id:null)){alert('These dates overlap with an existing booking. Please choose different dates.');return;}
      if(!isEdit)f.id=uid();
      f.roundOff=paysUsDirectly(f)?r2(f.roundOff||0):0;   // never for platforms that collect payment
      const owedBefore=isEdit?balanceDue(editItem):balanceDue({});
      mutateData(d=>{if(isEdit)d.bookings=d.bookings.map(b=>b.id===f.id?f:b);else d.bookings.push({...f});});
      // This save settled it: offer the receipt, as "Mark paid" does.
      if(isEdit&&owedBefore>0&&justPaidInFull(f))setState({modal:'paidReceipt',editItem:{...f}});
      else if(!isEdit&&waNumber(f.phone))setState({modal:'sendConfirm',editItem:{...f}});
      else closeModal();
    }},isEdit?'Update Booking':'Add Booking'));
    return wrap;
  };
  return modal(isEdit?'Edit Booking':'New Booking',content);
}

function renderExpenseModal(){
  const{data,editItem}=state;
  const isEdit=!!editItem;
  const f=isEdit?{...editItem}:{propertyId:data.properties[0]?.id||'',description:'',amount:'',date:today(),category:'maintenance',paid:false,notes:'',staffId:'',loanId:'',loanDeduction:0};
  if(!f.staffId)f.staffId='';
  if(!f.loanId){f.loanId='';f.loanDeduction=0;}
  // "gross" is what you owe the staff before any loan cut; f.amount is the cash actually paid
  const g={val:isEdit?Number(f.grossAmount||f.amount||0)||'':''};
  const content=()=>{
    const wrap=div({style:{display:'flex',flexDirection:'column',gap:11}});
    const propSel=h('select');
    data.properties.forEach(p=>propSel.appendChild(h('option',{value:p.id,selected:f.propertyId===p.id},p.name)));
    propSel.addEventListener('change',e=>f.propertyId=e.target.value);wrap.appendChild(propSel);
    const descInp=h('input',{type:'text',placeholder:'Description *',value:f.description||''});descInp.addEventListener('input',e=>f.description=e.target.value);wrap.appendChild(descInp);
    const amtInp=h('input',{type:'number',placeholder:'Amount (₹) *',value:g.val||''});
    amtInp.addEventListener('input',e=>{g.val=e.target.value;updateNet();});wrap.appendChild(amtInp);
    const dateWrap=div({},div({className:'label'},'Date'));
    const dateInp=h('input',{type:'date',value:f.date||today()});dateInp.addEventListener('change',e=>f.date=e.target.value);dateWrap.appendChild(dateInp);wrap.appendChild(dateWrap);
    const catSel=h('select');
    [['maintenance','🔧 Maintenance'],['utilities','💡 Utilities'],['supplies','🛒 Supplies'],['staff','👤 Staff'],['marketing','📣 Marketing'],['other','📦 Other']].forEach(([v,l])=>catSel.appendChild(h('option',{value:v,selected:f.category===v},l)));
    catSel.addEventListener('change',e=>{f.category=e.target.value;buildStaffBlock();});wrap.appendChild(catSel);

    // ── Staff payout + loan recovery ─────────────────────────────────────────
    const staffBlock=div({style:{display:'flex',flexDirection:'column',gap:11}});
    wrap.appendChild(staffBlock);
    const netLine=div({style:{display:'none'}});
    wrap.appendChild(netLine);

    function updateNet(){
      const gross=round2(g.val), ded=round2(f.loanDeduction);
      const showPending=!!f.loanId&&ded>0&&!f.paid;
      pendingNote.style.display=showPending?'block':'none';
      pendingNote.textContent=showPending?`This payout is marked Unpaid, so the ${fmtCur(ded)} is not credited to the loan yet. It posts against the loan the moment you mark it Paid.`:'';
      if(!(f.loanId&&ded>0)){netLine.style.display='none';netLine.innerHTML='';return;}
      const net=round2(gross-ded);
      netLine.innerHTML='';
      netLine.style.display='block';
      Object.assign(netLine.style,{background:'var(--accent-light)',border:'1px solid var(--accent-line)',borderRadius:'var(--radius-sm)',padding:'11px 13px',fontSize:13,lineHeight:1.6,color:'var(--accent)'});
      netLine.appendChild(div({style:{display:'flex',justifyContent:'space-between'}},span({},'Payout due'),span({style:{fontWeight:600}},fmtCur(gross))));
      netLine.appendChild(div({style:{display:'flex',justifyContent:'space-between'}},span({},'Less loan instalment'),span({style:{fontWeight:600}},'− '+fmtCur(ded))));
      netLine.appendChild(div({style:{display:'flex',justifyContent:'space-between',borderTop:'1px solid var(--accent-line)',marginTop:5,paddingTop:5,fontWeight:700,color:net<0?'var(--danger)':'var(--accent)'}},
        span({},'Cash paid (booked as expense)'),span({},fmtCur(net))));
      if(net<0)netLine.appendChild(div({style:{color:'var(--danger)',marginTop:4}},'The deduction is larger than the payout.'));
    }

    function buildStaffBlock(){
      staffBlock.innerHTML='';
      if(f.category!=='staff'){f.staffId='';f.loanId='';f.loanDeduction=0;updateNet();return;}
      if(data.staff.length===0){
        staffBlock.appendChild(div({style:{background:'var(--cream)',border:'1px solid var(--border)',borderRadius:'var(--radius-sm)',padding:'11px 13px',fontSize:12.5,color:'var(--muted)',lineHeight:1.5}},
          'No staff on record yet. Add staff in the Loans tab to link payouts and deduct loan instalments here.'));
        updateNet();return;
      }
      staffBlock.appendChild(div({className:'label'},'Paid to'));
      const sSel=h('select');
      sSel.appendChild(h('option',{value:'',selected:!f.staffId},'Not a specific person'));
      data.staff.filter(s=>s.active!==false||s.id===f.staffId).forEach(s=>sSel.appendChild(h('option',{value:s.id,selected:f.staffId===s.id},s.name+(s.role?` — ${s.role}`:''))));
      sSel.addEventListener('change',e=>{f.staffId=e.target.value;f.loanId='';f.loanDeduction=0;buildStaffBlock();});
      staffBlock.appendChild(sSel);

      if(!f.staffId){f.loanId='';f.loanDeduction=0;updateNet();return;}
      const s=staffById(f.staffId);
      if(s?.monthlySalary&&!g.val&&!isEdit){g.val=Number(s.monthlySalary);amtInp.value=g.val;}

      const loans=activeLoansForStaff(f.staffId);
      // keep an already-linked loan selectable even if it just went to zero
      if(f.loanId&&!loans.some(l=>l.id===f.loanId)){const cur=loanById(f.loanId);if(cur)loans.push(cur);}
      if(loans.length===0){
        staffBlock.appendChild(div({style:{fontSize:12.5,color:'var(--muted)'}},`No running loan for ${s.name}.`));
        f.loanId='';f.loanDeduction=0;updateNet();return;
      }

      const on=!!f.loanId;
      const togRow=div({style:{display:'flex',alignItems:'center',justifyContent:'space-between',gap:10,background:on?'var(--gold-light)':'var(--cream)',borderRadius:'var(--radius-sm)',padding:'11px 13px',border:`1.5px solid ${on?'var(--gold-line)':'var(--border)'}`,cursor:'pointer'}});
      togRow.appendChild(div({style:{minWidth:0}},
        div({style:{fontSize:14,fontWeight:600}},'Deduct loan instalment'),
        div({style:{fontSize:12,color:'var(--muted)',marginTop:2}},`${s.name} owes ${fmtCur(round2(loans.reduce((a,l)=>a+Math.max(0,loanBalance(l)),0)))}`)
      ));
      const knob=div({style:{width:44,height:26,borderRadius:20,background:on?'var(--accent)':'var(--border)',flexShrink:0,position:'relative',transition:'background .15s'}},
        div({style:{width:20,height:20,borderRadius:'50%',background:'var(--on-accent)',position:'absolute',top:3,left:on?21:3,transition:'left .15s',boxShadow:'0 1px 3px rgba(0,0,0,0.2)'}}));
      togRow.appendChild(knob);
      togRow.addEventListener('click',()=>{
        if(f.loanId){f.loanId='';f.loanDeduction=0;}
        else{
          const l=loans[0];
          f.loanId=l.id;
          f.loanDeduction=loanInstalmentDue(l);
          f.paid=true;
        }
        buildStaffBlock();syncPaidToggle();
      });
      staffBlock.appendChild(togRow);

      if(f.loanId){
        const l=loanById(f.loanId);
        if(loans.length>1){
          staffBlock.appendChild(div({className:'label'},'Against which loan'));
          const lSel=h('select');
          loans.forEach(x=>lSel.appendChild(h('option',{value:x.id,selected:f.loanId===x.id},
            `${fmtCur(x.principal)} of ${fmtDate(x.disbursedOn)} · ${fmtCur(Math.max(0,loanBalance(x)))} left`)));
          lSel.addEventListener('change',e=>{
            f.loanId=e.target.value;
            f.loanDeduction=loanInstalmentDue(loanById(f.loanId));
            buildStaffBlock();
          });
          staffBlock.appendChild(lSel);
        }
        staffBlock.appendChild(div({className:'label'},'Instalment to deduct (₹)'));
        const dInp=h('input',{type:'number',value:f.loanDeduction||''});
        dInp.addEventListener('input',e=>{f.loanDeduction=e.target.value;updateNet();});
        staffBlock.appendChild(dInp);
        const bal=Math.max(0,loanBalance(l)),nd=loanNextDue(l);
        staffBlock.appendChild(div({style:{fontSize:12,color:'var(--muted)',lineHeight:1.5}},
          `Scheduled instalment ${fmtCur(l.installmentAmount)}${nd?` · due ${fmtDate(nd.dueDate)}`:''} · balance ${fmtCur(bal)}. The loan is credited once this payout is marked Paid.`));
      }
      updateNet();
    }

    // Paid toggle
    const paidRow=div({style:{display:'flex',alignItems:'center',justifyContent:'space-between',background:'var(--cream)',borderRadius:'var(--radius-sm)',padding:'10px 14px',border:'1.5px solid var(--border)'}});
    paidRow.appendChild(div({style:{fontSize:14,fontWeight:500}},'Payment Status'));
    const toggle=div({style:{display:'flex',gap:8}});
    ['Paid','Unpaid'].forEach(lbl=>{
      const isPaid=lbl==='Paid';
      const b=btn({
        style:{padding:'5px 14px',borderRadius:20,border:`1.5px solid ${f.paid===isPaid?'var(--accent)':'var(--border)'}`,background:f.paid===isPaid?'var(--accent-light)':'var(--white)',color:f.paid===isPaid?'var(--accent)':'var(--muted)',fontSize:13,fontWeight:f.paid===isPaid?600:400,cursor:'pointer'},
        onClick:()=>{f.paid=isPaid;syncPaidToggle();buildStaffBlock();}
      },lbl);
      toggle.appendChild(b);
    });
    function syncPaidToggle(){
      toggle.querySelectorAll('button').forEach((b2,i)=>{
        const ip2=i===0;
        b2.style.borderColor=f.paid===ip2?'var(--accent)':'var(--border)';
        b2.style.background=f.paid===ip2?'var(--accent-light)':'var(--white)';
        b2.style.color=f.paid===ip2?'var(--accent)':'var(--muted)';
        b2.style.fontWeight=f.paid===ip2?600:400;
      });
    }
    paidRow.appendChild(toggle);wrap.appendChild(paidRow);
    const pendingNote=div({style:{display:'none',fontSize:12.5,color:'var(--warn)',background:'var(--warn-light)',border:'1px solid var(--warn-line)',borderRadius:'var(--radius-sm)',padding:'9px 12px',lineHeight:1.5}});
    wrap.appendChild(pendingNote);
    const notesTA=h('textarea',{placeholder:'Notes (optional)',rows:2,style:{resize:'none'}});notesTA.textContent=f.notes||'';notesTA.addEventListener('input',e=>f.notes=e.target.value);wrap.appendChild(notesTA);
    wrap.appendChild(btn({className:'btn-primary',style:{marginTop:4,width:'100%'},onClick:()=>{
      const gross=round2(g.val);
      if(!f.description||!(gross>0)||!f.propertyId){alert('Description, amount and property are required.');return;}
      const ded=f.loanId?round2(f.loanDeduction):0;
      if(f.loanId&&!(ded>0)){alert('Enter the instalment amount to deduct, or switch the deduction off.');return;}
      if(ded>gross){alert(`The ${fmtCur(ded)} deduction is more than the ${fmtCur(gross)} payout.`);return;}
      if(f.loanId){
        const l=loanById(f.loanId);
        const already=isEdit?round2((l.repayments||[]).filter(r=>r.expenseId===f.id).reduce((a,r)=>a+Number(r.amount||0),0)):0;
        const bal=round2(Math.max(0,loanBalance(l))+already);
        if(ded>bal+0.5&&!confirm(`${fmtCur(ded)} is more than the ${fmtCur(bal)} still outstanding on this loan. Continue?`))return;
      }
      f.loanDeduction=ded;
      f.grossAmount=gross;
      f.amount=round2(gross-ded);
      if(!f.id)f.id=uid();
      mutateData(d=>{
        if(isEdit)d.expenses=d.expenses.map(e=>e.id===f.id?{...f}:e);
        else d.expenses.push({...f});
        syncExpenseLoan(d,f);
      });
      closeModal();
    }},isEdit?'Update Expense':'Add Expense'));
    // initial paint of the conditional staff/loan section
    syncPaidToggle();
    buildStaffBlock();
    return wrap;
  };
  return modal(isEdit?'Edit Expense':'New Expense',content);
}

// ─── Actions ──────────────────────────────────────────────────────────────────
function updateStatus(id,status){
  mutateData(d=>d.bookings=d.bookings.map(b=>b.id===id?{...b,status}:b));
  if(status!=='checkedin')return;
  const b=state.data.bookings.find(x=>x.id===id);
  if(b&&waNumber(b.phone)&&!msgSentOn(b,'stay'))setState({modal:'sendConfirm',editItem:b});
}

// ─── Main Render ──────────────────────────────────────────────────────────────
let currentModal=null;
function render(){
  const app=document.getElementById('app');
  if(state._loading){
    app.innerHTML='';
    app.appendChild(div({style:{display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',height:'100vh',gap:16}},
      h('div',{style:{fontFamily:'var(--display)',fontSize:28,color:'var(--accent)'}},'StayLog'),
      h('div',{style:{fontSize:13,color:'var(--muted)'}},'Loading your data…')
    ));
    return;
  }
  if(!state.loggedIn){renderLoginScreen();return;}
  if(pendingOpen){setTimeout(applyPendingOpen,0);}
  if(state.tab!=='bookings')state.stayHint=null;
  state._clashes=bookingClashes(state.data.bookings);
  state._gaps=((cloudStatus().icalLog)||{}).gaps||{};
  app.innerHTML='';
  app.appendChild(renderHeader());
  const swb=swBanner(); if(swb)app.appendChild(swb);
  const main=div({style:{flex:1}});
  if(state.tab==='dashboard') main.appendChild(renderDashboard());
  else if(state.tab==='bookings') main.appendChild(renderBookings());
  else if(state.tab==='calendar') main.appendChild(renderCalendar());
  else if(state.tab==='expenses') main.appendChild(renderExpenses());
  else if(state.tab==='loans')    main.appendChild(renderLoans());
  else if(state.tab==='reports')  main.appendChild(renderReports());
  app.appendChild(main);
  app.appendChild(renderNav());
  if(currentModal&&currentModal.parentNode)currentModal.parentNode.removeChild(currentModal);
  currentModal=null;
  if(state.modal==='addProp')       {currentModal=renderPropertyModal();document.body.appendChild(currentModal);}
  else if(state.modal==='addBooking'){currentModal=renderBookingModal(); document.body.appendChild(currentModal);}
  else if(state.modal==='addExpense'){currentModal=renderExpenseModal(); document.body.appendChild(currentModal);}
  else if(state.modal==='calDay')   {currentModal=renderCalDayModal();  document.body.appendChild(currentModal);}
  else if(state.modal==='addStaff') {currentModal=renderStaffModal();   document.body.appendChild(currentModal);}
  else if(state.modal==='settleWages'){currentModal=renderSettleModal(); document.body.appendChild(currentModal);}
  else if(state.modal==='addLoan')  {currentModal=renderLoanModal();    document.body.appendChild(currentModal);}
  else if(state.modal==='addRepayment'){currentModal=renderRepaymentModal();document.body.appendChild(currentModal);}
  else if(state.modal==='menu')     {currentModal=renderMenuModal();      document.body.appendChild(currentModal);}
  else if(state.modal==='propPicker'){currentModal=renderPropPickerModal();document.body.appendChild(currentModal);}
  else if(state.modal==='cloud')    {currentModal=renderCloudModal();     document.body.appendChild(currentModal);}
  else if(state.modal==='sendConfirm'){currentModal=renderSendModal();     document.body.appendChild(currentModal);}
  else if(state.modal==='paidReceipt'){currentModal=renderPaidReceiptModal();document.body.appendChild(currentModal);}
  else if(state.modal==='faceId')   {currentModal=renderFaceIdModal();    document.body.appendChild(currentModal);}
  else if(state.modal==='backup')   {currentModal=renderBackupModal();    document.body.appendChild(currentModal);}
  else if(state.modal==='inbox')    {currentModal=renderInboxModal();     document.body.appendChild(currentModal);}
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
try{applyTheme(getTheme());}catch(e){}
render();
if(window.StayLogBackup)window.StayLogBackup.onChange(()=>{if(state.loggedIn&&['backup','cloud','menu'].includes(state.modal))render();});
Promise.all([loadDataFromIDB(),loadAuth(),checkFaceId()]).then(([data,auth])=>{
  state.data=data;state.auth=auth;state.loggedIn=false;state._loading=false;
  // Once at every start, so unpaid days made before checkout-day wages (or
  // while this phone was closed) are priced by the same rule as new ones.
  if(repriceWages(state.data))saveData(state.data);
  render();
  if(window.StayLogCloud){
    window.StayLogCloud.onChange(st=>{
      if(state.modal==='cloud'||state.modal==='menu')render();
      // The first minimal sync says once what it took out of the cloud.
      if(st&&st.privacyNote&&!privacyToastShown&&state.loggedIn){privacyToastShown=true;
        showToast('Removing private details from the cloud','Why',()=>setState({modal:'cloud'}));}
    });
    // A good sync is followed, a little later, by an encrypted backup.
    if(window.StayLogCloud.onSynced&&window.StayLogBackup)
      window.StayLogCloud.onSynced(()=>window.StayLogBackup.schedule(()=>state.data));
    // Opening the app is itself a reason to sync: her attendance marks arrive
    // while this phone is doing nothing, and they only become expenses here.
    window.StayLogCloud.restoreSession()
      .then(()=>{resubscribeQuietly();refreshInbox();return window.StayLogCloud.checkIn&&window.StayLogCloud.checkIn(true);})
      .catch(()=>{});
  }
  setTimeout(checkSwMatch,SW_CHECK_DELAY);
});
// A notification tapped while the app was closed opens it at #open=…; one
// tapped while it is open is passed on by the service worker.
takeOpen(location.hash);
window.addEventListener('hashchange',()=>takeOpen(location.hash));
try{navigator.serviceWorker&&navigator.serviceWorker.addEventListener('message',e=>{
  if(e.data&&e.data.type==='open')try{takeOpen(new URL(e.data.url).hash);}catch(err){}
});}catch(e){}
// Coming back to the app is when an hourly update may have landed underneath it.
document.addEventListener('visibilitychange',()=>{if(!document.hidden)setTimeout(checkSwMatch,SW_CHECK_DELAY);});
// iOS can drop a subscription while the app sits in the background, and a
// Home Screen app is usually resumed rather than reopened.
let lastResub=0;
document.addEventListener('visibilitychange',()=>{
  if(document.hidden||Date.now()-lastResub<60000)return;
  lastResub=Date.now(); resubscribeQuietly(); refreshInbox();
});
// The app icon's number, from the last list loaded, as soon as the app opens.
inboxBadge();
