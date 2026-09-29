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
const PAGE_VERSION = 'v6 · 29 Sept 2026';

const MONTH_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

const isoOf = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const today = () => isoOf(new Date());
const fmtDate = s => s ? new Date(s+'T00:00:00').toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'}) : '—';
const fmtCur = n => '₹' + Number(n||0).toLocaleString('en-IN');
const nights = (a,b) => Math.max(0, Math.round((new Date(b) - new Date(a))/86400000));

// Properties that take a bare number. Everything else gets px, otherwise
// numeric values are dropped — and lineHeight:1.5 would become 1.5px.
const UNITLESS_CSS = new Set(['opacity','zIndex','fontWeight','lineHeight','flex','flexGrow',
  'flexShrink','order','zoom','columnCount','tabSize','gridRow','gridColumn','aspectRatio']);
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k,v] of Object.entries(attrs)) {
    if (k === 'style' && typeof v === 'object') {
      for (const [p,val] of Object.entries(v))
        el.style[p] = (typeof val === 'number' && !UNITLESS_CSS.has(p)) ? val+'px' : val;
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

let sb = null, session = null, view = null, busy = false;

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
// Folded state for the wage breakdown. Deliberately not remembered between
// visits: closed is the right thing to see when the page first opens.
let detailOpen = false;

// ── Attendance ───────────────────────────────────────────────────────────────
// One tap, for today. Deliberately says nothing about money: the amount it
// becomes is the owner's business, and the wage card below already carries
// the totals she is entitled to see.
let marking = false;

async function markToday(on) {
  if (marking) return;
  marking = true; render();
  try {
    const { data, error } = await client().rpc(on ? 'staff_mark_today' : 'staff_unmark_today');
    if (error) throw error;
    if (data && data.ok === false) {
      alert(data.reason === 'already_counted'
        ? 'Today has already been counted. Ask Rakshit if it needs changing.'
        : 'Your access is not active. Please check with Rakshit.');
    }
  } catch (err) {
    alert('Could not save that — check your internet and try again.');
  } finally {
    marking = false;
    await refresh(true);        // re-read rather than guess at the new state
  }
}

function attendanceCard(st) {
  const a = (st && st.attendance) || {};
  const marked = !!a.marked;
  const card = div({className:'card',style:{padding:'15px 15px 14px'}});

  card.appendChild(div({className:'kicker'}, 'Today · ' + fmtDate(a.today || today())));

  if (!marked) {
    card.appendChild(h('button',{className:'btn',disabled:marking,style:{marginTop:11},
      onClick:()=>markToday(true)}, marking ? 'Saving…' : 'I came in today'));
    if (a.this_month)
      card.appendChild(div({style:{fontSize:12,color:'var(--muted)',marginTop:9,textAlign:'center'}},
        `${a.this_month} ${a.this_month === 1 ? 'day' : 'days'} marked this month`));
    return card;
  }

  const at = a.marked_at ? new Date(a.marked_at) : null;
  card.appendChild(div({style:{display:'flex',alignItems:'center',gap:10,marginTop:10}},
    div({style:{width:34,height:34,borderRadius:99,background:'var(--accent-light)',
      display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0,
      color:'var(--accent)',fontSize:18,fontWeight:700}}, '✓'),
    div({style:{minWidth:0}},
      div({style:{fontWeight:700,fontSize:15}}, 'Marked present'),
      div({style:{fontSize:12,color:'var(--muted)',marginTop:1}},
        at ? 'at ' + at.toLocaleTimeString('en-IN',{hour:'numeric',minute:'2-digit'}) : 'today'))));

  card.appendChild(div({style:{display:'flex',alignItems:'center',justifyContent:'space-between',
    gap:10,marginTop:12,paddingTop:11,borderTop:'1px solid var(--border-soft)'}},
    div({style:{fontSize:12,color:'var(--muted)'}},
      `${a.this_month || 1} ${(a.this_month || 1) === 1 ? 'day' : 'days'} this month`),
    a.locked
      ? div({style:{fontSize:12,color:'var(--light)'}}, 'Counted')
      : h('button',{className:'btn-quiet',disabled:marking,
          style:{width:'auto',minHeight:36,padding:'8px 14px',fontSize:12.5},
          onClick:()=>{ if(confirm('Remove today\u2019s mark?')) markToday(false); }},
          marking ? '…' : 'Undo')));
  return card;
}

function wageCard(st) {
  if (!st.pending || !st.overall) return staleCard();
  const pend = st.pending, month = st.this_month || {}, all = st.overall;
  const owed = Number(pend.amount || 0);
  const settled = owed <= 0;

  const card = div({className:'card',style:{padding:'15px 16px'}});
  card.appendChild(div({className:'kicker'}, settled ? 'Your wages' : 'Waiting to be paid'));
  card.appendChild(div({className:'display num',style:{fontSize:settled?26:30,marginTop:4,
    color: settled ? 'var(--accent)' : 'var(--gold)'}},
    settled ? 'All settled' : fmtCur(owed)));

  card.appendChild(div({style:{fontSize:12.5,color:'var(--muted)',marginTop:2}},
    settled
      ? (st.last_payout ? `Last paid ${fmtDate(st.last_payout.date)}` : 'Nothing recorded yet')
      : `${pend.count} payment${pend.count===1?'':'s'}${pend.oldest?` · oldest ${fmtDate(pend.oldest)}`:''}`));

  // The arithmetic behind the figure above. She counts her own days; seeing
  // the same days listed is what settles a disagreement before it starts.
  // Folded away by default: the total is what she opens the page for, and a
  // list of dates sitting open every time is noise she has to scroll past.
  const days = Array.isArray(pend.days) ? pend.days : [];
  if (!settled && days.length) {
    const toggle = h('button',{
      style:{display:'flex',alignItems:'center',justifyContent:'space-between',gap:10,width:'100%',
        marginTop:12,paddingTop:11,borderTop:'1px solid var(--border-soft)',minHeight:40,
        background:'none',fontSize:13,fontWeight:600,color:'var(--accent)'},
      'aria-expanded': detailOpen ? 'true' : 'false',
      onClick:()=>{ detailOpen = !detailOpen; render(); }},
      div({}, detailOpen ? 'Hide the days' : 'See the days'),
      div({style:{fontSize:11,color:'var(--muted)',fontWeight:400}},
        detailOpen ? '▴' : `${days.length}${Number(pend.earlier||0)?'+':''} days  ▾`));
    card.appendChild(toggle);
  }
  if (!settled && days.length && detailOpen) {
    const list = div({style:{marginTop:2}});
    days.forEach(d => {
      const gross = Number(d.gross || 0), cut = Number(d.deducted || 0), net = Number(d.net || 0);
      const row = div({style:{display:'flex',alignItems:'baseline',justifyContent:'space-between',
        gap:10,padding:'8px 0',borderBottom:'1px solid var(--border-soft)'}});
      row.appendChild(div({style:{fontSize:13.5,minWidth:0}}, fmtDate(d.date)));
      row.appendChild(div({style:{textAlign:'right',flexShrink:0}},
        div({className:'num',style:{fontSize:14,fontWeight:700}}, fmtCur(net)),
        cut > 0 ? div({className:'num',style:{fontSize:11.5,color:'var(--muted)',marginTop:1}},
          `${fmtCur(gross)} − ${fmtCur(cut)} loan`) : null));
      list.appendChild(row);
    });
    const earlier = Number(pend.earlier || 0);
    if (earlier > 0) list.appendChild(div({style:{fontSize:12,color:'var(--muted)',padding:'9px 0 2px'}},
      `and ${earlier} earlier ${earlier === 1 ? 'day' : 'days'}`));
    card.appendChild(list);
  }

  const rows = div({style:{display:'flex',gap:14,borderTop:'1px solid var(--border-soft)',
    marginTop:13,paddingTop:12}});
  const cell = (label, value) => div({style:{flex:1,minWidth:0}},
    div({className:'kicker'}, label),
    div({className:'num',style:{fontSize:16,fontWeight:700,marginTop:3}}, value));
  rows.appendChild(cell('This month', fmtCur(month.amount)));
  rows.appendChild(cell('Received so far', fmtCur(all.paid)));
  card.appendChild(rows);

  // Her payout is what is left after an instalment comes off, so say so rather
  // than leaving her to work out why the figure is short.
  const cut = Number(month.deducted || 0);
  if (cut > 0) card.appendChild(div({style:{fontSize:12,color:'var(--text-mid)',marginTop:11,
    background:'var(--gold-light)',border:'1px solid var(--gold-line)',
    borderRadius:'var(--radius-sm)',padding:'9px 11px',lineHeight:1.5}},
    `${fmtCur(cut)} of this month's wage went towards your loan. The figures above are what you receive in hand.`));

  return card;
}

// The database is answering in an older shape than this page understands.
// Saying so is the only honest option — rendering zeroes would read as
// "you are owed nothing", which is a serious thing to get wrong.
function staleCard() {
  return div({className:'card',style:{padding:'16px',borderColor:'var(--gold-line)',
    background:'var(--gold-light)'}},
    div({className:'kicker',style:{color:'var(--gold)'}},'Wages unavailable'),
    div({style:{fontSize:13.5,color:'var(--text-mid)',marginTop:6,lineHeight:1.55}},
      'This page could not read your wage figures. Nothing is wrong with your money — please ask Rakshit to finish the update.'));
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
  const stays = view.calendar || [];
  const start = new Date(); start.setHours(0,0,0,0);

  const days = [];
  for (let i = 0; i < 15; i++) {
    const d = new Date(start); d.setDate(d.getDate() + i);
    const iso = isoOf(d);
    let guests = 0;
    stays.forEach(s => { if (s.check_in <= iso && s.check_out > iso) guests += (s.guests || 1); });
    days.push({ d, iso, guests,
      arriving: stays.some(s => s.check_in === iso),
      leaving:  stays.some(s => s.check_out === iso) });
  }

  const card = div({className:'card',style:{padding:'12px 10px 14px'}});
  const grid = div({style:{display:'grid',gridTemplateColumns:'repeat(5,1fr)',gap:5}});
  days.forEach(x => {
    const busy = x.guests > 0;
    const isToday = x.iso === today();
    grid.appendChild(div({style:{borderRadius:'var(--radius-sm)',padding:'7px 2px 6px',
      textAlign:'center', minHeight:62,
      background: busy ? 'var(--accent-light)' : 'var(--surface-2)',
      border: isToday ? '1.5px solid var(--accent)' : '1.5px solid transparent'}},
      div({style:{fontSize:9.5,color:'var(--muted)',fontWeight:700,textTransform:'uppercase'}},
        DAYS[x.d.getDay()]),
      div({className:'num',style:{fontSize:16,fontWeight:700,lineHeight:1.2,
        color: busy ? 'var(--accent)' : 'var(--text)'}}, String(x.d.getDate())),
      busy
        ? div({style:{fontSize:9.5,color:'var(--accent)',fontWeight:700,marginTop:1}},
            `${x.guests} guest${x.guests>1?'s':''}`)
        : div({style:{fontSize:9.5,color:'var(--light)',marginTop:1}},'free'),
      (x.arriving || x.leaving)
        ? div({style:{fontSize:8.5,color:'var(--gold)',fontWeight:700,marginTop:1}},
            x.arriving && x.leaving ? 'in · out' : x.arriving ? 'arrives' : 'leaves')
        : null));
  });
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
    wrap.appendChild(attendanceCard(st));
    wrap.appendChild(wageCard(st));
    (st.loans || []).forEach(l => wrap.appendChild(loanCard(l)));
  }

  if (view) {
    wrap.appendChild(div({className:'display',style:{fontSize:17,margin:'12px 2px 2px'}},'Next 15 days'));
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
  foot.appendChild(div({style:{fontSize:10,color:'var(--light)',marginTop:4}}, PAGE_VERSION));
  wrap.appendChild(foot);

  app.appendChild(wrap);
}

// ── Boot ─────────────────────────────────────────────────────────────────────
(async function () {
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
