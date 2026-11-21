/* Phase 7 (v68): the calendar import runs on the server.
   ical-sync, in the new model, reads the feeds in parallel (at most 5 at once,
   oldest-read first, none started after the deadline, at most 20 per account
   per run), plans each account's stored events against its bookings with the
   phone's own planIcal() rules, and creates or updates the bookings itself —
   an update only on the version it planned from. New stays are announced
   through notify and stamped announced_at, so a run cut short loses nothing.
   Import now is once in 5 minutes per account. One account failing never
   stops the others. Runs in Node against a fake Supabase; the parity part
   loads cloud.js's planIcal and compares it with the function's copy. */
const path = require('path'), fs = require('fs'), vm = require('vm');
const FN = path.resolve(__dirname, '../supabase/functions/ical-sync/index.ts');
let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (x !== undefined ? '  → ' + JSON.stringify(x) : ''))); };

// ── cloud.js's planIcal, loaded as the phone runs it ─────────────────────────
function phonePlanIcal() {
  const store = {};
  const ctx = { console, setTimeout, clearTimeout, Date, JSON, Math, Promise, URL, crypto: globalThis.crypto,
    localStorage: { getItem: k => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } },
    navigator: { onLine: true, userAgent: '' }, addEventListener() {}, document: { addEventListener() {}, visibilityState: 'visible' },
    location: { href: 'http://x/', hostname: 'x' } };
  ctx.window = ctx; vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../cloud.js'), 'utf8'), ctx);
  return { plan: ctx.StayLogCloud._planIcal, id: ctx.StayLogCloud._icalBookingId };
}

// ── a fake Supabase (PostgREST as the function uses it) ─────────────────────
const ACC = 'aaaaaaaa-0000-0000-0000-000000000001', ACC2 = 'bbbbbbbb-0000-0000-0000-000000000002';
const ICS = evs => ['BEGIN:VCALENDAR', 'VERSION:2.0', ...evs.flatMap(([uid, a, b, summary]) => ['BEGIN:VEVENT', 'UID:' + uid,
  `DTSTART;VALUE=DATE:${a.replace(/-/g, '')}`, `DTEND;VALUE=DATE:${b.replace(/-/g, '')}`, 'SUMMARY:' + summary, 'END:VEVENT']), 'END:VCALENDAR', ''].join('\r\n');
const RES = 'Reserved', BLOCK = 'Airbnb (Not available)', CLOSED = 'CLOSED - Not available';
const unq = v => v.replace(/^"|"$/g, '');
function cond(row, k, v) {
  const val = row[k];
  if (v === 'is.null') return val == null;
  if (v === 'is.true') return val === true;
  if (v.startsWith('in.(')) return v.slice(4, -1).split(',').map(x => unq(decodeURIComponent(x))).includes(String(val));
  if (v.startsWith('eq.')) return String(val) === decodeURIComponent(v.slice(3));
  if (v.startsWith('neq.')) return String(val) !== decodeURIComponent(v.slice(4));
  if (v.startsWith('lt.')) return val != null && String(val) < decodeURIComponent(v.slice(3));
  if (v.startsWith('gt.')) return val != null && String(val) > decodeURIComponent(v.slice(3));
  return true;
}
function match(row, q) {
  return q.every(([k, v]) => {
    if (['select', 'on_conflict', 'order', 'limit', 'offset'].includes(k)) return true;
    if (k === 'or') return v.slice(1, -1).split(',').some(p => { const i = p.indexOf('.'); return cond(row, p.slice(0, i), p.slice(i + 1)); });
    return cond(row, k, v);
  });
}
function world(o = {}) {
  const W = { model: o.model || 'stay', pub: { ical_feeds: [], ical_events: [] },
    stay: { accounts: [{ id: ACC, time_zone: 'Asia/Kolkata' }, { id: ACC2, time_zone: 'Asia/Kolkata' }],
      members: [{ account_id: ACC, user_id: 'u-owner', role: 'owner', active: true }, { account_id: ACC2, user_id: 'u-other', role: 'owner', active: true },
                { account_id: ACC, user_id: 'u-mgr', role: 'manager', active: true }],
      properties: [{ account_id: ACC, id: 'p1', deleted_at: null }, { account_id: ACC, id: 'p2', deleted_at: null }, { account_id: ACC2, id: 'q1', deleted_at: null }],
      bookings: [], ical_feeds: [], ical_events: [], ical_runs: [] },
    feeds: {}, delay: {}, posted: [], fetching: 0, maxFetching: 0, fetchedUrls: [], fail: {}, notifyDown: false, onBookingsRead: null, writes: [] };
  const res = (s, b) => new Response(b === undefined ? null : JSON.stringify(b), { status: s });
  W.fetch = async (url, init = {}) => {
    const u = new URL(url), m = (init.method || 'GET').toUpperCase(), h = init.headers || {};
    if (u.host === 'proj.supabase.co') {
      if (u.pathname === '/functions/v1/notify') {
        if (h['x-cron-secret'] !== 'push-secret') return res(401, {});
        if (W.notifyDown) return res(500, {});
        const body = JSON.parse(init.body); W.posted.push(body);
        // as notify does: each event looked at is settled
        for (const e of body.events) { const r = W.stay.ical_events.find(x => x.account_id === body.account && x.feed_id === e.feed_id && x.uid === e.uid);
          if (r && !r.announced_at) r.announced_at = 'by-notify'; }
        return res(200, { ok: true });
      }
      if (h.apikey !== 'service-key') return res(401, {});
      if (u.pathname === '/auth/v1/user') { const id = { 'tok-owner': 'u-owner', 'tok-mgr': 'u-mgr', 'tok-other': 'u-other' }[(h.Authorization || '').replace('Bearer ', '')];
        return id ? res(200, { id }) : res(401, {}); }
      const t = u.pathname.replace('/rest/v1/', '');
      if (t === 'app_status') return res(200, [{ id: 1, model: W.model }]);
      // v74: 12-plans.sql's answer (absent unless the test sets W.readOnly)
      if (t === 'rpc/accounts_can_write') {
        if (!W.readOnly) return res(404, { message: 'function not found' });
        return res(200, JSON.parse(init.body).p_accounts.map(a => ({ account_id: a, can_write: !W.readOnly.has(a) })));
      }
      if (t === 'rpc/trial_fingerprint') { (W.fp = W.fp || []).push(JSON.parse(init.body)); return res(200, { repeat: false }); }
      const S = h['Accept-Profile'] === 'stay' ? W.stay : W.pub, q = [...u.searchParams];
      if (S === W.pub) (W.touchedPublic = W.touchedPublic || []).push(m + ' ' + t);
      if (W.fail[t] && W.fail[t](m, u)) return res(500, { message: 'boom' });
      const T = S[t] = S[t] || [];
      if (m === 'GET') {
        let rows = T.filter(r => match(r, q));
        if (t === 'bookings' && W.onBookingsRead) { const fn = W.onBookingsRead; W.onBookingsRead = null; rows = rows.map(r => ({ ...r })); fn(); }
        const ord = u.searchParams.get('order'); if (ord) rows = rows.slice().sort((a, b) => String(a[ord.split('.')[0]]).localeCompare(String(b[ord.split('.')[0]])));
        const off = +(u.searchParams.get('offset') || 0), lim = u.searchParams.get('limit');
        rows = rows.slice(off, lim ? off + +lim : undefined);
        return res(200, rows.map(r => ({ ...r })));
      }
      if (m === 'POST') {
        const keys = u.searchParams.get('on_conflict').split(','), ignore = /ignore-duplicates/.test(h.Prefer || '');
        for (const r of JSON.parse(init.body)) {
          const i = T.findIndex(x => keys.every(k => x[k] === r[k]));
          W.writes.push({ t, m, r });
          if (i < 0) T.push({ ...r, ...(t === 'bookings' ? { version: 1, status: r.status || 'confirmed' } : {}) });
          else if (!ignore) Object.assign(T[i], r);
        }
        return res(201);
      }
      if (m === 'PATCH') {
        const p = JSON.parse(init.body), out = [];
        for (const r of T) if (match(r, q)) { Object.assign(r, p); if (t === 'bookings') r.version++; out.push({ ...r }); }
        W.writes.push({ t, m, p, n: out.length });
        return /representation/.test(h.Prefer || '') ? res(200, out) : res(204);
      }
      return res(400, {});
    }
    // a calendar link
    W.fetchedUrls.push(url);
    if (W.fail.feed && W.fail.feed(url)) throw new Error(`error sending request for url (${url}): connection reset`);
    W.fetching++; W.maxFetching = Math.max(W.maxFetching, W.fetching);
    await new Promise(r => setTimeout(r, W.delay[url] || 0));
    W.fetching--;
    return W.feeds[url] != null ? new Response(W.feeds[url], { status: 200 }) : new Response('', { status: 404 });
  };
  W.feed = (account, id, property, platform, extra = {}) => {
    const url = `https://${platform === 'Airbnb' ? 'www.airbnb.com/calendar/ical' : 'admin.booking.com/ical'}/${id}.ics?t=secret-${id}`;
    W.stay.ical_feeds.push({ account_id: account, id, property_id: property, platform, url, connected: false,
      last_ok_at: '2026-10-01T00:00:00Z', last_fetched_at: '2026-11-14T00:00:00Z', last_error: null, ...extra });
    return url;
  };
  W.booking = id => W.stay.bookings.find(b => b.id === id);
  W.ev = (feed, uid) => W.stay.ical_events.find(e => e.feed_id === feed && e.uid === uid);
  return W;
}
const ENV = { SUPABASE_URL: 'https://proj.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-key', ICAL_CRON_SECRET: 'ical-secret', PUSH_CRON_SECRET: 'push-secret' };
const CRON = { 'x-cron-secret': 'ical-secret' };
const NOW = Date.parse('2026-11-15T06:00:00Z');                       // 11:30 AM in India, 15 Nov
const post = h => new Request('https://proj.supabase.co/functions/v1/ical-sync', { method: 'POST', headers: { 'content-type': 'application/json', ...h }, body: '{}' });

(async () => {
  const F = await import(FN);
  let t0 = Date.now(), at = NOW;
  const clock = () => at + (Date.now() - t0);
  const run = async (W, h = CRON, opts = {}) => (await F.handle(post(h), ENV, W.fetch, { clock, ...opts })).json();
  const later = ms => { at += ms; };

  console.log('\n— the same rules as the phone (planIcal, word for word) —');
  { const phone = phonePlanIcal();
    let seed = 7; const rnd = n => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    const day = n => new Date(Date.UTC(2026, 10, 15 + n)).toISOString().slice(0, 10);
    let same = 0, diffs = [];
    for (let c = 0; c < 400; c++) {
      const feeds = [['fa', 'Airbnb', 'p1'], ['fb', 'Booking.com', 'p1'], ['fc', 'Airbnb', 'p2'], ['fx', 'Booking.com', 'p9']];
      const bookings = [], events = [];
      for (let i = 0; i < 1 + rnd(5); i++) { const a = rnd(30) - 8, n = 1 + rnd(4);
        bookings.push({ id: rnd(3) ? 'ics_' + rnd(9) + '' + i : 'typed' + i, propertyId: ['p1', 'p2'][rnd(2)], checkIn: day(a), checkOut: day(a + n),
          status: ['confirmed', 'cancelled', 'checkedin'][rnd(3)], source: ['Airbnb', 'Booking.com', 'Direct'][rnd(3)], guestName: ['Booking.com guest', 'Anita', 'Airbnb guest'][rnd(3)],
          icalGone: !!rnd(2), icalMoved: rnd(4) ? '' : day(-1) }); }
      for (let i = 0; i < 1 + rnd(7); i++) { const [fid, pl, prop] = feeds[rnd(4)], a = rnd(30) - 8, n = 1 + rnd(4);
        const e = { feed_id: fid, uid: 'u' + rnd(6) + '@' + fid, property_id: prop, platform: pl, start_date: day(a), end_date: day(a + n),
          kind: pl === 'Airbnb' && rnd(3) === 0 ? 'blocked' : 'reserved', gone_at: rnd(5) ? null : '2026-11-10T00:00:00Z', description: 'x' };
        if (events.some(x => x.feed_id === e.feed_id && x.uid === e.uid)) continue;
        const r = rnd(5); e.imported_booking_id = r === 0 ? phone.id(e) : r === 1 && bookings.length ? bookings[rnd(bookings.length)].id : r === 2 ? 'ics_gone' : null;
        if (rnd(4) === 0 && e.imported_booking_id === phone.id(e)) bookings.push({ id: phone.id(e), propertyId: prop, checkIn: day(a - 1), checkOut: day(a + n), status: 'confirmed', source: pl, guestName: pl + ' guest' });
        events.push(e); }
      const data = { properties: [{ id: 'p1' }, { id: 'p2' }], bookings };
      const A = JSON.stringify(phone.plan(JSON.parse(JSON.stringify(events)), JSON.parse(JSON.stringify(data)), day(0)));
      const B = JSON.stringify(F.planIcal(JSON.parse(JSON.stringify(events)), JSON.parse(JSON.stringify(data)), day(0)));
      A === B ? same++ : diffs.push(c);
    }
    ok('400 mixed cases: the server plans exactly as the phone (creates, links, moves, flags, counts, per feed)', same === 400, diffs.slice(0, 5));
    ok('the same booking ids', phone.id({ feed_id: 'f1', uid: 'abc@airbnb.com' }) === F.icalBookingId({ feed_id: 'f1', uid: 'abc@airbnb.com' })); }

  console.log('\n— a first read: imports, announces nothing —');
  const W = world();
  const A1 = W.feed(ACC, 'fa', 'p1', 'Airbnb', { last_ok_at: null, last_fetched_at: null });
  const B1 = W.feed(ACC, 'fb', 'p1', 'Booking.com', { last_ok_at: null, last_fetched_at: null });
  W.feeds[A1] = ICS([['a1@airbnb', '2026-12-01', '2026-12-04', RES], ['a2@airbnb', '2026-12-10', '2026-12-12', BLOCK], ['a0@airbnb', '2026-11-01', '2026-11-03', RES]]);
  W.feeds[B1] = ICS([['b1@booking', '2026-12-01', '2026-12-04', CLOSED]]);
  let r = await run(W);
  const own = id => F.icalBookingId(id);
  const bA1 = W.booking(own({ feed_id: 'fa', uid: 'a1@airbnb' }));
  ok('the future stay becomes a booking on the server', bA1 && bA1.account_id === ACC && bA1.property_id === 'p1' && bA1.check_in === '2026-12-01' && bA1.check_out === '2026-12-04', W.stay.bookings);
  ok('…as the phone made it: placeholder name, the platform, notes, imported today, no amount', bA1 && bA1.guest_name === 'Airbnb guest' && bA1.source === 'Airbnb' && bA1.status === 'confirmed'
    && /Imported from the Airbnb calendar/.test(bA1.notes) && bA1.imported_on === '2026-11-15' && bA1.guests === 1 && !('total_amount' in bA1) && !('paid' in bA1), bA1);
  ok('Booking.com\'s echo of it is linked, not a second booking', W.stay.bookings.length === 1 && W.ev('fb', 'b1@booking').imported_booking_id === bA1.id, W.stay.bookings.map(b => b.id));
  ok('an Airbnb block never makes a booking; a stay already over is not imported', !W.ev('fa', 'a2@airbnb').imported_booking_id && !W.ev('fa', 'a0@airbnb').imported_booking_id);
  ok('a first read announces nothing', W.posted.length === 0 && W.stay.ical_events.every(e => e.announced_at), W.posted);
  const run1 = W.stay.ical_runs.find(x => x.account_id === ACC);
  ok('the run is recorded for the panel: per feed Added, and the counts', run1 && run1.last_run_at && run1.result.created === 1 && run1.result.linked === 1
    && run1.result.feeds.fa.added === 1 && run1.result.feeds.fa.lastChange.added === 1 && run1.result.feeds.fb.matched === 1, run1 && run1.result);
  ok('the old tables are not touched (only app_status is read)', !(W.touchedPublic || []).length, W.touchedPublic);
  ok('the response names the account and feeds, and no link', r.accounts.length === 1 && r.feeds.length === 2 && !JSON.stringify(r).includes('secret-'), r);

  console.log('\n— later reads —');
  W.feeds[A1] = ICS([['a1@airbnb', '2026-12-01', '2026-12-04', RES], ['a2@airbnb', '2026-12-10', '2026-12-12', BLOCK], ['a3@airbnb', '2026-12-20', '2026-12-22', RES]]);
  W.feeds[B1] = ICS([['b1@booking', '2026-12-01', '2026-12-04', CLOSED], ['b3@booking', '2026-12-20', '2026-12-22', CLOSED], ['b4@booking', '2026-12-26', '2026-12-28', CLOSED]]);
  later(30 * 60e3); r = await run(W);
  const bA3 = W.booking(own({ feed_id: 'fa', uid: 'a3@airbnb' })), bB4 = W.booking(own({ feed_id: 'fb', uid: 'b4@booking' }));
  ok('a new Airbnb stay and a new Booking.com stay: both made', bA3 && bB4 && bB4.guest_name === 'Booking.com guest' && W.stay.bookings.length === 3, W.stay.bookings.map(b => b.id));
  ok('the other feed\'s echo of the Airbnb stay is linked, not doubled', W.ev('fb', 'b3@booking').imported_booking_id === bA3.id);
  const told = W.posted.flatMap(p => p.events.map(e => e.uid));
  ok('notify is asked about the two new stays, with their account — never the echo', W.posted.every(p => p.account === ACC) && told.sort().join() === 'a3@airbnb,b4@booking', W.posted);
  ok('the echo is settled as needing no push', !!W.ev('fb', 'b3@booking').announced_at && W.ev('fb', 'b3@booking').announced_at !== 'by-notify');
  W.posted = []; later(30 * 60e3); await run(W);
  ok('nothing is asked about twice', W.posted.length === 0, W.posted);

  console.log('\n— moved, gone, cancelled —');
  W.feeds[A1] = ICS([['a1@airbnb', '2026-12-02', '2026-12-05', RES], ['a2@airbnb', '2026-12-10', '2026-12-12', BLOCK]]);
  later(30 * 60e3); await run(W);
  let b = W.booking(bA1.id);
  ok('a stay the platform moved: new dates, the old ones kept, flagged today', b.check_in === '2026-12-02' && b.check_out === '2026-12-05' && b.ical_moved === '2026-11-15'
    && JSON.stringify(b.ical_moved_from) === JSON.stringify({ checkIn: '2026-12-01', checkOut: '2026-12-04' }), b);
  b = W.booking(bA3.id);
  ok('a stay that left the feed: flagged "No longer on…", never cancelled', W.ev('fa', 'a3@airbnb').gone_at && b.ical_gone === true && b.status === 'confirmed', b);
  // He cancels the moved stay on a phone; the platform moves it again, and the other feed echoes the new dates.
  Object.assign(W.booking(bA1.id), { status: 'cancelled' }); W.booking(bA1.id).version++;
  W.feeds[A1] = ICS([['a1@airbnb', '2026-12-06', '2026-12-08', RES], ['a2@airbnb', '2026-12-10', '2026-12-12', BLOCK]]);
  W.feeds[B1] = ICS([['b1x@booking', '2026-12-06', '2026-12-08', CLOSED], ['b3@booking', '2026-12-20', '2026-12-22', CLOSED], ['b4@booking', '2026-12-26', '2026-12-28', CLOSED]]);
  later(30 * 60e3); await run(W);
  b = W.booking(bA1.id);
  ok('a cancelled import stays cancelled: the feed moves nothing', b.status === 'cancelled' && b.check_in === '2026-12-02', b);
  ok('…and the echo on the new dates links to it, never re-created', W.ev('fb', 'b1x@booking').imported_booking_id === bA1.id && W.stay.bookings.length === 3, W.stay.bookings.map(x => [x.id, x.check_in]));
  // A booking deleted long ago (before v55): its event's stamp points at nothing.
  W.stay.ical_events.push({ account_id: ACC, feed_id: 'fa', uid: 'old@airbnb', property_id: 'p1', platform: 'Airbnb', start_date: '2026-12-14', end_date: '2026-12-16',
    kind: 'reserved', gone_at: null, imported_booking_id: 'ics_deleted', announced_at: '2026-10-01T00:00:00Z' });
  W.feeds[A1] = ICS([['a1@airbnb', '2026-12-06', '2026-12-08', RES], ['old@airbnb', '2026-12-14', '2026-12-16', RES]]);
  later(30 * 60e3); await run(W);
  ok('an event stamped to a booking that is gone stays gone', !W.stay.bookings.some(x => x.check_in === '2026-12-14'), W.stay.bookings.map(x => x.id));
  // The feed suddenly empty: nothing flagged.
  const before = JSON.stringify(W.stay.bookings);
  W.feeds[B1] = ICS([]);
  later(30 * 60e3); r = await run(W);
  ok('a feed that suddenly comes back empty flags nothing', JSON.stringify(W.stay.bookings) === before && !W.ev('fb', 'b4@booking').gone_at
    && /came back empty/.test(W.stay.ical_feeds.find(f => f.id === 'fb').last_error), W.stay.ical_feeds.find(f => f.id === 'fb'));

  console.log('\n— an edit made on a phone meanwhile wins —');
  { const W = world();
    const A = W.feed(ACC, 'fa', 'p1', 'Airbnb');
    W.feeds[A] = ICS([['m@airbnb', '2026-12-01', '2026-12-03', RES]]);
    await run(W);
    const id = own({ feed_id: 'fa', uid: 'm@airbnb' });
    W.feeds[A] = ICS([['m@airbnb', '2026-12-02', '2026-12-04', RES]]);
    // Between the function reading the bookings and writing, a phone saves the guest's name.
    W.onBookingsRead = () => { const x = W.booking(id); x.guest_name = 'Anita Rao'; x.version++; };
    later(30 * 60e3); const r = await run(W);
    ok('the move is not written over the newer version', W.booking(id).check_in === '2026-12-01' && W.booking(id).guest_name === 'Anita Rao' && r.accounts[0].skipped === 1, r.accounts[0]);
    later(30 * 60e3); await run(W);
    ok('…and the next run moves it, keeping the name', W.booking(id).check_in === '2026-12-02' && W.booking(id).guest_name === 'Anita Rao', W.booking(id)); }

  console.log('\n— no announcement lost —');
  { const W = world();
    const A = W.feed(ACC, 'fa', 'p1', 'Airbnb');
    W.feeds[A] = ICS([['n@airbnb', '2026-12-01', '2026-12-03', RES]]);
    W.notifyDown = true;
    await run(W);
    const e = W.ev('fa', 'n@airbnb');
    ok('notify out of reach: the booking is made, the event waits (announced_at empty)', W.booking(own(e)) && e.announced_at == null);
    W.notifyDown = false; later(30 * 60e3); await run(W);
    ok('the next run announces it', W.posted.length === 1 && W.posted[0].events[0].uid === 'n@airbnb' && e.announced_at === 'by-notify', W.posted);
    later(30 * 60e3); await run(W);
    ok('…once', W.posted.length === 1); }
  { const W = world();
    const A = W.feed(ACC, 'fa', 'p1', 'Airbnb');
    W.feeds[A] = ICS([['k@airbnb', '2026-12-01', '2026-12-03', RES]]);
    let once = true;
    W.fail.ical_events = (m, u) => { if (m === 'PATCH' && once && !u.searchParams.has('announced_at')) { once = false; return true; } return false; };
    const r = await run(W);
    ok('a run cut short after making the booking (the stamp failed): said so, nothing announced yet', /could not finish/.test(r.accounts[0].error) && W.posted.length === 0 && W.booking(own({ feed_id: 'fa', uid: 'k@airbnb' })), r.accounts[0]);
    later(30 * 60e3); await run(W);
    ok('the next run finds the booking by its id, stamps it and announces it once', W.stay.bookings.length === 1 && W.ev('fa', 'k@airbnb').imported_booking_id
      && W.posted.length === 1, { b: W.stay.bookings.length, posted: W.posted }); }
  { const W = world();
    const A = W.feed(ACC, 'fa', 'p1', 'Airbnb');
    W.feeds[A] = ICS([['typed@airbnb', '2026-12-01', '2026-12-03', RES]]);
    W.stay.bookings.push({ account_id: ACC, id: 'typed1', property_id: 'p1', check_in: '2026-12-01', check_out: '2026-12-03', status: 'confirmed', source: 'Direct', guest_name: 'Ravi', version: 1 });
    await run(W);
    ok('a stay he had typed in already: linked, not announced', W.ev('fa', 'typed@airbnb').imported_booking_id === 'typed1' && W.posted.length === 0 && W.ev('fa', 'typed@airbnb').announced_at); }

  console.log('\n— parallel, oldest first, within the deadline —');
  { const W = world();
    for (let i = 0; i < 8; i++) { const u = W.feed(ACC, 'f' + i, 'p1', 'Booking.com'); W.feeds[u] = ICS([]); W.delay[u] = 120; }
    const s = Date.now(); const r = await run(W);
    ok('8 links read at most 5 at once', W.maxFetching === 5, W.maxFetching);
    ok('…in parallel (well under 8 one after another)', Date.now() - s < 600 && r.feeds.every(f => f.ok), Date.now() - s); }
  { const W = world();
    const urls = [];
    for (let i = 0; i < 12; i++) { const u = W.feed(ACC, 'g' + String(i).padStart(2, '0'), 'p1', 'Booking.com', { last_fetched_at: `2026-11-14T00:${String(59 - i).padStart(2, '0')}:00Z` });
      W.feeds[u] = ICS([]); W.delay[u] = 150; urls.push(u); }
    const r = await run(W, CRON, { fetchDeadlineMs: 200 });
    const read = W.fetchedUrls.slice();
    ok('none started after the deadline: 10 read, 2 left for next time', read.length === 10 && r.feeds.filter(f => f.later).length === 2, r.feeds.map(f => [f.id, f.ok]));
    ok('oldest-read first', read[0] === urls[11] && !read.includes(urls[0]) && !read.includes(urls[1]), read.map(u => urls.indexOf(u)));
    W.fetchedUrls = []; later(30 * 60e3); await run(W, CRON, { fetchDeadlineMs: 200 });
    ok('the ones left over go first next time', W.fetchedUrls[0] === urls[1] || W.fetchedUrls[0] === urls[0], W.fetchedUrls.slice(0, 2).map(u => urls.indexOf(u))); }
  { const W = world();
    for (let i = 0; i < 22; i++) { const u = W.feed(ACC, 'h' + String(i).padStart(2, '0'), 'p1', 'Booking.com'); W.feeds[u] = ICS([]); }
    const r = await run(W);
    ok('at most 20 links of one account in a run; the rest wait their turn', W.fetchedUrls.length === 20 && r.feeds.filter(f => /more than 20/.test(f.error || '')).length === 2, W.fetchedUrls.length); }

  console.log('\n— Import now, once in 5 minutes —');
  { const W = world();
    const A = W.feed(ACC, 'fa', 'p1', 'Airbnb'); W.feeds[A] = ICS([]);
    const Bx = W.feed(ACC2, 'fq', 'q1', 'Airbnb'); W.feeds[Bx] = ICS([]);
    let r = await run(W, { authorization: 'Bearer tok-owner' });
    ok('the owner\'s Import now reads only their account\'s links', W.fetchedUrls.join() === A && r.accounts.length === 1 && r.accounts[0].account === ACC, W.fetchedUrls);
    W.fetchedUrls = []; later(60e3);
    r = await run(W, { authorization: 'Bearer tok-owner' });
    ok('again a minute later: not read; says when it can be', W.fetchedUrls.length === 0 && r.throttled && r.throttled[0].account === ACC
      && Date.parse(r.throttled[0].next_at) - clock() > 3 * 60e3, r);
    r = await run(W);
    ok('the half-hourly run is never held back', W.fetchedUrls.length === 2, W.fetchedUrls);
    W.fetchedUrls = []; later(5 * 60e3);
    await run(W, { authorization: 'Bearer tok-owner' });
    ok('after 5 minutes it runs again', W.fetchedUrls.join() === A, W.fetchedUrls);
    W.fetchedUrls = [];
    r = await run(W, { authorization: 'Bearer tok-mgr' });
    ok('a manager reads no calendar links', W.fetchedUrls.length === 0 && r.feeds.length === 0, r);
    r = await (await F.handle(post({}), ENV, W.fetch, { clock })).json();
    ok('no secret, no token: refused', r.error === 'not allowed'); }

  console.log('\n— each account on its own —');
  { const W = world();
    const A = W.feed(ACC, 'fa', 'p1', 'Airbnb'); W.feeds[A] = ICS([['s@airbnb', '2026-12-01', '2026-12-03', RES]]);
    const Bx = W.feed(ACC2, 'fq', 'q1', 'Airbnb'); W.feeds[Bx] = ICS([['t@airbnb', '2026-12-01', '2026-12-03', RES]]);
    W.fail.bookings = (m, u) => m === 'GET' && u.searchParams.get('account_id') === 'eq.' + ACC;
    const r = await run(W);
    ok('one account failing does not stop the others', W.stay.bookings.length === 1 && W.stay.bookings[0].account_id === ACC2 && /could not finish/.test(r.accounts.find(a => a.account === ACC).error), r.accounts);
    ok('…and its trouble is on its own run record', /could not finish/.test(W.stay.ical_runs.find(x => x.account_id === ACC).result.error)); }
  { const W = world();
    const A = W.feed(ACC, 'fa', 'p1', 'Airbnb');
    W.fail.feed = () => true;
    const r = await run(W);
    const f = W.stay.ical_feeds[0];
    ok('a failed read is recorded without the link (it is the password)', /connection reset/.test(f.last_error) && !f.last_error.includes('secret-') && !JSON.stringify(r).includes('secret-'), f.last_error); }

  console.log('\n— a read-only account (v74: its trial or plan has ended) —');
  { const W = world();
    const A = W.feed(ACC, 'fa', 'p1', 'Airbnb'); W.feeds[A] = ICS([['ok@airbnb', '2026-12-01', '2026-12-03', RES]]);
    const Bx = W.feed(ACC2, 'fq', 'q1', 'Airbnb'); W.feeds[Bx] = ICS([['ro@airbnb', '2026-12-01', '2026-12-03', RES]]);
    W.readOnly = new Set([ACC2]);
    const logs = []; const real = console.log; console.log = (...a) => logs.push(a.join(' '));
    let r; try { r = await run(W); } finally { console.log = real; }
    ok('its links are not read and it gets no bookings; the other account imports as usual',
      !W.fetchedUrls.includes(Bx) && W.fetchedUrls.includes(A) && W.stay.bookings.every(b => b.account_id === ACC) && W.stay.bookings.length === 1, W.fetchedUrls);
    ok('…and the reason is logged and in the answer', r.skipped && r.skipped[0].account === ACC2 && r.skipped[0].reason === 'read_only'
      && logs.some(l => /skipped — read-only/.test(l)), { skipped: r.skipped, logs }); }

  console.log('\n— one free trial per business (v75): the Airbnb listing —');
  { const W = world();
    const A = W.feed(ACC, '48151623', 'p1', 'Airbnb'); W.feeds[A] = ICS([]);
    const B = W.feed(ACC, 'bk1', 'p1', 'Booking.com'); W.feeds[B] = ICS([]);
    await (await F.handle(post(CRON), { ...ENV, FINGERPRINT_PEPPER: 'fake-pepper' }, W.fetch, { clock })).json();
    const sent = JSON.stringify(W.fp || []);
    ok('the listing goes as a keyed hash, once per account, Airbnb only', (W.fp || []).length === 1 && W.fp[0].p_account === ACC
      && W.fp[0].p_kind === 'airbnb_listing' && W.fp[0].p_hashes.length === 1 && /^[0-9a-f]{64}$/.test(W.fp[0].p_hashes[0]), W.fp);
    ok('…never the link, its token or the listing id', !sent.includes('48151623') && !sent.includes('secret-') && !sent.includes('airbnb.com'));
    ok('airbnbListing reads the id from a real-shaped link only', F.airbnbListing('https://www.airbnb.co.in/calendar/ical/48151623.ics?s=x') === '48151623'
      && F.airbnbListing('https://admin.booking.com/ical/48151623.ics') === null);
    const W2 = world(); const A2 = W2.feed(ACC, '48151623', 'p1', 'Airbnb'); W2.feeds[A2] = ICS([]);
    await run(W2);
    ok('no pepper set: nothing sent', !W2.fp); }

  console.log('\n— pasted before 09-calendar.sql has run —');
  { const W = world();
    W.fail.ical_runs = () => true;                                    // no such table yet
    const A = W.feed(ACC, 'fa', 'p1', 'Airbnb');
    W.feeds[A] = ICS([['early@airbnb', '2026-12-01', '2026-12-03', RES], ['phone@airbnb', '2026-12-05', '2026-12-07', RES]]);
    // a stay the phone had already imported; its event was never marked announced
    const pid = own({ feed_id: 'fa', uid: 'phone@airbnb' });
    W.stay.ical_events.push({ account_id: ACC, feed_id: 'fa', uid: 'phone@airbnb', property_id: 'p1', platform: 'Airbnb', start_date: '2026-12-05', end_date: '2026-12-07',
      kind: 'reserved', gone_at: null, imported_booking_id: pid, announced_at: null });
    W.stay.bookings.push({ account_id: ACC, id: pid, property_id: 'p1', check_in: '2026-12-05', check_out: '2026-12-07', status: 'confirmed', source: 'Airbnb', guest_name: 'Airbnb guest', version: 3 });
    let r = await run(W, { authorization: 'Bearer tok-owner' });
    ok('the import still runs (the new stay becomes a booking)', !!W.booking(own({ feed_id: 'fa', uid: 'early@airbnb' })), W.stay.bookings.map(b => b.id));
    ok('…but nothing is announced: every stored stay would look new', W.posted.length === 0 && W.ev('fa', 'phone@airbnb').announced_at == null, W.posted);
    W.fetchedUrls = []; r = await run(W, { authorization: 'Bearer tok-owner' });
    ok('…and Import now is not held back', W.fetchedUrls.length === 1 && !r.throttled, r); }

  console.log('\n— a long history —');
  { const W = world();
    const A = W.feed(ACC, 'fa', 'p1', 'Airbnb');
    for (let i = 0; i < 1150; i++) W.stay.ical_events.push({ account_id: ACC, feed_id: 'fa', uid: `past${String(i).padStart(4, '0')}@airbnb`, property_id: 'p1', platform: 'Airbnb',
      start_date: '2024-01-01', end_date: '2024-01-03', kind: 'reserved', gone_at: '2024-02-01T00:00:00Z', imported_booking_id: null, announced_at: '2024-01-01T00:00:00Z' });
    W.feeds[A] = ICS([['zz-new@airbnb', '2026-12-01', '2026-12-03', RES]]);
    await run(W);
    ok('over 1000 events: read page by page, the newest stay still imported', !!W.booking(own({ feed_id: 'fa', uid: 'zz-new@airbnb' })) && W.posted.length === 1, W.stay.bookings.length); }

  console.log('\n— the account\'s own day —');
  { const W = world();
    W.stay.accounts[0].time_zone = 'America/New_York';
    const A = W.feed(ACC, 'fa', 'p1', 'Airbnb');
    W.feeds[A] = ICS([['z@airbnb', '2026-11-14', '2026-11-16', RES]]);
    const keep = at; at = Date.parse('2026-11-15T20:00:00Z'); t0 = Date.now();     // 16 Nov in India, still 15 Nov in New York
    await run(W);
    const zb = W.booking(own({ feed_id: 'fa', uid: 'z@airbnb' }));
    ok('"past" is judged by the account\'s date: in New York the stay has a night left, so it is imported', zb && zb.imported_on === '2026-11-15', W.stay.bookings);
    ok('dayIn: India and New York differ at that moment', F.dayIn('Asia/Kolkata', at) === '2026-11-16' && F.dayIn('America/New_York', at) === '2026-11-15');
    at = keep; t0 = Date.now(); }

  console.log('\n— the old model, until the switch —');
  { const W = world({ model: 'public' });
    W.pub.ical_feeds.push({ id: 'g1', owner_id: 'u-owner', property_id: 'p1', platform: 'Airbnb', url: 'https://www.airbnb.com/calendar/ical/9.ics?s=x', last_ok_at: '2026-10-01T00:00:00Z' });
    W.pub.ical_events.push({ feed_id: 'g1', uid: 'seen@airbnb', owner_id: 'u-owner', gone_at: null });
    W.feeds['https://www.airbnb.com/calendar/ical/9.ics?s=x'] = ICS([['seen@airbnb', '2026-12-01', '2026-12-03', RES], ['new@airbnb', '2026-12-05', '2026-12-07', RES]]);
    await run(W);
    ok('model public: events only, no booking written, new stays handed to notify as before',
      W.pub.ical_events.some(e => e.uid === 'new@airbnb') && !W.stay.bookings.length && !W.pub.bookings
      && W.posted.length === 1 && !W.posted[0].account && W.posted[0].events.map(e => e.uid).join() === 'new@airbnb', W.posted); }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
