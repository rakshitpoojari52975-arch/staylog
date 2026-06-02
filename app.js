/* StayLog — Homestay Manager App
   Vanilla JS, no build step, works offline on iPhone via PWA */

'use strict';

// ─── Storage ──────────────────────────────────────────────────────────────────
const STORAGE_KEY = 'staylog_v2';
const defaultData = { properties: [], bookings: [], expenses: [] };

function loadData() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || defaultData; }
  catch { return defaultData; }
}
function saveData(d) { localStorage.setItem(STORAGE_KEY, JSON.stringify(d)); }
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2); }

// ─── Formatters ──────────────────────────────────────────────────────────────
const fmtDate = s => s ? new Date(s + 'T00:00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
const fmtCur = n => '₹' + Number(n || 0).toLocaleString('en-IN');
const diffDays = (a, b) => Math.max(0, Math.ceil((new Date(b) - new Date(a)) / 86400000));
const today = () => new Date().toISOString().split('T')[0];

// ─── State ───────────────────────────────────────────────────────────────────
let state = {
  data: loadData(),
  tab: 'dashboard',
  modal: null,
  editItem: null,
  filterProp: 'all',
  bookingFilter: 'all',
  expandedBooking: null,
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
const div = (attrs, ...c) => h('div', attrs, ...c);
const span = (attrs, ...c) => h('span', attrs, ...c);
const btn = (attrs, ...c) => h('button', attrs, ...c);
const ico = (name, extra = {}) => h('i', { className: `ti ti-${name}`, 'aria-hidden': 'true', ...extra });

// ─── Badge ────────────────────────────────────────────────────────────────────
const STATUS_META = {
  confirmed:  { label: 'Confirmed',   bg: '#e8f4ef', color: '#1b5e38' },
  checkedin:  { label: 'Checked In',  bg: '#e8f0fb', color: '#0d47a1' },
  checkedout: { label: 'Checked Out', bg: '#f0f0ee', color: '#5a5a58' },
  cancelled:  { label: 'Cancelled',   bg: '#fdeaea', color: '#c62828' },
};

function badge(status) {
  const m = STATUS_META[status] || { label: status, bg: '#f0f0f0', color: '#555' };
  return span({ style: { background: m.bg, color: m.color, borderRadius: 20, padding: '4px 11px', fontSize: 12, fontWeight: 600, letterSpacing: '0.01em' } }, m.label);
}

// ─── Modal ────────────────────────────────────────────────────────────────────
function modal(title, contentFn) {
  const overlay = div({
    style: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 999, display: 'flex', alignItems: 'flex-end', justifyContent: 'center', backdropFilter: 'blur(2px)' },
    onClick: e => { if (e.target === overlay) closeModal(); }
  });
  const sheet = div({
    style: { background: 'var(--white)', borderRadius: '22px 22px 0 0', padding: '20px 16px env(safe-area-inset-bottom, 24px)', width: '100%', maxWidth: 480, maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 -4px 24px rgba(0,0,0,0.12)' }
  });
  const header = div({ style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 } },
    h('span', { style: { fontFamily: 'Playfair Display', fontSize: 20, fontWeight: 500 } }, title),
    btn({ style: { background: 'none', border: 'none', fontSize: 24, color: '#aaa', cursor: 'pointer', padding: '2px 8px', lineHeight: 1 }, onClick: closeModal }, '×')
  );
  sheet.appendChild(header);
  sheet.appendChild(contentFn());
  overlay.appendChild(sheet);
  // Animate in
  sheet.style.transform = 'translateY(100%)';
  requestAnimationFrame(() => {
    sheet.style.transition = 'transform .28s cubic-bezier(.32,.72,0,1)';
    sheet.style.transform = 'translateY(0)';
  });
  return overlay;
}

function closeModal() {
  setState({ modal: null, editItem: null });
}

// ─── Prop Filter Chips ────────────────────────────────────────────────────────
function propFilterChips() {
  const { data, filterProp } = state;
  if (data.properties.length < 2) return null;
  const row = div({ style: { display: 'flex', gap: 6, marginTop: 10, overflowX: 'auto', paddingBottom: 2, scrollbarWidth: 'none' } });
  const chip = (id, label) => btn({
    style: {
      padding: '5px 14px', borderRadius: 20, whiteSpace: 'nowrap',
      border: `1.5px solid ${filterProp === id ? 'var(--accent)' : 'var(--border)'}`,
      background: filterProp === id ? 'var(--accent-light)' : 'var(--white)',
      color: filterProp === id ? 'var(--accent)' : 'var(--muted)',
      fontSize: 13, fontWeight: filterProp === id ? 600 : 400,
    },
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
    h('div', { style: { fontSize: 12, color: 'var(--muted)', marginTop: 1 } }, `${data.properties.length} ${data.properties.length === 1 ? 'property' : 'properties'} · ${data.bookings.length} bookings`)
  );
  const addBtn = btn({ className: 'btn-primary btn-sm', onClick: () => setState({ modal: 'addProp', editItem: null }) },
    ico('plus', { style: { marginRight: 5 } }), 'Property'
  );
  top.appendChild(brand);
  top.appendChild(addBtn);
  header.appendChild(top);
  const chips = propFilterChips();
  if (chips) header.appendChild(chips);
  return header;
}

// ─── Bottom Nav ───────────────────────────────────────────────────────────────
function renderNav() {
  const tabs = [
    ['dashboard', 'home', 'Home'],
    ['bookings', 'calendar', 'Bookings'],
    ['expenses', 'receipt', 'Expenses'],
    ['reports', 'chart-bar', 'Reports'],
  ];
  const nav = div({
    style: { position: 'fixed', bottom: 0, left: '50%', transform: 'translateX(-50%)', width: '100%', maxWidth: 480, background: 'var(--white)', borderTop: '1px solid var(--border)', display: 'flex', zIndex: 100, paddingBottom: 'env(safe-area-inset-bottom, 0)' }
  });
  tabs.forEach(([t, icon, label]) => {
    const active = state.tab === t;
    const tb = btn({
      style: { flex: 1, padding: '10px 4px 8px', background: 'none', border: 'none', fontSize: 11, fontWeight: active ? 600 : 400, color: active ? 'var(--accent)' : 'var(--muted)', cursor: 'pointer', borderTop: active ? '2.5px solid var(--accent)' : '2.5px solid transparent', transition: 'all .15s' },
      onClick: () => setState({ tab: t })
    },
      ico(icon, { style: { fontSize: 22, display: 'block', marginBottom: 3 } }),
      label
    );
    nav.appendChild(tb);
  });
  return nav;
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
  summary.appendChild(
    div({ style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' } },
      div({},
        div({ style: { fontWeight: 600, fontSize: 15 } }, b.guestName),
        div({ style: { fontSize: 12, color: 'var(--muted)', marginTop: 3, display: 'flex', alignItems: 'center', gap: 6 } },
          ico('home', { style: { fontSize: 13 } }),
          prop?.name || '—',
          span({ style: { color: 'var(--border)' } }, '·'),
          `${nights} nights`
        )
      ),
      div({ style: { textAlign: 'right' } },
        badge(b.status),
        div({ style: { fontSize: 15, fontWeight: 700, color: 'var(--accent)', marginTop: 5 } }, fmtCur(total))
      )
    )
  );
  summary.appendChild(
    div({ style: { fontSize: 12, color: 'var(--muted)', marginTop: 7, display: 'flex', alignItems: 'center', gap: 5 } },
      ico('calendar', { style: { fontSize: 13 } }),
      fmtDate(b.checkIn), '→', fmtDate(b.checkOut)
    )
  );
  card.appendChild(summary);

  if (isExpanded) {
    const detail = div({ style: { borderTop: '1px solid var(--border-soft)', padding: '12px 14px 14px', background: '#fafaf8', borderRadius: '0 0 var(--radius) var(--radius)' } });

    const infoRow = (icon, text) => text ? div({ style: { fontSize: 13, color: 'var(--text-mid)', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 8 } }, ico(icon, { style: { fontSize: 15, color: 'var(--light)' } }), text) : null;

    [
      infoRow('phone', b.phone),
      infoRow('users', b.guests ? `${b.guests} guest${b.guests > 1 ? 's' : ''}` : null),
      infoRow('link', b.source),
      infoRow('currency-rupee', paid > 0 ? `Paid: ${fmtCur(paid)} · ${due > 0 ? 'Due: ' + fmtCur(due) : 'Fully paid'}` : null),
    ].forEach(row => row && detail.appendChild(row));

    if (b.notes) {
      detail.appendChild(div({ style: { fontSize: 13, color: 'var(--muted)', fontStyle: 'italic', margin: '6px 0 10px', lineHeight: 1.5, background: 'var(--white)', padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)' } }, `"${b.notes}"`));
    }

    const actions = div({ style: { display: 'flex', gap: 7, flexWrap: 'wrap', marginTop: 8 } });
    if (b.status === 'confirmed') actions.appendChild(btn({ className: 'btn-primary btn-sm', onClick: () => { updateStatus(b.id, 'checkedin'); } }, ico('door-enter', { style: { marginRight: 5 } }), 'Check In'));
    if (b.status === 'checkedin') actions.appendChild(btn({ className: 'btn-primary btn-sm', onClick: () => { updateStatus(b.id, 'checkedout'); } }, ico('door-exit', { style: { marginRight: 5 } }), 'Check Out'));
    if (b.status !== 'cancelled' && b.status !== 'checkedout') actions.appendChild(btn({ className: 'btn-ghost btn-sm', onClick: () => { updateStatus(b.id, 'cancelled'); } }, 'Cancel'));
    actions.appendChild(btn({ className: 'btn-ghost btn-sm', onClick: () => setState({ modal: 'addBooking', editItem: b }) }, ico('edit', { style: { marginRight: 4 } }), 'Edit'));
    actions.appendChild(btn({ className: 'btn-danger btn-sm', onClick: () => { if (confirm('Delete this booking?')) { mutateData(d => d.bookings = d.bookings.filter(x => x.id !== b.id)); setState({ expandedBooking: null }); } } }, ico('trash', { style: { marginRight: 4 } }), 'Delete'));

    detail.appendChild(actions);
    card.appendChild(detail);
  }

  return card;
}

// ─── Dashboard ────────────────────────────────────────────────────────────────
function renderDashboard() {
  const { data, filterProp } = state;
  const bookings = filterProp === 'all' ? data.bookings : data.bookings.filter(b => b.propertyId === filterProp);
  const expenses = filterProp === 'all' ? data.expenses : data.expenses.filter(e => e.propertyId === filterProp);

  const totalRevenue = bookings.filter(b => b.status !== 'cancelled').reduce((s, b) => s + Number(b.totalAmount || 0), 0);
  const totalExpenses = expenses.reduce((s, e) => s + Number(e.amount || 0), 0);
  const net = totalRevenue - totalExpenses;
  const activeBookings = bookings.filter(b => b.status === 'checkedin').length;
  const upcomingBookings = bookings.filter(b => b.status === 'confirmed').length;

  const t = today();
  const todayCheckins = bookings.filter(b => b.checkIn === t && b.status === 'confirmed');
  const todayCheckouts = bookings.filter(b => b.checkOut === t && b.status === 'checkedin');

  const wrap = div({ style: { padding: '14px 12px 100px' } });

  if (data.properties.length === 0) {
    wrap.appendChild(div({ style: { textAlign: 'center', padding: '70px 20px' } },
      ico('home', { style: { fontSize: 52, color: 'var(--light)', display: 'block', marginBottom: 16 } }),
      h('div', { style: { fontFamily: 'Playfair Display', fontSize: 22, color: 'var(--text)', marginBottom: 8 } }, 'Welcome to StayLog'),
      h('div', { style: { color: 'var(--muted)', fontSize: 14, marginBottom: 24, lineHeight: 1.6 } }, 'Your personal homestay manager.\nAdd a property to get started.'),
      btn({ className: 'btn-primary', onClick: () => setState({ modal: 'addProp' }) }, ico('plus', { style: { marginRight: 6 } }), 'Add First Property')
    ));
    return wrap;
  }

  // Stats grid
  const stats = [
    { label: 'Revenue', val: fmtCur(totalRevenue), icon: 'currency-rupee', bg: 'var(--accent-light)', col: 'var(--accent)' },
    { label: 'Net Profit', val: fmtCur(net), icon: 'trending-up', bg: net >= 0 ? 'var(--accent-light)' : 'var(--danger-light)', col: net >= 0 ? 'var(--accent)' : 'var(--danger)' },
    { label: 'Checked In', val: activeBookings, icon: 'door-enter', bg: 'var(--info-light)', col: 'var(--info)' },
    { label: 'Upcoming', val: upcomingBookings, icon: 'calendar-event', bg: 'var(--gold-light)', col: 'var(--gold)' },
  ];
  const grid = div({ style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 16 } });
  stats.forEach(s => {
    grid.appendChild(div({ className: 'card', style: { padding: '14px' } },
      div({ style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 } },
        div({ style: { fontSize: 11, color: 'var(--muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' } }, s.label),
        div({ style: { background: s.bg, borderRadius: 8, padding: '5px 7px' } }, ico(s.icon, { style: { fontSize: 17, color: s.col } }))
      ),
      div({ style: { fontSize: 23, fontWeight: 700, color: 'var(--text)', letterSpacing: '-0.02em' } }, String(s.val))
    ));
  });
  wrap.appendChild(grid);

  // Today alert
  if (todayCheckins.length > 0 || todayCheckouts.length > 0) {
    const alert = div({ style: { background: 'var(--warn-light)', border: '1.5px solid #f5cba0', borderRadius: 'var(--radius)', padding: '12px 14px', marginBottom: 16 } });
    alert.appendChild(div({ style: { fontWeight: 600, fontSize: 13, color: 'var(--warn)', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 } }, ico('bell', { style: { fontSize: 16 } }), "Today's Activity"));
    todayCheckins.forEach(b => alert.appendChild(div({ style: { fontSize: 13, marginBottom: 4 } }, `🟢 ${b.guestName} checks in`)));
    todayCheckouts.forEach(b => alert.appendChild(div({ style: { fontSize: 13, marginBottom: 4 } }, `🔵 ${b.guestName} checks out`)));
    wrap.appendChild(alert);
  }

  // Recent bookings
  const recentHeader = div({ style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 } },
    h('div', { style: { fontFamily: 'Playfair Display', fontSize: 17 } }, 'Recent Bookings'),
    btn({ className: 'btn-ghost btn-sm', onClick: () => setState({ tab: 'bookings' }) }, 'See all')
  );
  wrap.appendChild(recentHeader);

  const recent = [...bookings].sort((a, b) => new Date(b.checkIn) - new Date(a.checkIn)).slice(0, 4);
  if (recent.length === 0) {
    wrap.appendChild(div({ className: 'card', style: { padding: '24px', textAlign: 'center' } },
      div({ style: { color: 'var(--muted)', fontSize: 14, marginBottom: 12 } }, 'No bookings yet'),
      btn({ className: 'btn-primary btn-sm', onClick: () => setState({ modal: 'addBooking', editItem: null }) }, 'Add First Booking')
    ));
  } else {
    recent.forEach(b => wrap.appendChild(bookingCard(b)));
  }

  // Properties summary
  wrap.appendChild(h('div', { style: { fontFamily: 'Playfair Display', fontSize: 17, margin: '18px 0 10px' } }, 'Properties'));
  data.properties.forEach(p => {
    const propRev = data.bookings.filter(b => b.propertyId === p.id && b.status !== 'cancelled').reduce((s, b) => s + Number(b.totalAmount || 0), 0);
    const propBookings = data.bookings.filter(b => b.propertyId === p.id).length;
    wrap.appendChild(div({ className: 'card', style: { padding: '13px 14px', marginBottom: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
      div({},
        div({ style: { fontWeight: 600, fontSize: 15 } }, p.name),
        div({ style: { fontSize: 12, color: 'var(--muted)', marginTop: 3 } }, `${p.location || 'No location'} · ${p.rooms || 0} rooms · ${propBookings} bookings`)
      ),
      div({ style: { textAlign: 'right', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 7 } },
        div({ style: { fontSize: 14, fontWeight: 700, color: 'var(--accent)' } }, fmtCur(propRev)),
        btn({ className: 'btn-danger btn-sm', style: { padding: '4px 9px' }, onClick: () => { if (confirm(`Delete "${p.name}" and all its data?`)) { mutateData(d => { d.properties = d.properties.filter(x => x.id !== p.id); d.bookings = d.bookings.filter(b => b.propertyId !== p.id); d.expenses = d.expenses.filter(e => e.propertyId !== p.id); }); } } },
          ico('trash', { style: { fontSize: 14 } })
        )
      )
    ));
  });

  // FAB
  wrap.appendChild(div({ style: { textAlign: 'center', marginTop: 20 } },
    btn({ className: 'btn-primary', onClick: () => setState({ modal: 'addBooking', editItem: null }) }, ico('plus', { style: { marginRight: 7 } }), 'New Booking')
  ));

  return wrap;
}

// ─── Bookings Tab ─────────────────────────────────────────────────────────────
function renderBookings() {
  const { data, filterProp, bookingFilter } = state;
  const all = filterProp === 'all' ? data.bookings : data.bookings.filter(b => b.propertyId === filterProp);
  const filtered = bookingFilter === 'all' ? all : all.filter(b => b.status === bookingFilter);
  const sorted = [...filtered].sort((a, b) => new Date(b.checkIn) - new Date(a.checkIn));

  const wrap = div({ style: { padding: '14px 12px 100px' } });

  const header = div({ style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 } },
    h('div', { style: { fontFamily: 'Playfair Display', fontSize: 20 } }, 'Bookings'),
    btn({ className: 'btn-primary btn-sm', onClick: () => setState({ modal: 'addBooking', editItem: null }) }, ico('plus', { style: { marginRight: 4 } }), 'Add')
  );
  wrap.appendChild(header);

  const chips = div({ style: { display: 'flex', gap: 6, marginBottom: 14, overflowX: 'auto', paddingBottom: 2, scrollbarWidth: 'none' } });
  [['all', 'All'], ['confirmed', 'Confirmed'], ['checkedin', 'In'], ['checkedout', 'Out'], ['cancelled', 'Cancelled']].forEach(([s, l]) => {
    chips.appendChild(btn({
      style: { padding: '5px 13px', borderRadius: 20, whiteSpace: 'nowrap', border: `1.5px solid ${bookingFilter === s ? 'var(--accent)' : 'var(--border)'}`, background: bookingFilter === s ? 'var(--accent-light)' : 'var(--white)', color: bookingFilter === s ? 'var(--accent)' : 'var(--muted)', fontSize: 13, fontWeight: bookingFilter === s ? 600 : 400 },
      onClick: () => setState({ bookingFilter: s })
    }, l));
  });
  wrap.appendChild(chips);

  if (sorted.length === 0) {
    wrap.appendChild(div({ style: { textAlign: 'center', padding: '40px 20px', color: 'var(--muted)' } }, 'No bookings found'));
  } else {
    sorted.forEach(b => wrap.appendChild(bookingCard(b)));
  }

  return wrap;
}

// ─── Expenses Tab ─────────────────────────────────────────────────────────────
function renderExpenses() {
  const { data, filterProp } = state;
  const expenses = (filterProp === 'all' ? data.expenses : data.expenses.filter(e => e.propertyId === filterProp))
    .sort((a, b) => new Date(b.date) - new Date(a.date));
  const total = expenses.reduce((s, e) => s + Number(e.amount || 0), 0);

  const catEmoji = { maintenance: '🔧', utilities: '💡', supplies: '🛒', staff: '👤', marketing: '📣', other: '📦' };

  const wrap = div({ style: { padding: '14px 12px 100px' } });

  wrap.appendChild(div({ style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 } },
    h('div', { style: { fontFamily: 'Playfair Display', fontSize: 20 } }, 'Expenses'),
    btn({ className: 'btn-primary btn-sm', onClick: () => setState({ modal: 'addExpense', editItem: null }) }, ico('plus', { style: { marginRight: 4 } }), 'Add')
  ));

  wrap.appendChild(div({ className: 'card', style: { padding: '14px 16px', marginBottom: 14, display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
    div({},
      div({ style: { fontSize: 12, color: 'var(--muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' } }, 'Total Expenses'),
      div({ style: { fontSize: 24, fontWeight: 700, color: 'var(--danger)', marginTop: 4 } }, fmtCur(total))
    ),
    ico('receipt', { style: { fontSize: 32, color: 'var(--danger)', opacity: 0.2 } })
  ));

  if (expenses.length === 0) {
    wrap.appendChild(div({ style: { textAlign: 'center', padding: '40px 20px', color: 'var(--muted)' } }, 'No expenses logged yet'));
  } else {
    expenses.forEach(e => {
      const prop = data.properties.find(p => p.id === e.propertyId);
      const card = div({ className: 'card', style: { padding: '12px 14px', marginBottom: 9, display: 'flex', justifyContent: 'space-between', alignItems: 'center' } });
      card.appendChild(div({},
        div({ style: { fontWeight: 600, fontSize: 15 } }, `${catEmoji[e.category] || '📦'} ${e.description}`),
        div({ style: { fontSize: 12, color: 'var(--muted)', marginTop: 3 } }, `${prop?.name || '—'} · ${fmtDate(e.date)} · ${e.category}`)
      ));
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
  const { data, filterProp } = state;
  const bookings = filterProp === 'all' ? data.bookings : data.bookings.filter(b => b.propertyId === filterProp);
  const expenses = filterProp === 'all' ? data.expenses : data.expenses.filter(e => e.propertyId === filterProp);

  const yr = new Date().getFullYear();
  const months = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];
  const monthlyRev = Array(12).fill(0);
  const monthlyExp = Array(12).fill(0);
  bookings.filter(b => b.status !== 'cancelled' && new Date(b.checkIn).getFullYear() === yr)
    .forEach(b => monthlyRev[new Date(b.checkIn).getMonth()] += Number(b.totalAmount || 0));
  expenses.filter(e => new Date(e.date).getFullYear() === yr)
    .forEach(e => monthlyExp[new Date(e.date).getMonth()] += Number(e.amount || 0));

  const maxVal = Math.max(...monthlyRev, ...monthlyExp, 1);
  const totalRev = monthlyRev.reduce((a, b) => a + b, 0);
  const totalExp = monthlyExp.reduce((a, b) => a + b, 0);

  const wrap = div({ style: { padding: '14px 12px 100px' } });
  wrap.appendChild(h('div', { style: { fontFamily: 'Playfair Display', fontSize: 20, marginBottom: 14 } }, `Reports · ${yr}`));

  // Summary
  const summaryGrid = div({ style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 16 } });
  [
    { label: 'Revenue', val: fmtCur(totalRev), col: 'var(--accent)' },
    { label: 'Expenses', val: fmtCur(totalExp), col: 'var(--danger)' },
    { label: 'Net Profit', val: fmtCur(totalRev - totalExp), col: totalRev - totalExp >= 0 ? 'var(--accent)' : 'var(--danger)' },
    { label: 'Bookings', val: bookings.filter(b => b.status !== 'cancelled').length, col: 'var(--info)' },
  ].forEach(s => {
    summaryGrid.appendChild(div({ className: 'card', style: { padding: '14px' } },
      div({ style: { fontSize: 11, color: 'var(--muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 } }, s.label),
      div({ style: { fontSize: 22, fontWeight: 700, color: s.col } }, String(s.val))
    ));
  });
  wrap.appendChild(summaryGrid);

  // Bar chart
  const chartCard = div({ className: 'card', style: { padding: '16px', marginBottom: 14 } });
  chartCard.appendChild(div({ style: { fontWeight: 600, fontSize: 14, marginBottom: 14 } }, 'Monthly Overview'));
  const bars = div({ style: { display: 'flex', alignItems: 'flex-end', gap: 4, height: 100 } });
  months.forEach((m, i) => {
    const col = div({ style: { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 } });
    const barWrap = div({ style: { width: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', gap: 2, height: 80 } });
    const revH = Math.max(2, (monthlyRev[i] / maxVal) * 78);
    const expH = Math.max(0, (monthlyExp[i] / maxVal) * 78);
    barWrap.appendChild(div({ style: { width: '70%', margin: '0 auto', background: 'var(--accent)', borderRadius: '3px 3px 0 0', height: revH + 'px', opacity: 0.85 } }));
    if (expH > 0) barWrap.appendChild(div({ style: { width: '70%', margin: '0 auto', background: 'var(--danger)', borderRadius: '3px 3px 0 0', height: expH + 'px', opacity: 0.65 } }));
    col.appendChild(barWrap);
    col.appendChild(div({ style: { fontSize: 9, color: 'var(--muted)', marginTop: 4 } }, m));
    bars.appendChild(col);
  });
  chartCard.appendChild(bars);
  chartCard.appendChild(div({ style: { display: 'flex', gap: 16, marginTop: 10, fontSize: 12 } },
    div({ style: { display: 'flex', alignItems: 'center', gap: 5 } }, div({ style: { width: 10, height: 10, background: 'var(--accent)', borderRadius: 2 } }), 'Revenue'),
    div({ style: { display: 'flex', alignItems: 'center', gap: 5 } }, div({ style: { width: 10, height: 10, background: 'var(--danger)', borderRadius: 2 } }), 'Expenses')
  ));
  wrap.appendChild(chartCard);

  // Property performance
  const perfCard = div({ className: 'card', style: { padding: '16px', marginBottom: 14 } });
  perfCard.appendChild(div({ style: { fontWeight: 600, fontSize: 14, marginBottom: 12 } }, 'Property Performance'));
  if (data.properties.length === 0) {
    perfCard.appendChild(div({ style: { color: 'var(--muted)', fontSize: 13 } }, 'No properties yet'));
  } else {
    data.properties.forEach((p, i) => {
      const bks = data.bookings.filter(b => b.propertyId === p.id && b.status !== 'cancelled');
      const rev = bks.reduce((s, b) => s + Number(b.totalAmount || 0), 0);
      const nights = bks.reduce((s, b) => s + diffDays(b.checkIn, b.checkOut), 0);
      const row = div({ style: { paddingBottom: i < data.properties.length - 1 ? 12 : 0, marginBottom: i < data.properties.length - 1 ? 12 : 0, borderBottom: i < data.properties.length - 1 ? '1px solid var(--border-soft)' : 'none' } });
      row.appendChild(div({ style: { display: 'flex', justifyContent: 'space-between', marginBottom: 4 } },
        div({ style: { fontWeight: 600, fontSize: 14 } }, p.name),
        div({ style: { fontWeight: 700, color: 'var(--accent)', fontSize: 14 } }, fmtCur(rev))
      ));
      row.appendChild(div({ style: { fontSize: 12, color: 'var(--muted)' } }, `${bks.length} bookings · ${nights} nights booked`));
      perfCard.appendChild(row);
    });
  }
  wrap.appendChild(perfCard);

  // Booking sources
  const bySource = {};
  bookings.filter(b => b.status !== 'cancelled').forEach(b => {
    const s = b.source || 'Direct';
    bySource[s] = (bySource[s] || 0) + Number(b.totalAmount || 0);
  });
  if (Object.keys(bySource).length > 0) {
    const srcCard = div({ className: 'card', style: { padding: '16px' } });
    srcCard.appendChild(div({ style: { fontWeight: 600, fontSize: 14, marginBottom: 12 } }, 'Revenue by Source'));
    const srcTotal = Object.values(bySource).reduce((a, b) => a + b, 0);
    Object.entries(bySource).sort((a, b) => b[1] - a[1]).forEach(([s, v]) => {
      const pct = srcTotal > 0 ? Math.round(v / srcTotal * 100) : 0;
      srcCard.appendChild(div({ style: { marginBottom: 10 } },
        div({ style: { display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 5 } },
          div({ style: { color: 'var(--text-mid)', fontWeight: 500 } }, s),
          span({ style: { fontWeight: 600 } }, `${fmtCur(v)} (${pct}%)`)
        ),
        div({ style: { height: 5, background: 'var(--border)', borderRadius: 10, overflow: 'hidden' } },
          div({ style: { height: '100%', width: pct + '%', background: 'var(--accent)', borderRadius: 10, transition: 'width .4s' } })
        )
      ));
    });
    wrap.appendChild(srcCard);
  }

  return wrap;
}

// ─── Modals ───────────────────────────────────────────────────────────────────
function renderPropertyModal() {
  const f = { name: '', location: '', rooms: '', pricePerNight: '', description: '' };
  const fields = [
    ['name', 'Property name *', 'text'],
    ['location', 'Location / Address', 'text'],
    ['rooms', 'Number of rooms', 'number'],
    ['pricePerNight', 'Base price per night (₹)', 'number'],
  ];
  const content = () => {
    const wrap = div({ style: { display: 'flex', flexDirection: 'column', gap: 11 } });
    fields.forEach(([k, ph, t]) => {
      const inp = h('input', { type: t, placeholder: ph, value: f[k] || '' });
      inp.addEventListener('input', e => f[k] = e.target.value);
      wrap.appendChild(inp);
    });
    const ta = h('textarea', { placeholder: 'Notes / description', rows: 2, style: { resize: 'none' } });
    ta.addEventListener('input', e => f.description = e.target.value);
    wrap.appendChild(ta);
    const savBtn = btn({ className: 'btn-primary', style: { marginTop: 4, width: '100%' },
      onClick: () => {
        if (!f.name) return;
        mutateData(d => d.properties.push({ ...f, id: uid() }));
        closeModal();
      }
    }, 'Save Property');
    wrap.appendChild(savBtn);
    return wrap;
  };
  return modal('Add Property', content);
}

function renderBookingModal() {
  const { data, editItem } = state;
  const isEdit = !!editItem;
  const f = isEdit ? { ...editItem } : {
    propertyId: data.properties[0]?.id || '',
    guestName: '', phone: '', checkIn: '', checkOut: '',
    guests: 1, totalAmount: '', paid: '',
    source: 'Direct', status: 'confirmed', notes: ''
  };

  const content = () => {
    const wrap = div({ style: { display: 'flex', flexDirection: 'column', gap: 11 } });

    // Property select
    const propSel = h('select');
    data.properties.forEach(p => {
      const o = h('option', { value: p.id, selected: f.propertyId === p.id }, p.name);
      propSel.appendChild(o);
    });
    propSel.addEventListener('change', e => { f.propertyId = e.target.value; autoCalc(); });
    wrap.appendChild(propSel);

    // Guest name
    const guestInp = h('input', { type: 'text', placeholder: 'Guest name *', value: f.guestName || '' });
    guestInp.addEventListener('input', e => f.guestName = e.target.value);
    wrap.appendChild(guestInp);

    // Phone
    const phoneInp = h('input', { type: 'tel', placeholder: 'Phone number', value: f.phone || '' });
    phoneInp.addEventListener('input', e => f.phone = e.target.value);
    wrap.appendChild(phoneInp);

    // Dates
    const datesRow = div({ style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 } });
    const ciWrap = div({}, div({ className: 'label' }, 'Check-in'));
    const ciInp = h('input', { type: 'date', value: f.checkIn || '' });
    ciInp.addEventListener('change', e => { f.checkIn = e.target.value; autoCalc(); });
    ciWrap.appendChild(ciInp);
    const coWrap = div({}, div({ className: 'label' }, 'Check-out'));
    const coInp = h('input', { type: 'date', value: f.checkOut || '' });
    coInp.addEventListener('change', e => { f.checkOut = e.target.value; autoCalc(); });
    coWrap.appendChild(coInp);
    datesRow.appendChild(ciWrap); datesRow.appendChild(coWrap);
    wrap.appendChild(datesRow);

    // Nights info
    const nightsInfo = div({ style: { fontSize: 13, color: 'var(--accent)', fontWeight: 500, minHeight: 18 } });
    wrap.appendChild(nightsInfo);

    function autoCalc() {
      if (f.checkIn && f.checkOut && !isEdit) {
        const n = diffDays(f.checkIn, f.checkOut);
        const prop = data.properties.find(p => p.id === f.propertyId);
        if (n > 0 && prop?.pricePerNight) {
          const suggested = n * Number(prop.pricePerNight);
          f.totalAmount = suggested;
          amtInp.value = suggested;
          nightsInfo.textContent = `${n} nights · Suggested: ₹${suggested.toLocaleString('en-IN')}`;
        } else if (n > 0) {
          nightsInfo.textContent = `${n} nights`;
        }
      }
    }

    // Amount row
    const amtRow = div({ style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 } });
    const amtInp = h('input', { type: 'number', placeholder: 'Total (₹)', value: f.totalAmount || '' });
    amtInp.addEventListener('input', e => f.totalAmount = e.target.value);
    const paidInp = h('input', { type: 'number', placeholder: 'Paid (₹)', value: f.paid || '' });
    paidInp.addEventListener('input', e => f.paid = e.target.value);
    amtRow.appendChild(amtInp); amtRow.appendChild(paidInp);
    wrap.appendChild(amtRow);

    // Guests
    const guestsInp = h('input', { type: 'number', placeholder: 'No. of guests', value: f.guests || 1 });
    guestsInp.addEventListener('input', e => f.guests = e.target.value);
    wrap.appendChild(guestsInp);

    // Source
    const srcSel = h('select');
    ['Direct', 'Airbnb', 'Booking.com', 'MakeMyTrip', 'Goibibo', 'OYO', 'Other'].forEach(s => {
      srcSel.appendChild(h('option', { value: s, selected: f.source === s }, s));
    });
    srcSel.addEventListener('change', e => f.source = e.target.value);
    wrap.appendChild(srcSel);

    // Status
    const stSel = h('select');
    [['confirmed', 'Confirmed'], ['checkedin', 'Checked In'], ['checkedout', 'Checked Out'], ['cancelled', 'Cancelled']].forEach(([v, l]) => {
      stSel.appendChild(h('option', { value: v, selected: f.status === v }, l));
    });
    stSel.addEventListener('change', e => f.status = e.target.value);
    wrap.appendChild(stSel);

    // Notes
    const notesTA = h('textarea', { placeholder: 'Notes (optional)', rows: 2, style: { resize: 'none' } });
    notesTA.textContent = f.notes || '';
    notesTA.addEventListener('input', e => f.notes = e.target.value);
    wrap.appendChild(notesTA);

    // Save
    wrap.appendChild(btn({
      className: 'btn-primary', style: { marginTop: 4, width: '100%' },
      onClick: () => {
        if (!f.guestName || !f.checkIn || !f.checkOut || !f.propertyId) return;
        mutateData(d => {
          if (isEdit) d.bookings = d.bookings.map(b => b.id === f.id ? f : b);
          else d.bookings.push({ ...f, id: uid() });
        });
        closeModal();
      }
    }, isEdit ? 'Update Booking' : 'Add Booking'));

    return wrap;
  };
  return modal(isEdit ? 'Edit Booking' : 'New Booking', content);
}

function renderExpenseModal() {
  const { data, editItem } = state;
  const isEdit = !!editItem;
  const f = isEdit ? { ...editItem } : {
    propertyId: data.properties[0]?.id || '',
    description: '', amount: '', date: today(),
    category: 'maintenance', notes: ''
  };

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
    const dateInp = h('input', { type: 'date', value: f.date || today() });
    dateInp.addEventListener('change', e => f.date = e.target.value);
    dateWrap.appendChild(dateInp);
    wrap.appendChild(dateWrap);

    const catSel = h('select');
    [['maintenance', '🔧 Maintenance'], ['utilities', '💡 Utilities'], ['supplies', '🛒 Supplies'], ['staff', '👤 Staff'], ['marketing', '📣 Marketing'], ['other', '📦 Other']].forEach(([v, l]) => {
      catSel.appendChild(h('option', { value: v, selected: f.category === v }, l));
    });
    catSel.addEventListener('change', e => f.category = e.target.value);
    wrap.appendChild(catSel);

    const notesTA = h('textarea', { placeholder: 'Notes (optional)', rows: 2, style: { resize: 'none' } });
    notesTA.textContent = f.notes || '';
    notesTA.addEventListener('input', e => f.notes = e.target.value);
    wrap.appendChild(notesTA);

    wrap.appendChild(btn({
      className: 'btn-primary', style: { marginTop: 4, width: '100%' },
      onClick: () => {
        if (!f.description || !f.amount || !f.propertyId) return;
        mutateData(d => {
          if (isEdit) d.expenses = d.expenses.map(e => e.id === f.id ? f : e);
          else d.expenses.push({ ...f, id: uid() });
        });
        closeModal();
      }
    }, isEdit ? 'Update Expense' : 'Add Expense'));

    return wrap;
  };
  return modal(isEdit ? 'Edit Expense' : 'New Expense', content);
}

// ─── Actions ──────────────────────────────────────────────────────────────────
function updateStatus(id, status) {
  mutateData(d => d.bookings = d.bookings.map(b => b.id === id ? { ...b, status } : b));
}

// ─── Main Render ─────────────────────────────────────────────────────────────
let currentModal = null;

function render() {
  const app = document.getElementById('app');
  app.innerHTML = '';

  app.appendChild(renderHeader());

  const main = div({ style: { flex: 1 } });
  if (state.tab === 'dashboard') main.appendChild(renderDashboard());
  else if (state.tab === 'bookings') main.appendChild(renderBookings());
  else if (state.tab === 'expenses') main.appendChild(renderExpenses());
  else if (state.tab === 'reports') main.appendChild(renderReports());
  app.appendChild(main);

  app.appendChild(renderNav());

  // Modals
  if (currentModal && currentModal.parentNode) currentModal.parentNode.removeChild(currentModal);
  currentModal = null;

  if (state.modal === 'addProp') { currentModal = renderPropertyModal(); document.body.appendChild(currentModal); }
  else if (state.modal === 'addBooking') { currentModal = renderBookingModal(); document.body.appendChild(currentModal); }
  else if (state.modal === 'addExpense') { currentModal = renderExpenseModal(); document.body.appendChild(currentModal); }
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
render();
