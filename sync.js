/* StayLog — the new sync engine (revamp phase 2). DORMANT until switch-over.
 *
 * Supabase becomes the source of truth (schema `stay`). Each device keeps a
 * local copy for speed and offline use, and syncs row by row:
 *   - local-first: the app edits its own copy at once (state.data, as now).
 *     The outbox is worked out, never kept by hand: every row is compared with
 *     the copy of it last seen on the server (`base`), field by field.
 *   - push: only the fields this device changed go up, through
 *     stay.apply_change(table, fields, base_version): they land only on the
 *     version they were edited from.
 *   - merge, field by field: when the server moved on (another device saved
 *     the same row), fields only one side changed are both kept; a field both
 *     changed differently is a conflict — the server's value stands and this
 *     device keeps its own to Reapply. Nothing is silently lost, and a money
 *     field is never overwritten blind (those conflicts are flagged as money).
 *   - pull: rows changed since the last pull (with a 2-minute overlap, merged
 *     by version, so a row committed late is not missed), deleted ones too.
 *   - no whole-state push and no deleting by absence: a row is deleted only
 *     because this device deleted it, as a soft delete, and more than 5 at once
 *     wait for a "Sync now" to ask first. Bookings are never deleted.
 *   - a new device signs in and pulls everything.
 * Local state (bases, cursors, conflicts) lives in IndexedDB `staylog_stay`,
 * one record per (user, account); the old app's keys are never touched here.
 *
 * Active only when localStorage `staylog_model` says {mode:'stay', user,
 * account} — set by the switch-over (phase 3). Until then nothing here runs,
 * and cloud.js syncs exactly as before.
 */
(function () {
  'use strict';
  const MODEL_KEY = 'staylog_model';
  const DB = 'staylog_stay', STORE = 'state';
  const PULL_OVERLAP_MS = 2 * 60 * 1000;
  const DELETE_BRAKE = 5;
  const POLL_MS = 60 * 1000;

  // ── Phone object ⇄ stay row ────────────────────────────────────────────────
  // [phone key, column, type, notNull]. A notNull column left empty on the
  // phone is not sent (the server's default stands). Anything the phone holds
  // that is not listed here goes into `legacy` — kept, never dropped — and a
  // value the column cannot hold as it is (a date that is not a date, a number
  // typed as text) is kept there too, under legacy.$orig, so a round trip
  // gives back exactly what was there.
  const SPEC = {
    properties: [
      ['name', 'name', 'text', true], ['location', 'address', 'text'], ['city', 'city', 'text'],
      ['mapsLink', 'maps_link', 'text'], ['rooms', 'rooms', 'int'], ['rentedAsWholeUnit', 'rented_as_whole_unit', 'bool', true],
      ['pricePerNight', 'price_per_night', 'num'], ['description', 'notes', 'text'],
      ['checkinTime', 'checkin_time', 'time', true], ['checkoutTime', 'checkout_time', 'time', true],
      ['arrivalInstructions', 'arrival_instructions', 'text'], ['houseRules', 'house_rules', 'textarr', true],
      ['houseNotes', 'house_notes', 'text'], ['welcomeText', 'welcome_text', 'text'],
      ['wifiName', 'wifi_name', 'text'], ['wifiPassword', 'wifi_password', 'text'],
      ['upiId', 'upi_id', 'text'], ['upiPayee', 'upi_payee', 'text'], ['upiQr', 'upi_qr', 'text'],
      ['bankDetails', 'bank_details', 'text'], ['signature', 'signature', 'text'], ['signatureRatio', 'signature_ratio', 'num'],
      ['receiptPrefix', 'receipt_prefix', 'text'], ['cardPaymentLink', 'card_payment_link', 'text']],
    staff: [
      ['name', 'name', 'text', true], ['role', 'role', 'text'], ['phone', 'phone', 'text'], ['joinedOn', 'joined_on', 'date'],
      ['monthlySalary', 'monthly_salary', 'num'], ['dailyWage', 'daily_wage', 'num'], ['checkoutWage', 'checkout_wage', 'num'],
      ['utensilRate', 'utensil_rate', 'num'], ['active', 'active', 'bool', true], ['worksAt', 'works_at', 'textarr', true]],
    loans: [
      ['staffId', 'staff_id', 'text'], ['principal', 'principal', 'num', true], ['installmentAmount', 'installment_amount', 'num'],
      ['disbursedOn', 'disbursed_on', 'date'], ['firstDueDate', 'first_due_date', 'date'], ['status', 'status', 'text', true],
      ['writtenOffOn', 'written_off_on', 'date'], ['notes', 'notes', 'text']],
    bookings: [
      ['propertyId', 'property_id', 'text', true], ['guestName', 'guest_name', 'text'], ['phone', 'phone', 'text'],
      ['checkIn', 'check_in', 'date', true], ['checkOut', 'check_out', 'date', true], ['guests', 'guests', 'int'],
      ['source', 'source', 'text'], ['status', 'status', 'text', true], ['notes', 'notes', 'text'],
      ['totalAmount', 'total_amount', 'num'], ['paid', 'paid', 'num'], ['roundOff', 'round_off', 'num', true],
      ['roundOffHand', 'round_off_hand', 'bool', true], ['idProofType', 'id_proof_type', 'text'],
      ['idProofNumber', 'id_proof_number', 'text'], ['msgSent', 'msg_sent', 'json', true], ['receiptNo', 'receipt_no', 'text'],
      ['receiptOn', 'receipt_on', 'date'], ['importedOn', 'imported_on', 'date'], ['icalMoved', 'ical_moved', 'date'],
      ['icalMovedFrom', 'ical_moved_from', 'json'], ['icalGone', 'ical_gone', 'bool', true], ['gapClosed', 'gap_closed', 'json', true]],
    expenses: [
      ['propertyId', 'property_id', 'text'], ['date', 'date', 'date', true], ['category', 'category', 'text', true],
      ['description', 'description', 'text'], ['amount', 'amount', 'num', true], ['paid', 'paid', 'bool', true],
      ['paidOn', 'paid_on', 'date'], ['notes', 'notes', 'text'], ['staffId', 'staff_id', 'text'], ['loanId', 'loan_id', 'text'],
      ['loanDeduction', 'loan_deduction', 'num'], ['grossAmount', 'gross_amount', 'num'], ['autoAmount', 'auto_amount', 'num'],
      ['wageKind', 'wage_kind', 'text'], ['sourceMarkId', 'source_mark_id', 'text']],
    loan_repayments: [
      ['loanId', 'loan_id', 'text', true], ['date', 'date', 'date'], ['amount', 'amount', 'num', true],
      ['mode', 'mode', 'text', true], ['expenseId', 'expense_id', 'text'], ['note', 'note', 'text']],
  };
  // Phone-only: guest ID photos never leave the device (not even encrypted).
  const LOCAL_ONLY = { bookings: ['idProofImage'] };
  // Push order follows the foreign keys.
  const ORDER = ['properties', 'staff', 'loans', 'bookings', 'expenses', 'loan_repayments'];
  const COLL = { properties: 'properties', staff: 'staff', loans: 'loans', bookings: 'bookings', expenses: 'expenses' };
  const SERVER_ONLY = ['account_id', 'id', 'created_at', 'updated_at', 'updated_by', 'version'];
  // A conflict on one of these is flagged as money: always put to the person.
  const MONEY = {
    bookings: ['paid', 'total_amount', 'round_off', 'receipt_no', 'source', 'status'],
    expenses: ['amount', 'paid', 'loan_deduction', 'gross_amount'],
    loans: ['principal', 'installment_amount', 'status'], loan_repayments: ['amount'],
    staff: ['daily_wage', 'checkout_wage', 'utensil_rate', 'monthly_salary'],
  };

  const empty = v => v === undefined || v === null || v === '';
  const isDate = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(Date.parse(v + 'T00:00:00Z'));
  // phone value → [column value, held exactly?]
  function conv(type, v) {
    if (empty(v)) return [null, true];
    switch (type) {
      case 'text': return [String(v), typeof v === 'string'];
      case 'num': { const n = Number(v); return Number.isFinite(n) ? [n, typeof v === 'number'] : [null, false]; }
      case 'int': { const n = Number(v); return Number.isInteger(n) ? [n, typeof v === 'number'] : [null, false]; }
      case 'bool': return typeof v === 'boolean' ? [v, true] : [!!v && v !== 'false', false];
      case 'date': return isDate(v) ? [v, true] : [null, false];
      case 'time': return typeof v === 'string' && /^\d{2}:\d{2}$/.test(v) ? [v, true] : [null, false];
      case 'json': return typeof v === 'object' ? [JSON.parse(JSON.stringify(v)), true] : [null, false];
      case 'textarr': return Array.isArray(v) && v.every(x => typeof x === 'string') ? [v.slice(), true] : [null, false];
    }
    return [v, true];
  }
  // column value → phone value (an empty field is '' on the phone, as the app keeps it)
  function back(type, v) {
    if (v === null || v === undefined) return type === 'bool' ? false : type === 'json' ? null : type === 'textarr' ? [] : '';
    if (type === 'num' || type === 'int') return Number(v);
    if (type === 'time') return String(v).slice(0, 5);
    return v;
  }

  function toRow(table, item, account) {
    const spec = SPEC[table], row = { account_id: account, id: String(item.id) };
    const known = new Set(['id', 'deletedAt', ...spec.map(s => s[0]), ...(LOCAL_ONLY[table] || [])]);
    if (table === 'loans') known.add('repayments');
    const legacy = {}, orig = {};
    for (const [k, col, type, notNull] of spec) {
      if (!(k in item)) continue;
      const [val, exact] = conv(type, item[k]);
      if (!exact) orig[k] = item[k];
      if (val === null && notNull) continue;
      row[col] = val;
    }
    for (const k of Object.keys(item)) if (!known.has(k) && item[k] !== undefined) legacy[k] = item[k];
    if (Object.keys(orig).length) legacy.$orig = orig;
    row.legacy = Object.keys(legacy).length ? JSON.parse(JSON.stringify(legacy)) : null;
    row.deleted_at = item.deletedAt || null;
    return row;
  }
  function fromRow(table, row, local) {
    const item = { id: row.id };
    for (const [k, col, type] of SPEC[table]) if (col in row) item[k] = back(type, row[col]);
    const lg = row.legacy || {};
    for (const k of Object.keys(lg)) if (k !== '$orig') item[k] = lg[k];
    // The original spelling comes back only while the column still holds what
    // it meant: once another device changes the column, its value wins.
    for (const [k, v] of Object.entries(lg.$orig || {})) {
      const s = SPEC[table].find(x => x[0] === k);
      if (!s) { item[k] = v; continue; }
      const now = s[1] in row ? row[s[1]] : null;
      if (canonical(conv(s[2], v)[0]) === canonical(now) || (s[3] && conv(s[2], v)[0] === null && !(s[1] in row))) item[k] = v;
    }
    for (const k of LOCAL_ONLY[table] || []) if (local && local[k] !== undefined) item[k] = local[k];
    if (table === 'loans') item.repayments = (local && local.repayments) || [];
    if (table === 'loan_repayments') delete item.loanId;
    return item;
  }
  // A server row as this device would write it back unchanged.
  function formOf(table, row) {
    const item = fromRow(table, row, null);
    if (table === 'loan_repayments') item.loanId = row.loan_id;
    if (table === 'loans') delete item.repayments;
    const r = toRow(table, item, row.account_id);
    r.deleted_at = row.deleted_at || null;
    return r;
  }
  const canonical = v => JSON.stringify(v === undefined ? null : v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x))
    ? Object.keys(x).sort().reduce((o, key) => (o[key] = x[key], o), {}) : x);
  // Columns of `b` that differ from `a`. Only columns `b` states count: a
  // field the phone never had is not a change.
  const diff = (a, b) => Object.keys(b).filter(c => !SERVER_ONLY.includes(c) && canonical(b[c]) !== canonical(a ? a[c] : undefined));

  // The app's nested shape → flat rows, keyed 'table:id'.
  function flatten(data, account) {
    const out = {};
    for (const t of Object.keys(COLL)) for (const x of data[COLL[t]] || []) if (x && x.id) out[t + ':' + x.id] = toRow(t, x, account);
    for (const l of data.loans || []) for (const r of l.repayments || []) if (r && r.id)
      out['loan_repayments:' + r.id] = toRow('loan_repayments', { ...r, loanId: l.id }, account);
    return out;
  }
  const tableOf = k => k.slice(0, k.indexOf(':')), idOf = k => k.slice(k.indexOf(':') + 1);
  const clone = x => x == null ? x : JSON.parse(JSON.stringify(x));

  // Puts an item (or, with null, takes it out) of the app's nested shape.
  function putItem(data, table, id, item, loanId) {
    if (table === 'loan_repayments') {
      for (const l of data.loans || []) if (l.repayments) l.repayments = l.repayments.filter(x => String(x.id) !== String(id));
      if (!item) return true;
      const loan = (data.loans || []).find(l => String(l.id) === String(loanId));
      if (!loan) return false;
      (loan.repayments = loan.repayments || []).push(item);
      return true;
    }
    const list = data[COLL[table]] = data[COLL[table]] || [];
    const i = list.findIndex(x => String(x.id) === String(id));
    if (!item) { if (i >= 0) list.splice(i, 1); }
    else if (i >= 0) list[i] = item; else list.push(item);
    return true;
  }
  function getItem(data, table, id) {
    if (table === 'loan_repayments') {
      for (const l of data.loans || []) { const r = (l.repayments || []).find(x => String(x.id) === String(id)); if (r) return r; }
      return null;
    }
    return (data[COLL[table]] || []).find(x => String(x.id) === String(id)) || null;
  }
  function loanOf(data, repId) {
    for (const l of data.loans || []) if ((l.repayments || []).some(x => String(x.id) === String(repId))) return l.id;
    return null;
  }
  const rowOf = (data, table, id, account) => {
    const item = getItem(data, table, id);
    if (!item) return null;
    return toRow(table, table === 'loan_repayments' ? { ...item, loanId: loanOf(data, id) } : item, account);
  };

  // ── Local store ────────────────────────────────────────────────────────────
  let _db = null;
  const openDB = () => _db ? Promise.resolve(_db) : new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = e => { const d = e.target.result; if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE); };
    r.onsuccess = e => { _db = e.target.result; res(_db); }; r.onerror = () => rej(r.error);
  });
  const idb = (mode, fn) => openDB().then(d => new Promise((res, rej) => {
    const r = fn(d.transaction(STORE, mode).objectStore(STORE)); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  }));

  function model() {
    try { const m = JSON.parse(localStorage.getItem(MODEL_KEY) || 'null'); return m && m.mode === 'stay' && m.user && m.account ? m : null; }
    catch { return null; }
  }
  const nsOf = m => m ? `${m.user}:${m.account}` : '';

  // S: { data, base: {'table:id': {v, row, del}}, cursor: {table: iso}, conflicts,
  //      errors, held, stamps, events, lastPull, lastPush, lastError, oldestUnsent }
  let S = null, dirtyTimer = null, pollTimer = null, running = null, queued = null, started = false;
  const listeners = [], synced = [];
  const changed = () => { const s = status(); listeners.forEach(fn => { try { fn(s); } catch {} }); };
  const blank = () => ({ data: { properties: [], bookings: [], expenses: [], staff: [], loans: [] },
    base: {}, cursor: {}, conflicts: [], errors: [], held: 0, stamps: [], events: [],
    lastPull: null, lastPush: null, lastError: '', oldestUnsent: null });
  async function loadState() {
    const ns = nsOf(model());
    if (S && S._ns === ns) return S;
    const got = await idb('readonly', s => s.get(ns)).catch(() => null);
    S = Object.assign(blank(), got || {}); S._ns = ns;
    return S;
  }
  function persist() {
    if (!S || !S._ns) return Promise.resolve();
    const copy = clone(S); delete copy._ns;
    return idb('readwrite', s => s.put(copy, S._ns)).catch(() => {});
  }

  // ── The server, through the session cloud.js already holds ────────────────
  const C = () => window.StayLogCloud;
  async function stay() { const c = await C().client(); return c.schema('stay'); }
  const srv = {
    async pull(table, account, since) {
      const db = await stay(), rows = [];
      for (let from = 0; ; from += 1000) {
        let q = db.from(table).select('*').eq('account_id', account);
        if (since) q = q.gt('updated_at', since);
        const { data, error } = await q.order('updated_at', { ascending: true }).order('id', { ascending: true }).range(from, from + 999);
        if (error) throw error;
        rows.push(...(data || []));
        if (!data || data.length < 1000) return rows;
      }
    },
    async apply(table, row, base) {
      const db = await stay();
      const { data, error } = await db.rpc('apply_change', { p_table: table, p_row: row, p_base_version: base });
      if (error) throw error;
      return data;
    },
    async heartbeat(row) {
      const db = await stay();
      const { error } = await db.from('sync_status').upsert(row, { onConflict: 'account_id,device_id' });
      if (error) throw error;
    },
    async issueReceipt(account, id) {
      const db = await stay();
      const { data, error } = await db.rpc('issue_receipt', { p_account: account, p_booking: id });
      if (error) throw error;
      return data;
    },
    async booking(account, id) {
      const db = await stay();
      const { data, error } = await db.from('bookings').select('*').eq('account_id', account).eq('id', id);
      if (error) throw error;
      return (data || [])[0] || null;
    },
    async events(account) {
      const db = await stay();
      const { data, error } = await db.from('ical_events').select('*').eq('account_id', account);
      if (error) throw error;
      return data || [];
    },
    // The server's import record (09-calendar.sql). Missing table, no row,
    // or not the owner: null — the phone then imports as before.
    async icalRun(account) {
      const db = await stay();
      const { data, error } = await db.from('ical_runs').select('last_run_at,result').eq('account_id', account);
      if (error) return null;
      return (data || [])[0] || null;
    },
    async feeds(account) {
      const db = await stay();
      const { data, error } = await db.from('ical_feeds').select('id,property_id,platform,last_ok_at,last_error,connected').eq('account_id', account);
      if (error) return null;
      return data || [];
    },
    async stamp(account, feed, uid, booking) {
      const db = await stay();
      const { error } = await db.from('ical_events').update({ imported_booking_id: booking })
        .eq('account_id', account).eq('feed_id', feed).eq('uid', uid);
      if (error) throw error;
    },
    async memberships() {
      const db = await stay();
      const { data, error } = await db.from('members').select('account_id,role,display_name,active,accounts(name,code)').eq('active', true);
      if (error) throw error;
      return data || [];
    },
  };

  async function rpc(name, args) {
    const db = await stay();
    const { data, error } = await db.rpc(name, args);
    if (error) throw new Error(error.message || String(error));
    return data;
  }

  // ── Merge one server row into the local copy ──────────────────────────────
  // Returns the fields this device still has to send (its own changes the
  // server does not have yet), or null when there are none.
  function conflictNote(table, id, fields, mine, theirs, why) {
    S.conflicts = S.conflicts.filter(c => !(c.table === table && c.id === id));
    S.conflicts.push({ table, id, why, at: new Date().toISOString(), fields,
      mine: Object.fromEntries(fields.map(f => [f, mine[f] === undefined ? null : clone(mine[f])])),
      theirs: Object.fromEntries(fields.map(f => [f, theirs[f] === undefined ? null : clone(theirs[f])])),
      money: why === 'deleted' ? false : fields.some(f => (MONEY[table] || []).includes(f)) });
  }
  function merge(table, row) {
    const k = table + ':' + row.id, b = S.base[k];
    const local = getItem(S.data, table, row.id);
    const mine = rowOf(S.data, table, row.id, row.account_id);
    const theirs = formOf(table, row);
    const gone = !!row.deleted_at && table !== 'bookings';
    S.base[k] = { v: row.version, row: theirs, del: gone };
    if (!mine) {
      if (b && !b.del && !gone) {
        // Deleted here. If another device changed it since, theirs is kept
        // (nothing lost) and the person is told; else the delete still goes up.
        if (diff(b.row, theirs).length) {
          conflictNote(table, row.id, ['deleted_at'], { deleted_at: 'deleted on this phone' }, { deleted_at: null }, 'deleted');
          putItem(S.data, table, row.id, fromRow(table, theirs, null), theirs.loan_id);
          return null;
        }
        return { deleted_at: new Date().toISOString() };
      }
      if (!gone) putItem(S.data, table, row.id, fromRow(table, theirs, null), theirs.loan_id);
      return null;
    }
    const mineChanged = b ? diff(b.row, mine) : diff(theirs, mine);
    const theirsChanged = b ? diff(b.row, theirs) : Object.keys(theirs);
    // Mine stands on fields only I changed; on fields we both changed to
    // different values, theirs stands and mine is kept to Reapply.
    const both = mineChanged.filter(c => theirsChanged.includes(c) && canonical(mine[c]) !== canonical(theirs[c]));
    const keep = mineChanged.filter(c => !both.includes(c) && canonical(mine[c]) !== canonical(theirs[c]));
    if (gone) {
      const lost = mineChanged.filter(c => canonical(mine[c]) !== canonical(theirs[c]) && c !== 'deleted_at');
      if (lost.length) conflictNote(table, row.id, lost, mine, theirs, 'deleted elsewhere');
      putItem(S.data, table, row.id, null);
      return null;
    }
    if (both.length) conflictNote(table, row.id, both, mine, theirs, b ? 'edited' : 'new');
    const merged = { ...theirs };
    for (const c of keep) merged[c] = mine[c];
    putItem(S.data, table, row.id, fromRow(table, merged, local), merged.loan_id);
    return keep.length ? Object.fromEntries(keep.map(c => [c, mine[c]])) : null;
  }

  // Her marks still waiting for a rate (no line yet): the server holds them
  // and makes the line once the rate is set. Shown on Home (v64).
  async function heldMarks(account) {
    try {
      const db = await stay(), out = [];
      for (const [table, kind] of [['attendance', 'attendance'], ['utensil_marks', 'utensils']]) {
        const { data, error } = await db.from(table).select('staff_id,date').eq('account_id', account).is('expense_id', null).is('deleted_at', null);
        if (error) return;                    // not allowed to see staff: nothing to show
        for (const r of data || []) out.push({ staff_id: r.staff_id, date: r.date, kind });
      }
      S.heldMarks = out;
    } catch {}
  }

  // What this login may do in the account (v65): role, each permission as
  // stay.can() decides it, and the properties a manager holds. Kept with the
  // local state so the screens stay right offline.
  async function myAccess(account) {
    try { const a = await rpc('my_access', { p_account: account }); if (a) S.me = a; } catch {}
    // v71: the account's own settings (currency, who pays directly, time
    // zone) and whether this login may invite new owners. Kept for offline.
    try { const db = await stay();
      const { data } = await db.from('accounts').select('name,code,time_zone,currency,pays_directly_sources,owner_name,migrated_from').eq('id', account);
      if (data && data[0]) S.settings = data[0]; } catch {}
    try { const pa = await rpc('am_platform_admin', {}); S.platformAdmin = pa === true; } catch {}
    // v73: the Terms and Privacy Policy versions this login has not accepted
    // (11-legal.sql; before it has run, nothing is asked).
    try { const lp = await rpc('legal_pending', {}); S.legalPending = Array.isArray(lp) ? lp : []; } catch {}
    // v74: the plan and whether this account can be written (12-plans.sql;
    // Postgres decides, this is only for the app to show it). Kept offline.
    try { const ps = await rpc('account_state', { p_account: account }); if (ps) S.plan = ps; } catch {}
    // v75: billing (owners only: sales open?, the plan bought, cancelling,
    // an order waiting for Razorpay). Null for anyone else, or before 13.
    try { const bs = await rpc('billing_state', { p_account: account }); S.billing = bs || null; } catch {}
  }

  async function pull(account, touched) {
    for (const t of ORDER) {
      const since = S.cursor[t] ? new Date(Date.parse(S.cursor[t]) - PULL_OVERLAP_MS).toISOString() : null;
      const rows = await srv.pull(t, account, since);
      for (const row of rows) {
        const b = S.base[t + ':' + row.id];
        if (!(b && b.v === row.version)) { merge(t, row); touched.add(t + ':' + row.id); }
        if (!S.cursor[t] || row.updated_at > S.cursor[t]) S.cursor[t] = row.updated_at;
      }
    }
    S.lastPull = new Date().toISOString();
  }

  // What this device changed since it last saw each row.
  function outbox(account) {
    const rows = flatten(S.data, account), out = [];
    for (const t of ORDER) {
      for (const [k, row] of Object.entries(rows)) {
        if (tableOf(k) !== t) continue;
        const b = S.base[k];
        if (!b) out.push({ table: t, k, fields: row, base: null });
        else { const d = diff(b.row, row); if (d.length) out.push({ table: t, k, fields: Object.fromEntries(d.map(c => [c, row[c]])), base: b.v }); }
      }
      if (t === 'bookings') continue;                          // cancelled, never deleted
      for (const [k, b] of Object.entries(S.base)) {
        if (tableOf(k) !== t || b.del || rows[k]) continue;
        out.push({ table: t, k, fields: { deleted_at: new Date().toISOString() }, base: b.v, deletion: true });
      }
    }
    return out;
  }

  async function push(account, manual, touched) {
    let box = outbox(account);
    const dels = box.filter(x => x.deletion);
    S.held = 0;
    if (dels.length > DELETE_BRAKE) {
      const names = [...new Set(dels.map(d => d.table.replace('_', ' ')))].join(', ');
      const ask = manual && window.STAYLOG_CONFIRM_TOMBSTONE;
      const yes = ask ? ask({ message: `This would delete ${dels.length} records (${names}) for everyone on this account. ` +
        'They can be brought back. Go ahead?', manual: true }) : false;
      if (!yes) { box = box.filter(x => !x.deletion); S.held = dels.length; }
    }
    S.errors = [];
    for (const x of box) {
      const id = idOf(x.k);
      let fields = x.fields, base = x.base;
      for (let attempt = 0; attempt < 3 && fields; attempt++) {
        let res;
        try { res = await srv.apply(x.table, { account_id: account, id, ...fields }, base); }
        catch (e) { S.errors.push({ table: x.table, id, message: (e && e.message) || String(e) }); break; }
        if (res && res.status === 'ok') {
          const gone = !!res.row.deleted_at && x.table !== 'bookings';
          S.base[x.k] = { v: res.row.version, row: formOf(x.table, res.row), del: gone };
          const local = getItem(S.data, x.table, id);
          // Take the server's own additions (defaults, a stamped number)
          // while keeping every field this device holds.
          if (local && !gone) {
            const merged = { ...S.base[x.k].row, ...rowOf(S.data, x.table, id, account) };
            putItem(S.data, x.table, id, fromRow(x.table, merged, local), merged.loan_id);
            S.base[x.k].row = formOf(x.table, res.row);
          }
          touched.add(x.k);
          break;
        }
        if (res && res.status === 'conflict') {
          // Someone else saved this row first: merge field by field and try
          // again with what is left of mine, on top of their version.
          fields = merge(x.table, res.server); base = res.server.version; touched.add(x.k);
          continue;
        }
        S.errors.push({ table: x.table, id, message: 'The server did not take this change (not found, or not allowed for your login).' });
        break;
      }
    }
    S.lastPush = new Date().toISOString();
  }

  // ── Calendar import on the new tables ─────────────────────────────────────
  // From v68 the server makes the bookings (ical-sync, with the same rules);
  // its run record in stay.ical_runs says so, and the phone then only works
  // out what the Calendar sync panel shows: the per-feed figures, from the
  // events and bookings as they stand, and the "Still open on …" check. Until
  // the server has run once, the owner's phone imports as before: new stays become
  // bookings and go up through the ordinary outbox, and events are stamped
  // once their booking is on the server.
  async function drainIcal(account) {
    const cl = C(), plan = cl && cl._planIcal;
    if (!plan) return 0;
    let events;
    try { events = await srv.events(account); } catch { return 0; }
    S.events = events;
    const run = await srv.icalRun(account).catch(() => null);
    const today = (window.STAYLOG_TODAY && window.STAYLOG_TODAY()) || localToday();
    const p = plan(events, S.data, today);
    // A manager's phone never imports (it cannot stamp the events, and the
    // calendar is the owner's): the server, or the owner's phone, does.
    const owner = !S.me || S.me.role === 'owner';
    let made = 0;
    if (!run && owner) {
      S.data.bookings = S.data.bookings || [];
      for (const b of p.create) if (!S.data.bookings.some(x => x.id === b.id)) S.data.bookings.push({ ...b });
      for (const u of p.update) { const b = S.data.bookings.find(x => x.id === u.id); if (b) Object.assign(b, u.fields); }
      const seen = new Set((S.stamps || []).map(s => s.feed_id + '|' + s.uid));
      S.stamps = (S.stamps || []).concat(p.stamp.filter(s => !seen.has(s.feed_id + '|' + s.uid)));
      made = p.create.length + p.update.length;
    }
    // What the panel shows. The server's own record, when there is one, says
    // what its runs did and when; the per-feed totals are worked out here.
    const res = (run && run.result) || {};
    const feeds = {};
    for (const [fid, F] of Object.entries(p.feeds || {}))
      feeds[fid] = { ...F, lastChange: (res.feeds && res.feeds[fid] && res.feeds[fid].lastChange) || null };
    let cover = null;
    const feedRows = events.length ? await srv.feeds(account).catch(() => null) : [];
    if (feedRows && cl._coverageGaps) {
      const stamped = new Map(p.stamp.map(x => [x.feed_id + '|' + x.uid, x.booking_id]));
      const evs = events.map(e => ({ ...e, imported_booking_id: e.imported_booking_id || stamped.get(e.feed_id + '|' + e.uid) || null }));
      cover = cl._coverageGaps(evs, feedRows, S.data.bookings || [], today);
    }
    S.ical = run
      ? { server: true, at: run.last_run_at || null, created: res.created || 0, updated: res.updated || 0, gone: res.gone || 0, held: res.held || 0,
          error: res.error || '', feeds, gaps: cover ? cover.gaps : {}, proven: cover ? cover.proven : {} }
      : { server: false, at: new Date().toISOString(), ...p.counts, error: '', feeds, gaps: cover ? cover.gaps : {}, proven: cover ? cover.proven : {} };
    return made;
  }
  async function stampEvents(account) {
    const left = [];
    for (const s of S.stamps || []) {
      if (!S.base['bookings:' + s.booking_id]) { left.push(s); continue; }      // not on the server yet
      try { await srv.stamp(account, s.feed_id, s.uid, s.booking_id); } catch { left.push(s); }
    }
    S.stamps = left;
  }
  const localToday = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

  function deviceId() {
    try { let d = localStorage.getItem('staylog_device'); if (!d) { d = crypto.randomUUID(); localStorage.setItem('staylog_device', d); } return d; }
    catch { return 'unknown'; }
  }
  const deviceLabel = () => { const ua = navigator.userAgent || '';
    return /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android phone' : 'this browser'; };

  // ── One sync: pull, import, push, hand the result back to the app ─────────
  // The sync works on a copy. A row typed on the phone while it ran wins over
  // what the sync brought for it, and goes up next time (its old base is put
  // back, so it is merged against the server properly).
  async function syncNow(opts) {
    opts = opts || {};
    const m = model();
    if (!m) return;
    if (running) { queued = { manual: !!((queued && queued.manual) || opts.manual) }; return running; }
    const st = C() && C().status && C().status();
    await loadState();
    if (!st || !st.signedIn) { changed(); return; }
    if (st.userId && st.userId !== m.user) { S.lastError = 'Signed in as someone else — sign out and sign in again.'; changed(); return; }
    if (!navigator.onLine) { changed(); return; }
    // v77: an app older than public.app_status.min_version neither pulls nor
    // pushes (the old model's cloud.js always did this; the new model never
    // had). A later release can then change what a column holds without an
    // old copy pulling it in and overwriting the phone's data.
    try { if (C().refreshModel) await C().refreshModel(); } catch {}
    if (C().status && C().status().retired) { S.lastError = ''; changed(); return; }
    running = (async () => {
      const touched = new Set();
      let before = null, baseBefore = null;
      try {
        const app = window.STAYLOG_GET_DATA && window.STAYLOG_GET_DATA();
        if (app) S.data = clone(app);
        before = flatten(S.data, m.account);
        baseBefore = clone(S.base);
        await pull(m.account, touched);
        await heldMarks(m.account);
        await myAccess(m.account);
        await drainIcal(m.account);
        // v74: a read-only account sends nothing (Postgres would refuse it);
        // anything changed here waits, shown as not saved, until it can.
        if (!(S.plan && S.plan.can_write === false)) await push(m.account, opts.manual, touched);
        await stampEvents(m.account);
        S.lastError = '';
      } catch (e) {
        const msg = (e && e.message) || String(e);
        S.lastError = /Failed to fetch|NetworkError|network|Load failed/i.test(msg)
          ? 'Can’t reach the server — check the internet and try again.' : msg;
      } finally {
        if (before) handBack(m.account, touched, before, baseBefore);
        let pending = 0;
        try { pending = outbox(m.account).length; } catch {}
        S.oldestUnsent = pending ? (S.oldestUnsent || new Date().toISOString()) : null;
        await persist();
        if (!S.lastError) synced.forEach(fn => { try { fn(); } catch {} });
        if (!S.lastError) srv.heartbeat({ account_id: m.account, device_id: deviceId(), user_id: m.user, device_name: deviceLabel(),
          app_version: window.STAYLOG_APP_VERSION || null, last_pull_at: S.lastPull, last_push_at: S.lastPush,
          outbox: pending, conflicts: S.conflicts.length, oldest_unsent: S.oldestUnsent, updated_at: new Date().toISOString() }).catch(() => {});
        running = null; changed();
        if (queued) { const q = queued; queued = null; setTimeout(() => syncNow(q), 0); }
      }
    })();
    return running;
  }
  // Rows the sync changed go into the app's copy, unless the person changed
  // that row meanwhile: then theirs stays and the row's old base comes back.
  function handBack(account, touched, before, baseBefore) {
    const get = window.STAYLOG_GET_DATA, apply = window.STAYLOG_REPLACE_DATA;
    if (!get || !apply) return;
    const now = clone(get());
    const nowRows = flatten(now, account);
    const synced = flatten(S.data, account);
    for (const k of Object.keys(synced)) if (!before[k]) touched.add(k);      // made by the import
    let any = false;
    const keys = [...touched].sort((a, b) => ORDER.indexOf(tableOf(a)) - ORDER.indexOf(tableOf(b)));
    for (const k of keys) {
      const t = tableOf(k), id = idOf(k);
      if (canonical(before[k] || null) !== canonical(nowRows[k] || null)) {      // edited here meanwhile
        if (baseBefore[k]) S.base[k] = baseBefore[k]; else delete S.base[k];
        continue;
      }
      const item = clone(getItem(S.data, t, id));
      const local = getItem(now, t, id);
      if (item && t === 'bookings') for (const f of LOCAL_ONLY.bookings) if (local && local[f] !== undefined) item[f] = local[f];
      if (item && t === 'loans') item.repayments = (local && local.repayments) || item.repayments || [];
      if (canonical(item) === canonical(local)) continue;
      putItem(now, t, id, item, item && t === 'loan_repayments' ? loanOf(S.data, id) : null);
      any = true;
    }
    S.data = now;
    if (any) apply(clone(now));
  }

  function status() {
    const m = model();
    let pending = 0;
    try { if (m && S && S._ns === nsOf(m)) pending = outbox(m.account).length; } catch {}
    return { active: !!m, account: m && m.account, user: m && m.user, running: !!running,
      lastPull: S && S.lastPull, lastPush: S && S.lastPush, outbox: pending, held: (S && S.held) || 0,
      conflicts: (S && S.conflicts) || [], errors: (S && S.errors) || [], lastError: (S && S.lastError) || '',
      heldMarks: (S && S.heldMarks) || [], me: (S && S.me) || null,
      settings: (S && S.settings) || null, platformAdmin: !!(S && S.platformAdmin),
      legalPending: (S && S.legalPending) || [] };
  }

  window.StayLogSync = {
    isActive: () => !!model(),
    model,
    // Set by the switch-over (phase 3). Nothing else sets it.
    activate(user, account) { localStorage.setItem(MODEL_KEY, JSON.stringify({ mode: 'stay', user, account, at: new Date().toISOString() })); S = null; },
    // The rollback (the database says the old model is back).
    deactivate() { try { localStorage.removeItem(MODEL_KEY); } catch {} S = null; clearInterval(pollTimer); started = false; },
    onSynced: fn => synced.push(fn),
    // The app saved: send the changes a moment later.
    save() {
      if (!model()) return;
      clearTimeout(dirtyTimer);
      dirtyTimer = setTimeout(() => syncNow(), 4000);
      changed();
    },
    sync: syncNow,
    start() {
      if (!model()) return;
      syncNow();
      if (started) return;
      started = true;
      pollTimer = setInterval(() => { if (!document.hidden) syncNow(); }, POLL_MS);
      window.addEventListener('online', () => syncNow());
      window.addEventListener('focus', () => syncNow());
      document.addEventListener('visibilitychange', () => { if (!document.hidden) syncNow(); });
    },
    status,
    onChange: fn => listeners.push(fn),
    // Reapply: put this device's value back on those fields; it goes up next sync.
    reapply(table, id) {
      const c = S && S.conflicts.find(x => x.table === table && x.id === id);
      const m = model();
      if (!c || !m) return false;
      const get = window.STAYLOG_GET_DATA, apply = window.STAYLOG_REPLACE_DATA;
      const now = clone(get ? get() : S.data);
      if (c.why !== 'deleted') {
        const local = getItem(now, table, id);
        const row = rowOf(now, table, id, m.account) || clone((S.base[table + ':' + id] || {}).row);
        if (row) {
          for (const f of c.fields) row[f] = clone(c.mine[f]);
          putItem(now, table, id, fromRow(table, row, local), row.loan_id);
        }
      }
      S.conflicts = S.conflicts.filter(x => x !== c);
      S.data = now; persist();
      if (apply) apply(clone(now));
      changed();
      syncNow();
      return true;
    },
    dismiss(table, id) { if (!S) return; S.conflicts = S.conflicts.filter(x => !(x.table === table && x.id === id)); persist(); changed(); },
    // A receipt number comes from the server, in one transaction: two devices
    // issuing at once get different numbers.
    async issueReceipt(bookingId) {
      const m = model(); if (!m) throw new Error('Not switched over yet');
      await syncNow();                                       // the booking must be on the server first
      if (running) await running;
      const no = await srv.issueReceipt(m.account, bookingId);
      const row = await srv.booking(m.account, bookingId).catch(() => null);
      return { receiptNo: no, receiptOn: (row && row.receipt_on) || localToday() };
    },
    memberships: () => srv.memberships(),
    // Staff logins of this account (v64): who has one, its username, whether
    // it is on; changes go through the staff-login Edge Function.
    async staffLogins() {
      const m = model(); if (!m) return { logins: [], code: '' };
      const db = await stay();
      const [{ data: logins, error }, { data: acct }] = await Promise.all([
        db.from('staff_logins').select('staff_id,username,active').eq('account_id', m.account),
        db.from('accounts').select('code,owner_name').eq('id', m.account)]);
      if (error) throw new Error(error.message || String(error));
      return { logins: logins || [], code: (acct && acct[0] && acct[0].code) || '', ownerName: (acct && acct[0] && acct[0].owner_name) || '' };
    },
    async staffLogin(action, fields) {
      const m = model(); if (!m) throw new Error('Not switched over yet');
      const c = await C().client();
      const { data, error } = await c.functions.invoke('staff-login', { body: { action, account: m.account, ...fields } });
      if (error) {
        let msg = '';
        try { msg = (await error.context.json()).error || ''; } catch {}
        throw new Error(msg || (/404|not found/i.test(error.message || '') ? 'The staff-login function is not deployed yet.' : (error.message || 'That did not work.')));
      }
      return data;
    },
    // ── The team (v65): the owner's Team screen and the invite link ──────────
    team: () => { const m = model(); return rpc('team', { p_account: m.account }); },
    async invite({ label, propertyIds, permissions }) {
      const m = model(); if (!m) throw new Error('Not switched over yet');
      const bytes = crypto.getRandomValues(new Uint8Array(18));
      const code = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      const db = await stay();
      const { error } = await db.from('invites').insert({ code, account_id: m.account, role: 'manager', label: label || null,
        property_ids: propertyIds || [], permissions: permissions || {}, created_by: m.user });
      if (error) throw new Error(error.message || String(error));
      return code;
    },
    async withdrawInvite(code) {
      const m = model(); const db = await stay();
      const { error } = await db.from('invites').update({ expires_at: new Date().toISOString() }).eq('account_id', m.account).eq('code', code);
      if (error) throw new Error(error.message || String(error));
    },
    async setMember(userId, fields) {
      const m = model(); const db = await stay();
      const { error } = await db.from('members').update(fields).eq('account_id', m.account).eq('user_id', userId);
      if (error) throw new Error(/an owner/i.test(error.message || '') ? 'The account needs at least one owner.' : (error.message || String(error)));
    },
    async setMemberProperties(userId, ids) {
      const m = model(); const db = await stay();
      const { data: have, error: e0 } = await db.from('member_properties').select('property_id').eq('account_id', m.account).eq('user_id', userId);
      if (e0) throw new Error(e0.message || String(e0));
      const now = new Set((have || []).map(x => x.property_id)), want = new Set(ids);
      const gone = [...now].filter(x => !want.has(x)), add = [...want].filter(x => !now.has(x));
      if (gone.length) { const { error } = await db.from('member_properties').delete().eq('account_id', m.account).eq('user_id', userId).in('property_id', gone);
        if (error) throw new Error(error.message || String(error)); }
      if (add.length) { const { error } = await db.from('member_properties').insert(add.map(p => ({ account_id: m.account, user_id: userId, property_id: p })));
        if (error) throw new Error(error.message || String(error)); }
    },
    // Joining from a link: works before this phone has any account.
    async joinCall(body) {
      const c = await C().client();
      const { data, error } = await c.functions.invoke('team-invite', { body });
      if (error) {
        let msg = ''; try { msg = (await error.context.json()).error || ''; } catch {}
        throw new Error(msg || (/404|not found/i.test(error.message || '') ? 'That invite was not found.' : (error.message || 'That did not work.')));
      }
      return data;
    },
    // ⋯ → Account settings (owner). The database checks each value
    // (10-onboarding.sql): a real time zone, a currency code, at least one
    // source that pays directly; the account code never changes.
    async saveSettings(fields) {
      const m = model(); if (!m) throw new Error('Not switched over yet');
      const db = await stay();
      const keep = ['name', 'time_zone', 'currency', 'pays_directly_sources', 'owner_name'];
      const row = Object.fromEntries(Object.entries(fields || {}).filter(([k]) => keep.includes(k)));
      const { data, error } = await db.from('accounts').update(row).eq('id', m.account).select('name,code,time_zone,currency,pays_directly_sources,owner_name,migrated_from');
      if (error) throw new Error(/time zone/i.test(error.message || '') ? 'That time zone is not known.' : (error.message || String(error)));
      if (data && data[0]) { await loadState(); S.settings = data[0]; await persist(); changed(); }
      return data && data[0];
    },
    // Platform invites (a platform admin only): a link for a new owner.
    async platformInvites() {
      const db = await stay();
      const { data, error } = await db.from('platform_invites').select('code,label,created_at,expires_at,used_by,used_at,account_id')
        .order('created_at', { ascending: false });
      if (error) throw new Error(error.message || String(error));
      return data || [];
    },
    async platformInvite(label) {
      const m = model(); if (!m) throw new Error('Not switched over yet');
      const bytes = crypto.getRandomValues(new Uint8Array(18));
      const code = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      const db = await stay();
      const { error } = await db.from('platform_invites').insert({ code, label: label || null, created_by: m.user });
      if (error) throw new Error(error.message || String(error));
      return code;
    },
    async withdrawPlatformInvite(code) {
      const db = await stay();
      const { error } = await db.from('platform_invites').update({ expires_at: new Date().toISOString() }).eq('code', code);
      if (error) throw new Error(error.message || String(error));
    },
    // The Terms and Privacy Policy accepted in the app (v73).
    async acceptLegal(documents) {
      const left = await rpc('accept_legal', { p_documents: documents });
      await loadState(); S.legalPending = Array.isArray(left) ? left : []; await persist(); changed();
      return S.legalPending;
    },
    // v74: rule B — which properties stay active (owner)
    async chooseActive(ids) {
      const m = model(); if (!m) throw new Error('Not switched over yet');
      const st = await rpc('choose_active_properties', { p_account: m.account, p_active: ids });
      await loadState(); S.plan = st; await persist(); changed();
      return st;
    },
    // v75: paying for a plan. The order and the cancel go through the billing
    // Edge Function (Razorpay's keys are its secrets); the rest is read here.
    async billingPlans() {
      const db = await stay();
      const [{ data: plans, error }, { data: st }] = await Promise.all([
        db.from('plans').select('id,plan,period,amount_paise,currency,properties_allowed,active,sort').eq('active', true).order('sort'),
        db.from('platform_settings').select('billing_open,gst_enabled,gst_rate').eq('id', 1)]);
      if (error) throw new Error(error.message || String(error));
      return { plans: plans || [], settings: (st && st[0]) || {} };
    },
    async invoices() {
      const m = model(); if (!m) return [];
      const db = await stay();
      const { data, error } = await db.from('invoices').select('*').eq('account_id', m.account).order('issued_at', { ascending: false });
      if (error) throw new Error(error.message || String(error));
      return data || [];
    },
    async billingCall(action, fields) {
      const m = model(); if (!m) throw new Error('Not switched over yet');
      const c = await C().client();
      const { data, error } = await c.functions.invoke('billing', { body: { action, account: m.account, ...fields } });
      if (error) {
        let msg = '';
        try { msg = (await error.context.json()).error || ''; } catch {}
        throw new Error(msg || (/404|not found/i.test(error.message || '') ? 'The billing function is not deployed yet.' : (error.message || 'That did not work.')));
      }
      return data;
    },
    subscribe(plan) { return this.billingCall('subscribe', { plan }); },
    async cancelPlan() { const r = await this.billingCall('cancel', {}); await this.refreshPlan(); return r; },
    async refreshPlan() { const m = model(); if (!m) return; await loadState(); await myAccess(m.account); await persist(); changed(); },
    async saveGstin(gstin) {
      const m = model(); if (!m) return;
      const db = await stay();
      const { error } = await db.from('accounts').update({ gstin: gstin || null }).eq('id', m.account);
      if (error) throw new Error(/gstin_check/.test(error.message || '') ? 'That GSTIN does not look right (15 letters and digits).' : (error.message || String(error)));
      await this.refreshPlan();
    },
    billing: () => (S && S.billing) || null,
    // v77: support access (owner), the account's activity log, and the events
    // the app reports itself (an export, a restore). 15-privacy.sql.
    supportState() { const m = model(); return m ? rpc('support_state', { p_account: m.account }) : Promise.resolve(null); },
    grantSupport(days, note) { const m = model(); return rpc('grant_support', { p_account: m.account, p_days: days, p_note: note || null }); },
    revokeSupport() { const m = model(); return rpc('revoke_support', { p_account: m.account }); },
    async activity(limit) {
      const m = model(); if (!m) return [];
      const db = await stay();
      const { data, error } = await db.from('audit_log').select('at,actor,actor_kind,action,target,detail')
        .eq('account_id', m.account).order('at', { ascending: false }).limit(limit || 30);
      if (error) throw new Error(error.message || String(error));
      return data || [];
    },
    // best effort: a log line is never worth failing what it records
    async logEvent(action, detail) { const m = model(); if (!m) return; try { await rpc('log_event', { p_account: m.account, p_action: action, p_detail: detail || {} }); } catch {} },
    // v74: the platform admin's screen (no guest data)
    admin: {
      // v75: prices, sales and GST, billing per account
      async plans() { const db = await stay(); const { data, error } = await db.from('plans').select('*').order('sort');
        if (error) throw new Error(error.message || String(error)); return data || []; },
      async settings() { const db = await stay(); const { data, error } = await db.from('platform_settings').select('*').eq('id', 1);
        if (error) throw new Error(error.message || String(error)); return (data && data[0]) || null; },
      savePlan: p => rpc('admin_save_plan', { p_id: p.id, p_amount_paise: p.amount_paise, p_razorpay_plan_id: p.razorpay_plan_id,
        p_properties: p.properties_allowed, p_active: !!p.active }),
      saveSettings: s => rpc('admin_save_settings', { p: s }),
      billing: () => rpc('admin_billing', {}),
      supportAccounts: () => rpc('support_accounts', {}),
      supportRead: (account, table) => rpc('support_read', { p_account: account, p_table: table, p_limit: 50 }),
      accounts: () => rpc('admin_accounts', {}),
      extendTrial: (account, days) => rpc('admin_extend_trial', { p_account: account, p_days: days }),
      setPlan: (account, plan) => rpc('admin_set_plan', { p_account: account, p_plan: plan }),
      cancel: account => rpc('admin_cancel', { p_account: account }),
    },
    async setOwnerName(name) {
      const m = model(); if (!m) return;
      const db = await stay();
      const { error } = await db.from('accounts').update({ owner_name: String(name || '').trim() || null }).eq('id', m.account);
      if (error) throw new Error(error.message || String(error));
    },
    switchAccount(account) { const m = model(); if (!m) return; this.activate(m.user, account); },
    // the account's settings (v71), light: read on every render
    settings: () => (S && S.settings) || null,
    // v74: the plan state (null before 12-plans.sql, or in the old model)
    plan: () => (S && S.plan) || null,
    // v73: light, read on every render
    legalPending: () => (S && !S.platformAdmin && S.legalPending) || [],
    events: () => (S && S.events) || [],
    // the Calendar sync panel's figures in the new model (null until a sync has read them)
    icalLog: () => (S && S.ical) || null,
    migration: {
      // ⋯ → Move to the new system (phase 3). Each step can be run again.
      account: (name, code) => rpc('migration_account', { p_name: name, p_code: code }),
      // Every row of the phone, as it is (ID photos never), then rows an
      // earlier run wrote that the phone no longer has are taken out.
      async upload(account, data, onStep) {
        const flat = flatten(data, account), out = { written: 0, placeholders: [], pruned: 0 };
        for (const t of ORDER) {
          const rows = Object.entries(flat).filter(([k]) => tableOf(k) === t).map(([, r]) => r);
          for (let i = 0; i < rows.length; i += 200) {
            if (onStep) onStep(t, i, rows.length);
            const r = await rpc('migrate_rows', { p_account: account, p_table: t, p_rows: rows.slice(i, i + 200) });
            out.written += (r && r.written) || 0;
            if (r && r.placeholders) out.placeholders.push(...r.placeholders);
          }
          if (t !== 'bookings') out.pruned += Number(await rpc('migrate_prune', { p_account: account, p_table: t, p_ids: rows.map(r => r.id) })) || 0;
        }
        return out;
      },
      copy: account => rpc('migrate_copy', { p_account: account }),
      // Everything the server now holds, in the phone's shape (deleted rows
      // and placeholders left out), with this phone's own ID photos added.
      async snapshot(account, photosFrom) {
        const data = { properties: [], bookings: [], expenses: [], staff: [], loans: [] };
        const reps = [];
        for (const t of ORDER) {
          for (const row of await srv.pull(t, account, null)) {
            if (row.deleted_at) continue;
            if (t === 'loan_repayments') { reps.push(row); continue; }
            data[COLL[t]].push(fromRow(t, formOf(t, row), null));
          }
        }
        for (const row of reps) {
          const loan = data.loans.find(l => String(l.id) === String(row.loan_id));
          if (loan) loan.repayments.push(fromRow('loan_repayments', formOf('loan_repayments', row), null));
        }
        const photos = new Map(((photosFrom && photosFrom.bookings) || []).filter(b => b.idProofImage).map(b => [String(b.id), b.idProofImage]));
        for (const b of data.bookings) if (photos.has(String(b.id))) b.idProofImage = photos.get(String(b.id));
        return data;
      },
      // Row by row: what the phone has that the server lacks, what the server
      // has that the phone lacks, and rows whose fields differ.
      compareRows(phone, server, account) {
        const a = flatten(phone, account), b = flatten(server, account), out = { missing: [], extra: [], differ: [] };
        for (const k of Object.keys(a)) {
          if (!b[k]) out.missing.push(k);
          else { const d = diff(b[k], a[k]); if (d.length) out.differ.push({ k, fields: d }); }
        }
        for (const k of Object.keys(b)) if (!a[k]) out.extra.push(k);
        return out;
      },
      cutover: account => rpc('cutover', { p_account: account }),
    },
    // for the tests and the migration (phase 3)
    _toRow: toRow, _fromRow: fromRow, _formOf: formOf, _flatten: flatten, _diff: diff, SPEC, ORDER, LOCAL_ONLY,
    _srv: srv, _state: () => S, _reset: () => { S = null; running = null; queued = null; },
  };
})();
