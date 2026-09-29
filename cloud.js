/* StayLog · cloud sync
   ────────────────────────────────────────────────────────────────────────────
   Your phone stays the master copy. IndexedDB is written first and the app
   works exactly as it always has with no signal; the cloud is caught up
   afterwards, whenever there is a connection.

   Sync is a whole-state push rather than a queue of operations. With one
   person writing, a queue buys nothing and can drift out of step with the data
   it describes; re-stating the truth is idempotent and cannot half-apply. The
   volumes here are a few hundred rows, so the cost is a rounding error.

   Deletes are reconciled rather than tracked: after pushing what exists, any
   row the server still has and this phone does not is tombstoned. That means
   no delete path in the app has to remember to tell the cloud anything.

   What is deliberately NOT sent: guest ID photographs. They are in the local
   record and in no mapper below, so they cannot leave the device by accident.
   ──────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  const CFG = window.STAYLOG_CLOUD || {};
  const SDK = './vendor/supabase.umd.js';
  const LAST_SYNC = 'staylog_last_sync';

  let sb = null;          // supabase client, once the SDK is loaded
  let session = null;     // current auth session, if signed in
  let dirty = false;      // local changes not yet pushed
  let pushing = false;
  let timer = null;
  let lastError = '';
  let held = 0;           // marks waiting on a daily wage being set
  let attError = '';      // attendance trouble, kept apart from sync trouble

  const num = v => (v === '' || v == null ? null : Number(v));
  const str = v => (v == null || v === '' ? null : String(v));
  const dat = v => (v ? String(v).slice(0, 10) : null);
  const ID_OK = /^[A-Za-z0-9_-]{1,64}$/;   // ids the app generates; anything else is not ours

  // ── Field mapping ──────────────────────────────────────────────────────────
  // Written out by hand in both directions. It is longer than a clever
  // converter and it is the file you read to answer "what of mine is up there".
  const MAP = {
    properties: {
      up: (p, owner) => ({
        id: p.id, owner_id: owner, name: p.name, location: str(p.location),
        rooms: num(p.rooms), price_per_night: num(p.pricePerNight),
        description: str(p.description), maps_link: str(p.mapsLink),
        wifi_name: str(p.wifiName), wifi_password: str(p.wifiPassword),
      }),
      down: r => ({
        id: r.id, name: r.name, location: r.location || '', rooms: r.rooms ?? '',
        pricePerNight: r.price_per_night ?? '', description: r.description || '',
        mapsLink: r.maps_link || '', wifiName: r.wifi_name || '', wifiPassword: r.wifi_password || '',
      }),
    },
    staff: {
      up: (s, owner) => ({
        id: s.id, owner_id: owner, name: s.name, role: str(s.role), phone: str(s.phone),
        monthly_salary: num(s.monthlySalary), daily_wage: num(s.dailyWage),
        active: s.active !== false, joined_on: dat(s.joinedOn),
      }),
      down: r => ({
        id: r.id, name: r.name, role: r.role || '', phone: r.phone || '',
        monthlySalary: r.monthly_salary ?? '', dailyWage: r.daily_wage ?? '',
        active: r.active, joinedOn: r.joined_on || '',
      }),
    },
    bookings: {
      up: (b, owner) => ({
        id: b.id, owner_id: owner, property_id: str(b.propertyId), guest_name: b.guestName,
        phone: str(b.phone), check_in: dat(b.checkIn), check_out: dat(b.checkOut),
        guests: num(b.guests) || 1, total_amount: num(b.totalAmount) || 0, paid: num(b.paid) || 0,
        source: str(b.source) || 'Direct', status: b.status || 'confirmed', notes: str(b.notes),
        id_proof_type: str(b.idProofType), id_proof_number: str(b.idProofNumber),
        // b.idProofImage is intentionally absent — see the header
        msg_sent: b.msgSent || (b.confirmSentOn ? { confirm: b.confirmSentOn } : {}),
      }),
      down: r => ({
        id: r.id, propertyId: r.property_id || '', guestName: r.guest_name, phone: r.phone || '',
        checkIn: r.check_in, checkOut: r.check_out, guests: r.guests ?? 1,
        totalAmount: r.total_amount ?? '', paid: r.paid ?? '', source: r.source || 'Direct',
        status: r.status, notes: r.notes || '',
        idProofType: r.id_proof_type || '', idProofNumber: r.id_proof_number || '',
        idProofImage: '',                       // refilled from the local copy on restore
        msgSent: r.msg_sent || {},
      }),
    },
    loans: {
      up: (l, owner) => ({
        id: l.id, owner_id: owner, staff_id: l.staffId, property_id: str(l.propertyId),
        principal: num(l.principal), installment_amount: num(l.installmentAmount),
        disbursed_on: dat(l.disbursedOn), first_due_date: dat(l.firstDueDate),
        status: l.status || 'active', notes: str(l.notes), written_off_on: dat(l.writtenOffOn),
      }),
      down: r => ({
        id: r.id, staffId: r.staff_id, propertyId: r.property_id || '',
        principal: r.principal, installmentAmount: r.installment_amount,
        disbursedOn: r.disbursed_on, firstDueDate: r.first_due_date || '',
        status: r.status, notes: r.notes || '', writtenOffOn: r.written_off_on || '',
        repayments: [],                         // filled from loan_repayments
      }),
    },
    loan_repayments: {
      up: (r, owner) => ({
        id: r.id, owner_id: owner, loan_id: r.loanId, date: dat(r.date),
        amount: num(r.amount), mode: r.mode || 'direct', expense_id: str(r.expenseId), note: str(r.note),
      }),
      down: r => ({
        id: r.id, loanId: r.loan_id, date: r.date, amount: Number(r.amount),
        mode: r.mode, expenseId: r.expense_id || undefined, note: r.note || '',
      }),
    },
    expenses: {
      up: (e, owner) => ({
        id: e.id, owner_id: owner, property_id: str(e.propertyId), staff_id: str(e.staffId),
        loan_id: str(e.loanId), description: e.description, date: dat(e.date),
        category: e.category || 'other', amount: num(e.amount) || 0,
        gross_amount: num(e.grossAmount), loan_deduction: num(e.loanDeduction) || 0,
        paid: !!e.paid, notes: str(e.notes),
      }),
      down: r => ({
        id: r.id, propertyId: r.property_id || '', staffId: r.staff_id || '', loanId: r.loan_id || '',
        description: r.description, date: r.date, category: r.category,
        amount: Number(r.amount), grossAmount: r.gross_amount ?? undefined,
        loanDeduction: Number(r.loan_deduction || 0), paid: r.paid, notes: r.notes || '',
      }),
    },
  };

  // Parents before children: loans need staff, repayments need loans.
  const ORDER = ['properties', 'staff', 'loans', 'loan_repayments', 'expenses', 'bookings'];

  // ── SDK, loaded only when it is actually needed ────────────────────────────
  let sdkPromise = null;
  function loadSDK() {
    if (window.supabase?.createClient) return Promise.resolve(window.supabase);
    if (sdkPromise) return sdkPromise;
    sdkPromise = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = SDK;
      s.onload = () => window.supabase?.createClient ? res(window.supabase) : rej(new Error('sdk'));
      s.onerror = () => { sdkPromise = null; rej(new Error('sdk')); };
      document.head.appendChild(s);
    });
    return sdkPromise;
  }

  async function client() {
    if (sb) return sb;
    if (!CFG.url || !CFG.publishableKey) throw new Error('cloud-config.js is missing its values');
    const lib = await loadSDK();
    sb = lib.createClient(CFG.url, CFG.publishableKey, {
      auth: { persistSession: true, autoRefreshToken: true },
    });
    return sb;
  }

  // ── Auth ───────────────────────────────────────────────────────────────────
  async function restoreSession() {
    try {
      const c = await client();
      const { data } = await c.auth.getSession();
      session = data.session || null;
      return session;
    } catch { return null; }
  }

  async function signIn(email, password) {
    const c = await client();
    const { data, error } = await c.auth.signInWithPassword({ email: email.trim(), password });
    if (error) throw error;
    session = data.session;
    lastError = '';
    checkIn(true);
    return session;
  }

  async function signOut() {
    try { const c = await client(); await c.auth.signOut(); } catch {}
    session = null;
  }

  // ── Push ───────────────────────────────────────────────────────────────────
  function collect(data) {
    const reps = [];
    (data.loans || []).forEach(l => (l.repayments || []).forEach(r =>
      reps.push({ ...r, loanId: l.id })));
    return {
      properties: data.properties || [],
      staff: data.staff || [],
      bookings: data.bookings || [],
      loans: data.loans || [],
      loan_repayments: reps,
      expenses: data.expenses || [],
    };
  }

  // ── Attendance ─────────────────────────────────────────────────────────────
  // The one table she writes and this phone does not own. It is deliberately
  // absent from ORDER and MAP above, which is what keeps the tombstone pass in
  // push() from deleting the marks she made while this phone was not looking.
  //
  // Draining is one-way: a mark becomes an unpaid wage expense here, the
  // server row is stamped with that expense's id, and a stamped row is never
  // looked at again. Delete the expense afterwards and it stays deleted.
  //
  // The expense id is derived from the mark id rather than generated, so
  // re-running this after a half-finished drain rewrites the same expense
  // instead of making a second one.
  const expenseIdFor = markId => 'wag_' + String(markId).replace(/^att_/, '');
  const prettyDate = iso => {
    const d = new Date(iso + 'T00:00:00');
    return isNaN(d) ? iso : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  };

  // Nothing in here may break the push. Attendance is an addition; if the
  // table is not there yet, or the request fails, or the app is an older build
  // than the database, the rest of the sync has to carry on exactly as before.
  async function drainAttendance(c, owner, data) {
    try {
      return await drainAttendanceInner(c, owner, data);
    } catch (err) {
      attError = (err && err.message) || String(err);
      return false;
    }
  }

  async function drainAttendanceInner(c, owner, data) {
    held = 0; attError = '';
    const { data: marks, error } = await c.from('attendance')
      .select('id,staff_id,date').eq('owner_id', owner)
      .is('deleted_at', null).is('expense_id', null).order('date', { ascending: true });
    if (error) throw error;
    if (!marks || !marks.length) return false;

    const known = new Map((data.attendance || []).map(a => [a.id, a]));
    const make = [];
    const stamp = [];

    for (const m of marks) {
      if (known.has(m.id)) {            // already spent here; the stamp is what failed
        stamp.push(m.id);
        continue;
      }
      const st = (data.staff || []).find(x => x.id === m.staff_id);
      const rate = Number(st && st.dailyWage);
      // No rate yet is not a reason to invent a figure, and not a reason to
      // drop the mark. It waits, and the cloud panel says how many are waiting.
      if (!st || !(rate > 0)) { held++; continue; }
      make.push({ mark: m, staff: st, rate });
    }

    if (make.length && window.STAYLOG_APPLY) {
      const ok = window.STAYLOG_APPLY(d => {
        d.attendance = d.attendance || [];
        for (const { mark, staff, rate } of make) {
          const eid = expenseIdFor(mark.id);
          if (!d.expenses.some(e => e.id === eid)) {
            d.expenses.push({
              id: eid,
              propertyId: (d.properties[0] || {}).id || '',
              description: `Wage — ${staff.name} · ${prettyDate(mark.date)}`,
              date: mark.date, category: 'staff', staffId: staff.id,
              amount: rate, grossAmount: rate,
              loanId: '', loanDeduction: 0, paid: false,
              notes: 'From her attendance mark', fromAttendance: mark.id,
            });
          }
          if (!d.attendance.some(a => a.id === mark.id))
            d.attendance.push({ id: mark.id, staffId: staff.id, date: mark.date, expenseId: eid });
        }
      });
      if (ok) make.forEach(({ mark }) => stamp.push(mark.id));
    }

    // Stamp last. If this fails the local side is already correct, and the
    // next drain finds the mark in data.attendance and only retries the stamp.
    for (const id of stamp) {
      const { error: sErr } = await c.from('attendance')
        .update({ expense_id: expenseIdFor(id) }).eq('id', id).eq('owner_id', owner);
      if (sErr) break;
    }
    return stamp.length > 0;
  }

  async function push(data) {
    if (!session) throw new Error('not signed in');
    if (pushing) return;
    pushing = true;
    const owner = session.user.id;
    const c = await client();
    try {
      // Before pushing, not after: expenses born from her marks have to go up
      // in this same cycle, or the tombstone pass below would see rows the
      // server has and this phone does not.
      const drained = await drainAttendance(c, owner, data).catch(() => false);
      if (drained) data = (window.STAYLOG_GET_DATA && window.STAYLOG_GET_DATA()) || data;
      const sets = collect(data);
      for (const table of ORDER) {
        const rows = (sets[table] || []).filter(x => ID_OK.test(String(x.id || '')))
          .map(x => MAP[table].up(x, owner));
        if (rows.length) {
          const { error } = await c.from(table).upsert(rows, { onConflict: 'id' });
          if (error) throw error;
        }
        // Anything the server still holds that this phone no longer has is gone.
        let q = c.from(table).update({ deleted_at: new Date().toISOString() })
          .eq('owner_id', owner).is('deleted_at', null);
        if (rows.length) q = q.not('id', 'in', '(' + rows.map(r => `"${r.id}"`).join(',') + ')');
        const { error: delErr } = await q;
        if (delErr) throw delErr;
      }
      dirty = false;
      lastError = '';
      try { localStorage.setItem(LAST_SYNC, new Date().toISOString()); } catch {}
    } catch (err) {
      lastError = err.message || String(err);
      throw err;
    } finally {
      pushing = false;
      notify();
    }
  }

  // ── Pull ───────────────────────────────────────────────────────────────────
  // Used to bring a new device up to date, not to merge concurrent edits.
  async function pull() {
    if (!session) throw new Error('not signed in');
    const c = await client();
    const out = {};
    for (const table of ORDER) {
      const { data, error } = await c.from(table).select('*').is('deleted_at', null);
      if (error) throw error;
      out[table] = data.map(MAP[table].down);
    }
    const byLoan = {};
    out.loan_repayments.forEach(r => (byLoan[r.loanId] = byLoan[r.loanId] || []).push(r));
    out.loans.forEach(l => { l.repayments = byLoan[l.id] || []; });
    return {
      properties: out.properties, bookings: out.bookings, expenses: out.expenses,
      staff: out.staff, loans: out.loans,
    };
  }

  // ── Scheduling ─────────────────────────────────────────────────────────────
  const listeners = [];
  function notify() { listeners.forEach(fn => { try { fn(status()); } catch {} }); }

  function status() {
    let last = null;
    try { last = localStorage.getItem(LAST_SYNC); } catch {}
    return {
      configured: !!(CFG.url && CFG.publishableKey),
      signedIn: !!session,
      email: session?.user?.email || '',
      userId: session?.user?.id || '',
      online: navigator.onLine,
      dirty, pushing, lastSync: last, lastError, heldMarks: held, attError,
    };
  }

  // Called by the app whenever local data changes.
  function markDirty(getData) {
    dirty = true;
    notify();
    if (!session || !navigator.onLine) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      // Conditions can change in four seconds. Staying dirty is correct —
      // the 'online' handler picks it up rather than failing a doomed request.
      if (!session || !navigator.onLine) return;
      push(getData()).catch(() => {});
    }, 4000);
  }

  // ── Checking in ────────────────────────────────────────────────────────────
  // markDirty only fires when THIS phone changes something, which is the wrong
  // trigger for attendance: her marks arrive without this phone doing anything,
  // and waiting for the next expense to be typed could be days. So the app also
  // syncs when it is opened and when it comes back to the foreground.
  let lastCheck = 0;
  async function checkIn(force) {
    if (!session || !navigator.onLine || pushing) return;
    const now = Date.now();
    if (!force && now - lastCheck < 30000) return;   // returning to the app repeatedly is cheap
    lastCheck = now;
    const data = window.STAYLOG_GET_DATA && window.STAYLOG_GET_DATA();
    if (!data) return;
    try { await push(data); } catch {}
  }

  window.addEventListener('online', () => { notify(); checkIn(true); });
  window.addEventListener('offline', notify);
  window.addEventListener('focus', () => checkIn());
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) checkIn();
  });

  window.StayLogCloud = {
    restoreSession, signIn, signOut, push, pull, status, markDirty, checkIn,
    onChange: fn => listeners.push(fn),
    staffEmail: u => `${String(u || '').trim().toLowerCase()}@${CFG.staffEmailDomain}`,
  };
})();
