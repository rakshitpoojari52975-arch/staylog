/* StayLog — Homestay Manager App
   v5: Better PIN UI, expense paid status, encrypted backup/restore */
'use strict';

// ─── Auth ─────────────────────────────────────────────────────────────────────
const AUTH_KEY   = 'staylog_auth';
const PIN_LENGTH = 4;

// ─── Storage ──────────────────────────────────────────────────────────────────
const DB_NAME='staylog_db', DB_VERSION=1, STORE_NAME='appdata';
const DATA_KEY='staylog_main', LS_KEY='staylog_v2';
const defaultData={ properties:[], bookings:[], expenses:[] };

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
}
async function loadDataFromIDB(){
  try{const d=await idbGet(DATA_KEY);if(d&&d.properties)return d;}catch{}
  try{const ls=JSON.parse(localStorage.getItem(LS_KEY));if(ls&&ls.properties){saveData(ls);return ls;}}catch{}
  return{...defaultData};
}
async function loadAuth(){
  try{const a=await idbGet(AUTH_KEY);if(a)return a;}catch{}
  try{const ls=localStorage.getItem(AUTH_KEY);if(ls)return JSON.parse(ls);}catch{}
  return null;
}
function saveAuth(a){try{localStorage.setItem(AUTH_KEY,JSON.stringify(a));}catch{} idbSet(AUTH_KEY,a).catch(()=>{});}
function uid(){return Date.now().toString(36)+Math.random().toString(36).slice(2);}

// ─── Encryption helpers (AES-GCM via WebCrypto) ───────────────────────────────
// Key is derived from the user's PIN using PBKDF2 so backup files are tied to
// the same PIN — without the PIN the file cannot be decrypted.
const ENC_MAGIC = 'STAYLOG_ENC_V1';

async function deriveKey(pin, saltBuf){
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    {name:'PBKDF2', salt:saltBuf, iterations:200000, hash:'SHA-256'},
    baseKey,
    {name:'AES-GCM', length:256},
    false,
    ['encrypt','decrypt']
  );
}

async function encryptData(dataObj, pin){
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv   = crypto.getRandomValues(new Uint8Array(12));
  const key  = await deriveKey(pin, salt);
  const plain= new TextEncoder().encode(JSON.stringify(dataObj));
  const cipher= await crypto.subtle.encrypt({name:'AES-GCM',iv}, key, plain);
  // Pack: magic(14) + salt(16) + iv(12) + ciphertext, encode as base64
  const combined = new Uint8Array(16+12+cipher.byteLength);
  combined.set(salt,0); combined.set(iv,16); combined.set(new Uint8Array(cipher),28);
  const b64 = btoa(String.fromCharCode(...combined));
  return JSON.stringify({_staylog: ENC_MAGIC, data: b64});
}

async function decryptData(fileText, pin){
  let parsed;
  try{ parsed=JSON.parse(fileText); }catch{ throw new Error('Invalid file format'); }
  if(!parsed._staylog || parsed._staylog!==ENC_MAGIC){
    // Legacy: attempt plain JSON parse for unencrypted old backups
    if(parsed.properties && parsed.bookings){ return parsed; }
    throw new Error('Not a StayLog backup file');
  }
  try{
    const bytes = Uint8Array.from(atob(parsed.data), c=>c.charCodeAt(0));
    const salt  = bytes.slice(0,16);
    const iv    = bytes.slice(16,28);
    const cipher= bytes.slice(28);
    const key   = await deriveKey(pin, salt);
    const plain = await crypto.subtle.decrypt({name:'AES-GCM',iv}, key, cipher);
    return JSON.parse(new TextDecoder().decode(plain));
  }catch{
    throw new Error('Wrong PIN or corrupted file');
  }
}

// ─── Formatters ───────────────────────────────────────────────────────────────
const MONTH_NAMES=['January','February','March','April','May','June','July','August','September','October','November','December'];
const MONTH_SHORT=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const DAY_SHORT  =['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const fmtDate    =s=>s?new Date(s+'T00:00:00').toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'}):'—';
const fmtDateLong=s=>s?new Date(s+'T00:00:00').toLocaleDateString('en-IN',{weekday:'long',day:'numeric',month:'long',year:'numeric'}):'—';
const fmtCur     =n=>'₹'+Number(n||0).toLocaleString('en-IN');
const diffDays   =(a,b)=>Math.max(0,Math.ceil((new Date(b)-new Date(a))/86400000));
const today      =()=>new Date().toISOString().split('T')[0];

// ─── State ────────────────────────────────────────────────────────────────────
let state={
  data:{...defaultData}, auth:null, loggedIn:false,
  tab:'dashboard', modal:null, editItem:null,
  filterProp:'all', bookingFilter:'all', expandedBooking:null,
  dashMonth:{year:new Date().getFullYear(),month:new Date().getMonth()},
  reportMonth:null,
  calMonth:{year:new Date().getFullYear(),month:new Date().getMonth()},
  _loading:true,
};
function setState(p){Object.assign(state,typeof p==='function'?p(state):p);render();}
function mutateData(fn){fn(state.data);saveData(state.data);render();}

// ─── DOM helpers ──────────────────────────────────────────────────────────────
const h=(tag,attrs={}, ...children)=>{
  const el=document.createElement(tag);
  for(const [k,v] of Object.entries(attrs)){
    if(k==='style'&&typeof v==='object')Object.assign(el.style,v);
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
  const label=btn({style:{background:isAll?'var(--accent)':'var(--white)',color:isAll?'#fff':'var(--text)',border:'1.5px solid '+(isAll?'var(--accent)':'var(--border)'),borderRadius:20,padding:'5px 14px',fontSize:13,fontWeight:600,minWidth:110,textAlign:'center',cursor:'pointer'}},
    isAll?'All Time':`${MONTH_SHORT[current.month]} ${current.year}`);
  label.addEventListener('click',()=>{
    const existing=document.getElementById('month-picker-overlay');
    if(existing){existing.remove();return;}
    const overlay=div({id:'month-picker-overlay',style:{position:'fixed',inset:0,zIndex:500}});
    overlay.addEventListener('click',e=>{if(e.target===overlay)overlay.remove();});
    const rect=label.getBoundingClientRect();
    const picker=div({style:{position:'absolute',top:(rect.bottom+6)+'px',left:Math.max(8,rect.left-40)+'px',background:'var(--white)',border:'1px solid var(--border)',borderRadius:14,padding:'12px',boxShadow:'0 4px 24px rgba(0,0,0,0.15)',minWidth:240,zIndex:501}});
    picker.appendChild(btn({style:{width:'100%',padding:'8px 12px',textAlign:'left',background:isAll?'var(--accent-light)':'none',color:isAll?'var(--accent)':'var(--text)',border:'none',borderRadius:8,fontWeight:isAll?600:400,fontSize:14,cursor:'pointer',marginBottom:6},onClick:()=>{onChange(null);overlay.remove();}},'All Time'));
    [yr,yr-1].forEach(y=>{
      picker.appendChild(div({style:{fontSize:11,color:'var(--muted)',fontWeight:600,textTransform:'uppercase',letterSpacing:'0.06em',margin:'8px 0 6px 4px'}},String(y)));
      const grid=div({style:{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:4}});
      MONTH_SHORT.forEach((m,i)=>{
        const isCur=!isAll&&current.year===y&&current.month===i;
        grid.appendChild(btn({style:{padding:'7px 4px',borderRadius:8,border:'none',background:isCur?'var(--accent)':'var(--cream)',color:isCur?'#fff':'var(--text)',fontSize:13,fontWeight:isCur?600:400,cursor:'pointer'},onClick:()=>{onChange({year:y,month:i});overlay.remove();}},m));
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
  confirmed:{label:'Confirmed',bg:'#e8f4ef',color:'#1b5e38'},
  checkedin:{label:'Checked In',bg:'#e8f0fb',color:'#0d47a1'},
  checkedout:{label:'Checked Out',bg:'#f0f0ee',color:'#5a5a58'},
  cancelled:{label:'Cancelled',bg:'#fdeaea',color:'#c62828'},
};
function badge(status){const m=STATUS_META[status]||{label:status,bg:'#f0f0f0',color:'#555'};return span({style:{background:m.bg,color:m.color,borderRadius:20,padding:'4px 11px',fontSize:12,fontWeight:600}},m.label);}

// Expense paid badge
function expPaidBadge(paid){
  const m=paid?{label:'Paid',bg:'#e8f4ef',color:'#1b5e38'}:{label:'Unpaid',bg:'#fdf1e8',color:'#c05010'};
  return span({style:{background:m.bg,color:m.color,borderRadius:20,padding:'3px 10px',fontSize:11,fontWeight:600}},m.label);
}

// ─── Modal ────────────────────────────────────────────────────────────────────
function modal(title,contentFn){
  const overlay=div({style:{position:'fixed',inset:0,background:'rgba(0,0,0,0.35)',zIndex:999,display:'flex',alignItems:'flex-end',justifyContent:'center',backdropFilter:'blur(2px)'},onClick:e=>{if(e.target===overlay)closeModal();}});
  const sheet=div({style:{background:'var(--white)',borderRadius:'22px 22px 0 0',padding:'20px 16px env(safe-area-inset-bottom,24px)',width:'100%',maxWidth:480,maxHeight:'90vh',overflowY:'auto',boxShadow:'0 -4px 24px rgba(0,0,0,0.12)'}});
  sheet.appendChild(div({style:{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:18}},
    h('span',{style:{fontFamily:'Playfair Display',fontSize:20,fontWeight:500}},title),
    btn({style:{background:'none',border:'none',fontSize:24,color:'#aaa',cursor:'pointer',padding:'2px 8px',lineHeight:1},onClick:closeModal},'×')
  ));
  sheet.appendChild(contentFn());
  overlay.appendChild(sheet);
  sheet.style.transform='translateY(100%)';
  requestAnimationFrame(()=>{sheet.style.transition='transform .28s cubic-bezier(.32,.72,0,1)';sheet.style.transform='translateY(0)';});
  return overlay;
}
function closeModal(){setState({modal:null,editItem:null});}

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
    .pin-cell.active{border-color:var(--accent);box-shadow:0 0 0 4px rgba(45,106,79,0.15);transform:scale(1.07);}
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

  wrap.appendChild(div({style:{fontFamily:'Playfair Display',fontSize:34,color:'var(--accent)',marginBottom:4}},'StayLog'));
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
          setTimeout(()=>{state.loggedIn=true;render();},380);
        } else {
          updateCells(next,'error');
          msgEl.textContent='Incorrect PIN — please try again';
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

  if(!isSetup){
    wrap.appendChild(div({style:{marginTop:32}},
      btn({style:{background:'none',border:'none',color:'var(--muted)',fontSize:13,cursor:'pointer',textDecoration:'underline'},
        onClick:()=>{if(confirm('Reset PIN? You will need to create a new one.')){state.auth=null;state.loggedIn=false;saveAuth(null);renderLoginScreen();}}
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
function renderHeader(){
  const{data}=state;
  const header=div({style:{background:'var(--white)',borderBottom:'1px solid var(--border)',padding:'14px 16px 12px',position:'sticky',top:0,zIndex:100}});
  const top=div({style:{display:'flex',justifyContent:'space-between',alignItems:'center'}});
  const brand=div({},
    h('div',{style:{fontFamily:'Playfair Display',fontSize:24,fontWeight:500,color:'var(--text)',letterSpacing:'-0.01em'}},'StayLog'),
    div({style:{display:'flex',alignItems:'center',gap:8,marginTop:2}},
      h('div',{style:{fontSize:12,color:'var(--muted)'}},`${data.properties.length} ${data.properties.length===1?'property':'properties'} · ${data.bookings.length} bookings`),
      btn({title:'Backup (encrypted)',style:{background:'none',border:'none',padding:'2px 4px',cursor:'pointer',color:'var(--muted)'},onClick:downloadBackup},ico('download',{style:{fontSize:15}})),
      btn({title:'Restore backup',style:{background:'none',border:'none',padding:'2px 4px',cursor:'pointer',color:'var(--muted)'},onClick:restoreBackup},ico('upload',{style:{fontSize:15}})),
      btn({title:'Lock app',style:{background:'none',border:'none',padding:'2px 4px',cursor:'pointer',color:'var(--muted)'},onClick:()=>{state.loggedIn=false;render();}},ico('lock',{style:{fontSize:15}}))
    )
  );
  top.appendChild(brand);
  top.appendChild(btn({className:'btn-primary btn-sm',onClick:()=>setState({modal:'addProp',editItem:null})},ico('plus',{style:{marginRight:5}}),'Property'));
  header.appendChild(top);
  const chips=propFilterChips();if(chips)header.appendChild(chips);
  return header;
}

// Encrypted backup download
async function downloadBackup(){
  try{
    const encrypted=await encryptData(state.data, state.auth.pin);
    const blob=new Blob([encrypted],{type:'application/json'});
    const a=document.createElement('a');
    a.href=URL.createObjectURL(blob);
    a.download=`staylog-backup-${today()}.enc.json`;
    a.click();
  }catch(e){alert('Backup failed: '+e.message);}
}

// Encrypted restore
async function restoreBackup(){
  const inp=document.createElement('input');
  inp.type='file';inp.accept='.json';
  inp.onchange=async e=>{
    const file=e.target.files[0];if(!file)return;
    const text=await file.text();
    try{
      const d=await decryptData(text,state.auth.pin);
      if(!d.properties||!d.bookings||!d.expenses)throw new Error('Invalid data structure');
      if(confirm(`Restore ${d.bookings.length} bookings and ${d.expenses.length} expenses? Current data will be replaced.`)){
        state.data=d;saveData(d);render();
      }
    }catch(err){
      alert('Restore failed: '+err.message+'\n\nMake sure you are using a backup created on this app with the same PIN.');
    }
  };
  inp.click();
}

// ─── Bottom Nav ───────────────────────────────────────────────────────────────
function renderNav(){
  const tabs=[['dashboard','home','Home'],['bookings','calendar','Bookings'],['expenses','receipt','Expenses'],['reports','chart-bar','Reports']];
  const nav=div({style:{position:'fixed',bottom:0,left:'50%',transform:'translateX(-50%)',width:'100%',maxWidth:480,background:'var(--white)',borderTop:'1px solid var(--border)',display:'flex',zIndex:100,paddingBottom:'env(safe-area-inset-bottom,0)'}});
  tabs.forEach(([t,icon,label])=>{
    const active=state.tab===t||(t==='bookings'&&state.tab==='calendar');
    nav.appendChild(btn({style:{flex:1,padding:'10px 4px 8px',background:'none',border:'none',fontSize:11,fontWeight:active?600:400,color:active?'var(--accent)':'var(--muted)',cursor:'pointer',borderTop:active?'2.5px solid var(--accent)':'2.5px solid transparent',transition:'all .15s'},onClick:()=>setState({tab:t})},
      ico(icon,{style:{fontSize:22,display:'block',marginBottom:3}}),label));
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
  const STATUS_COL={confirmed:'#52b788',checkedin:'#4a90d9',checkedout:'#aaa'};
  const wrap=div({style:{padding:'14px 12px 100px'}});
  wrap.appendChild(div({style:{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:14}},
    h('div',{style:{fontFamily:'Playfair Display',fontSize:20}},'Calendar'),
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
    const cell=div({style:{borderRight:isLastCol?'none':'1px solid var(--border-soft)',borderBottom:'1px solid var(--border-soft)',minHeight:52,padding:'4px',cursor:bods.length>0?'pointer':'default',background:isToday?'#f0faf5':'var(--white)',transition:'background .12s'},
      onClick:()=>{if(bods.length>0)setState({modal:'calDay',editItem:{date:ds,bookings:bods}});}
    });
    cell.appendChild(div({style:{fontSize:12,fontWeight:isToday?700:400,marginBottom:3,width:22,height:22,display:'flex',alignItems:'center',justifyContent:'center',borderRadius:'50%',background:isToday?'var(--accent)':'transparent',color:isToday?'#fff':'var(--text)'}},String(d)));
    bods.slice(0,2).forEach(b=>{
      const prop=data.properties.find(p=>p.id===b.propertyId);
      cell.appendChild(div({style:{fontSize:9,background:STATUS_COL[b.status]||'var(--accent)',color:'#fff',borderRadius:3,padding:'1px 4px',marginBottom:2,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis',maxWidth:'100%'}},b.guestName.split(' ')[0]+(prop?` · ${prop.name.slice(0,6)}`:'')));
    });
    if(bods.length>2)cell.appendChild(div({style:{fontSize:9,color:'var(--muted)',paddingLeft:2}},`+${bods.length-2} more`));
    grid.appendChild(cell);
  }
  const rem=(7-(firstDay+daysInMonth)%7)%7;
  for(let i=0;i<rem;i++)grid.appendChild(div({style:{borderBottom:'1px solid var(--border-soft)',minHeight:52}}));
  calWrap.appendChild(grid);wrap.appendChild(calWrap);
  wrap.appendChild(div({style:{display:'flex',gap:14,fontSize:12,marginBottom:16,flexWrap:'wrap'}},
    ...[['var(--accent)','Confirmed'],['#4a90d9','Checked In'],['#aaa','Checked Out']].map(([c,l])=>
      div({style:{display:'flex',alignItems:'center',gap:5}},div({style:{width:10,height:10,borderRadius:2,background:c}}),l))
  ));
  const monthBks=active.filter(b=>{const d=new Date(b.checkIn+'T00:00:00');return d.getFullYear()===year&&d.getMonth()===month;}).sort((a,b2)=>new Date(a.checkIn)-new Date(b2.checkIn));
  if(monthBks.length>0){
    wrap.appendChild(h('div',{style:{fontFamily:'Playfair Display',fontSize:16,marginBottom:10}},`Bookings this month (${monthBks.length})`));
    monthBks.forEach(b=>wrap.appendChild(bookingCard(b)));
  }
  return wrap;
}

// ─── Booking Card ─────────────────────────────────────────────────────────────
function bookingCard(b){
  const prop=state.data.properties.find(p=>p.id===b.propertyId);
  const nights=diffDays(b.checkIn,b.checkOut);
  const isExpanded=state.expandedBooking===b.id;
  const paid=Number(b.paid||0),total=Number(b.totalAmount||0),due=total-paid;
  const card=div({className:'card',style:{marginBottom:10}});
  const summary=div({style:{padding:'13px 14px',cursor:'pointer'},onClick:()=>setState({expandedBooking:isExpanded?null:b.id})});
  summary.appendChild(div({style:{display:'flex',justifyContent:'space-between',alignItems:'flex-start'}},
    div({},div({style:{fontWeight:600,fontSize:15}},b.guestName),div({style:{fontSize:12,color:'var(--muted)',marginTop:3,display:'flex',alignItems:'center',gap:6}},ico('home',{style:{fontSize:13}}),prop?.name||'—',span({style:{color:'var(--border)'}},'·'),`${nights} nights`)),
    div({style:{textAlign:'right'}},badge(b.status),div({style:{fontSize:15,fontWeight:700,color:'var(--accent)',marginTop:5}},fmtCur(total)))
  ));
  summary.appendChild(div({style:{fontSize:12,color:'var(--muted)',marginTop:7,display:'flex',alignItems:'center',gap:5}},ico('calendar',{style:{fontSize:13}}),fmtDate(b.checkIn),'→',fmtDate(b.checkOut)));
  card.appendChild(summary);
  if(isExpanded){
    const detail=div({style:{borderTop:'1px solid var(--border-soft)',padding:'12px 14px 14px',background:'#fafaf8',borderRadius:'0 0 var(--radius) var(--radius)'}});
    const infoRow=(icon,text)=>text?div({style:{fontSize:13,color:'var(--text-mid)',marginBottom:6,display:'flex',alignItems:'center',gap:8}},ico(icon,{style:{fontSize:15,color:'var(--light)'}}),text):null;
    [infoRow('phone',b.phone),infoRow('users',b.guests?`${b.guests} guest${b.guests>1?'s':''}`:''),infoRow('link',b.source),infoRow('currency-rupee',paid>0?`Paid: ${fmtCur(paid)} · ${due>0?'Due: '+fmtCur(due):'Fully paid'}`:null)].forEach(r=>r&&detail.appendChild(r));
    if(b.notes)detail.appendChild(div({style:{fontSize:13,color:'var(--muted)',fontStyle:'italic',margin:'6px 0 10px',lineHeight:1.5,background:'var(--white)',padding:'8px 10px',borderRadius:8,border:'1px solid var(--border)'}},`"${b.notes}"`));
    const actions=div({style:{display:'flex',gap:7,flexWrap:'wrap',marginTop:8}});
    if(b.status==='confirmed')actions.appendChild(btn({className:'btn-primary btn-sm',onClick:()=>updateStatus(b.id,'checkedin')},ico('door-enter',{style:{marginRight:5}}),'Check In'));
    if(b.status==='checkedin')actions.appendChild(btn({className:'btn-primary btn-sm',onClick:()=>updateStatus(b.id,'checkedout')},ico('door-exit',{style:{marginRight:5}}),'Check Out'));
    if(b.status!=='cancelled'&&b.status!=='checkedout')actions.appendChild(btn({className:'btn-ghost btn-sm',onClick:()=>updateStatus(b.id,'cancelled')},'Cancel'));
    actions.appendChild(btn({className:'btn-ghost btn-sm',onClick:()=>setState({modal:'addBooking',editItem:b})},ico('edit',{style:{marginRight:4}}),'Edit'));
    actions.appendChild(btn({style:{background:'var(--gold-light)',color:'var(--gold)',border:'1.5px solid #e0c060',borderRadius:'var(--radius-sm)',padding:'7px 12px',fontSize:13,fontWeight:600,cursor:'pointer',display:'flex',alignItems:'center',gap:5},onClick:()=>downloadConfirmation(b)},ico('file-text',{style:{fontSize:14}}),'PDF'));
    actions.appendChild(btn({className:'btn-danger btn-sm',onClick:()=>{if(confirm('Delete this booking?')){mutateData(d=>d.bookings=d.bookings.filter(x=>x.id!==b.id));setState({expandedBooking:null});}}},ico('trash',{style:{marginRight:4}}),'Delete'));
    detail.appendChild(actions);card.appendChild(detail);
  }
  return card;
}

// ─── Guest Confirmation PDF ───────────────────────────────────────────────────
function downloadConfirmation(b){
  const prop=state.data.properties.find(p=>p.id===b.propertyId);
  const nights=diffDays(b.checkIn,b.checkOut);
  const bookingRef='SL-'+b.id.slice(-6).toUpperCase();
  const html=`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"/><title>Booking Confirmation — ${b.guestName}</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=Playfair+Display:wght@500;600&family=DM+Sans:wght@300;400;500;600&display=swap');
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'DM Sans',sans-serif;background:#fff;color:#1a1a1a;padding:40px;max-width:680px;margin:0 auto;font-size:15px;line-height:1.6}
.header{text-align:center;margin-bottom:36px;padding-bottom:24px;border-bottom:2px solid #e8f4ef}
.logo{font-family:'Playfair Display',serif;font-size:32px;color:#2d6a4f;margin-bottom:6px}
.tagline{font-size:13px;color:#7a7570;letter-spacing:0.04em;text-transform:uppercase}
.hero{background:linear-gradient(135deg,#e8f4ef 0%,#f7f5f0 100%);border-radius:16px;padding:28px 32px;margin-bottom:28px;border:1px solid #d0e8da}
.hero h1{font-family:'Playfair Display',serif;font-size:24px;color:#1a1a1a;margin-bottom:6px}
.hero p{font-size:14px;color:#4a4540;line-height:1.7}
.ref{display:inline-block;background:#2d6a4f;color:#fff;padding:4px 14px;border-radius:20px;font-size:12px;font-weight:600;letter-spacing:0.06em;margin-top:10px}
.section{margin-bottom:24px}
.section-title{font-size:11px;font-weight:700;color:#2d6a4f;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:12px;padding-bottom:6px;border-bottom:1px solid #e8e3da}
.detail-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.detail-item{background:#f7f5f0;border-radius:10px;padding:12px 14px}
.detail-label{font-size:11px;color:#7a7570;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:3px}
.detail-value{font-size:15px;font-weight:600;color:#1a1a1a}
.rules{background:#fffbf0;border:1px solid #f0d890;border-radius:12px;padding:22px 24px;margin-bottom:24px}
.rules h3{font-family:'Playfair Display',serif;font-size:17px;color:#b8860b;margin-bottom:14px}
.rule{display:flex;gap:12px;margin-bottom:12px;align-items:flex-start}
.rule-icon{font-size:18px;flex-shrink:0;margin-top:1px}
.rule-text{font-size:14px;color:#3a3530;line-height:1.55}
.footer{text-align:center;margin-top:36px;padding-top:20px;border-top:1px solid #e8e3da;color:#7a7570;font-size:13px;line-height:1.8}
.warm-note{background:#e8f4ef;border-radius:12px;padding:18px 22px;margin-bottom:24px;font-size:14px;color:#1b5e38;line-height:1.7;border-left:4px solid #2d6a4f}
</style></head><body>
<div class="header"><div class="logo">StayLog</div><div class="tagline">Booking Confirmation</div></div>
<div class="hero"><h1>Welcome, ${b.guestName}! 🏡</h1><p>We're absolutely delighted to have you stay with us. Your booking is confirmed and we're looking forward to welcoming you. We hope your stay is everything you're hoping for and more!</p><span class="ref">Ref: ${bookingRef}</span></div>
<div class="section"><div class="section-title">Booking Details</div>
<div class="detail-grid">
<div class="detail-item"><div class="detail-label">Guest Name</div><div class="detail-value">${b.guestName}</div></div>
<div class="detail-item"><div class="detail-label">Property</div><div class="detail-value">${prop?.name||'Our Home'}</div></div>
<div class="detail-item"><div class="detail-label">Check-in</div><div class="detail-value">${fmtDateLong(b.checkIn)}</div></div>
<div class="detail-item"><div class="detail-label">Check-out</div><div class="detail-value">${fmtDateLong(b.checkOut)}</div></div>
<div class="detail-item"><div class="detail-label">Duration</div><div class="detail-value">${nights} night${nights!==1?'s':''}</div></div>
<div class="detail-item"><div class="detail-label">Guests</div><div class="detail-value">${b.guests||1} person${(b.guests||1)>1?'s':''}</div></div>
${prop?.location?`<div class="detail-item" style="grid-column:1/-1"><div class="detail-label">Address</div><div class="detail-value">${prop.location}</div></div>`:''}
${b.phone?`<div class="detail-item"><div class="detail-label">Contact</div><div class="detail-value">${b.phone}</div></div>`:''}
</div></div>
<div class="warm-note">💚 <strong>A warm note from us:</strong> Our home is your home during your stay. Please make yourself comfortable and don't hesitate to reach out if you need anything at all. We genuinely want you to feel at ease and have a wonderful time!</div>
<div class="rules"><h3>🏠 A Few House Guidelines</h3><p style="font-size:13px;color:#7a6830;margin-bottom:16px">We've put these together simply to make the stay enjoyable for everyone!</p>
<div class="rule"><span class="rule-icon">🌙</span><span class="rule-text"><strong>A peaceful evening for all:</strong> To keep things quiet and restful for the neighbourhood, we kindly ask that you plan to return to the house by <strong>10 PM</strong> each evening.</span></div>
<div class="rule"><span class="rule-icon">🕯️</span><span class="rule-text"><strong>Keep it cozy:</strong> This home is a sanctuary — no parties or large gatherings, please. Just good company and good vibes!</span></div>
<div class="rule"><span class="rule-icon">🌿</span><span class="rule-text"><strong>Fresh air policy:</strong> The <strong>entire property is non-smoking</strong>. We appreciate your understanding!</span></div>
<div class="rule"><span class="rule-icon">💡</span><span class="rule-text"><strong>A little energy saving:</strong> When you head out, please turn off the <strong>lights, A/C, and fans</strong>.</span></div>
<div class="rule"><span class="rule-icon">🍽️</span><span class="rule-text"><strong>Kitchen courtesy:</strong> Please ensure <strong>utensils used are washed</strong> after use.</span></div>
<div class="rule"><span class="rule-icon">👟</span><span class="rule-text"><strong>Shoes at the door:</strong> Please <strong>leave your footwear outside</strong> the house.</span></div>
</div>
<div class="footer"><p>We hope you have a truly memorable and relaxing stay. 🌸</p><p style="margin-top:6px">If you need anything, please don't hesitate to get in touch.</p><p style="margin-top:12px;font-weight:600;color:#2d6a4f">Generated by StayLog · ${new Date().toLocaleDateString('en-IN',{day:'numeric',month:'long',year:'numeric'})}</p></div>
</body></html>`;
  const blob=new Blob([html],{type:'text/html;charset=utf-8'});
  const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`StayLog-Confirmation-${b.guestName.replace(/\s+/g,'-')}-${b.checkIn}.html`;a.click();
}

// ─── Day detail modal ─────────────────────────────────────────────────────────
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
      acts.appendChild(btn({style:{background:'var(--gold-light)',color:'var(--gold)',border:'1.5px solid #e0c060',borderRadius:'var(--radius-sm)',padding:'6px 10px',fontSize:12,fontWeight:600,cursor:'pointer',display:'flex',alignItems:'center',gap:4},onClick:()=>downloadConfirmation(b)},ico('file-text',{style:{fontSize:13}}),'PDF'));
      card.appendChild(acts);wrap.appendChild(card);
    });
    return wrap;
  };
  return modal(`Bookings — ${MONTH_SHORT[new Date(date+'T00:00:00').getMonth()]} ${new Date(date+'T00:00:00').getDate()}`,content);
}

// ─── Dashboard ────────────────────────────────────────────────────────────────
function renderDashboard(){
  const{data,filterProp,dashMonth}=state;
  let bookings=filterProp==='all'?data.bookings:data.bookings.filter(b=>b.propertyId===filterProp);
  let expenses=filterProp==='all'?data.expenses:data.expenses.filter(e=>e.propertyId===filterProp);
  bookings=filterByMonth(bookings,'checkIn',dashMonth);
  expenses=filterByMonth(expenses,'date',dashMonth);
  const totalRevenue=bookings.filter(b=>b.status!=='cancelled').reduce((s,b)=>s+Number(b.totalAmount||0),0);
  const totalExpenses=expenses.reduce((s,e)=>s+Number(e.amount||0),0);
  const net=totalRevenue-totalExpenses;
  const t=today();
  const todayCheckins=data.bookings.filter(b=>b.checkIn===t&&b.status==='confirmed');
  const todayCheckouts=data.bookings.filter(b=>b.checkOut===t&&b.status==='checkedin');
  const wrap=div({style:{padding:'14px 12px 100px'}});
  if(data.properties.length===0){
    wrap.appendChild(div({style:{textAlign:'center',padding:'70px 20px'}},
      ico('home',{style:{fontSize:52,color:'var(--light)',display:'block',marginBottom:16}}),
      h('div',{style:{fontFamily:'Playfair Display',fontSize:22,color:'var(--text)',marginBottom:8}},'Welcome to StayLog'),
      h('div',{style:{color:'var(--muted)',fontSize:14,marginBottom:24,lineHeight:1.6}},'Add a property to get started.'),
      btn({className:'btn-primary',onClick:()=>setState({modal:'addProp'})},ico('plus',{style:{marginRight:6}}),'Add First Property')
    ));
    return wrap;
  }
  wrap.appendChild(div({style:{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:14}},
    h('div',{style:{fontFamily:'Playfair Display',fontSize:17}},'Overview'),
    monthSelector(dashMonth,m=>setState({dashMonth:m}))
  ));
  const grid=div({style:{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10,marginBottom:16}});
  [{label:'Revenue',val:fmtCur(totalRevenue),icon:'currency-rupee',bg:'var(--accent-light)',col:'var(--accent)'},{label:'Net Profit',val:fmtCur(net),icon:'trending-up',bg:net>=0?'var(--accent-light)':'var(--danger-light)',col:net>=0?'var(--accent)':'var(--danger)'},{label:'Checked In',val:bookings.filter(b=>b.status==='checkedin').length,icon:'door-enter',bg:'var(--info-light)',col:'var(--info)'},{label:'Upcoming',val:bookings.filter(b=>b.status==='confirmed').length,icon:'calendar-event',bg:'var(--gold-light)',col:'var(--gold)'}].forEach(s=>{
    grid.appendChild(div({className:'card',style:{padding:'14px'}},
      div({style:{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:8}},div({style:{fontSize:11,color:'var(--muted)',fontWeight:600,textTransform:'uppercase',letterSpacing:'0.06em'}},s.label),div({style:{background:s.bg,borderRadius:8,padding:'5px 7px'}},ico(s.icon,{style:{fontSize:17,color:s.col}}))),
      div({style:{fontSize:23,fontWeight:700,color:'var(--text)',letterSpacing:'-0.02em'}},String(s.val))
    ));
  });
  wrap.appendChild(grid);
  if(todayCheckins.length>0||todayCheckouts.length>0){
    const alert=div({style:{background:'var(--warn-light)',border:'1.5px solid #f5cba0',borderRadius:'var(--radius)',padding:'12px 14px',marginBottom:16}});
    alert.appendChild(div({style:{fontWeight:600,fontSize:13,color:'var(--warn)',marginBottom:8,display:'flex',alignItems:'center',gap:6}},ico('bell',{style:{fontSize:16}}),"Today's Activity"));
    todayCheckins.forEach(b=>alert.appendChild(div({style:{fontSize:13,marginBottom:4}},`🟢 ${b.guestName} checks in`)));
    todayCheckouts.forEach(b=>alert.appendChild(div({style:{fontSize:13,marginBottom:4}},`🔵 ${b.guestName} checks out`)));
    wrap.appendChild(alert);
  }
  wrap.appendChild(div({style:{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:10}},
    h('div',{style:{fontFamily:'Playfair Display',fontSize:17}},dashMonth?`Bookings · ${MONTH_SHORT[dashMonth.month]} ${dashMonth.year}`:'All Bookings'),
    btn({className:'btn-ghost btn-sm',onClick:()=>setState({tab:'bookings'})},'See all')
  ));
  const recent=[...bookings].filter(b=>b.status!=='cancelled').sort((a,b)=>new Date(b.checkIn)-new Date(a.checkIn)).slice(0,4);
  if(recent.length===0){
    wrap.appendChild(div({className:'card',style:{padding:'24px',textAlign:'center'}},div({style:{color:'var(--muted)',fontSize:14,marginBottom:12}},dashMonth?'No bookings this month':'No bookings yet'),btn({className:'btn-primary btn-sm',onClick:()=>setState({modal:'addBooking',editItem:null})},'Add Booking')));
  } else {recent.forEach(b=>wrap.appendChild(bookingCard(b)));}
  wrap.appendChild(h('div',{style:{fontFamily:'Playfair Display',fontSize:17,margin:'18px 0 10px'}},'Properties'));
  data.properties.forEach(p=>{
    const pBks=data.bookings.filter(b=>b.propertyId===p.id);
    const pRev=pBks.filter(b=>b.status!=='cancelled').reduce((s,b)=>s+Number(b.totalAmount||0),0);
    wrap.appendChild(div({className:'card',style:{padding:'13px 14px',marginBottom:8,display:'flex',justifyContent:'space-between',alignItems:'center'}},
      div({},div({style:{fontWeight:600,fontSize:15}},p.name),div({style:{fontSize:12,color:'var(--muted)',marginTop:3}},`${p.location||'No location'} · ${p.rooms||0} rooms · ${pBks.length} bookings`)),
      div({style:{textAlign:'right',display:'flex',flexDirection:'column',alignItems:'flex-end',gap:7}},
        div({style:{fontSize:14,fontWeight:700,color:'var(--accent)'}},fmtCur(pRev)),
        btn({className:'btn-danger btn-sm',style:{padding:'4px 9px'},onClick:()=>{if(confirm(`Delete "${p.name}" and all its data?`)){mutateData(d=>{d.properties=d.properties.filter(x=>x.id!==p.id);d.bookings=d.bookings.filter(b=>b.propertyId!==p.id);d.expenses=d.expenses.filter(e=>e.propertyId!==p.id);});}}},ico('trash',{style:{fontSize:14}}))
      )
    ));
  });
  wrap.appendChild(div({style:{textAlign:'center',marginTop:20}},btn({className:'btn-primary',onClick:()=>setState({modal:'addBooking',editItem:null})},ico('plus',{style:{marginRight:7}}),'New Booking')));
  return wrap;
}

// ─── Bookings Tab ─────────────────────────────────────────────────────────────
function renderBookings(){
  const{data,filterProp,bookingFilter}=state;
  const all=filterProp==='all'?data.bookings:data.bookings.filter(b=>b.propertyId===filterProp);
  const filtered=bookingFilter==='all'?all:all.filter(b=>b.status===bookingFilter);
  const sorted=[...filtered].sort((a,b)=>new Date(b.checkIn)-new Date(a.checkIn));
  const wrap=div({style:{padding:'14px 12px 100px'}});
  wrap.appendChild(div({style:{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:12}},
    h('div',{style:{fontFamily:'Playfair Display',fontSize:20}},'Bookings'),
    div({style:{display:'flex',gap:8}},
      btn({style:{background:'var(--accent-light)',color:'var(--accent)',border:'1.5px solid var(--accent)',borderRadius:'var(--radius-sm)',padding:'7px 12px',fontSize:13,fontWeight:600,cursor:'pointer',display:'flex',alignItems:'center',gap:5},onClick:()=>setState({tab:'calendar'})},ico('calendar-month',{style:{fontSize:15}}),'Calendar'),
      btn({className:'btn-primary btn-sm',onClick:()=>setState({modal:'addBooking',editItem:null})},ico('plus',{style:{marginRight:4}}),'Add')
    )
  ));
  const chips=div({style:{display:'flex',gap:6,marginBottom:14,overflowX:'auto',paddingBottom:2,scrollbarWidth:'none'}});
  [['all','All'],['confirmed','Confirmed'],['checkedin','In'],['checkedout','Out'],['cancelled','Cancelled']].forEach(([s,l])=>{
    chips.appendChild(btn({style:{padding:'5px 13px',borderRadius:20,whiteSpace:'nowrap',border:`1.5px solid ${bookingFilter===s?'var(--accent)':'var(--border)'}`,background:bookingFilter===s?'var(--accent-light)':'var(--white)',color:bookingFilter===s?'var(--accent)':'var(--muted)',fontSize:13,fontWeight:bookingFilter===s?600:400},onClick:()=>setState({bookingFilter:s})},l));
  });
  wrap.appendChild(chips);
  if(sorted.length===0)wrap.appendChild(div({style:{textAlign:'center',padding:'40px 20px',color:'var(--muted)'}},'No bookings found'));
  else sorted.forEach(b=>wrap.appendChild(bookingCard(b)));
  return wrap;
}

// ─── Expenses Tab ─────────────────────────────────────────────────────────────
function renderExpenses(){
  const{data,filterProp}=state;
  const expenses=(filterProp==='all'?data.expenses:data.expenses.filter(e=>e.propertyId===filterProp)).sort((a,b)=>new Date(b.date)-new Date(a.date));
  const total=expenses.reduce((s,e)=>s+Number(e.amount||0),0);
  const totalPaid=expenses.filter(e=>e.paid).reduce((s,e)=>s+Number(e.amount||0),0);
  const totalUnpaid=total-totalPaid;
  const catEmoji={maintenance:'🔧',utilities:'💡',supplies:'🛒',staff:'👤',marketing:'📣',other:'📦'};
  const wrap=div({style:{padding:'14px 12px 100px'}});
  wrap.appendChild(div({style:{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:12}},
    h('div',{style:{fontFamily:'Playfair Display',fontSize:20}},'Expenses'),
    btn({className:'btn-primary btn-sm',onClick:()=>setState({modal:'addExpense',editItem:null})},ico('plus',{style:{marginRight:4}}),'Add')
  ));
  // Summary cards
  const sg=div({style:{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:8,marginBottom:14}});
  [{label:'Total',val:fmtCur(total),col:'var(--danger)'},{label:'Paid',val:fmtCur(totalPaid),col:'var(--accent)'},{label:'Unpaid',val:fmtCur(totalUnpaid),col:'var(--warn)'}].forEach(s=>{
    sg.appendChild(div({className:'card',style:{padding:'10px 12px'}},
      div({style:{fontSize:10,color:'var(--muted)',fontWeight:600,textTransform:'uppercase',letterSpacing:'0.05em',marginBottom:4}},s.label),
      div({style:{fontSize:16,fontWeight:700,color:s.col}},s.val)
    ));
  });
  wrap.appendChild(sg);
  if(expenses.length===0){wrap.appendChild(div({style:{textAlign:'center',padding:'40px 20px',color:'var(--muted)'}},'No expenses logged yet'));}
  else expenses.forEach(e=>{
    const prop=data.properties.find(p=>p.id===e.propertyId);
    const card=div({className:'card',style:{padding:'12px 14px',marginBottom:9}});
    // Top row
    card.appendChild(div({style:{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:5}},
      div({},
        div({style:{fontWeight:600,fontSize:15}},`${catEmoji[e.category]||'📦'} ${e.description}`),
        div({style:{fontSize:12,color:'var(--muted)',marginTop:3}},`${prop?.name||'—'} · ${fmtDate(e.date)} · ${e.category}`)
      ),
      div({style:{textAlign:'right'}},
        div({style:{fontWeight:700,color:'var(--danger)',fontSize:15,marginBottom:5}},fmtCur(e.amount)),
        expPaidBadge(e.paid)
      )
    ));
    // Action row
    const acts=div({style:{display:'flex',gap:6,marginTop:8,flexWrap:'wrap'}});
    // Toggle paid/unpaid button
    acts.appendChild(btn({
      style:{background:e.paid?'var(--cream)':'var(--accent-light)',color:e.paid?'var(--muted)':'var(--accent)',border:`1.5px solid ${e.paid?'var(--border)':'var(--accent)'}`,borderRadius:'var(--radius-sm)',padding:'5px 11px',fontSize:12,fontWeight:600,cursor:'pointer',display:'flex',alignItems:'center',gap:4},
      onClick:()=>mutateData(d=>d.expenses=d.expenses.map(x=>x.id===e.id?{...x,paid:!x.paid}:x))
    },ico(e.paid?'circle-check':'circle',{style:{fontSize:13}}),e.paid?'Mark Unpaid':'Mark as Paid'));
    acts.appendChild(btn({className:'btn-ghost btn-sm',style:{padding:'5px 10px'},onClick:()=>setState({modal:'addExpense',editItem:e})},ico('edit',{style:{fontSize:14}})));
    acts.appendChild(btn({className:'btn-danger btn-sm',style:{padding:'5px 10px'},onClick:()=>{if(confirm('Delete this expense?'))mutateData(d=>d.expenses=d.expenses.filter(x=>x.id!==e.id));}},ico('trash',{style:{fontSize:14}})));
    card.appendChild(acts);
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
  bookings.filter(b=>b.status!=='cancelled'&&new Date(b.checkIn).getFullYear()===yr).forEach(b=>monthlyRev[new Date(b.checkIn).getMonth()]+=Number(b.totalAmount||0));
  expenses.filter(e=>new Date(e.date).getFullYear()===yr).forEach(e=>monthlyExp[new Date(e.date).getMonth()]+=Number(e.amount||0));
  const maxVal=Math.max(...monthlyRev,...monthlyExp,1);
  const totalRev=monthlyRev.reduce((a,b)=>a+b,0),totalExp=monthlyExp.reduce((a,b)=>a+b,0);
  const periodLabel=reportMonth?`${MONTH_NAMES[reportMonth.month]}-${reportMonth.year}`:`${yr}-Full-Year`;
  const wrap=div({style:{padding:'14px 12px 100px'}});
  wrap.appendChild(div({style:{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:14}},
    h('div',{style:{fontFamily:'Playfair Display',fontSize:20}},'Reports'),
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
    const rev=bks.reduce((s,b)=>s+Number(b.totalAmount||0),0);
    const nights=bks.reduce((s,b)=>s+diffDays(b.checkIn,b.checkOut),0);
    const row=div({style:{paddingBottom:i<data.properties.length-1?12:0,marginBottom:i<data.properties.length-1?12:0,borderBottom:i<data.properties.length-1?'1px solid var(--border-soft)':'none'}});
    row.appendChild(div({style:{display:'flex',justifyContent:'space-between',marginBottom:4}},div({style:{fontWeight:600,fontSize:14}},p.name),div({style:{fontWeight:700,color:'var(--accent)',fontSize:14}},fmtCur(rev))));
    row.appendChild(div({style:{fontSize:12,color:'var(--muted)'}},`${bks.length} bookings · ${nights} nights`));
    perfCard.appendChild(row);
  });
  wrap.appendChild(perfCard);
  const bySource={};
  bookings.filter(b=>b.status!=='cancelled').forEach(b=>{const s=b.source||'Direct';bySource[s]=(bySource[s]||0)+Number(b.totalAmount||0);});
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
    const catEmoji={maintenance:'🔧',utilities:'💡',supplies:'🛒',staff:'👤',marketing:'📣',other:'📦'};
    Object.entries(byCat).sort((a,b)=>b[1]-a[1]).forEach(([c,v])=>{
      const pct=catTotal>0?Math.round(v/catTotal*100):0;
      catCard.appendChild(div({style:{marginBottom:10}},div({style:{display:'flex',justifyContent:'space-between',fontSize:13,marginBottom:5}},div({style:{color:'var(--text-mid)',fontWeight:500}},`${catEmoji[c]||'📦'} ${c}`),span({style:{fontWeight:600,color:'var(--danger)'}},`${fmtCur(v)} (${pct}%)`)),div({style:{height:5,background:'var(--border)',borderRadius:10,overflow:'hidden'}},div({style:{height:'100%',width:pct+'%',background:'var(--danger)',opacity:0.7,borderRadius:10}}))));
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
  const totalRev=bookings.filter(b=>b.status!=='cancelled').reduce((s,b)=>s+Number(b.totalAmount||0),0);
  const totalExp=expenses.reduce((s,e)=>s+Number(e.amount||0),0);
  let csv=`StayLog Report,${esc(periodLabel)}\nGenerated,${esc(new Date().toLocaleString('en-IN'))}\n\nSUMMARY\nTotal Revenue,${totalRev}\nTotal Expenses,${totalExp}\nNet Profit,${totalRev-totalExp}\n\nINCOME DETAILS\nDate,Guest Name,Property,Check-in,Check-out,Nights,Guests,Source,Total Amount,Amount Paid,Balance Due,Status\n`;
  [...bookings].filter(b=>b.status!=='cancelled').sort((a,b)=>new Date(a.checkIn)-new Date(b.checkIn)).forEach(b=>{
    const nights=diffDays(b.checkIn,b.checkOut),due=Number(b.totalAmount||0)-Number(b.paid||0);
    csv+=[esc(b.checkIn),esc(b.guestName),esc(propName(b.propertyId)),esc(fmtDate(b.checkIn)),esc(fmtDate(b.checkOut)),nights,b.guests||1,esc(b.source||'Direct'),Number(b.totalAmount||0),Number(b.paid||0),due,esc(b.status)].join(',')+'\n';
  });
  csv+='\nEXPENDITURE DETAILS\nDate,Description,Property,Category,Amount,Status,Notes\n';
  [...expenses].sort((a,b)=>new Date(a.date)-new Date(b.date)).forEach(e=>{
    csv+=[esc(e.date),esc(e.description),esc(propName(e.propertyId)),esc(e.category),Number(e.amount||0),esc(e.paid?'Paid':'Unpaid'),esc(e.notes||'')].join(',')+'\n';
  });
  const blob=new Blob([csv],{type:'text/csv;charset=utf-8;'});
  const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`staylog-report-${periodLabel}.csv`;a.click();
}

// ─── Modals ───────────────────────────────────────────────────────────────────
function renderPropertyModal(){
  const f={name:'',location:'',rooms:'',pricePerNight:'',description:''};
  const content=()=>{
    const wrap=div({style:{display:'flex',flexDirection:'column',gap:11}});
    [['name','Property name *','text'],['location','Location / Address','text'],['rooms','Number of rooms','number'],['pricePerNight','Base price per night (₹)','number']].forEach(([k,ph,t])=>{
      const inp=h('input',{type:t,placeholder:ph,value:f[k]||''});inp.addEventListener('input',e=>f[k]=e.target.value);wrap.appendChild(inp);
    });
    const ta=h('textarea',{placeholder:'Notes / description',rows:2,style:{resize:'none'}});ta.addEventListener('input',e=>f.description=e.target.value);wrap.appendChild(ta);
    wrap.appendChild(btn({className:'btn-primary',style:{marginTop:4,width:'100%'},onClick:()=>{if(!f.name)return;mutateData(d=>d.properties.push({...f,id:uid()}));closeModal();}},'Save Property'));
    return wrap;
  };
  return modal('Add Property',content);
}

function renderBookingModal(){
  const{data,editItem}=state;
  const isEdit=!!editItem;
  const f=isEdit?{...editItem}:{propertyId:data.properties[0]?.id||'',guestName:'',phone:'',checkIn:'',checkOut:'',guests:1,totalAmount:'',paid:'',source:'Direct',status:'confirmed',notes:''};
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
    const amtRow=div({style:{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}});
    const amtInp=h('input',{type:'number',placeholder:'Total (₹)',value:f.totalAmount||''});amtInp.addEventListener('input',e=>f.totalAmount=e.target.value);
    const paidInp=h('input',{type:'number',placeholder:'Paid (₹)',value:f.paid||''});paidInp.addEventListener('input',e=>f.paid=e.target.value);
    amtRow.appendChild(amtInp);amtRow.appendChild(paidInp);wrap.appendChild(amtRow);
    function autoCalc(){
      if(f.checkIn&&f.checkOut&&!isEdit){
        const n=diffDays(f.checkIn,f.checkOut);
        const prop=data.properties.find(p=>p.id===f.propertyId);
        if(n>0&&prop?.pricePerNight){const s=n*Number(prop.pricePerNight);f.totalAmount=s;amtInp.value=s;nightsInfo.textContent=`${n} nights · Suggested: ₹${s.toLocaleString('en-IN')}`;}
        else if(n>0)nightsInfo.textContent=`${n} nights`;
      }
    }
    const guestsInp=h('input',{type:'number',placeholder:'No. of guests',value:f.guests||1});guestsInp.addEventListener('input',e=>f.guests=e.target.value);wrap.appendChild(guestsInp);
    const srcSel=h('select');
    ['Direct','Airbnb','Booking.com','MakeMyTrip','Goibibo','OYO','Other'].forEach(s=>srcSel.appendChild(h('option',{value:s,selected:f.source===s},s)));
    srcSel.addEventListener('change',e=>f.source=e.target.value);wrap.appendChild(srcSel);
    const stSel=h('select');
    [['confirmed','Confirmed'],['checkedin','Checked In'],['checkedout','Checked Out'],['cancelled','Cancelled']].forEach(([v,l])=>stSel.appendChild(h('option',{value:v,selected:f.status===v},l)));
    stSel.addEventListener('change',e=>f.status=e.target.value);wrap.appendChild(stSel);
    const notesTA=h('textarea',{placeholder:'Notes (optional)',rows:2,style:{resize:'none'}});notesTA.textContent=f.notes||'';notesTA.addEventListener('input',e=>f.notes=e.target.value);wrap.appendChild(notesTA);
    wrap.appendChild(btn({className:'btn-primary',style:{marginTop:4,width:'100%'},onClick:()=>{
      if(!f.guestName||!f.checkIn||!f.checkOut||!f.propertyId)return;
      if(hasConflict(f.propertyId,f.checkIn,f.checkOut,isEdit?f.id:null)){alert('These dates overlap with an existing booking. Please choose different dates.');return;}
      mutateData(d=>{if(isEdit)d.bookings=d.bookings.map(b=>b.id===f.id?f:b);else d.bookings.push({...f,id:uid()});});
      closeModal();
    }},isEdit?'Update Booking':'Add Booking'));
    return wrap;
  };
  return modal(isEdit?'Edit Booking':'New Booking',content);
}

function renderExpenseModal(){
  const{data,editItem}=state;
  const isEdit=!!editItem;
  const f=isEdit?{...editItem}:{propertyId:data.properties[0]?.id||'',description:'',amount:'',date:today(),category:'maintenance',paid:false,notes:''};
  const content=()=>{
    const wrap=div({style:{display:'flex',flexDirection:'column',gap:11}});
    const propSel=h('select');
    data.properties.forEach(p=>propSel.appendChild(h('option',{value:p.id,selected:f.propertyId===p.id},p.name)));
    propSel.addEventListener('change',e=>f.propertyId=e.target.value);wrap.appendChild(propSel);
    const descInp=h('input',{type:'text',placeholder:'Description *',value:f.description||''});descInp.addEventListener('input',e=>f.description=e.target.value);wrap.appendChild(descInp);
    const amtInp=h('input',{type:'number',placeholder:'Amount (₹) *',value:f.amount||''});amtInp.addEventListener('input',e=>f.amount=e.target.value);wrap.appendChild(amtInp);
    const dateWrap=div({},div({className:'label'},'Date'));
    const dateInp=h('input',{type:'date',value:f.date||today()});dateInp.addEventListener('change',e=>f.date=e.target.value);dateWrap.appendChild(dateInp);wrap.appendChild(dateWrap);
    const catSel=h('select');
    [['maintenance','🔧 Maintenance'],['utilities','💡 Utilities'],['supplies','🛒 Supplies'],['staff','👤 Staff'],['marketing','📣 Marketing'],['other','📦 Other']].forEach(([v,l])=>catSel.appendChild(h('option',{value:v,selected:f.category===v},l)));
    catSel.addEventListener('change',e=>f.category=e.target.value);wrap.appendChild(catSel);
    // Paid toggle
    const paidRow=div({style:{display:'flex',alignItems:'center',justifyContent:'space-between',background:'var(--cream)',borderRadius:'var(--radius-sm)',padding:'10px 14px',border:'1.5px solid var(--border)'}});
    paidRow.appendChild(div({style:{fontSize:14,fontWeight:500}},'Payment Status'));
    const toggle=div({style:{display:'flex',gap:8}});
    ['Paid','Unpaid'].forEach(lbl=>{
      const isPaid=lbl==='Paid';
      const b=btn({
        style:{padding:'5px 14px',borderRadius:20,border:`1.5px solid ${f.paid===isPaid?'var(--accent)':'var(--border)'}`,background:f.paid===isPaid?'var(--accent-light)':'var(--white)',color:f.paid===isPaid?'var(--accent)':'var(--muted)',fontSize:13,fontWeight:f.paid===isPaid?600:400,cursor:'pointer'},
        onClick:()=>{
          f.paid=isPaid;
          toggle.querySelectorAll('button').forEach((b2,i)=>{
            const ip2=i===0;
            b2.style.borderColor=f.paid===ip2?'var(--accent)':'var(--border)';
            b2.style.background=f.paid===ip2?'var(--accent-light)':'var(--white)';
            b2.style.color=f.paid===ip2?'var(--accent)':'var(--muted)';
            b2.style.fontWeight=f.paid===ip2?600:400;
          });
        }
      },lbl);
      toggle.appendChild(b);
    });
    paidRow.appendChild(toggle);wrap.appendChild(paidRow);
    const notesTA=h('textarea',{placeholder:'Notes (optional)',rows:2,style:{resize:'none'}});notesTA.textContent=f.notes||'';notesTA.addEventListener('input',e=>f.notes=e.target.value);wrap.appendChild(notesTA);
    wrap.appendChild(btn({className:'btn-primary',style:{marginTop:4,width:'100%'},onClick:()=>{
      if(!f.description||!f.amount||!f.propertyId)return;
      mutateData(d=>{if(isEdit)d.expenses=d.expenses.map(e=>e.id===f.id?f:e);else d.expenses.push({...f,id:uid()});});
      closeModal();
    }},isEdit?'Update Expense':'Add Expense'));
    return wrap;
  };
  return modal(isEdit?'Edit Expense':'New Expense',content);
}

// ─── Actions ──────────────────────────────────────────────────────────────────
function updateStatus(id,status){mutateData(d=>d.bookings=d.bookings.map(b=>b.id===id?{...b,status}:b));}

// ─── Main Render ──────────────────────────────────────────────────────────────
let currentModal=null;
function render(){
  const app=document.getElementById('app');
  if(state._loading){
    app.innerHTML='';
    app.appendChild(div({style:{display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',height:'100vh',gap:16}},
      h('div',{style:{fontFamily:'Playfair Display',fontSize:28,color:'var(--accent)'}},'StayLog'),
      h('div',{style:{fontSize:13,color:'var(--muted)'}},'Loading your data…')
    ));
    return;
  }
  if(!state.loggedIn){renderLoginScreen();return;}
  app.innerHTML='';
  app.appendChild(renderHeader());
  const main=div({style:{flex:1}});
  if(state.tab==='dashboard') main.appendChild(renderDashboard());
  else if(state.tab==='bookings') main.appendChild(renderBookings());
  else if(state.tab==='calendar') main.appendChild(renderCalendar());
  else if(state.tab==='expenses') main.appendChild(renderExpenses());
  else if(state.tab==='reports')  main.appendChild(renderReports());
  app.appendChild(main);
  app.appendChild(renderNav());
  if(currentModal&&currentModal.parentNode)currentModal.parentNode.removeChild(currentModal);
  currentModal=null;
  if(state.modal==='addProp')       {currentModal=renderPropertyModal();document.body.appendChild(currentModal);}
  else if(state.modal==='addBooking'){currentModal=renderBookingModal(); document.body.appendChild(currentModal);}
  else if(state.modal==='addExpense'){currentModal=renderExpenseModal(); document.body.appendChild(currentModal);}
  else if(state.modal==='calDay')   {currentModal=renderCalDayModal();  document.body.appendChild(currentModal);}
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
render();
Promise.all([loadDataFromIDB(),loadAuth()]).then(([data,auth])=>{
  state.data=data;state.auth=auth;state.loggedIn=false;state._loading=false;render();
});
