/* StayLog — Homestay Manager App
   v7: ID proof attachment in bookings, warm PDF house rules, check-in/out times
   v8: Staff registry + staff loan module — repayment schedule, payout deduction, loan analysis */
'use strict';

// ─── Auth ─────────────────────────────────────────────────────────────────────
const AUTH_KEY   = 'staylog_auth';
const PIN_LENGTH = 4;

// ─── Storage ──────────────────────────────────────────────────────────────────
const DB_NAME='staylog_db', DB_VERSION=1, STORE_NAME='appdata';
const DATA_KEY='staylog_main', LS_KEY='staylog_v2';
const defaultData={ properties:[], bookings:[], expenses:[], staff:[], loans:[] };

// Ensures older saved data (pre-loan-module) gains the new collections
function normalizeData(d){
  if(!d||typeof d!=='object')return{...defaultData};
  if(!Array.isArray(d.properties))d.properties=[];
  if(!Array.isArray(d.bookings))d.bookings=[];
  if(!Array.isArray(d.expenses))d.expenses=[];
  if(!Array.isArray(d.staff))d.staff=[];
  if(!Array.isArray(d.loans))d.loans=[];
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
}
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
const fmtCur     =n=>'₹'+Number(n||0).toLocaleString('en-IN');
const diffDays   =(a,b)=>Math.max(0,Math.ceil((new Date(b)-new Date(a))/86400000));
const today      =()=>new Date().toISOString().split('T')[0];

// ─── State ────────────────────────────────────────────────────────────────────
let state={
  data:{...defaultData}, auth:null, loggedIn:false,
  tab:'dashboard', modal:null, editItem:null,
  filterProp:'all', bookingFilter:'all', expandedBooking:null,
  loanFilter:'active', expandedLoan:null, showStaffPanel:false,
  dashMonth:{year:new Date().getFullYear(),month:new Date().getMonth()},
  reportMonth:null,
  calMonth:{year:new Date().getFullYear(),month:new Date().getMonth()},
  _loading:true,
};
function setState(p){Object.assign(state,typeof p==='function'?p(state):p);render();}
function mutateData(fn){fn(state.data);saveData(state.data);render();}

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
      btn({title:'Backup data',style:{background:'none',border:'none',padding:'2px 4px',cursor:'pointer',color:'var(--muted)'},onClick:downloadBackup},ico('download',{style:{fontSize:15}})),
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

// Plain JSON backup download
function downloadBackup(){
  const blob=new Blob([JSON.stringify(state.data,null,2)],{type:'application/json'});
  const a=document.createElement('a');
  a.href=URL.createObjectURL(blob);
  a.download=`staylog-backup-${today()}.json`;
  a.click();
}

// Plain JSON restore
function restoreBackup(){
  const inp=document.createElement('input');
  inp.type='file';inp.accept='.json';
  inp.onchange=e=>{
    const file=e.target.files[0];if(!file)return;
    const reader=new FileReader();
    reader.onload=ev=>{
      try{
        const d=normalizeData(JSON.parse(ev.target.result));
        if(!d.properties||!d.bookings||!d.expenses)throw new Error('Invalid data structure');
        if(confirm(`Restore ${d.bookings.length} bookings, ${d.expenses.length} expenses and ${d.loans.length} loans? Current data will be replaced.`)){
          state.data=d;saveData(d);render();
        }
      }catch(err){
        alert('Restore failed: '+err.message+'\n\nMake sure this is a valid StayLog backup file.');
      }
    };
    reader.readAsText(file);
  };
  inp.click();
}

// ─── Bottom Nav ───────────────────────────────────────────────────────────────
function renderNav(){
  const tabs=[['dashboard','home','Home'],['bookings','calendar','Bookings'],['expenses','receipt','Expenses'],['loans','wallet','Loans'],['reports','chart-bar','Reports']];
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
    // ID proof display
    if(b.idProofType||b.idProofImage){
      const idRow=div({style:{marginBottom:8}});
      if(b.idProofType||b.idProofNumber){
        idRow.appendChild(div({style:{fontSize:13,color:'var(--text-mid)',marginBottom:b.idProofImage?6:0,display:'flex',alignItems:'center',gap:8}},
          ico('id-badge',{style:{fontSize:15,color:'var(--light)'}}),
          `${b.idProofType||'ID'} ${b.idProofNumber?'— '+b.idProofNumber:''}`
        ));
      }
      if(b.idProofImage){
        const imgThumb=h('img',{src:b.idProofImage,style:{width:'100%',maxHeight:160,objectFit:'contain',borderRadius:8,border:'1px solid var(--border)',background:'var(--cream)',cursor:'pointer'}});
        imgThumb.addEventListener('click',()=>window.open(b.idProofImage,'_blank'));
        idRow.appendChild(imgThumb);
      }
      detail.appendChild(idRow);
    }
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
  const idTypeLabels={Aadhaar:'Aadhaar Card',Passport:'Passport',DrivingLicense:'Driving Licence',VoterID:'Voter ID',PAN:'PAN Card',Other:'ID Proof'};
  const html=`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"/><title>Booking Confirmation — ${b.guestName}</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=Playfair+Display:wght@500;600&family=DM+Sans:wght@300;400;500;600&display=swap');
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'DM Sans',sans-serif;background:#fff;color:#1a1a1a;padding:40px;max-width:700px;margin:0 auto;font-size:15px;line-height:1.65}
.header{text-align:center;margin-bottom:36px;padding-bottom:24px;border-bottom:2px solid #e8f4ef}
.logo{font-family:'Playfair Display',serif;font-size:34px;color:#2d6a4f;margin-bottom:4px;letter-spacing:-0.01em}
.tagline{font-size:12px;color:#7a7570;letter-spacing:0.08em;text-transform:uppercase}
.hero{background:linear-gradient(135deg,#e8f4ef 0%,#f7f5f0 100%);border-radius:18px;padding:30px 34px;margin-bottom:28px;border:1px solid #c8e0d0}
.hero h1{font-family:'Playfair Display',serif;font-size:26px;color:#1a1a1a;margin-bottom:8px}
.hero p{font-size:14.5px;color:#4a4540;line-height:1.75}
.ref{display:inline-block;background:#2d6a4f;color:#fff;padding:5px 16px;border-radius:20px;font-size:12px;font-weight:600;letter-spacing:0.06em;margin-top:12px}
.section-title{font-size:11px;font-weight:700;color:#2d6a4f;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:12px;padding-bottom:6px;border-bottom:1px solid #e8e3da}
.detail-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:24px}
.detail-item{background:#f7f5f0;border-radius:10px;padding:13px 15px}
.detail-label{font-size:10.5px;color:#7a7570;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:4px}
.detail-value{font-size:15px;font-weight:600;color:#1a1a1a}
.detail-value.highlight{color:#2d6a4f;font-size:16px}
.time-banner{background:#2d6a4f;color:#fff;border-radius:12px;padding:16px 22px;margin-bottom:24px;display:flex;justify-content:space-around;align-items:center;gap:12px}
.time-block{text-align:center}
.time-label{font-size:10px;letter-spacing:0.1em;text-transform:uppercase;opacity:0.8;margin-bottom:4px}
.time-value{font-size:22px;font-weight:700;letter-spacing:-0.01em}
.time-date{font-size:12px;opacity:0.85;margin-top:2px}
.time-sep{width:1px;background:rgba(255,255,255,0.3);height:48px}
.warm-note{background:#e8f4ef;border-radius:12px;padding:18px 22px;margin-bottom:24px;font-size:14px;color:#1b5e38;line-height:1.75;border-left:4px solid #2d6a4f}
.rules-wrap{background:#fffbf0;border:1px solid #edd890;border-radius:16px;padding:26px 28px;margin-bottom:24px}
.rules-intro{font-size:13.5px;color:#7a6020;line-height:1.7;margin-bottom:20px}
.rule{display:flex;gap:14px;margin-bottom:18px;align-items:flex-start}
.rule:last-child{margin-bottom:0}
.rule-icon{font-size:22px;flex-shrink:0;margin-top:2px}
.rule-body{}
.rule-title{font-weight:700;font-size:14.5px;color:#2d6a4f;margin-bottom:4px}
.rule-desc{font-size:13.5px;color:#3a3530;line-height:1.6}
.footer{text-align:center;margin-top:36px;padding-top:20px;border-top:1px solid #e8e3da;color:#7a7570;font-size:13px;line-height:1.9}
@media print{body{padding:20px}}
</style></head><body>

<div class="header">
  <div class="logo">Raaya Vasyam</div>
  <div class="tagline">Booking Confirmation</div>
</div>

<div class="hero">
  <h1>Welcome, ${b.guestName}! 🏡</h1>
  <p>We are so thrilled to have you with us at <strong>${prop?.name||'our home'}</strong>! Your booking is all set, and we truly cannot wait to welcome you. We hope this stay gives you a chance to unwind, recharge, and create some wonderful memories. Think of this home as your own little retreat — we've put our heart into making it comfortable, warm, and welcoming just for you.</p>
  <span class="ref">Booking Ref: ${bookingRef}</span>
</div>

<div class="section-title">Your Stay at a Glance</div>
<div class="detail-grid">
  <div class="detail-item"><div class="detail-label">Guest Name</div><div class="detail-value">${b.guestName}</div></div>
  <div class="detail-item"><div class="detail-label">Property</div><div class="detail-value">${prop?.name||'Our Home'}</div></div>
  <div class="detail-item"><div class="detail-label">Check-in</div><div class="detail-value">${fmtDateLong(b.checkIn)}</div></div>
  <div class="detail-item"><div class="detail-label">Check-out</div><div class="detail-value">${fmtDateLong(b.checkOut)}</div></div>
  <div class="detail-item"><div class="detail-label">Duration</div><div class="detail-value highlight">${nights} night${nights!==1?'s':''}</div></div>
  <div class="detail-item"><div class="detail-label">Guests</div><div class="detail-value">${b.guests||1} person${(b.guests||1)>1?'s':''}</div></div>
  ${prop?.location?`<div class="detail-item" style="grid-column:1/-1"><div class="detail-label">Property Address</div><div class="detail-value">${prop.location}</div></div>`:''}
  ${b.phone?`<div class="detail-item"><div class="detail-label">Contact Number</div><div class="detail-value">${b.phone}</div></div>`:''}
</div>

<div class="time-banner">
  <div class="time-block">
    <div class="time-label">Check-in Time</div>
    <div class="time-value">1:00 PM</div>
    <div class="time-date">${fmtDate(b.checkIn)}</div>
  </div>
  <div class="time-sep"></div>
  <div class="time-block">
    <div class="time-label">Check-out Time</div>
    <div class="time-value">11:00 AM</div>
    <div class="time-date">${fmtDate(b.checkOut)}</div>
  </div>
</div>

<div class="warm-note">
  💚 <strong>A little note from our heart to yours —</strong><br/>
  Our home has been lovingly set up so you can feel completely at ease the moment you walk in. The kitchen is stocked with essentials, the beds are made, and everything is ready for you. Please treat this space as your own, explore freely, and do reach out anytime if you need something. Your comfort means the world to us, and we genuinely hope every moment of your stay feels special.
</div>

<div class="section-title" style="margin-bottom:16px">A Few Things to Keep in Mind 🏠</div>
<div class="rules-wrap">
  <p class="rules-intro">We've put together a few simple guidelines to make sure everyone — you, fellow guests, and our lovely neighbours — has the most comfortable and enjoyable experience. We know you'll understand the spirit behind each one, and we truly appreciate your thoughtfulness!</p>

  <div class="rule">
    <span class="rule-icon">🌙</span>
    <div class="rule-body">
      <div class="rule-title">Home by 10 PM — Sweet Dreams for the Neighbourhood</div>
      <div class="rule-desc">Our neighbourhood is a quiet, peaceful community, and the evenings here are wonderfully serene. We kindly request that everyone plans to be back at the house by <strong>10 PM</strong> each night. This helps us keep a harmonious relationship with our lovely neighbours and ensures you get the restful night's sleep you deserve after a day of exploring!</div>
    </div>
  </div>

  <div class="rule">
    <span class="rule-icon">🕯️</span>
    <div class="rule-body">
      <div class="rule-title">A Home, Not a Party Venue — Keep the Vibe Cosy</div>
      <div class="rule-desc">This home is designed to be a serene, intimate retreat — a place where you can truly breathe and be at peace. We'd love for it to stay that way! We kindly request that you keep gatherings to your immediate group and avoid hosting large get-togethers or loud events. Good conversations, laughter, and great memories are absolutely welcome — just keep it cosy and warm!</div>
    </div>
  </div>

  <div class="rule">
    <span class="rule-icon">🌿</span>
    <div class="rule-body">
      <div class="rule-title">Fresh Air Always — A Smoke-Free Home</div>
      <div class="rule-desc">We've worked hard to keep the interiors of this home clean, fresh, and welcoming for every guest. To preserve that for you and for everyone who stays after you, the <strong>entire property — indoors and outdoors — is strictly non-smoking</strong>. We appreciate your cooperation with this, and if you do need a smoke, we kindly ask that you step outside the property gates. Thank you so much for your understanding!</div>
    </div>
  </div>

  <div class="rule">
    <span class="rule-icon">💡</span>
    <div class="rule-body">
      <div class="rule-title">Little Steps, Big Difference — Save Energy When You Step Out</div>
      <div class="rule-desc">Every time you head out for an adventure, we'd be grateful if you could take a moment to switch off the <strong>lights, fans, and air conditioners</strong> before leaving. It's a small habit that makes a meaningful difference — both for the environment and for keeping things running smoothly. We truly appreciate every little act of care!</div>
    </div>
  </div>

  <div class="rule">
    <span class="rule-icon">🍽️</span>
    <div class="rule-body">
      <div class="rule-title">A Clean Kitchen is a Happy Kitchen — Wash Up After Yourself</div>
      <div class="rule-desc">The kitchen is fully yours to use and enjoy! We just kindly ask that any <strong>utensils, pots, pans, or dishes used are washed and put back</strong> after each use. This keeps the space neat and ready for your next culinary adventure — or for your fellow travellers who may want to use it too. A tidy kitchen makes everyone's stay that much more pleasant!</div>
    </div>
  </div>

  <div class="rule">
    <span class="rule-icon">👟</span>
    <div class="rule-body">
      <div class="rule-title">Shoes Off at the Door — Step In and Feel at Home</div>
      <div class="rule-desc">We follow the lovely tradition of <strong>leaving footwear outside the entrance</strong>. It keeps our floors clean, reduces dust indoors, and — honestly — there's something wonderfully grounding about walking barefoot in a comfortable home! There's a dedicated spot for your shoes right at the entrance, so you can step in and immediately feel at ease.</div>
    </div>
  </div>
</div>

<div class="footer">
  <p style="font-size:15px;color:#1a1a1a;font-weight:500">We hope your stay at <strong style="color:#2d6a4f">${prop?.name||'our home'}</strong> is everything you've been looking forward to. 🌸</p>
  <p style="margin-top:8px">Wishing you a wonderful, restful, and joy-filled stay.</p>
  <p style="margin-top:4px">With warm regards &amp; a big welcome hug — <strong style="color:#2d6a4f">Your Hosts</strong></p>
  <p style="margin-top:16px;font-size:12px;color:#afa99e">Generated by StayLog · ${new Date().toLocaleDateString('en-IN',{day:'numeric',month:'long',year:'numeric'})}</p>
</div>

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
  // Staff loan position
  const openLoans=data.loans.filter(l=>l.status!=='writtenoff'&&loanBalance(l)>0.5);
  if(openLoans.length>0){
    const outstanding=round2(openLoans.reduce((s,l)=>s+loanBalance(l),0));
    const overdue=round2(openLoans.reduce((s,l)=>s+loanOverdue(l),0));
    wrap.appendChild(div({className:'card',style:{padding:'12px 14px',marginBottom:16,display:'flex',justifyContent:'space-between',alignItems:'center',gap:10,cursor:'pointer'},onClick:()=>setState({tab:'loans'})},
      div({style:{display:'flex',alignItems:'center',gap:10,minWidth:0}},
        div({style:{background:'var(--gold-light)',borderRadius:8,padding:'6px 8px'}},ico('wallet',{style:{fontSize:17,color:'var(--gold)'}})),
        div({},
          div({style:{fontSize:13,fontWeight:600}},`Staff loans · ${openLoans.length} running`),
          div({style:{fontSize:12,color:overdue>0?'var(--danger)':'var(--muted)',marginTop:2}},
            overdue>0?`${fmtCur(overdue)} behind schedule`:'On schedule')
        )
      ),
      div({style:{textAlign:'right',flexShrink:0}},
        div({style:{fontSize:16,fontWeight:700,color:'var(--gold)'}},fmtCur(outstanding)),
        div({style:{fontSize:11,color:'var(--muted)'}},'outstanding')
      )
    ));
  }
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
        btn({className:'btn-danger btn-sm',style:{padding:'4px 9px'},onClick:()=>{if(confirm(`Delete "${p.name}" and all its data?`)){mutateData(d=>{
          const dropped=d.expenses.filter(e=>e.propertyId===p.id).map(e=>e.id);
          d.properties=d.properties.filter(x=>x.id!==p.id);
          d.bookings=d.bookings.filter(b=>b.propertyId!==p.id);
          d.expenses=d.expenses.filter(e=>e.propertyId!==p.id);
          dropped.forEach(id=>unlinkExpenseLoan(d,id));
          d.loans=d.loans.map(l=>l.propertyId===p.id?{...l,propertyId:''}:l);
        });}}},ico('trash',{style:{fontSize:14}}))
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
    const ded=round2(e.loanDeduction);
    card.appendChild(div({style:{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:5}},
      div({style:{minWidth:0}},
        div({style:{fontWeight:600,fontSize:15}},`${catEmoji[e.category]||'📦'} ${e.description}`),
        div({style:{fontSize:12,color:'var(--muted)',marginTop:3}},
          `${prop?.name||'—'} · ${fmtDate(e.date)} · ${e.category}${e.staffId?' · '+staffName(e.staffId):''}`)
      ),
      div({style:{textAlign:'right',flexShrink:0}},
        div({style:{fontWeight:700,color:'var(--danger)',fontSize:15,marginBottom:5}},fmtCur(e.amount)),
        expPaidBadge(e.paid)
      )
    ));
    if(e.loanId&&ded>0){
      card.appendChild(div({style:{display:'flex',justifyContent:'space-between',alignItems:'center',gap:8,background:e.paid?'var(--accent-light)':'var(--warn-light)',border:`1px solid ${e.paid?'#cfe6db':'#f5cba0'}`,borderRadius:9,padding:'7px 10px',fontSize:12,marginTop:2,marginBottom:2,color:e.paid?'var(--accent)':'var(--warn)'}},
        div({style:{display:'flex',alignItems:'center',gap:6,minWidth:0}},ico('wallet',{style:{fontSize:14}}),
          `Payout ${fmtCur(e.grossAmount||round2(e.amount)+ded)} − loan ${fmtCur(ded)}`),
        span({style:{fontWeight:600,flexShrink:0}},e.paid?'credited to loan':'pending')
      ));
    }
    // Action row
    const acts=div({style:{display:'flex',gap:6,marginTop:8,flexWrap:'wrap'}});
    // Toggle paid/unpaid button
    acts.appendChild(btn({
      style:{background:e.paid?'var(--cream)':'var(--accent-light)',color:e.paid?'var(--muted)':'var(--accent)',border:`1.5px solid ${e.paid?'var(--border)':'var(--accent)'}`,borderRadius:'var(--radius-sm)',padding:'5px 11px',fontSize:12,fontWeight:600,cursor:'pointer',display:'flex',alignItems:'center',gap:4},
      onClick:()=>mutateData(d=>{
        const upd={...e,paid:!e.paid};
        d.expenses=d.expenses.map(x=>x.id===e.id?upd:x);
        syncExpenseLoan(d,upd); // marking a staff payout paid is what credits the loan
      })
    },ico(e.paid?'circle-check':'circle',{style:{fontSize:13}}),e.paid?'Mark Unpaid':'Mark as Paid'));
    acts.appendChild(btn({className:'btn-ghost btn-sm',style:{padding:'5px 10px'},onClick:()=>setState({modal:'addExpense',editItem:e})},ico('edit',{style:{fontSize:14}})));
    acts.appendChild(btn({className:'btn-danger btn-sm',style:{padding:'5px 10px'},onClick:()=>{
      if(!confirm(e.loanId&&ded>0?`Delete this payout? The ${fmtCur(ded)} credited against ${staffName(e.staffId)}'s loan will be reversed.`:'Delete this expense?'))return;
      mutateData(d=>{d.expenses=d.expenses.filter(x=>x.id!==e.id);unlinkExpenseLoan(d,e.id);});
    }},ico('trash',{style:{fontSize:14}})));
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

const LOAN_ROW_META={
  paid    :{label:'Paid',    bg:'#e8f4ef',color:'#1b5e38'},
  partial :{label:'Partial', bg:'#fdf1e8',color:'#c05010'},
  overdue :{label:'Overdue', bg:'#fdeaea',color:'#c62828'},
  upcoming:{label:'Upcoming',bg:'#f0f0ee',color:'#5a5a58'},
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
    h('div',{style:{fontFamily:'Playfair Display',fontSize:20}},'Staff Loans'),
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
      h('div',{style:{fontFamily:'Playfair Display',fontSize:20,marginBottom:8}},'No staff yet'),
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
    const al=div({style:{background:'var(--danger-light)',border:'1.5px solid #f5c6c6',borderRadius:'var(--radius)',padding:'12px 14px',marginBottom:14}});
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
        [s.role,s.monthlySalary?`${fmtCur(s.monthlySalary)}/mo`:null,s.phone].filter(Boolean).join(' · ')||'—'),
      bal>0?div({style:{fontSize:12,color:'var(--gold)',fontWeight:600,marginTop:3}},`Loan outstanding: ${fmtCur(bal)}`):null
    ));
    row.appendChild(div({style:{display:'flex',gap:6,flexShrink:0}},
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

  const card=div({className:'card',style:{marginBottom:10,borderColor:overdue>0?'#f0c4c4':'var(--border)'}});
  const head=div({style:{padding:'13px 14px',cursor:'pointer'},onClick:()=>setState({expandedLoan:expanded?null:l.id})});
  head.appendChild(div({style:{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:9}},
    div({style:{minWidth:0}},
      div({style:{fontWeight:600,fontSize:15}},staffName(l.staffId)),
      div({style:{fontSize:12,color:'var(--muted)',marginTop:3}},
        `${fmtCur(principal)} on ${fmtDate(l.disbursedOn)}${prop?' · '+prop.name:''}`)
    ),
    div({style:{textAlign:'right',flexShrink:0}},
      span({style:{background:wo?'#f0f0ee':settled?'var(--accent-light)':overdue>0?'var(--danger-light)':'var(--gold-light)',
        color:wo?'#5a5a58':settled?'#1b5e38':overdue>0?'var(--danger)':'var(--gold)',borderRadius:20,padding:'4px 11px',fontSize:12,fontWeight:600}},
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

  const body=div({style:{borderTop:'1px solid var(--border-soft)',padding:'12px 14px 14px',background:'#fafaf8',borderRadius:'0 0 var(--radius) var(--radius)'}});
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
  body.appendChild(div({style:{fontSize:12,fontWeight:600,color:'var(--muted)',textTransform:'uppercase',letterSpacing:'0.06em',marginBottom:8}},'Repayment Schedule'));
  const table=div({style:{background:'var(--white)',border:'1px solid var(--border)',borderRadius:10,overflow:'hidden',marginBottom:12,maxHeight:250,overflowY:'auto'}});
  rows.forEach((r,i)=>{
    const m=LOAN_ROW_META[r.status];
    table.appendChild(div({style:{display:'flex',alignItems:'center',justifyContent:'space-between',gap:8,padding:'8px 11px',borderBottom:i<rows.length-1?'1px solid var(--border-soft)':'none',background:r.status==='overdue'?'#fff7f7':'var(--white)'}},
      div({style:{display:'flex',alignItems:'center',gap:9,minWidth:0}},
        span({style:{fontSize:11,color:'var(--light)',fontWeight:600,width:18}},String(r.no)),
        div({},
          div({style:{fontSize:13,fontWeight:600}},fmtCur(r.amount)),
          div({style:{fontSize:11,color:'var(--muted)',marginTop:1}},fmtDate(r.dueDate)+(r.status==='partial'?` · ${fmtCur(r.paid)} received`:''))
        )
      ),
      span({style:{background:m.bg,color:m.color,borderRadius:20,padding:'3px 10px',fontSize:11,fontWeight:600,flexShrink:0}},m.label)
    ));
  });
  body.appendChild(table);

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
function renderStaffModal(){
  const{editItem}=state; const isEdit=!!editItem;
  const f=isEdit?{...editItem}:{name:'',role:'',phone:'',monthlySalary:'',active:true,joinedOn:today()};
  const content=()=>{
    const wrap=div({style:{display:'flex',flexDirection:'column',gap:11}});
    [['name','Staff name *','text'],['role','Role (caretaker, cook…)','text'],['phone','Phone number','tel'],['monthlySalary','Monthly salary (₹)','number']].forEach(([k,ph,t])=>{
      const inp=h('input',{type:t,placeholder:ph,value:f[k]??''});inp.addEventListener('input',e=>f[k]=e.target.value);wrap.appendChild(inp);
    });
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

    const hint=div({style:{background:'var(--accent-light)',border:'1px solid #cfe6db',borderRadius:'var(--radius-sm)',padding:'11px 13px',fontSize:13,color:'var(--accent)',lineHeight:1.55,minHeight:20}});
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
      wrap.appendChild(div({style:{fontSize:12.5,color:'var(--warn)',background:'var(--warn-light)',border:'1px solid #f5cba0',borderRadius:'var(--radius-sm)',padding:'9px 12px',lineHeight:1.5}},
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
      imgPreview.appendChild(btn({style:{marginTop:6,background:'var(--danger-light)',color:'var(--danger)',border:'1.5px solid #f5c6c6',borderRadius:'var(--radius-sm)',padding:'5px 12px',fontSize:12,fontWeight:600,cursor:'pointer',width:'100%'},onClick:()=>{f.idProofImage='';imgPreview.style.display='none';uploadBtn.style.display='flex';}},'Remove photo'));
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
        imgPreview.appendChild(btn({style:{marginTop:6,background:'var(--danger-light)',color:'var(--danger)',border:'1.5px solid #f5c6c6',borderRadius:'var(--radius-sm)',padding:'5px 12px',fontSize:12,fontWeight:600,cursor:'pointer',width:'100%'},onClick:()=>{f.idProofImage='';imgPreview.style.display='none';uploadBtn.style.display='flex';}},'Remove photo'));
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
      Object.assign(netLine.style,{background:'var(--accent-light)',border:'1px solid #cfe6db',borderRadius:'var(--radius-sm)',padding:'11px 13px',fontSize:13,lineHeight:1.6,color:'var(--accent)'});
      netLine.appendChild(div({style:{display:'flex',justifyContent:'space-between'}},span({},'Payout due'),span({style:{fontWeight:600}},fmtCur(gross))));
      netLine.appendChild(div({style:{display:'flex',justifyContent:'space-between'}},span({},'Less loan instalment'),span({style:{fontWeight:600}},'− '+fmtCur(ded))));
      netLine.appendChild(div({style:{display:'flex',justifyContent:'space-between',borderTop:'1px solid #cfe6db',marginTop:5,paddingTop:5,fontWeight:700,color:net<0?'var(--danger)':'var(--accent)'}},
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
      const togRow=div({style:{display:'flex',alignItems:'center',justifyContent:'space-between',gap:10,background:on?'var(--gold-light)':'var(--cream)',borderRadius:'var(--radius-sm)',padding:'11px 13px',border:`1.5px solid ${on?'#e8d9a8':'var(--border)'}`,cursor:'pointer'}});
      togRow.appendChild(div({style:{minWidth:0}},
        div({style:{fontSize:14,fontWeight:600}},'Deduct loan instalment'),
        div({style:{fontSize:12,color:'var(--muted)',marginTop:2}},`${s.name} owes ${fmtCur(round2(loans.reduce((a,l)=>a+Math.max(0,loanBalance(l)),0)))}`)
      ));
      const knob=div({style:{width:44,height:26,borderRadius:20,background:on?'var(--accent)':'var(--border)',flexShrink:0,position:'relative',transition:'background .15s'}},
        div({style:{width:20,height:20,borderRadius:'50%',background:'#fff',position:'absolute',top:3,left:on?21:3,transition:'left .15s',boxShadow:'0 1px 3px rgba(0,0,0,0.2)'}}));
      togRow.appendChild(knob);
      togRow.addEventListener('click',()=>{
        if(f.loanId){f.loanId='';f.loanDeduction=0;}
        else{
          const l=loans[0];
          f.loanId=l.id;
          const nd=loanNextDue(l);
          f.loanDeduction=round2(Math.min(nd?nd.amount-nd.paid:Number(l.installmentAmount||0),Math.max(0,loanBalance(l))));
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
            const nl=loanById(f.loanId),nd=loanNextDue(nl);
            f.loanDeduction=round2(Math.min(nd?nd.amount-nd.paid:Number(nl.installmentAmount||0),Math.max(0,loanBalance(nl))));
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
    const pendingNote=div({style:{display:'none',fontSize:12.5,color:'var(--warn)',background:'var(--warn-light)',border:'1px solid #f5cba0',borderRadius:'var(--radius-sm)',padding:'9px 12px',lineHeight:1.5}});
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
  else if(state.modal==='addLoan')  {currentModal=renderLoanModal();    document.body.appendChild(currentModal);}
  else if(state.modal==='addRepayment'){currentModal=renderRepaymentModal();document.body.appendChild(currentModal);}
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
render();
Promise.all([loadDataFromIDB(),loadAuth()]).then(([data,auth])=>{
  state.data=data;state.auth=auth;state.loggedIn=false;state._loading=false;render();
});
