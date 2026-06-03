/* StayLog — Homestay Manager App
   Vanilla JS, no build step, works offline on iPhone via PWA
   v3: Login, Monthly filter on Dashboard & Reports, CSV/HTML Report Download */

'use strict';

// ─── Auth (PIN stored in IndexedDB, never leaves device) ──────────────────────
const AUTH_KEY   = 'staylog_auth';
const PIN_LENGTH = 4;

// ─── Storage (IndexedDB primary + localStorage fallback) ─────────────────────
const DB_NAME    = 'staylog_db';
const DB_VERSION = 1;
const STORE_NAME = 'appdata';
const DATA_KEY   = 'staylog_main';
const LS_KEY     = 'staylog_v2';

const defaultData = { properties: [], bookings: [], expenses: [] };

let _db = null;
function openDB() {
  return new Promise((resolve, reject) => {
    if (_db) { resolve(_db); return; }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
    };
    req.onsuccess = e => { _db = e.target.result; resolve(_db); };
    req.onerror   = () => reject(req.error);
  });
}
function idbGet(key) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  }));
}
function idbSet(key, value) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const req = tx.objectStore(STORE_NAME).put(value, key);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  }));
}

function saveData(d) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(d)); } catch {}
  idbSet(DATA_KEY, JSON.parse(JSON.stringify(d))).catch(() => {});
}

async function loadDataFromIDB() {
  try {
    const d = await idbGet(DATA_KEY);
    if (d && d.properties) return d;
  } catch {}
  try {
    const ls = JSON.parse(localStorage.getItem(LS_KEY));
    if (ls && ls.properties) { saveData(ls); return ls; }
  } catch {}
  return { ...defaultData };
}

async function loadAuth() {
  try {
    const a = await idbGet(AUTH_KEY);
    if (a) return a;
  } catch {}
  try {
    const ls = localStorage.getItem(AUTH_KEY);
    if (ls) return JSON.parse(ls);
  } catch {}
  return null;
}

function saveAuth(auth) {
  try { localStorage.setItem(AUTH_KEY, JSON.stringify(auth)); } catch {}
  idbSet(AUTH_KEY, auth).catch(() => {});
}

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2); }

// ─── Formatters ──────────────────────────────────────────────────────────────
const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const MONTH_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const fmtDate = s => s ? new Date(s + 'T00:00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
const fmtCur  = n => '₹' + Number(n || 0).toLocaleString('en-IN');
const diffDays = (a, b) => Math.max(0, Math.ceil((new Date(b) - new Date(a)) / 86400000));
const today   = () => new Date().toISOString().split('T')[0];

// ─── State ───────────────────────────────────────────────────────────────────
let state = {
  data:          { ...defaultData },
  auth:          null,       // { pin: '...' } once set
  loggedIn:      false,
  tab:           'dashboard',
  modal:         null,
  editItem:      null,
  filterProp:    'all',
  bookingFilter: 'all',
  expandedBooking: null,
  // Month filters: null = "All Time", otherwise { year, month } (0-indexed month)
  dashMonth:     { year: new Date().getFullYear(), month: new Date().getMonth() },
  reportMonth:   null,
  _loading:      true,
};

function setState(patch) {
  Object.assign(state, typeof patch === 'function' ? patch(state) : patch);
  render();
}
function mutateData(fn) {
  fn(state.data);
  saveData(state.data);
  render();
}

// ─── DOM helpers ─────────────────────────────────────────────────────────────
const h = (tag, attrs = {}, ...children) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'className') el.className = v;
    else if (k === 'htmlFor') el.htmlFor = v;
    else if (k === 'checked' || k === 'disabled' || k === 'selected') el[k] = v;
    else el.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(c) : c);
  }
  return el;
};
const div  = (attrs, ...c) => h('div', attrs, ...c);
const span = (attrs, ...c) => h('span', attrs, ...c);
const btn  = (attrs, ...c) => h('button', attrs, ...c);
const ico  = (name, extra = {}) => h('i', { className: `ti ti-${name}`, 'aria-hidden': 'true', ...extra });

// ─── Month selector helper ────────────────────────────────────────────────────
function monthSelector(current, onChange) {
  // current = null (All Time) or { year, month }
  const now   = new Date();
  const yr    = now.getFullYear();
  const isAll = current === null;

  const wrap = div({ style: { display: 'flex', alignItems: 'center', gap: 8 } });

  // Prev arrow
  const prevBtn = btn({
    style: { background: 'none', border: 'none', padding: '4px 6px', cursor: 'pointer', color: 'var(--muted)', fontSize: 18 },
    onClick: () => {
      if (isAll) return;
      let { year, month } = current;
      month--;
      if (month < 0) { month = 11; year--; }
      onChange({ year, month });
    }
  }, '‹');

  // Label / toggle button
  const label = btn({
    style: { background: isAll ? 'var(--accent)' : 'var(--white)', color: isAll ? '#fff' : 'var(--text)', border: '1.5px solid ' + (isAll ? 'var(--accent)' : 'var(--border)'), borderRadius: 20, padding: '5px 14px', fontSize: 13, fontWeight: 600, minWidth: 110, textAlign: 'center' },
  }, isAll ? 'All Time' : `${MONTH_SHORT[current.month]} ${current.year}`);

  // Dropdown on click
  label.addEventListener('click', () => {
    const existing = document.getElementById('month-picker-overlay');
    if (existing) { existing.remove(); return; }

    const overlay = div({ id: 'month-picker-overlay', style: { position: 'fixed', inset: 0, zIndex: 500 } });
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

    const rect = label.getBoundingClientRect();
    const picker = div({ style: { position: 'absolute', top: (rect.bottom + 6) + 'px', left: Math.max(8, rect.left - 40) + 'px', background: 'var(--white)', border: '1px solid var(--border)', borderRadius: 14, padding: '12px', boxShadow: '0 4px 24px rgba(0,0,0,0.15)', minWidth: 240, zIndex: 501 } });

    // All time option
    picker.appendChild(btn({
      style: { width: '100%', padding: '8px 12px', textAlign: 'left', background: isAll ? 'var(--accent-light)' : 'none', color: isAll ? 'var(--accent)' : 'var(--text)', border: 'none', borderRadius: 8, fontWeight: isAll ? 600 : 400, fontSize: 14, cursor: 'pointer', marginBottom: 6 },
      onClick: () => { onChange(null); overlay.remove(); }
    }, 'All Time'));

    // Year label
    picker.appendChild(div({ style: { fontSize: 11, color: 'var(--muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', margin: '4px 0 8px 4px' } }, String(yr)));

    // Month grid
    const grid = div({ style: { display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 4 } });
    MONTH_SHORT.forEach((m, i) => {
      const isCurrent = !isAll && current.year === yr && current.month === i;
      grid.appendChild(btn({
        style: { padding: '7px 4px', borderRadius: 8, border: 'none', background: isCurrent ? 'var(--accent)' : 'var(--cream)', color: isCurrent ? '#fff' : 'var(--text)', fontSize: 13, fontWeight: isCurrent ? 600 : 400, cursor: 'pointer' },
        onClick: () => { onChange({ year: yr, month: i }); overlay.remove(); }
      }, m));
    });
    picker.appendChild(grid);

    // Previous year
    picker.appendChild(div({ style: { fontSize: 11, color: 'var(--muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', margin: '10px 0 8px 4px' } }, String(yr - 1)));
    const grid2 = div({ style: { display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 4 } });
    MONTH_SHORT.forEach((m, i) => {
      const isCurrent = !isAll && current.year === (yr - 1) && current.month === i;
      grid2.appendChild(btn({
        style: { padding: '7px 4px', borderRadius: 8, border: 'none', background: isCurrent ? 'var(--accent)' : 'var(--cream)', color: isCurrent ? '#fff' : 'var(--text)', fontSize: 13, fontWeight: isCurrent ? 600 : 400, cursor: 'pointer' },
        onClick: () => { onChange({ year: yr - 1, month: i }); overlay.remove(); }
      }, m));
    });
    picker.appendChild(grid2);

    overlay.appendChild(picker);
    document.body.appendChild(overlay);
  });

  // Next arrow
  const nextBtn = btn({
    style: { background: 'none', border: 'none', padding: '4px 6px', cursor: 'pointer', color: 'var(--muted)', fontSize: 18 },
    onClick: () => {
      if (isAll) return;
      let { year, month } = current;
      month++;
      if (month > 11) { month = 0; year++; }
      onChange({ year, month });
    }
  }, '›');

  wrap.appendChild(prevBtn);
  wrap.appendChild(label);
  wrap.appendChild(nextBtn);
  return wrap;
}

// ─── Badge ────────────────────────────────────────────────────────────────────
const STATUS_META = {
  confirmed:  { label: 'Confirmed',   bg: '#e8f4ef', color: '#1b5e38' },
  checkedin:  { label: 'Checked In',  bg: '#e8f0fb', color: '#0d47a1' },
  checkedout: { label: 'Checked Out', bg: '#f0f0ee', color: '#5a5a58' },
  cancelled:  { label: 'Cancelled',   bg: '#fdeaea', color: '#c62828' },
};
function badge(status) {
  const m = STATUS_META[status] || { label: status, bg: '#f0f0f0', color: '#555' };
  return span({ style: { background: m.bg, color: m.color, borderRadius: 20, padding: '4px 11px', fontSize: 12, fontWeight: 600 } }, m.label);
}

// ─── Modal ────────────────────────────────────────────────────────────────────
function modal(title, contentFn) {
  const overlay = div({
    style: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 999, display: 'flex', alignItems: 'flex-end', justifyContent: 'center', backdropFilter: 'blur(2px)' },
    onClick: e => { if (e.target === overlay) closeModal(); }
  });
  const sheet = div({ style: { background: 'var(--white)', borderRadius: '22px 22px 0 0', padding: '20px 16px env(safe-area-inset-bottom, 24px)', width: '100%', maxWidth: 480, maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 -4px 24px rgba(0,0,0,0.12)' } });
  sheet.appendChild(div({ style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 } },
    h('span', { style: { fontFamily: 'Playfair Display', fontSize: 20, fontWeight: 500 } }, title),
    btn({ style: { background: 'none', border: 'none', fontSize: 24, color: '#aaa', cursor: 'pointer', padding: '2px 8px', lineHeight: 1 }, onClick: closeModal }, '×')
  ));
  sheet.appendChild(contentFn());
  overlay.appendChild(sheet);
  sheet.style.transform = 'translateY(100%)';
  requestAnimationFrame(() => {
    sheet.style.transition = 'transform .28s cubic-bezier(.32,.72,0,1)';
    sheet.style.transform = 'translateY(0)';
  });
  return overlay;
}
function closeModal() { setState({ modal: null, editItem: null }); }

// ─── Login / PIN Screen ───────────────────────────────────────────────────────
function renderLoginScreen() {
  const isSetup = !state.auth;
  const app = document.getElementById('app');
  app.innerHTML = '';

  let pinEntry = '';
  let confirmPin = '';
  let phase = isSetup ? 'create' : 'enter'; // create | confirm | enter

  const wrap = div({ style: { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', padding: '32px 24px', background: 'var(--cream)' } });

  const title = div({ style: { fontFamily: 'Playfair Display', fontSize: 32, color: 'var(--accent)', marginBottom: 6, letterSpacing: '-0.01em' } }, 'StayLog');
  const sub   = div({ style: { fontSize: 14, color: 'var(--muted)', marginBottom: 40, textAlign: 'center' } }, isSetup ? 'Set a 4-digit PIN to protect your data' : 'Enter your PIN to continue');

  const dotsWrap = div({ style: { display: 'flex', gap: 16, marginBottom: 36 } });
  function renderDots(filled) {
    dotsWrap.innerHTML = '';
    for (let i = 0; i < PIN_LENGTH; i++) {
      dotsWrap.appendChild(div({ style: { width: 18, height: 18, borderRadius: '50%', border: '2px solid var(--accent)', background: i < filled ? 'var(--accent)' : 'transparent', transition: 'background .15s' } }));
    }
  }
  renderDots(0);

  const msgEl = div({ style: { fontSize: 13, color: 'var(--danger)', minHeight: 18, marginBottom: 10, fontWeight: 500 } });

  const phaseLabel = div({ style: { fontSize: 14, color: 'var(--muted)', marginBottom: 20, textAlign: 'center', minHeight: 20 } },
    isSetup ? 'Create PIN' : ''
  );

  // Numpad
  const pad = div({ style: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, width: '100%', maxWidth: 280 } });

  function handleDigit(d) {
    if (phase === 'enter') {
      pinEntry += d;
      renderDots(pinEntry.length);
      if (pinEntry.length === PIN_LENGTH) {
        if (pinEntry === state.auth.pin) {
          state.loggedIn = true;
          render();
        } else {
          msgEl.textContent = 'Incorrect PIN. Try again.';
          setTimeout(() => { pinEntry = ''; renderDots(0); msgEl.textContent = ''; }, 700);
        }
      }
    } else if (phase === 'create') {
      pinEntry += d;
      renderDots(pinEntry.length);
      if (pinEntry.length === PIN_LENGTH) {
        setTimeout(() => {
          phase = 'confirm';
          phaseLabel.textContent = 'Confirm PIN';
          renderDots(0);
          confirmPin = '';
        }, 200);
      }
    } else if (phase === 'confirm') {
      confirmPin += d;
      renderDots(confirmPin.length);
      if (confirmPin.length === PIN_LENGTH) {
        if (confirmPin === pinEntry) {
          const auth = { pin: pinEntry };
          state.auth = auth;
          state.loggedIn = true;
          saveAuth(auth);
          render();
        } else {
          msgEl.textContent = 'PINs do not match. Try again.';
          setTimeout(() => { pinEntry = ''; confirmPin = ''; phase = 'create'; phaseLabel.textContent = 'Create PIN'; renderDots(0); msgEl.textContent = ''; }, 800);
        }
      }
    }
  }

  function handleBack() {
    if (phase === 'enter' && pinEntry.length > 0) { pinEntry = pinEntry.slice(0, -1); renderDots(pinEntry.length); }
    else if (phase === 'create' && pinEntry.length > 0) { pinEntry = pinEntry.slice(0, -1); renderDots(pinEntry.length); }
    else if (phase === 'confirm' && confirmPin.length > 0) { confirmPin = confirmPin.slice(0, -1); renderDots(confirmPin.length); }
  }

  const keys = ['1','2','3','4','5','6','7','8','9','','0','⌫'];
  keys.forEach(k => {
    if (k === '') { pad.appendChild(div({})); return; }
    const b = btn({
      style: { padding: '18px', fontSize: k === '⌫' ? 20 : 22, fontWeight: 500, background: 'var(--white)', border: '1px solid var(--border)', borderRadius: 14, cursor: 'pointer', color: 'var(--text)', boxShadow: 'var(--shadow-sm)', transition: 'all .1s' },
      onClick: () => k === '⌫' ? handleBack() : handleDigit(k)
    }, k);
    pad.appendChild(b);
  });

  wrap.appendChild(title);
  wrap.appendChild(sub);
  wrap.appendChild(phaseLabel);
  wrap.appendChild(dotsWrap);
  wrap.appendChild(msgEl);
  wrap.appendChild(pad);

  // Change PIN option (only on login screen when PIN already exists)
  if (!isSetup) {
    wrap.appendChild(div({ style: { marginTop: 32 } },
      btn({ style: { background: 'none', border: 'none', color: 'var(--muted)', fontSize: 13, cursor: 'pointer', textDecoration: 'underline' },
        onClick: () => {
          if (confirm('Reset PIN? You will need to create a new one.')) {
            state.auth = null;
            state.loggedIn = false;
            saveAuth(null);
            renderLoginScreen();
          }
        }
      }, 'Forgot / Reset PIN')
    ));
  }

  app.appendChild(wrap);
}

// ─── Prop Filter Chips ────────────────────────────────────────────────────────
function propFilterChips() {
  const { data, filterProp } = state;
  if (data.properties.length < 2) return null;
  const row = div({ style: { display: 'flex', gap: 6, marginTop: 10, overflowX: 'auto', paddingBottom: 2, scrollbarWidth: 'none' } });
  const chip = (id, label) => btn({
    style: { padding: '5px 14px', borderRadius: 20, whiteSpace: 'nowrap', border: `1.5px solid ${filterProp === id ? 'var(--accent)' : 'var(--border)'}`, background: filterProp === id ? 'var(--accent-light)' : 'var(--white)', color: filterProp === id ? 'var(--accent)' : 'var(--muted)', fontSize: 13, fontWeight: filterProp === id ? 600 : 400 },
    onClick: () => setState({ filterProp: id })
  }, label);
  row.appendChild(chip('all', 'All Properties'));
  data.properties.forEach(p => row.appendChild(chip(p.id, p.name)));
  return row;
}

// ─── Header ──────────────────────────────────────────────────────────────────
function renderHeader() {
  const { data } = state;
  const header = div({ style: { background: 'var(--white)', borderBottom: '1px solid var(--border)', padding: '14px 16px 12px', position: 'sticky', top: 0, zIndex: 100 } });
  const top = div({ style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } });
  const brand = div({},
    h('div', { style: { fontFamily: 'Playfair Display', fontSize: 24, fontWeight: 500, color: 'var(--text)', letterSpacing: '-0.01em' } }, 'StayLog'),
    div({ style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 2 } },
      h('div', { style: { fontSize: 12, color: 'var(--muted)' } }, `${data.properties.length} ${data.properties.length === 1 ? 'property' : 'properties'} · ${data.bookings.length} bookings`),
      btn({ title: 'Backup data', style: { background: 'none', border: 'none', padding: '2px 4px', cursor: 'pointer', color: 'var(--muted)' }, onClick: downloadBackup }, ico('download', { style: { fontSize: 15 } })),
      btn({ title: 'Restore backup', style: { background: 'none', border: 'none', padding: '2px 4px', cursor: 'pointer', color: 'var(--muted)' }, onClick: restoreBackup }, ico('upload', { style: { fontSize: 15 } })),
      btn({ title: 'Lock app', style: { background: 'none', border: 'none', padding: '2px 4px', cursor: 'pointer', color: 'var(--muted)' }, onClick: () => { state.loggedIn = false; render(); } }, ico('lock', { style: { fontSize: 15 } }))
    )
  );
  const addBtn = btn({ className: 'btn-primary btn-sm', onClick: () => setState({ modal: 'addProp', editItem: null }) }, ico('plus', { style: { marginRight: 5 } }), 'Property');
  top.appendChild(brand);
  top.appendChild(addBtn);
  header.appendChild(top);
  const chips = propFilterChips();
  if (chips) header.appendChild(chips);
  return header;
}

function downloadBackup() {
  const blob = new Blob([JSON.stringify(state.data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `staylog-backup-${today()}.json`;
  a.click();
}
function restoreBackup() {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = '.json';
  inp.onchange = e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      try {
        const d = JSON.parse(ev.target.result);
        if (!d.properties || !d.bookings || !d.expenses) throw new Error('Invalid');
        if (confirm(`Restore ${d.bookings.length} bookings and ${d.expenses.length} expenses? Current data will be replaced.`)) {
          state.data = d; saveData(d); render();
        }
      } catch { alert('Invalid backup file.'); }
    };
    reader.readAsText(file);
  };
  inp.click();
}

// ─── Bottom Nav ───────────────────────────────────────────────────────────────
function renderNav() {
  const tabs = [['dashboard','home','Home'],['bookings','calendar','Bookings'],['expenses','receipt','Expenses'],['reports','chart-bar','Reports']];
  const nav = div({ style: { position: 'fixed', bottom: 0, left: '50%', transform: 'translateX(-50%)', width: '100%', maxWidth: 480, background: 'var(--white)', borderTop: '1px solid var(--border)', display: 'flex', zIndex: 100, paddingBottom: 'env(safe-area-inset-bottom, 0)' } });
  tabs.forEach(([t, icon, label]) => {
    const active = state.tab === t;
    nav.appendChild(btn({
      style: { flex: 1, padding: '10px 4px 8px', background: 'none', border: 'none', fontSize: 11, fontWeight: active ? 600 : 400, color: active ? 'var(--accent)' : 'var(--muted)', cursor: 'pointer', borderTop: active ? '2.5px solid var(--accent)' : '2.5px solid transparent', transition: 'all .15s' },
      onClick: () => setState({ tab: t })
    }, ico(icon, { style: { fontSize: 22, display: 'block', marginBottom: 3 } }), label));
  });
  return nav;
}

// ─── Filter bookings/expenses by month ───────────────────────────────────────
function filterByMonth(items, dateKey, monthFilter) {
  if (!monthFilter) return items;
  return items.filter(x => {
    const d = new Date(x[dateKey] + 'T00:00:00');
    return d.getFullYear() === monthFilter.year && d.getMonth() === monthFilter.month;
  });
}

// ─── Booking Card ─────────────────────────────────────────────────────────────
function bookingCard(b) {
  const prop = state.data.properties.find(p => p.id === b.propertyId);
  const nights = diffDays(b.checkIn, b.checkOut);
  const isExpanded = state.expandedBooking === b.id;
  const paid = Number(b.paid || 0);
  const total = Number(b.totalAmount || 0);
  const due = total - paid;
  const card = div({ className: 'card', style: { marginBottom: 10 } });
  const summary = div({ style: { padding: '13px 14px', cursor: 'pointer' }, onClick: () => setState({ expandedBooking: isExpanded ? null : b.id }) });
  summary.appendChild(div({ style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' } },
    div({},
      div({ style: { fontWeight: 600, fontSize: 15 } }, b.guestName),
      div({ style: { fontSize: 12, color: 'var(--muted)', marginTop: 3, display: 'flex', alignItems: 'center', gap: 6 } }, ico('home', { style: { fontSize: 13 } }), prop?.name || '—', span({ style: { color: 'var(--border)' } }, '·'), `${nights} nights`)
    ),
    div({ style: { textAlign: 'right' } }, badge(b.status), div({ style: { fontSize: 15, fontWeight: 700, color: 'var(--accent)', marginTop: 5 } }, fmtCur(total)))
  ));
  summary.appendChild(div({ style: { fontSize: 12, color: 'var(--muted)', marginTop: 7, display: 'flex', alignItems: 'center', gap: 5 } }, ico('calendar', { style: { fontSize: 13 } }), fmtDate(b.checkIn), '→', fmtDate(b.checkOut)));
  card.appendChild(summary);
  if (isExpanded) {
    const detail = div({ style: { borderTop: '1px solid var(--border-soft)', padding: '12px 14px 14px', background: '#fafaf8', borderRadius: '0 0 var(--radius) var(--radius)' } });
    const infoRow = (icon, text) => text ? div({ style: { fontSize: 13, color: 'var(--text-mid)', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 8 } }, ico(icon, { style: { fontSize: 15, color: 'var(--light)' } }), text) : null;
    [infoRow('phone', b.phone), infoRow('users', b.guests ? `${b.guests} guest${b.guests > 1 ? 's' : ''}` : null), infoRow('link', b.source), infoRow('currency-rupee', paid > 0 ? `Paid: ${fmtCur(paid)} · ${due > 0 ? 'Due: ' + fmtCur(due) : 'Fully paid'}` : null)].forEach(r => r && detail.appendChild(r));
    if (b.notes) detail.appendChild(div({ style: { fontSize: 13, color: 'var(--muted)', fontStyle: 'italic', margin: '6px 0 10px', lineHeight: 1.5, background: 'var(--white)', padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)' } }, `"${b.notes}"`));
    const actions = div({ style: { display: 'flex', gap: 7, flexWrap: 'wrap', marginTop: 8 } });
    if (b.status === 'confirmed') actions.appendChild(btn({ className: 'btn-primary btn-sm', onClick: () => updateStatus(b.id, 'checkedin') }, ico('door-enter', { style: { marginRight: 5 } }), 'Check In'));
    if (b.status === 'checkedin') actions.appendChild(btn({ className: 'btn-primary btn-sm', onClick: () => updateStatus(b.id, 'checkedout') }, ico('door-exit', { style: { marginRight: 5 } }), 'Check Out'));
    if (b.status !== 'cancelled' && b.status !== 'checkedout') actions.appendChild(btn({ className: 'btn-ghost btn-sm', onClick: () => updateStatus(b.id, 'cancelled') }, 'Cancel'));
    actions.appendChild(btn({ className: 'btn-ghost btn-sm', onClick: () => setState({ modal: 'addBooking', editItem: b }) }, ico('edit', { style: { marginRight: 4 } }), 'Edit'));
    actions.appendChild(btn({ className: 'btn-danger btn-sm', onClick: () => { if (confirm('Delete this booking?')) { mutateData(d => d.bookings = d.bookings.filter(x => x.id !== b.id)); setState({ expandedBooking: null }); } } }, ico('trash', { style: { marginRight: 4 } }), 'Delete'));
    detail.appendChild(actions);
    card.appendChild(detail);
  }
  return card;
}

// ─── Dashboard ────────────────────────────────────────────────────────────────
function renderDashboard() {
  const { data, filterProp, dashMonth } = state;
  let bookings = filterProp === 'all' ? data.bookings : data.bookings.filter(b => b.propertyId === filterProp);
  let expenses = filterProp === 'all' ? data.expenses : data.expenses.filter(e => e.propertyId === filterProp);

  // Apply month filter
  bookings = filterByMonth(bookings, 'checkIn', dashMonth);
  expenses = filterByMonth(expenses, 'date', dashMonth);

  const totalRevenue  = bookings.filter(b => b.status !== 'cancelled').reduce((s, b) => s + Number(b.totalAmount || 0), 0);
  const totalExpenses = expenses.reduce((s, e) => s + Number(e.amount || 0), 0);
  const net           = totalRevenue - totalExpenses;
  const activeBookings   = bookings.filter(b => b.status === 'checkedin').length;
  const upcomingBookings = bookings.filter(b => b.status === 'confirmed').length;

  const t = today();
  const todayCheckins  = data.bookings.filter(b => b.checkIn  === t && b.status === 'confirmed');
  const todayCheckouts = data.bookings.filter(b => b.checkOut === t && b.status === 'checkedin');

  const wrap = div({ style: { padding: '14px 12px 100px' } });

  if (data.properties.length === 0) {
    wrap.appendChild(div({ style: { textAlign: 'center', padding: '70px 20px' } },
      ico('home', { style: { fontSize: 52, color: 'var(--light)', display: 'block', marginBottom: 16 } }),
      h('div', { style: { fontFamily: 'Playfair Display', fontSize: 22, color: 'var(--text)', marginBottom: 8 } }, 'Welcome to StayLog'),
      h('div', { style: { color: 'var(--muted)', fontSize: 14, marginBottom: 24, lineHeight: 1.6 } }, 'Add a property to get started.'),
      btn({ className: 'btn-primary', onClick: () => setState({ modal: 'addProp' }) }, ico('plus', { style: { marginRight: 6 } }), 'Add First Property')
    ));
    return wrap;
  }

  // Month filter row
  wrap.appendChild(div({ style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 } },
    h('div', { style: { fontFamily: 'Playfair Display', fontSize: 17 } }, 'Overview'),
    monthSelector(dashMonth, m => setState({ dashMonth: m }))
  ));

  // Stats grid
  const grid = div({ style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 16 } });
  [
    { label: 'Revenue',    val: fmtCur(totalRevenue),  icon: 'currency-rupee', bg: 'var(--accent-light)', col: 'var(--accent)' },
    { label: 'Net Profit', val: fmtCur(net), icon: 'trending-up', bg: net >= 0 ? 'var(--accent-light)' : 'var(--danger-light)', col: net >= 0 ? 'var(--accent)' : 'var(--danger)' },
    { label: 'Checked In', val: activeBookings,    icon: 'door-enter',    bg: 'var(--info-light)',  col: 'var(--info)'  },
    { label: 'Upcoming',   val: upcomingBookings,  icon: 'calendar-event',bg: 'var(--gold-light)',  col: 'var(--gold)'  },
  ].forEach(s => {
    grid.appendChild(div({ className: 'card', style: { padding: '14px' } },
      div({ style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 } },
        div({ style: { fontSize: 11, color: 'var(--muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' } }, s.label),
        div({ style: { background: s.bg, borderRadius: 8, padding: '5px 7px' } }, ico(s.icon, { style: { fontSize: 17, color: s.col } }))
      ),
      div({ style: { fontSize: 23, fontWeight: 700, color: 'var(--text)', letterSpacing: '-0.02em' } }, String(s.val))
    ));
  });
  wrap.appendChild(grid);

  // Today alerts (always from full data, not month filtered)
  if (todayCheckins.length > 0 || todayCheckouts.length > 0) {
    const alert = div({ style: { background: 'var(--warn-light)', border: '1.5px solid #f5cba0', borderRadius: 'var(--radius)', padding: '12px 14px', marginBottom: 16 } });
    alert.appendChild(div({ style: { fontWeight: 600, fontSize: 13, color: 'var(--warn)', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 } }, ico('bell', { style: { fontSize: 16 } }), "Today's Activity"));
    todayCheckins.forEach(b  => alert.appendChild(div({ style: { fontSize: 13, marginBottom: 4 } }, `🟢 ${b.guestName} checks in`)));
    todayCheckouts.forEach(b => alert.appendChild(div({ style: { fontSize: 13, marginBottom: 4 } }, `🔵 ${b.guestName} checks out`)));
    wrap.appendChild(alert);
  }

  // Recent bookings
  wrap.appendChild(div({ style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 } },
    h('div', { style: { fontFamily: 'Playfair Display', fontSize: 17 } }, dashMonth ? `Bookings in ${MONTH_SHORT[dashMonth.month]} ${dashMonth.year}` : 'All Bookings'),
    btn({ className: 'btn-ghost btn-sm', onClick: () => setState({ tab: 'bookings' }) }, 'See all')
  ));
  const recent = [...bookings].filter(b => b.status !== 'cancelled').sort((a, b) => new Date(b.checkIn) - new Date(a.checkIn)).slice(0, 4);
  if (recent.length === 0) {
    wrap.appendChild(div({ className: 'card', style: { padding: '24px', textAlign: 'center' } },
      div({ style: { color: 'var(--muted)', fontSize: 14, marginBottom: 12 } }, dashMonth ? 'No bookings this month' : 'No bookings yet'),
      btn({ className: 'btn-primary btn-sm', onClick: () => setState({ modal: 'addBooking', editItem: null }) }, 'Add Booking')
    ));
  } else {
    recent.forEach(b => wrap.appendChild(bookingCard(b)));
  }

  // Properties summary
  wrap.appendChild(h('div', { style: { fontFamily: 'Playfair Display', fontSize: 17, margin: '18px 0 10px' } }, 'Properties'));
  data.properties.forEach(p => {
    const propBks = data.bookings.filter(b => b.propertyId === p.id);
    const propRev = propBks.filter(b => b.status !== 'cancelled').reduce((s, b) => s + Number(b.totalAmount || 0), 0);
    wrap.appendChild(div({ className: 'card', style: { padding: '13px 14px', marginBottom: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
      div({},
        div({ style: { fontWeight: 600, fontSize: 15 } }, p.name),
        div({ style: { fontSize: 12, color: 'var(--muted)', marginTop: 3 } }, `${p.location || 'No location'} · ${p.rooms || 0} rooms · ${propBks.length} bookings`)
      ),
      div({ style: { textAlign: 'right', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 7 } },
        div({ style: { fontSize: 14, fontWeight: 700, color: 'var(--accent)' } }, fmtCur(propRev)),
        btn({ className: 'btn-danger btn-sm', style: { padding: '4px 9px' }, onClick: () => { if (confirm(`Delete "${p.name}" and all its data?`)) { mutateData(d => { d.properties = d.properties.filter(x => x.id !== p.id); d.bookings = d.bookings.filter(b => b.propertyId !== p.id); d.expenses = d.expenses.filter(e => e.propertyId !== p.id); }); } } },
          ico('trash', { style: { fontSize: 14 } })
        )
      )
    ));
  });
  wrap.appendChild(div({ style: { textAlign: 'center', marginTop: 20 } },
    btn({ className: 'btn-primary', onClick: () => setState({ modal: 'addBooking', editItem: null }) }, ico('plus', { style: { marginRight: 7 } }), 'New Booking')
  ));
  return wrap;
}

// ─── Bookings Tab ─────────────────────────────────────────────────────────────
function renderBookings() {
  const { data, filterProp, bookingFilter } = state;
  const all      = filterProp === 'all' ? data.bookings : data.bookings.filter(b => b.propertyId === filterProp);
  const filtered = bookingFilter === 'all' ? all : all.filter(b => b.status === bookingFilter);
  const sorted   = [...filtered].sort((a, b) => new Date(b.checkIn) - new Date(a.checkIn));
  const wrap = div({ style: { padding: '14px 12px 100px' } });
  wrap.appendChild(div({ style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 } },
    h('div', { style: { fontFamily: 'Playfair Display', fontSize: 20 } }, 'Bookings'),
    btn({ className: 'btn-primary btn-sm', onClick: () => setState({ modal: 'addBooking', editItem: null }) }, ico('plus', { style: { marginRight: 4 } }), 'Add')
  ));
  const chips = div({ style: { display: 'flex', gap: 6, marginBottom: 14, overflowX: 'auto', paddingBottom: 2, scrollbarWidth: 'none' } });
  [['all','All'],['confirmed','Confirmed'],['checkedin','In'],['checkedout','Out'],['cancelled','Cancelled']].forEach(([s, l]) => {
    chips.appendChild(btn({
      style: { padding: '5px 13px', borderRadius: 20, whiteSpace: 'nowrap', border: `1.5px solid ${bookingFilter === s ? 'var(--accent)' : 'var(--border)'}`, background: bookingFilter === s ? 'var(--accent-light)' : 'var(--white)', color: bookingFilter === s ? 'var(--accent)' : 'var(--muted)', fontSize: 13, fontWeight: bookingFilter === s ? 600 : 400 },
      onClick: () => setState({ bookingFilter: s })
    }, l));
  });
  wrap.appendChild(chips);
  if (sorted.length === 0) wrap.appendChild(div({ style: { textAlign: 'center', padding: '40px 20px', color: 'var(--muted)' } }, 'No bookings found'));
  else sorted.forEach(b => wrap.appendChild(bookingCard(b)));
  return wrap;
}

// ─── Expenses Tab ─────────────────────────────────────────────────────────────
function renderExpenses() {
  const { data, filterProp } = state;
  const expenses = (filterProp === 'all' ? data.expenses : data.expenses.filter(e => e.propertyId === filterProp)).sort((a, b) => new Date(b.date) - new Date(a.date));
  const total    = expenses.reduce((s, e) => s + Number(e.amount || 0), 0);
  const catEmoji = { maintenance: '🔧', utilities: '💡', supplies: '🛒', staff: '👤', marketing: '📣', other: '📦' };
  const wrap = div({ style: { padding: '14px 12px 100px' } });
  wrap.appendChild(div({ style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 } },
    h('div', { style: { fontFamily: 'Playfair Display', fontSize: 20 } }, 'Expenses'),
    btn({ className: 'btn-primary btn-sm', onClick: () => setState({ modal: 'addExpense', editItem: null }) }, ico('plus', { style: { marginRight: 4 } }), 'Add')
  ));
  wrap.appendChild(div({ className: 'card', style: { padding: '14px 16px', marginBottom: 14, display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
    div({}, div({ style: { fontSize: 12, color: 'var(--muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' } }, 'Total Expenses'), div({ style: { fontSize: 24, fontWeight: 700, color: 'var(--danger)', marginTop: 4 } }, fmtCur(total))),
    ico('receipt', { style: { fontSize: 32, color: 'var(--danger)', opacity: 0.2 } })
  ));
  if (expenses.length === 0) {
    wrap.appendChild(div({ style: { textAlign: 'center', padding: '40px 20px', color: 'var(--muted)' } }, 'No expenses logged yet'));
  } else {
    expenses.forEach(e => {
      const prop = data.properties.find(p => p.id === e.propertyId);
      const card = div({ className: 'card', style: { padding: '12px 14px', marginBottom: 9, display: 'flex', justifyContent: 'space-between', alignItems: 'center' } });
      card.appendChild(div({}, div({ style: { fontWeight: 600, fontSize: 15 } }, `${catEmoji[e.category] || '📦'} ${e.description}`), div({ style: { fontSize: 12, color: 'var(--muted)', marginTop: 3 } }, `${prop?.name || '—'} · ${fmtDate(e.date)} · ${e.category}`)));
      card.appendChild(div({ style: { textAlign: 'right', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 } },
        div({ style: { fontWeight: 700, color: 'var(--danger)', fontSize: 15 } }, fmtCur(e.amount)),
        div({ style: { display: 'flex', gap: 5 } },
          btn({ className: 'btn-ghost btn-sm', style: { padding: '4px 9px' }, onClick: () => setState({ modal: 'addExpense', editItem: e }) }, ico('edit', { style: { fontSize: 14 } })),
          btn({ className: 'btn-danger btn-sm', style: { padding: '4px 9px' }, onClick: () => { if (confirm('Delete this expense?')) mutateData(d => d.expenses = d.expenses.filter(x => x.id !== e.id)); } }, ico('trash', { style: { fontSize: 14 } }))
        )
      ));
      wrap.appendChild(card);
    });
  }
  return wrap;
}

// ─── Reports Tab ──────────────────────────────────────────────────────────────
function renderReports() {
  const { data, filterProp, reportMonth } = state;
  let bookings = filterProp === 'all' ? data.bookings : data.bookings.filter(b => b.propertyId === filterProp);
  let expenses = filterProp === 'all' ? data.expenses : data.expenses.filter(e => e.propertyId === filterProp);

  // Apply month filter
  bookings = filterByMonth(bookings, 'checkIn', reportMonth);
  expenses = filterByMonth(expenses, 'date', reportMonth);

  const yr = reportMonth ? reportMonth.year : new Date().getFullYear();
  const monthlyRev = Array(12).fill(0);
  const monthlyExp = Array(12).fill(0);
  bookings.filter(b => b.status !== 'cancelled' && new Date(b.checkIn).getFullYear() === yr)
    .forEach(b => monthlyRev[new Date(b.checkIn).getMonth()] += Number(b.totalAmount || 0));
  expenses.filter(e => new Date(e.date).getFullYear() === yr)
    .forEach(e => monthlyExp[new Date(e.date).getMonth()] += Number(e.amount || 0));
  const maxVal   = Math.max(...monthlyRev, ...monthlyExp, 1);
  const totalRev = monthlyRev.reduce((a, b) => a + b, 0);
  const totalExp = monthlyExp.reduce((a, b) => a + b, 0);

  const periodLabel = reportMonth ? `${MONTH_NAMES[reportMonth.month]} ${reportMonth.year}` : `${yr} — All`;

  const wrap = div({ style: { padding: '14px 12px 100px' } });

  // Header row with month selector + download button
  wrap.appendChild(div({ style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 } },
    h('div', { style: { fontFamily: 'Playfair Display', fontSize: 20 } }, 'Reports'),
    div({ style: { display: 'flex', alignItems: 'center', gap: 8 } },
      monthSelector(reportMonth, m => setState({ reportMonth: m })),
      btn({
        title: 'Download report',
        style: { background: 'var(--accent-light)', border: '1.5px solid var(--accent)', color: 'var(--accent)', borderRadius: 'var(--radius-sm)', padding: '7px 10px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5, fontSize: 13, fontWeight: 600 },
        onClick: () => downloadReport(bookings, expenses, periodLabel)
      }, ico('file-spreadsheet', { style: { fontSize: 16 } }), 'CSV')
    )
  ));

  // Summary cards
  const summaryGrid = div({ style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 16 } });
  [
    { label: 'Revenue',    val: fmtCur(totalRev), col: 'var(--accent)' },
    { label: 'Expenses',   val: fmtCur(totalExp), col: 'var(--danger)' },
    { label: 'Net Profit', val: fmtCur(totalRev - totalExp), col: totalRev - totalExp >= 0 ? 'var(--accent)' : 'var(--danger)' },
    { label: 'Bookings',   val: bookings.filter(b => b.status !== 'cancelled').length, col: 'var(--info)' },
  ].forEach(s => {
    summaryGrid.appendChild(div({ className: 'card', style: { padding: '14px' } },
      div({ style: { fontSize: 11, color: 'var(--muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 } }, s.label),
      div({ style: { fontSize: 22, fontWeight: 700, color: s.col } }, String(s.val))
    ));
  });
  wrap.appendChild(summaryGrid);

  // Bar chart (only when showing full year / all-time)
  if (!reportMonth) {
    const chartCard = div({ className: 'card', style: { padding: '16px', marginBottom: 14 } });
    chartCard.appendChild(div({ style: { fontWeight: 600, fontSize: 14, marginBottom: 14 } }, `Monthly Overview · ${yr}`));
    const bars = div({ style: { display: 'flex', alignItems: 'flex-end', gap: 4, height: 100 } });
    MONTH_SHORT.forEach((m, i) => {
      const col    = div({ style: { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 } });
      const barW   = div({ style: { width: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', gap: 2, height: 80 } });
      const revH   = Math.max(2, (monthlyRev[i] / maxVal) * 78);
      const expH   = Math.max(0, (monthlyExp[i] / maxVal) * 78);
      barW.appendChild(div({ style: { width: '70%', margin: '0 auto', background: 'var(--accent)', borderRadius: '3px 3px 0 0', height: revH + 'px', opacity: 0.85 } }));
      if (expH > 0) barW.appendChild(div({ style: { width: '70%', margin: '0 auto', background: 'var(--danger)', borderRadius: '3px 3px 0 0', height: expH + 'px', opacity: 0.65 } }));
      col.appendChild(barW);
      col.appendChild(div({ style: { fontSize: 9, color: 'var(--muted)', marginTop: 4 } }, m));
      bars.appendChild(col);
    });
    chartCard.appendChild(bars);
    chartCard.appendChild(div({ style: { display: 'flex', gap: 16, marginTop: 10, fontSize: 12 } },
      div({ style: { display: 'flex', alignItems: 'center', gap: 5 } }, div({ style: { width: 10, height: 10, background: 'var(--accent)', borderRadius: 2 } }), 'Revenue'),
      div({ style: { display: 'flex', alignItems: 'center', gap: 5 } }, div({ style: { width: 10, height: 10, background: 'var(--danger)', borderRadius: 2 } }), 'Expenses')
    ));
    wrap.appendChild(chartCard);
  }

  // Property performance
  const perfCard = div({ className: 'card', style: { padding: '16px', marginBottom: 14 } });
  perfCard.appendChild(div({ style: { fontWeight: 600, fontSize: 14, marginBottom: 12 } }, 'Property Performance'));
  if (data.properties.length === 0) {
    perfCard.appendChild(div({ style: { color: 'var(--muted)', fontSize: 13 } }, 'No properties yet'));
  } else {
    data.properties.forEach((p, i) => {
      const bks    = bookings.filter(b => b.propertyId === p.id && b.status !== 'cancelled');
      const rev    = bks.reduce((s, b) => s + Number(b.totalAmount || 0), 0);
      const nights = bks.reduce((s, b) => s + diffDays(b.checkIn, b.checkOut), 0);
      const row    = div({ style: { paddingBottom: i < data.properties.length - 1 ? 12 : 0, marginBottom: i < data.properties.length - 1 ? 12 : 0, borderBottom: i < data.properties.length - 1 ? '1px solid var(--border-soft)' : 'none' } });
      row.appendChild(div({ style: { display: 'flex', justifyContent: 'space-between', marginBottom: 4 } }, div({ style: { fontWeight: 600, fontSize: 14 } }, p.name), div({ style: { fontWeight: 700, color: 'var(--accent)', fontSize: 14 } }, fmtCur(rev))));
      row.appendChild(div({ style: { fontSize: 12, color: 'var(--muted)' } }, `${bks.length} bookings · ${nights} nights`));
      perfCard.appendChild(row);
    });
  }
  wrap.appendChild(perfCard);

  // Revenue by source
  const bySource = {};
  bookings.filter(b => b.status !== 'cancelled').forEach(b => { const s = b.source || 'Direct'; bySource[s] = (bySource[s] || 0) + Number(b.totalAmount || 0); });
  if (Object.keys(bySource).length > 0) {
    const srcCard  = div({ className: 'card', style: { padding: '16px', marginBottom: 14 } });
    const srcTotal = Object.values(bySource).reduce((a, b) => a + b, 0);
    srcCard.appendChild(div({ style: { fontWeight: 600, fontSize: 14, marginBottom: 12 } }, 'Revenue by Source'));
    Object.entries(bySource).sort((a, b) => b[1] - a[1]).forEach(([s, v]) => {
      const pct = srcTotal > 0 ? Math.round(v / srcTotal * 100) : 0;
      srcCard.appendChild(div({ style: { marginBottom: 10 } },
        div({ style: { display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 5 } }, div({ style: { color: 'var(--text-mid)', fontWeight: 500 } }, s), span({ style: { fontWeight: 600 } }, `${fmtCur(v)} (${pct}%)`)),
        div({ style: { height: 5, background: 'var(--border)', borderRadius: 10, overflow: 'hidden' } }, div({ style: { height: '100%', width: pct + '%', background: 'var(--accent)', borderRadius: 10, transition: 'width .4s' } }))
      ));
    });
    wrap.appendChild(srcCard);
  }

  // Expense breakdown by category
  const byCat = {};
  expenses.forEach(e => { byCat[e.category] = (byCat[e.category] || 0) + Number(e.amount || 0); });
  if (Object.keys(byCat).length > 0) {
    const catCard  = div({ className: 'card', style: { padding: '16px' } });
    const catTotal = Object.values(byCat).reduce((a, b) => a + b, 0);
    catCard.appendChild(div({ style: { fontWeight: 600, fontSize: 14, marginBottom: 12 } }, 'Expenses by Category'));
    const catEmoji = { maintenance: '🔧', utilities: '💡', supplies: '🛒', staff: '👤', marketing: '📣', other: '📦' };
    Object.entries(byCat).sort((a, b) => b[1] - a[1]).forEach(([c, v]) => {
      const pct = catTotal > 0 ? Math.round(v / catTotal * 100) : 0;
      catCard.appendChild(div({ style: { marginBottom: 10 } },
        div({ style: { display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 5 } }, div({ style: { color: 'var(--text-mid)', fontWeight: 500 } }, `${catEmoji[c] || '📦'} ${c}`), span({ style: { fontWeight: 600, color: 'var(--danger)' } }, `${fmtCur(v)} (${pct}%)`)),
        div({ style: { height: 5, background: 'var(--border)', borderRadius: 10, overflow: 'hidden' } }, div({ style: { height: '100%', width: pct + '%', background: 'var(--danger)', opacity: 0.7, borderRadius: 10 } }))
      ));
    });
    wrap.appendChild(catCard);
  }

  return wrap;
}

// ─── CSV Report Download ──────────────────────────────────────────────────────
function downloadReport(bookings, expenses, periodLabel) {
  const { data } = state;
  const propName = pid => data.properties.find(p => p.id === pid)?.name || '—';
  const esc = s => `"${String(s || '').replace(/"/g, '""')}"`;

  let csv = '';

  // Period info
  csv += `StayLog Report,${esc(periodLabel)}\n`;
  csv += `Generated,${esc(new Date().toLocaleString('en-IN'))}\n\n`;

  // Summary
  const totalRev = bookings.filter(b => b.status !== 'cancelled').reduce((s, b) => s + Number(b.totalAmount || 0), 0);
  const totalExp = expenses.reduce((s, e) => s + Number(e.amount || 0), 0);
  csv += 'SUMMARY\n';
  csv += `Total Revenue,${totalRev}\n`;
  csv += `Total Expenses,${totalExp}\n`;
  csv += `Net Profit,${totalRev - totalExp}\n\n`;

  // Income details
  csv += 'INCOME DETAILS\n';
  csv += 'Date,Guest Name,Property,Check-in,Check-out,Nights,Guests,Source,Total Amount,Amount Paid,Balance Due,Status\n';
  [...bookings].filter(b => b.status !== 'cancelled').sort((a, b) => new Date(a.checkIn) - new Date(b.checkIn)).forEach(b => {
    const nights = diffDays(b.checkIn, b.checkOut);
    const due    = Number(b.totalAmount || 0) - Number(b.paid || 0);
    csv += [
      esc(b.checkIn),
      esc(b.guestName),
      esc(propName(b.propertyId)),
      esc(fmtDate(b.checkIn)),
      esc(fmtDate(b.checkOut)),
      nights,
      b.guests || 1,
      esc(b.source || 'Direct'),
      Number(b.totalAmount || 0),
      Number(b.paid || 0),
      due,
      esc(b.status)
    ].join(',') + '\n';
  });

  csv += '\nEXPENDITURE DETAILS\n';
  csv += 'Date,Description,Property,Category,Amount,Notes\n';
  [...expenses].sort((a, b) => new Date(a.date) - new Date(b.date)).forEach(e => {
    csv += [
      esc(e.date),
      esc(e.description),
      esc(propName(e.propertyId)),
      esc(e.category),
      Number(e.amount || 0),
      esc(e.notes || '')
    ].join(',') + '\n';
  });

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const a    = document.createElement('a');
  a.href     = URL.createObjectURL(blob);
  a.download = `staylog-report-${periodLabel.replace(/\s/g, '-')}.csv`;
  a.click();
}

// ─── Modals ───────────────────────────────────────────────────────────────────
function renderPropertyModal() {
  const f = { name: '', location: '', rooms: '', pricePerNight: '', description: '' };
  const content = () => {
    const wrap = div({ style: { display: 'flex', flexDirection: 'column', gap: 11 } });
    [['name','Property name *','text'],['location','Location / Address','text'],['rooms','Number of rooms','number'],['pricePerNight','Base price per night (₹)','number']].forEach(([k, ph, t]) => {
      const inp = h('input', { type: t, placeholder: ph, value: f[k] || '' });
      inp.addEventListener('input', e => f[k] = e.target.value);
      wrap.appendChild(inp);
    });
    const ta = h('textarea', { placeholder: 'Notes / description', rows: 2, style: { resize: 'none' } });
    ta.addEventListener('input', e => f.description = e.target.value);
    wrap.appendChild(ta);
    wrap.appendChild(btn({ className: 'btn-primary', style: { marginTop: 4, width: '100%' }, onClick: () => { if (!f.name) return; mutateData(d => d.properties.push({ ...f, id: uid() })); closeModal(); } }, 'Save Property'));
    return wrap;
  };
  return modal('Add Property', content);
}

function renderBookingModal() {
  const { data, editItem } = state;
  const isEdit = !!editItem;
  const f = isEdit ? { ...editItem } : { propertyId: data.properties[0]?.id || '', guestName: '', phone: '', checkIn: '', checkOut: '', guests: 1, totalAmount: '', paid: '', source: 'Direct', status: 'confirmed', notes: '' };
  const content = () => {
    const wrap = div({ style: { display: 'flex', flexDirection: 'column', gap: 11 } });
    const propSel = h('select');
    data.properties.forEach(p => propSel.appendChild(h('option', { value: p.id, selected: f.propertyId === p.id }, p.name)));
    propSel.addEventListener('change', e => { f.propertyId = e.target.value; autoCalc(); });
    wrap.appendChild(propSel);
    const guestInp = h('input', { type: 'text', placeholder: 'Guest name *', value: f.guestName || '' });
    guestInp.addEventListener('input', e => f.guestName = e.target.value);
    wrap.appendChild(guestInp);
    const phoneInp = h('input', { type: 'tel', placeholder: 'Phone number', value: f.phone || '' });
    phoneInp.addEventListener('input', e => f.phone = e.target.value);
    wrap.appendChild(phoneInp);
    const datesRow = div({ style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 } });
    const ciWrap = div({}, div({ className: 'label' }, 'Check-in'));
    const ciInp  = h('input', { type: 'date', value: f.checkIn || '' });
    ciInp.addEventListener('change', e => { f.checkIn = e.target.value; autoCalc(); });
    ciWrap.appendChild(ciInp);
    const coWrap = div({}, div({ className: 'label' }, 'Check-out'));
    const coInp  = h('input', { type: 'date', value: f.checkOut || '' });
    coInp.addEventListener('change', e => { f.checkOut = e.target.value; autoCalc(); });
    coWrap.appendChild(coInp);
    datesRow.appendChild(ciWrap); datesRow.appendChild(coWrap);
    wrap.appendChild(datesRow);
    const nightsInfo = div({ style: { fontSize: 13, color: 'var(--accent)', fontWeight: 500, minHeight: 18 } });
    wrap.appendChild(nightsInfo);
    const amtRow = div({ style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 } });
    const amtInp  = h('input', { type: 'number', placeholder: 'Total (₹)', value: f.totalAmount || '' });
    amtInp.addEventListener('input', e => f.totalAmount = e.target.value);
    const paidInp = h('input', { type: 'number', placeholder: 'Paid (₹)', value: f.paid || '' });
    paidInp.addEventListener('input', e => f.paid = e.target.value);
    amtRow.appendChild(amtInp); amtRow.appendChild(paidInp);
    wrap.appendChild(amtRow);
    function autoCalc() {
      if (f.checkIn && f.checkOut && !isEdit) {
        const n = diffDays(f.checkIn, f.checkOut);
        const prop = data.properties.find(p => p.id === f.propertyId);
        if (n > 0 && prop?.pricePerNight) { const s = n * Number(prop.pricePerNight); f.totalAmount = s; amtInp.value = s; nightsInfo.textContent = `${n} nights · Suggested: ₹${s.toLocaleString('en-IN')}`; }
        else if (n > 0) nightsInfo.textContent = `${n} nights`;
      }
    }
    const guestsInp = h('input', { type: 'number', placeholder: 'No. of guests', value: f.guests || 1 });
    guestsInp.addEventListener('input', e => f.guests = e.target.value);
    wrap.appendChild(guestsInp);
    const srcSel = h('select');
    ['Direct','Airbnb','Booking.com','MakeMyTrip','Goibibo','OYO','Other'].forEach(s => srcSel.appendChild(h('option', { value: s, selected: f.source === s }, s)));
    srcSel.addEventListener('change', e => f.source = e.target.value);
    wrap.appendChild(srcSel);
    const stSel = h('select');
    [['confirmed','Confirmed'],['checkedin','Checked In'],['checkedout','Checked Out'],['cancelled','Cancelled']].forEach(([v, l]) => stSel.appendChild(h('option', { value: v, selected: f.status === v }, l)));
    stSel.addEventListener('change', e => f.status = e.target.value);
    wrap.appendChild(stSel);
    const notesTA = h('textarea', { placeholder: 'Notes (optional)', rows: 2, style: { resize: 'none' } });
    notesTA.textContent = f.notes || '';
    notesTA.addEventListener('input', e => f.notes = e.target.value);
    wrap.appendChild(notesTA);
    wrap.appendChild(btn({ className: 'btn-primary', style: { marginTop: 4, width: '100%' }, onClick: () => { if (!f.guestName || !f.checkIn || !f.checkOut || !f.propertyId) return; mutateData(d => { if (isEdit) d.bookings = d.bookings.map(b => b.id === f.id ? f : b); else d.bookings.push({ ...f, id: uid() }); }); closeModal(); } }, isEdit ? 'Update Booking' : 'Add Booking'));
    return wrap;
  };
  return modal(isEdit ? 'Edit Booking' : 'New Booking', content);
}

function renderExpenseModal() {
  const { data, editItem } = state;
  const isEdit = !!editItem;
  const f = isEdit ? { ...editItem } : { propertyId: data.properties[0]?.id || '', description: '', amount: '', date: today(), category: 'maintenance', notes: '' };
  const content = () => {
    const wrap = div({ style: { display: 'flex', flexDirection: 'column', gap: 11 } });
    const propSel = h('select');
    data.properties.forEach(p => propSel.appendChild(h('option', { value: p.id, selected: f.propertyId === p.id }, p.name)));
    propSel.addEventListener('change', e => f.propertyId = e.target.value);
    wrap.appendChild(propSel);
    const descInp = h('input', { type: 'text', placeholder: 'Description *', value: f.description || '' });
    descInp.addEventListener('input', e => f.description = e.target.value);
    wrap.appendChild(descInp);
    const amtInp = h('input', { type: 'number', placeholder: 'Amount (₹) *', value: f.amount || '' });
    amtInp.addEventListener('input', e => f.amount = e.target.value);
    wrap.appendChild(amtInp);
    const dateWrap = div({}, div({ className: 'label' }, 'Date'));
    const dateInp  = h('input', { type: 'date', value: f.date || today() });
    dateInp.addEventListener('change', e => f.date = e.target.value);
    dateWrap.appendChild(dateInp);
    wrap.appendChild(dateWrap);
    const catSel = h('select');
    [['maintenance','🔧 Maintenance'],['utilities','💡 Utilities'],['supplies','🛒 Supplies'],['staff','👤 Staff'],['marketing','📣 Marketing'],['other','📦 Other']].forEach(([v, l]) => catSel.appendChild(h('option', { value: v, selected: f.category === v }, l)));
    catSel.addEventListener('change', e => f.category = e.target.value);
    wrap.appendChild(catSel);
    const notesTA = h('textarea', { placeholder: 'Notes (optional)', rows: 2, style: { resize: 'none' } });
    notesTA.textContent = f.notes || '';
    notesTA.addEventListener('input', e => f.notes = e.target.value);
    wrap.appendChild(notesTA);
    wrap.appendChild(btn({ className: 'btn-primary', style: { marginTop: 4, width: '100%' }, onClick: () => { if (!f.description || !f.amount || !f.propertyId) return; mutateData(d => { if (isEdit) d.expenses = d.expenses.map(e => e.id === f.id ? f : e); else d.expenses.push({ ...f, id: uid() }); }); closeModal(); } }, isEdit ? 'Update Expense' : 'Add Expense'));
    return wrap;
  };
  return modal(isEdit ? 'Edit Expense' : 'New Expense', content);
}

// ─── Actions ─────────────────────────────────────────────────────────────────
function updateStatus(id, status) {
  mutateData(d => d.bookings = d.bookings.map(b => b.id === id ? { ...b, status } : b));
}

// ─── Main Render ──────────────────────────────────────────────────────────────
let currentModal = null;

function render() {
  const app = document.getElementById('app');

  // Loading screen
  if (state._loading) {
    app.innerHTML = '';
    app.appendChild(div({ style: { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100vh', gap: 16 } },
      h('div', { style: { fontFamily: 'Playfair Display', fontSize: 28, color: 'var(--accent)' } }, 'StayLog'),
      h('div', { style: { fontSize: 13, color: 'var(--muted)' } }, 'Loading your data…')
    ));
    return;
  }

  // Login screen (handled separately — full page replace)
  if (!state.loggedIn) {
    renderLoginScreen();
    return;
  }

  // Main app
  app.innerHTML = '';
  app.appendChild(renderHeader());
  const main = div({ style: { flex: 1 } });
  if (state.tab === 'dashboard') main.appendChild(renderDashboard());
  else if (state.tab === 'bookings') main.appendChild(renderBookings());
  else if (state.tab === 'expenses') main.appendChild(renderExpenses());
  else if (state.tab === 'reports')  main.appendChild(renderReports());
  app.appendChild(main);
  app.appendChild(renderNav());

  // Modals
  if (currentModal && currentModal.parentNode) currentModal.parentNode.removeChild(currentModal);
  currentModal = null;
  if (state.modal === 'addProp')    { currentModal = renderPropertyModal(); document.body.appendChild(currentModal); }
  else if (state.modal === 'addBooking')  { currentModal = renderBookingModal();  document.body.appendChild(currentModal); }
  else if (state.modal === 'addExpense') { currentModal = renderExpenseModal();  document.body.appendChild(currentModal); }
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
render(); // loading spinner

Promise.all([loadDataFromIDB(), loadAuth()]).then(([data, auth]) => {
  state.data     = data;
  state.auth     = auth;
  state.loggedIn = false;
  state._loading = false;
  render(); // shows login screen
});
