/* Raaya Vasyam · staff view
   ────────────────────────────────────────────────────────────────────────────
   What the house help sees. It reads nothing directly — two database functions
   hand back a fixed list of columns, so guest names, phone numbers and money
   cannot appear here however the policies change later.

   Signing in asks for a username, not an email. Her account is a made-up
   address she never needs to know about.
   ──────────────────────────────────────────────────────────────────────────── */
'use strict';

const CFG = window.STAYLOG_CLOUD || {};
const CHECKIN_TIME = '1:00 PM', CHECKOUT_TIME = '11:00 AM';
const CACHE_KEY = 'rv_staff_cache';

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const MONTH_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

const isoOf = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const today = () => isoOf(new Date());
const fmtDate = s => s ? new Date(s+'T00:00:00').toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'}) : '—';
const fmtCur = n => '₹' + Number(n||0).toLocaleString('en-IN');
const nights = (a,b) => Math.max(0, Math.round((new Date(b) - new Date(a))/86400000));

const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k,v] of Object.entries(attrs)) {
    if (k === 'style' && typeof v === 'object') {
      for (const [p,val] of Object.entries(v))
        el.style[p] = typeof val === 'number' ? val+'px' : val;
    }
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'className') el.className = v;
    else if (k === 'disabled') el.disabled = v;
    else el.setAttribute(k, v);
  }
  for (const c of kids.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
  }
  return el;
};
const div = (a,...c) => h('div',a,...c);
const span = (a,...c) => h('span',a,...c);

let sb = null, session = null, view = null, calMonth = null, busy = false;

function client() {
  if (!sb) sb = window.supabase.createClient(CFG.url, CFG.publishableKey,
    { auth:{ persistSession:true, autoRefreshToken:true } });
  return sb;
}
const cacheGet = () => { try { return JSON.parse(localStorage.getItem(CACHE_KEY)); } catch { return null; } };
const cacheSet = v => { try { localStorage.setItem(CACHE_KEY, JSON.stringify(v)); } catch {} };

// ── Data ─────────────────────────────────────────────────────────────────────
async function fetchView() {
  const c = client();
  const [cal, standing] = await Promise.all([
    c.rpc('staff_calendar'),
    c.rpc('staff_standing'),
  ]);
  if (cal.error) throw cal.error;
  if (standing.error) throw standing.error;
  const v = { calendar: cal.data || [], standing: standing.data || null, at: new Date().toISOString() };
  cacheSet(v);
  return v;
}

async function refresh(silent) {
  if (busy) return;
  busy = true; if (!silent) render();
  try { view = await fetchView(); }
  catch (err) {
    if (!view) view = cacheGet();
    if (!silent) alert('Could not refresh: ' + (err.message || err));
  }
  finally { busy = false; render(); }
}

// ── Login ────────────────────────────────────────────────────────────────────
function renderLogin(msg) {
  const app = document.getElementById('app');
  app.innerHTML = '';
  const wrap = div({style:{display:'flex',flexDirection:'column',justifyContent:'center',
    minHeight:'100vh',padding:'32px 22px',gap:13}});

  wrap.appendChild(div({className:'display',style:{fontSize:32,color:'var(--accent)',textAlign:'center'}},'Raaya Vasyam'));
  wrap.appendChild(div({style:{fontSize:13.5,color:'var(--muted)',textAlign:'center',marginBottom:18,lineHeight:1.6}},
    'Your schedule, wages and loan'));

  const user = h('input',{type:'text',placeholder:'Username',autocapitalize:'none',
    autocorrect:'off',spellcheck:'false',autocomplete:'username'});
  const pass = h('input',{type:'password',placeholder:'Password',autocomplete:'current-password'});
  wrap.appendChild(user); wrap.appendChild(pass);

  if (msg) wrap.appendChild(div({style:{fontSize:13,color:'var(--danger)',background:'var(--danger-light)',
    border:'1px solid var(--danger)',borderRadius:'var(--radius-sm)',padding:'10px 12px',lineHeight:1.45}}, msg));

  const go = h('button',{className:'btn'},'Sign in');
  const submit = async () => {
    const u = user.value.trim(), p = pass.value;
    if (!u || !p) return;
    go.disabled = true; go.textContent = 'Signing in…';
    try {
      const email = u.includes('@') ? u : `${u.toLowerCase()}@${CFG.staffEmailDomain}`;
      const { data, error } = await client().auth.signInWithPassword({ email, password: p });
      if (error) throw error;
      session = data.session;
      view = cacheGet();
      render();
      refresh(true);
    } catch (err) {
      renderLogin(/Invalid login/i.test(err.message||'')
        ? 'That username and password did not match. Check with Rakshit if you are stuck.'
        : (err.message || 'Could not sign in.'));
    }
  };
  go.addEventListener('click', submit);
  pass.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
  wrap.appendChild(go);
  app.appendChild(wrap);
}

// ── Pieces ───────────────────────────────────────────────────────────────────
function wageCard(st) {
  const card = div({className:'card',style:{padding:'15px 16px'}});
  card.appendChild(div({className:'kicker'},'Your wages'));
  card.appendChild(div({className:'display num',style:{fontSize:30,marginTop:4}},
    st.monthly_salary ? fmtCur(st.monthly_salary) : '—'));
  card.appendChild(div({style:{fontSize:12.5,color:'var(--muted)',marginTop:2}},'per month'));

  const rows = div({style:{display:'flex',gap:14,borderTop:'1px solid var(--border-soft)',
    marginTop:13,paddingTop:12}});
  const cell = (label, value, sub) => div({style:{flex:1,minWidth:0}},
    div({className:'kicker'}, label),
    div({className:'num',style:{fontSize:15,fontWeight:700,marginTop:3}}, value),
    sub ? div({style:{fontSize:11,color:'var(--muted)',marginTop:1}}, sub) : null);
  rows.appendChild(cell('Last paid',
    st.last_payout ? fmtCur(st.last_payout.amount) : '—',
    st.last_payout ? fmtDate(st.last_payout.date) : 'nothing recorded'));
  rows.appendChild(cell('Paid this year', fmtCur(st.paid_this_year)));
  card.appendChild(rows);
  return card;
}

function loanCard(loan) {
  const repaid = Number(loan.repaid || 0);
  const principal = Number(loan.principal || 0);
  const balance = Math.max(0, principal - repaid);
  const pct = principal > 0 ? Math.round(repaid / principal * 100) : 0;
  const settled = balance <= 0.5 || loan.status === 'writtenoff';

  const card = div({className:'card',style:{padding:'15px 16px'}});
  card.appendChild(div({style:{display:'flex',justifyContent:'space-between',alignItems:'flex-start',gap:10}},
    div({},
      div({className:'kicker'},'Loan outstanding'),
      div({className:'display num',style:{fontSize:28,marginTop:4,
        color:settled?'var(--accent)':'var(--gold)'}}, settled ? 'Cleared' : fmtCur(balance))),
    span({style:{background:settled?'var(--accent-light)':'var(--gold-light)',
      color:settled?'var(--accent)':'var(--gold)',borderRadius:20,padding:'4px 11px',
      fontSize:11,fontWeight:700,whiteSpace:'nowrap',flexShrink:0}},
      settled ? 'Settled' : `${pct}% repaid`)));

  card.appendChild(div({className:'track',style:{marginTop:12}},
    div({style:{width:pct+'%'}})));
  card.appendChild(div({style:{display:'flex',justifyContent:'space-between',fontSize:11.5,
    color:'var(--muted)',marginTop:7}},
    span({}, `${fmtCur(repaid)} of ${fmtCur(principal)} repaid`),
    span({}, loan.instalment ? `${fmtCur(loan.instalment)} a month` : '')));

  if (!settled && loan.instalment) {
    const left = Math.ceil(balance / Number(loan.instalment));
    card.appendChild(div({style:{fontSize:12.5,color:'var(--text-mid)',marginTop:11,
      borderTop:'1px solid var(--border-soft)',paddingTop:11}},
      `About ${left} more instalment${left===1?'':'s'} to go.`));
  }
  return card;
}

function calendarCard() {
  const stays = (view.calendar || []).map(s => ({
    from: s.check_in, to: s.check_out, guests: s.guests || 1, property: s.property || '',
  }));
  const { year, month } = calMonth;
  const first = new Date(year, month, 1).getDay();
  const count = new Date(year, month+1, 0).getDate();

  // which days are occupied, and by how many people
  const byDay = {};
  stays.forEach(s => {
    for (let d = 1; d <= count; d++) {
      const iso = `${year}-${String(month+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      if (s.from <= iso && s.to > iso) byDay[iso] = (byDay[iso]||0) + s.guests;
    }
  });

  const card = div({className:'card',style:{overflow:'hidden'}});
  card.appendChild(div({style:{display:'flex',alignItems:'center',justifyContent:'space-between',
    padding:'12px 14px 10px'}},
    h('button',{className:'btn-quiet',style:{minHeight:36,padding:'6px 12px',fontSize:16},
      'aria-label':'Previous month',
      onClick:()=>{let y=year,m=month-1;if(m<0){m=11;y--;}calMonth={year:y,month:m};render();}},'‹'),
    div({style:{fontSize:14,fontWeight:700}}, `${MONTHS[month]} ${year}`),
    h('button',{className:'btn-quiet',style:{minHeight:36,padding:'6px 12px',fontSize:16},
      'aria-label':'Next month',
      onClick:()=>{let y=year,m=month+1;if(m>11){m=0;y++;}calMonth={year:y,month:m};render();}},'›')));

  const head = div({style:{display:'grid',gridTemplateColumns:'repeat(7,1fr)',
    borderBottom:'1px solid var(--border-soft)'}});
  DAYS.forEach(d => head.appendChild(div({style:{textAlign:'center',padding:'6px 0',fontSize:10,
    fontWeight:700,color:'var(--muted)',letterSpacing:'.05em'}}, d)));
  card.appendChild(head);

  const grid = div({style:{display:'grid',gridTemplateColumns:'repeat(7,1fr)'}});
  for (let i = 0; i < first; i++) grid.appendChild(div({style:{minHeight:46}}));
  for (let d = 1; d <= count; d++) {
    const iso = `${year}-${String(month+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const g = byDay[iso];
    const isToday = iso === today();
    grid.appendChild(div({style:{minHeight:46,padding:'4px 2px',textAlign:'center',
      borderTop:'1px solid var(--border-soft)',
      background: g ? 'var(--accent-light)' : 'transparent'}},
      div({className:'num',style:{fontSize:13,fontWeight:isToday?700:500,width:22,height:22,
        margin:'0 auto',display:'flex',alignItems:'center',justifyContent:'center',
        borderRadius:'50%',background:isToday?'var(--accent)':'transparent',
        color:isToday?'var(--on-accent)':(g?'var(--accent)':'var(--text)')}}, String(d)),
      g ? div({style:{fontSize:9.5,color:'var(--accent)',fontWeight:700,marginTop:2}},
        `${g} guest${g>1?'s':''}`) : null));
  }
  card.appendChild(grid);
  return card;
}

function staysList() {
  const t = today();
  const upcoming = (view.calendar || [])
    .filter(s => s.check_out >= t)
    .sort((a,b) => String(a.check_in).localeCompare(String(b.check_in)))
    .slice(0, 6);
  const wrap = div({});
  wrap.appendChild(div({className:'display',style:{fontSize:17,margin:'22px 2px 10px'}},'Coming up'));
  if (!upcoming.length) {
    wrap.appendChild(div({className:'card',style:{padding:'22px',textAlign:'center',
      color:'var(--muted)',fontSize:13.5}}, 'Nothing booked yet'));
    return wrap;
  }
  upcoming.forEach(s => {
    const n = nights(s.check_in, s.check_out);
    const arriving = s.check_in === t, leaving = s.check_out === t;
    const card = div({className:'card',style:{padding:'12px 14px',marginBottom:8,
      display:'flex',alignItems:'center',gap:12}});
    const d = new Date(s.check_in+'T00:00:00');
    card.appendChild(div({style:{flex:'0 0 44px',textAlign:'center',borderRadius:'var(--radius-sm)',
      padding:'6px 0',background:'var(--accent-light)',color:'var(--accent)'}},
      div({className:'num',style:{fontSize:16,fontWeight:700,lineHeight:1.1}}, String(d.getDate()).padStart(2,'0')),
      div({style:{fontSize:9,textTransform:'uppercase',letterSpacing:'.07em',fontWeight:700}}, MONTH_SHORT[d.getMonth()])));
    card.appendChild(div({style:{flex:1,minWidth:0}},
      div({style:{fontSize:14,fontWeight:700}}, `${s.guests} guest${s.guests>1?'s':''} · ${n} night${n===1?'':'s'}`),
      div({style:{fontSize:11.5,color:'var(--muted)',marginTop:2}},
        `In ${fmtDate(s.check_in)} · out ${fmtDate(s.check_out)}`)));
    if (arriving || leaving)
      card.appendChild(span({style:{fontSize:10,fontWeight:700,padding:'4px 9px',borderRadius:20,
        background:'var(--gold-light)',color:'var(--gold)',whiteSpace:'nowrap',flexShrink:0}},
        arriving ? 'Arriving today' : 'Leaving today'));
    wrap.appendChild(card);
  });
  return wrap;
}

// ── Screen ───────────────────────────────────────────────────────────────────
function render() {
  const app = document.getElementById('app');
  if (!session) { renderLogin(); return; }
  app.innerHTML = '';

  const st = view && view.standing;
  const wrap = div({style:{padding:'14px 12px 60px',display:'flex',flexDirection:'column',gap:11}});

  wrap.appendChild(div({style:{display:'flex',alignItems:'center',justifyContent:'space-between',
    gap:10,paddingBottom:4}},
    div({style:{minWidth:0}},
      div({className:'display',style:{fontSize:21}}, 'Raaya Vasyam'),
      div({style:{fontSize:12,color:'var(--muted)',marginTop:1}},
        st && st.name ? st.name : 'Staff')),
    h('button',{className:'btn-quiet',style:{flexShrink:0,minHeight:38,padding:'8px 12px',fontSize:12.5},
      onClick:async()=>{ await client().auth.signOut(); session=null; view=null;
        try{localStorage.removeItem(CACHE_KEY);}catch{} render(); }},'Sign out')));

  if (busy && !view)
    wrap.appendChild(div({className:'card',style:{padding:'30px',textAlign:'center',
      color:'var(--muted)',fontSize:13.5}}, 'Loading…'));

  if (!st && !busy)
    wrap.appendChild(div({className:'card',style:{padding:'20px',textAlign:'center',
      color:'var(--muted)',fontSize:13.5,lineHeight:1.6}},
      'Nothing is shared with this account yet. Ask Rakshit to check your access.'));

  if (st) {
    wrap.appendChild(wageCard(st));
    (st.loans || []).forEach(l => wrap.appendChild(loanCard(l)));
  }

  if (view) {
    wrap.appendChild(div({className:'display',style:{fontSize:17,margin:'12px 2px 2px'}},'House calendar'));
    wrap.appendChild(div({style:{fontSize:12,color:'var(--muted)',margin:'0 2px 8px',lineHeight:1.5}},
      `Guests arrive from ${CHECKIN_TIME} and leave by ${CHECKOUT_TIME}.`));
    wrap.appendChild(calendarCard());
    wrap.appendChild(staysList());
  }

  const foot = div({style:{marginTop:20,textAlign:'center'}});
  const btn = h('button',{className:'btn-quiet',disabled:busy,
    onClick:()=>refresh(false)}, busy ? 'Refreshing…' : 'Refresh');
  foot.appendChild(btn);
  if (view && view.at) foot.appendChild(div({style:{fontSize:11,color:'var(--light)',marginTop:8}},
    'Updated ' + new Date(view.at).toLocaleString('en-IN',{day:'numeric',month:'short',hour:'numeric',minute:'2-digit'})));
  wrap.appendChild(foot);

  app.appendChild(wrap);
}

// ── Boot ─────────────────────────────────────────────────────────────────────
(async function () {
  const now = new Date();
  calMonth = { year: now.getFullYear(), month: now.getMonth() };
  view = cacheGet();
  try {
    const { data } = await client().auth.getSession();
    session = data.session || null;
  } catch {}
  render();
  if (session) refresh(true);

  // Fresh figures when she comes back to it, without hammering the database.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && session) refresh(true);
  });
  setInterval(() => { if (session && !document.hidden) refresh(true); }, 120000);
})();
