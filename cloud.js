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
  let queued = false;     // a push asked for while one was already running
  let timer = null;
  let lastError = '';
  let held = 0;           // marks waiting on a daily wage being set
  let attError = '';      // attendance trouble, kept apart from sync trouble
  let brake = null;       // what the last stopped push would have deleted
  let declinedSig = '';   // that same set of deletions, already refused once
  // What the last drain actually did. Without this the only way to find out
  // why a mark did not become an expense is to read the database by hand,
  // which is not a thing the app should ask of anybody.
  // Kept on disk, not only in memory. These used to reset on every launch, so
  // the check that runs at boot — which finds nothing, because everything has
  // already been converted — was the only thing the panel ever had to report.
  // It said "nothing waiting" forever, whatever had happened earlier.
  const ATT_LOG_KEY = 'staylog_att_log';
  const blankLog = () => ({ at: '', found: 0, created: 0, stamped: 0, pending: 0,
                            cloudMarks: 0, removed: 0, names: [] });
  const loadLog = k => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } };
  const saveLog = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
  let attLog  = loadLog(ATT_LOG_KEY) || blankLog();
  // What the last drain that actually DID something did. Separate, because
  // creating an expense marks the data dirty, which schedules another push a
  // few seconds later, whose drain finds nothing — and used to overwrite the
  // record of the conversion that had just happened. The panel then said
  // "nothing waiting" seconds after converting a mark, which is how a working
  // conversion came to look like a failure.
  const ATT_LAST_KEY = 'staylog_att_last';
  let attLast = loadLog(ATT_LAST_KEY) || { at: '', created: 0, names: [] };
  // What the calendar import has done, per feed. Kept on disk for the same
  // reason as attLog: the sync that adds a booking schedules another one a
  // few seconds later, which finds nothing and would otherwise wipe the record.
  // null until the tables exist.
  const ICAL_LOG_KEY = 'staylog_ical_log';
  let icalLog = loadLog(ICAL_LOG_KEY);

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
        signature: str(p.signature), signature_ratio: num(p.signatureRatio),
      }),
      down: r => ({
        id: r.id, name: r.name, location: r.location || '', rooms: r.rooms ?? '',
        pricePerNight: r.price_per_night ?? '', description: r.description || '',
        mapsLink: r.maps_link || '', wifiName: r.wifi_name || '', wifiPassword: r.wifi_password || '',
        signature: r.signature || '', signatureRatio: r.signature_ratio ?? '',
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
        receipt_no: str(b.receiptNo), receipt_on: dat(b.receiptOn),
      }),
      down: r => ({
        id: r.id, propertyId: r.property_id || '', guestName: r.guest_name, phone: r.phone || '',
        checkIn: r.check_in, checkOut: r.check_out, guests: r.guests ?? 1,
        totalAmount: r.total_amount ?? '', paid: r.paid ?? '', source: r.source || 'Direct',
        status: r.status, notes: r.notes || '',
        idProofType: r.id_proof_type || '', idProofNumber: r.id_proof_number || '',
        receiptNo: r.receipt_no || '', receiptOn: r.receipt_on || '',
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

// Every request to Supabase is made with cache:'no-store'. The service worker
  // already leaves the API alone; this is the second, independent layer, so a
  // stale answer cannot come back from the browser's own HTTP cache either.
  // Live data is fetched live, or not at all.
  const noStoreFetch = (input, init) => fetch(input, Object.assign({}, init, { cache: 'no-store' }));

  async function client() {
    if (sb) return sb;
    if (!CFG.url || !CFG.publishableKey) throw new Error('cloud-config.js is missing its values');
    const lib = await loadSDK();
    sb = lib.createClient(CFG.url, CFG.publishableKey, {
      auth: { persistSession: true, autoRefreshToken: true },
      global: { fetch: noStoreFetch },
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
      // Framed where it is raised, so the panel can print whatever it is given
      // verbatim — a stamp failure explains itself and does not want this.
      attError = 'Could not read the marks — ' + ((err && err.message) || String(err));
      attLog = Object.assign(blankLog(), { at: new Date().toISOString() });
      saveLog(ATT_LOG_KEY, attLog);
      return false;
    }
  }

  async function drainAttendanceInner(c, owner, data) {
    held = 0; attError = '';
    const { data: marks, error } = await c.from('attendance')
      .select('id,staff_id,date').eq('owner_id', owner)
      .is('deleted_at', null).is('expense_id', null).order('date', { ascending: true });
    if (error) throw error;
    // Every mark, not only the unconverted ones. Without the full picture the
    // app cannot say "six in the cloud, four here" — which is the question
    // actually being asked when a day appears to have gone missing.
    const { data: allMarks } = await c.from('attendance')
      .select('id,staff_id,date,expense_id').eq('owner_id', owner)
      .is('deleted_at', null).order('date', { ascending: false }).limit(400);

    // Reconciliation runs whether or not there is anything to convert — when
    // every mark is already ticked off there is still a question worth
    // answering, which is whether an expense has since gone missing here.
    const haveExpense = id => (data.expenses || []).some(e => e.id === expenseIdFor(id));
    attLog = Object.assign(blankLog(), {
      at: new Date().toISOString(),
      found: (marks || []).length,
      cloudMarks: (allMarks || []).length,
      removed: (allMarks || []).filter(m => m.expense_id && !haveExpense(m.id)).length });
    if (!marks || !marks.length) { saveLog(ATT_LOG_KEY, attLog); return false; }

    // What counts as "already done" is whether the EXPENSE exists here, not
    // whether this phone once wrote the mark down. The old check asked the
    // bookkeeping list, so a mark whose expense had since gone — deleted, or
    // lost to a restore that replaced expenses but not that list — was skipped
    // for good: never rebuilt, only re-stamped. That is how a day in the cloud
    // ends up with nothing to show for it here.
    const make = [];
    const stamp = [];

    for (const m of marks) {
      if (haveExpense(m.id)) {          // the expense is here; only the tick-off is outstanding
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
      if (!ok) attError = 'The wage expenses could not be written to this phone. '
                        + 'Nothing is lost in the cloud; try Check now again.';
      if (ok) {
        make.forEach(({ mark }) => stamp.push(mark.id));
        attLog.created = make.length;
        attLog.names = make.map(m => `${m.staff.name} · ${prettyDate(m.mark.date)}`);
        attLast = { at: attLog.at, created: attLog.created, names: attLog.names.slice() };
        saveLog(ATT_LAST_KEY, attLast);
      }
    }

    // Stamp last. If this fails the local side is already correct, and the
    // next drain finds the mark in data.attendance and only retries the stamp.
    // A failure here used to be swallowed, which left a mark that looked
    // unconverted in the database while its expense already existed — and
    // nothing anywhere said so.
    for (const id of stamp) {
      // .select() so the reply says which rows were actually updated. Without
      // it an update matching NO rows is indistinguishable from one that
      // worked, and a mark that never got ticked off counted as ticked off.
      const { data: hit, error: sErr } = await c.from('attendance')
        .update({ expense_id: expenseIdFor(id) })
        .eq('id', id).eq('owner_id', owner).select('id');
      // One bad row must not stop the others being ticked off.
      if (sErr) {
        attError = 'Some marks could not be ticked off in the cloud — '
                 + (sErr.message || sErr) + '. The expenses are safe; it retries at the next sync.';
        continue;
      }
      if (!hit || !hit.length) {
        attError = 'Ticking a mark off changed nothing — the row was not found. '
                 + 'The expense is safe; tell Rakshit.';
        continue;
      }
      attLog.stamped++;
    }
    // Marks that are spent here but still unstamped in the cloud: the honest
    // count of what is out of step, which the panel reports rather than hiding.
    attLog.pending = Math.max(0, stamp.length - attLog.stamped);
    saveLog(ATT_LOG_KEY, attLog);
    return attLog.stamped > 0;
  }

  // ── Calendar import (Booking.com / Airbnb) ─────────────────────────────────
  // The Edge Function ical-sync reads the platforms' export links into
  // public.ical_events. Like attendance, that table is absent from ORDER and
  // MAP and is drained one way: event → ordinary booking → event stamped with
  // the booking's id. The stamp is how a booking deleted on purpose stays
  // deleted, and how a mirrored or hand-entered stay is linked, not doubled.
  const ICAL_COLS = 'feed_id,uid,property_id,platform,start_date,end_date,summary,description,kind,gone_at,imported_booking_id';
  const localToday = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  // Deterministic, and inside ID_OK: a re-run rewrites the same booking.
  function fnv(str, seed) {
    let h = seed >>> 0;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h.toString(16).padStart(8, '0');
  }
  const icalBookingId = e => 'ics_' + fnv(e.feed_id + '|' + e.uid, 2166136261) + fnv(e.uid + '|' + e.feed_id, 33554467);
  const placeholder = platform => `${platform} guest`;

  function importNotes(e) {
    if (e.platform === 'Airbnb') {
      const url = (/(https:\/\/\S*airbnb\S*\/reservations\/\S+)/i.exec(e.description || '') || [])[1];
      const last4 = (/Last 4 Digits\)?:\s*(\d{4})/i.exec(e.description || '') || [])[1];
      return ['Imported from the Airbnb calendar.', url ? `Reservation: ${url}` : '',
              last4 ? `Guest phone ends ${last4}.` : ''].filter(Boolean).join('\n');
    }
    return `Imported from the ${e.platform} calendar. The feed carries no name or amount; fill them in.`;
  }

  // Pure: what the events mean for these bookings. Exposed for the tests.
  //  • Airbnb "Reserved" first: those are certainly stays.
  //  • Then Booking.com, whose events are all "CLOSED - Not available".
  //  • Airbnb blocks last, and they never create a booking: with the two
  //    calendars connected, a block is usually a Booking.com stay seen from
  //    Airbnb's side, or dates closed by hand.
  // An event whose property and exact dates match a live booking is linked to
  // it instead of becoming a second booking. That one rule covers mirrors from
  // the other platform and stays already typed in by hand.
  function planIcal(events, data, today) {
    const bookings = (data.bookings || []).map(b => ({ ...b }));   // copies: the plan writes nothing itself
    const byId = new Map(bookings.map(b => [b.id, b]));
    const props = new Set((data.properties || []).map(p => p.id));
    const rank = e => e.platform === 'Airbnb' && e.kind === 'reserved' ? 0 : e.kind === 'reserved' ? 1 : 2;
    const order = (events || []).slice().sort((a, b) => rank(a) - rank(b) ||
      String(a.start_date).localeCompare(String(b.start_date)) || String(a.uid).localeCompare(String(b.uid)));
    const plan = { create: [], update: [], stamp: [], counts: {
      events: order.length, created: 0, linked: 0, updated: 0, gone: 0, blocks: 0, past: 0, removed: 0, held: 0 } };
    const C = plan.counts;
    const sameStay = e => bookings.find(b => b.status !== 'cancelled' && b.propertyId === e.property_id &&
      b.checkIn === e.start_date && b.checkOut === e.end_date);
    const patch = (id, fields) => {
      const b = byId.get(id); Object.assign(b, fields);
      const u = plan.update.find(x => x.id === id);
      u ? Object.assign(u.fields, fields) : plan.update.push({ id, fields: { ...fields } });
    };

    for (const e of order) {
      const own = icalBookingId(e);
      if (e.imported_booking_id) {
        const b = byId.get(e.imported_booking_id);
        if (!b) { C.removed++; continue; }               // deleted on purpose; stays deleted
        if (b.id !== own) continue;                      // linked to a mirror or a hand-entered stay
        if (!e.gone_at && (b.checkIn !== e.start_date || b.checkOut !== e.end_date)) {
          patch(b.id, { checkIn: e.start_date, checkOut: e.end_date, icalMoved: today }); C.updated++;
        }
        if (e.gone_at && !b.icalGone && b.status !== 'cancelled') { patch(b.id, { icalGone: true }); C.gone++; }
        if (!e.gone_at && b.icalGone) patch(b.id, { icalGone: false });
        continue;
      }
      if (e.gone_at) continue;
      if (!(e.end_date > today)) { C.past++; continue; }   // history is not imported
      if (!props.has(e.property_id)) { C.held++; continue; }
      const already = byId.get(own);                     // made earlier; only the stamp failed
      const match = already || sameStay(e);
      if (match) {
        // A stay first seen through Booking.com's mirror of Airbnb, still untouched,
        // takes the right name once Airbnb's own event arrives.
        if (match.id !== own && e.platform === 'Airbnb' && e.kind === 'reserved' &&
            /^ics_/.test(match.id) && match.source !== 'Airbnb' && match.guestName === placeholder(match.source)) {
          patch(match.id, { source: 'Airbnb', guestName: placeholder('Airbnb'), notes: importNotes(e) });
        }
        plan.stamp.push({ feed_id: e.feed_id, uid: e.uid, booking_id: match.id });
        if (!already) C.linked++;
        continue;
      }
      if (e.kind === 'blocked') { C.blocks++; continue; }
      const b = {
        id: own, propertyId: e.property_id, guestName: placeholder(e.platform), phone: '',
        checkIn: e.start_date, checkOut: e.end_date, guests: 1, totalAmount: '', paid: '',
        source: e.platform, status: 'confirmed', notes: importNotes(e),
        idProofType: '', idProofNumber: '', idProofImage: '', importedOn: today,
      };
      plan.create.push(b); bookings.push(b); byId.set(b.id, b);
      plan.stamp.push({ feed_id: e.feed_id, uid: e.uid, booking_id: b.id });
      C.created++;
    }

    // Per feed, worked out from the events and the bookings as they now stand,
    // so the figures are the same whichever sync computed them:
    //   added   — bookings this feed created (including any deleted since)
    //   updated — of those, how many the feed has moved to new dates
    //   removed — stays the feed no longer lists (flagged on their bookings)
    //   matched — events linked to a booking that was already there
    //   deleted — bookings it created that were deleted here, and stay deleted
    // run.* is what this sync itself changed.
    const stampOf = new Map(plan.stamp.map(x => [x.feed_id + '|' + x.uid, x.booking_id]));
    const createdIds = new Set(plan.create.map(b => b.id));
    const moved = new Set(plan.update.filter(u => 'checkIn' in u.fields).map(u => u.id));
    const flagged = new Set(plan.update.filter(u => u.fields.icalGone === true).map(u => u.id));
    plan.feeds = {};
    for (const e of order) {
      const F = plan.feeds[e.feed_id] = plan.feeds[e.feed_id] || { events: 0, added: 0, updated: 0, removed: 0,
        matched: 0, deleted: 0, blocks: 0, run: { added: 0, updated: 0, removed: 0 } };
      F.events++;
      const bid = e.imported_booking_id || stampOf.get(e.feed_id + '|' + e.uid);
      if (!bid) { if (e.kind === 'blocked' && !e.gone_at) F.blocks++; continue; }
      const b = byId.get(bid);
      if (bid === icalBookingId(e)) {
        F.added++;
        if (!b) F.deleted++;
        else if (b.icalMoved) F.updated++;
        if (createdIds.has(bid)) F.run.added++;
        if (moved.has(bid)) F.run.updated++;
        if (flagged.has(bid)) F.run.removed++;
      } else F.matched++;
      if (e.gone_at && b) F.removed++;
    }
    return plan;
  }

  // Nothing here may break the push: before ical.sql has been run the table
  // does not exist, and that is a normal state, not an error to show.
  async function drainIcal(c, owner, data) {
    try {
      const { data: events, error } = await c.from('ical_events').select(ICAL_COLS).eq('owner_id', owner);
      if (error) {
        const missing = /does not exist|schema cache|PGRST205|42P01/i.test(`${error.code || ''} ${error.message || ''}`);
        icalLog = missing ? null : { ...(icalLog || {}), at: new Date().toISOString(), error: 'Could not read the calendars — ' + error.message };
        if (icalLog) saveLog(ICAL_LOG_KEY, icalLog); else try { localStorage.removeItem(ICAL_LOG_KEY); } catch {}
        return false;
      }
      const plan = planIcal(events || [], data, localToday());
      let wrote = false;
      if ((plan.create.length || plan.update.length) && window.STAYLOG_APPLY) {
        wrote = window.STAYLOG_APPLY(d => {
          d.bookings = d.bookings || [];
          for (const b of plan.create) if (!d.bookings.some(x => x.id === b.id)) d.bookings.push({ ...b });
          for (const u of plan.update) { const b = d.bookings.find(x => x.id === u.id); if (b) Object.assign(b, u.fields); }
        });
        if (!wrote) {
          icalLog = { ...(icalLog || {}), at: new Date().toISOString(), ...plan.counts, error: 'The imported bookings could not be written to this phone.' };
          saveLog(ICAL_LOG_KEY, icalLog);
          return false;
        }
      }
      // Stamp last, as attendance does: if it fails, the next run finds the
      // booking by its id and only retries the stamp.
      let stampErr = '';
      for (const s of plan.stamp) {
        const { error: e2 } = await c.from('ical_events').update({ imported_booking_id: s.booking_id })
          .eq('owner_id', owner).eq('feed_id', s.feed_id).eq('uid', s.uid);
        if (e2) stampErr = e2.message || String(e2);
      }
      const at = new Date().toISOString();
      const before = (icalLog && icalLog.feeds) || {};
      const feeds = {};
      for (const [fid, F] of Object.entries(plan.feeds)) {
        const changed = F.run.added || F.run.updated || F.run.removed;
        feeds[fid] = { ...F, lastChange: changed ? { at, ...F.run } : (before[fid] && before[fid].lastChange) || null };
      }
      icalLog = { at, ...plan.counts, feeds,
        error: stampErr ? 'Imported, but could not mark it done in the cloud — ' + stampErr : '' };
      saveLog(ICAL_LOG_KEY, icalLog);
      return wrote;
    } catch (err) {
      icalLog = { ...(icalLog || {}), at: new Date().toISOString(), error: 'Could not read the calendars — ' + ((err && err.message) || err) };
      saveLog(ICAL_LOG_KEY, icalLog);
      return false;
    }
  }

  // Feed links live only in the cloud: they are read by the function there.
  async function listFeeds() {
    if (!session) throw new Error('not signed in');
    const c = await client();
    const { data, error } = await c.from('ical_feeds')
      .select('id,property_id,platform,url,last_fetched_at,last_ok_at,last_error,last_count')
      .eq('owner_id', session.user.id);
    if (error) throw error;
    return data || [];
  }
  async function saveFeed(propertyId, platform, url) {
    if (!session) throw new Error('not signed in');
    const c = await client();
    const owner = session.user.id;
    url = String(url || '').trim();
    if (!url) {
      const { error } = await c.from('ical_feeds').delete()
        .eq('owner_id', owner).eq('property_id', propertyId).eq('platform', platform);
      if (error) throw error;
      return null;
    }
    if (!/^https:\/\//i.test(url)) throw new Error('The link should start with https://');
    const { error } = await c.from('ical_feeds')
      .upsert([{ owner_id: owner, property_id: propertyId, platform, url }], { onConflict: 'owner_id,property_id,platform' });
    if (error) throw error;
    return true;
  }
  // Asks the function to read this owner's feeds now, then syncs, which
  // brings whatever it found onto the phone.
  async function importNow() {
    if (!session) throw new Error('not signed in');
    const c = await client();
    const { data, error } = await c.functions.invoke('ical-sync', { body: {} });
    if (error) throw new Error(error.message || 'The calendar import could not be reached.');
    const d = window.STAYLOG_GET_DATA && window.STAYLOG_GET_DATA();
    if (d) await push(d, { manual: true });
    return data;
  }

  // ── The safety brake ───────────────────────────────────────────────────────
  // The tombstone pass deletes whatever the server has and this phone lacks.
  // That is right when he deletes a booking, and a disaster when the phone's
  // data is wrong — a new phone that has not been filled yet, a bad restore,
  // a half-loaded state. So before anything is written, the deletions are
  // counted, and an unusual number is put to him first.
  const BRAKE_ROWS = 5;        // more than this many rows in one sync
  const BRAKE_SHARE = 0.2;     // or more than this share of any one table
  const LABEL = { properties: 'properties', staff: 'staff', loans: 'loans',
    loan_repayments: 'loan repayments', expenses: 'expenses', bookings: 'bookings' };
  const ONE = { properties: 'property', staff: 'staff', loans: 'loan',
    loan_repayments: 'loan repayment', expenses: 'expense', bookings: 'booking' };

  async function plannedTombstones(c, owner, up) {
    const plan = [];
    for (const table of ORDER) {
      const { data: live, error } = await c.from(table).select('id')
        .eq('owner_id', owner).is('deleted_at', null);
      if (error) throw error;
      const keep = new Set(up[table].map(r => r.id));
      const gone = (live || []).map(r => r.id).filter(id => !keep.has(id));
      if (gone.length) plan.push({ table, count: gone.length, of: (live || []).length, ids: gone.sort() });
    }
    return plan;
  }
  function overLimit(plan) {
    const total = plan.reduce((t, p) => t + p.count, 0);
    return total > BRAKE_ROWS || plan.some(p => p.count / p.of > BRAKE_SHARE);
  }
  function describe(plan) {
    const lines = plan.map(p => `• ${p.count} of ${p.of} ${LABEL[p.table] || p.table} (${Math.round(p.count / p.of * 100)}%)`);
    return 'This sync would delete from the cloud:\n' + lines.join('\n') +
      '\n\nThat is more than usual, so nothing has been changed yet. ' +
      'If this phone is new or was just restored, choose Cancel and use ' +
      '"Replace this phone from the cloud" instead.\n\n' +
      'OK deletes them (they stay recoverable in SQL). Cancel stops this sync.';
  }

  async function push(data, opts) {
    opts = opts || {};
    if (!session) throw new Error('not signed in');
    // Two pushes can now overlap — opening the app starts one, and an edit a
    // moment later starts another. Dropping the second would leave the newer
    // state unsent until something else happened to trigger a sync, so it is
    // remembered and run once the first is done.
    if (pushing) { queued = true; return; }
    pushing = true;
    const owner = session.user.id;
    const c = await client();
    try {
      // Before pushing, not after: expenses born from her marks have to go up
      // in this same cycle, or the tombstone pass below would see rows the
      // server has and this phone does not.
      const drained = await drainAttendance(c, owner, data).catch(() => false);
      if (drained) data = (window.STAYLOG_GET_DATA && window.STAYLOG_GET_DATA()) || data;
      // Same reason: imported bookings go up in this cycle, not after it.
      const imported = await drainIcal(c, owner, data).catch(() => false);
      if (imported) data = (window.STAYLOG_GET_DATA && window.STAYLOG_GET_DATA()) || data;
      const sets = collect(data);
      const up = {};
      for (const table of ORDER) up[table] = (sets[table] || [])
        .filter(x => ID_OK.test(String(x.id || ''))).map(x => MAP[table].up(x, owner));

      // Counted before anything is written, so a refusal leaves the cloud as it was.
      const plan = await plannedTombstones(c, owner, up);
      if (overLimit(plan)) {
        const sig = plan.map(p => p.table + ':' + p.ids.join(',')).join('|');
        // A background sync does not ask twice about deletions already refused;
        // Sync now always asks.
        const ask = opts.manual || sig !== declinedSig;
        let yes = false;
        if (ask && typeof window.STAYLOG_CONFIRM_TOMBSTONE === 'function') {
          try { yes = !!(await window.STAYLOG_CONFIRM_TOMBSTONE({ plan, message: describe(plan) })); }
          catch { yes = false; }
        }
        if (!yes) {
          if (ask) declinedSig = sig;
          brake = plan.map(({ table, count, of }) => ({ table, count, of }));
          const what = brake.map(p => `${p.count} ${(p.count === 1 ? ONE : LABEL)[p.table] || p.table}`).join(', ');
          throw new Error(`Sync paused — it would delete ${what}. Nothing was changed. Tap Sync now to review.`);
        }
      }
      brake = null; declinedSig = '';

      for (const table of ORDER) {
        const rows = up[table];
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
      if (queued) {
        queued = false;
        setTimeout(() => {
          const d = window.STAYLOG_GET_DATA && window.STAYLOG_GET_DATA();
          if (d) push(d).catch(() => {});
        }, 0);
      }
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
      dirty, pushing, lastSync: last, lastError, brake, icalLog, heldMarks: held, attError, attLog, attLast,
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
    listFeeds, saveFeed, importNow,
    _planIcal: planIcal, _icalBookingId: icalBookingId,   // for the tests
    onChange: fn => listeners.push(fn),
    staffEmail: u => `${String(u || '').trim().toLowerCase()}@${CFG.staffEmailDomain}`,
  };
})();
