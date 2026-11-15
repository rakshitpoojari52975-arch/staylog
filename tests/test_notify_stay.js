/* The notify Edge Function in the new model (v62): public.app_status.model =
   'stay' sends from the `stay` schema, by account, to each of the account's
   owners with their own devices, choices and inbox. The same reminders as
   before, on the same rules; nothing read from or written to the old tables
   but app_status. Each push is decrypted with the device's own keys. */
const path = require('path');
const FN = path.resolve(__dirname, '../supabase/functions/notify/index.ts');
const { subtle } = globalThis.crypto;
let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (x !== undefined ? '  → ' + JSON.stringify(x) : ''))); };
const b64u = b => Buffer.from(b).toString('base64url');
const cat = (...p) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };
const te = new TextEncoder();
const hmac = async (k, d) => new Uint8Array(await subtle.sign('HMAC', await subtle.importKey('raw', k, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']), d));
async function device(endpoint, account, user) {
  const kp = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const pub = new Uint8Array(await subtle.exportKey('raw', kp.publicKey)), auth = crypto.getRandomValues(new Uint8Array(16));
  return { row: { account_id: account, user_id: user, endpoint, p256dh: b64u(pub), auth: b64u(auth) }, kp, pub, auth };
}
async function decrypt(dev, body) {
  const salt = body.slice(0, 16), idlen = body[20], asPub = body.slice(21, 21 + idlen), ct = body.slice(21 + idlen);
  const asKey = await subtle.importKey('raw', asPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: asKey }, dev.kp.privateKey, 256));
  const ikm = (await hmac(await hmac(dev.auth, shared), cat(te.encode('WebPush: info\0'), dev.pub, asPub, new Uint8Array([1])))).slice(0, 32);
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, cat(te.encode('Content-Encoding: aes128gcm\0'), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, cat(te.encode('Content-Encoding: nonce\0'), new Uint8Array([1])))).slice(0, 12);
  const pt = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: nonce }, await subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['decrypt']), ct));
  return JSON.parse(new TextDecoder().decode(pt.slice(0, -1)));
}

const ACC = 'acct-1', ACC2 = 'acct-2', OWNER = 'owner-1', CO = 'owner-co', MGR = 'manager-1', OTHER = 'owner-2';
const NOW = Date.parse('2026-10-20T03:30:00Z');   // 9:00 AM IST; tomorrow (IST) is 21 Oct
// Two schemas. The function picks one with PostgREST's profile headers.
function world(stay, pub) {
  const W = { pub: Object.assign({ app_status: [{ id: 1, model: 'stay' }] }, pub || {}),
    stay: Object.assign({ members: [], accounts: [], push_subscriptions: [], notification_prefs: [], push_log: [], sync_status: [], backups: [],
      bookings: [], properties: [], staff: [], attendance: [], utensil_marks: [], ical_events: [] }, stay),
    pushes: [], gone: new Set(), users: { 'tok-owner': OWNER }, touchedPublic: [] };
  const res = (s, b) => new Response(b == null ? null : JSON.stringify(b), { status: s });
  const match = (row, q) => { for (const [k, v] of q) { if (['select', 'on_conflict', 'order', 'limit'].includes(k)) continue;
    const val = row[k];
    if (v === 'is.null') { if (val != null) return false; }
    else if (v === 'not.is.null') { if (val == null) return false; }
    else if (v === 'is.true') { if (val !== true) return false; }
    else if (v.startsWith('eq.')) { if (String(val) !== decodeURIComponent(v.slice(3))) return false; }
    else if (v.startsWith('neq.')) { if (String(val) === decodeURIComponent(v.slice(4))) return false; }
    else if (v.startsWith('lt.')) { if (!(val != null && String(val) < decodeURIComponent(v.slice(3)))) return false; }
    else if (v.startsWith('gte.')) { if (!(val != null && String(val) >= decodeURIComponent(v.slice(4)))) return false; } } return true; };
  W.fetch = async (url, init = {}) => {
    const u = new URL(url), m = (init.method || 'GET').toUpperCase(), h = init.headers || {};
    if (u.host === 'proj.supabase.co') {
      if (h.apikey !== 'service-key') return res(401, {});
      if (u.pathname === '/auth/v1/user') { const id = W.users[(h.Authorization || '').replace('Bearer ', '')]; return id ? res(200, { id }) : res(401, {}); }
      const S = h['Accept-Profile'] === 'stay' ? W.stay : W.pub;
      const t = u.pathname.replace('/rest/v1/', ''), q = [...u.searchParams];
      if (S === W.pub) W.touchedPublic.push(m + ' ' + t);
      const T = S[t]; if (!T) return res(404, {});
      if (m === 'GET') {
        let rows = T.filter(r => match(r, q));
        const ord = u.searchParams.get('order'); if (ord) { const [c, dir] = ord.split('.'); rows.sort((a, b) => String(a[c]).localeCompare(String(b[c])) * (dir === 'desc' ? -1 : 1)); }
        const lim = u.searchParams.get('limit'); if (lim) rows = rows.slice(0, +lim);
        return res(200, rows);
      }
      if (m === 'DELETE') { S[t] = T.filter(r => !match(r, q)); return res(204); }
      if (m === 'POST') { const rows = JSON.parse(init.body), out = [];
        for (const r of rows) { const dup = T.some(x => x.account_id === r.account_id && x.recipient === r.recipient && x.key === r.key); if (!dup) { T.push({ ...r }); out.push(r); } }
        return res(201, out); }
      if (m === 'PATCH') { const p = JSON.parse(init.body), out = []; for (const r of T) if (match(r, q)) { Object.assign(r, p); out.push(r); } return res(200, out); }
      return res(400, {});
    }
    W.pushes.push({ endpoint: url, body: new Uint8Array(init.body) });
    return new Response(null, { status: W.gone.has(url) ? 410 : 201 });
  };
  return W;
}
const post = (body, headers = {}) => new Request('https://proj.supabase.co/functions/v1/notify',
  { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

(async () => {
  const F = await import(FN);
  const kp = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const ENV = { SUPABASE_URL: 'https://proj.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-key',
    VAPID_PUBLIC_KEY: b64u(new Uint8Array(await subtle.exportKey('raw', kp.publicKey))), VAPID_PRIVATE_KEY: (await subtle.exportKey('jwk', kp.privateKey)).d,
    VAPID_SUBJECT: 'mailto:owner@example.invalid', PUSH_CRON_SECRET: 'cron-secret-123' };
  const CRON = { 'x-cron-secret': 'cron-secret-123' };
  const iphone = await device('https://web.push.apple.com/A1', ACC, OWNER);
  const coPhone = await device('https://web.push.apple.com/C1', ACC, CO);
  const mgrPhone = await device('https://web.push.apple.com/M1', ACC, MGR);
  const otherPhone = await device('https://web.push.apple.com/O1', ACC2, OTHER);
  const got = async (W, dev) => Promise.all(W.pushes.filter(p => p.endpoint === dev.row.endpoint).map(p => decrypt(dev, p.body)));
  const base = () => ({
    members: [{ account_id: ACC, user_id: OWNER, role: 'owner', active: true }, { account_id: ACC, user_id: CO, role: 'owner', active: true },
      { account_id: ACC, user_id: MGR, role: 'manager', active: true }, { account_id: ACC2, user_id: OTHER, role: 'owner', active: true }],
    accounts: [{ id: ACC, pays_directly_sources: ['Direct', 'Booking.com'] }, { id: ACC2, pays_directly_sources: ['Direct'] }],
    push_subscriptions: [{ ...iphone.row }, { ...coPhone.row }, { ...mgrPhone.row }, { ...otherPhone.row }],
    properties: [{ account_id: ACC, id: 'p1', name: 'Raaya Vasyam', deleted_at: null }, { account_id: ACC2, id: 'p1', name: 'Another House', deleted_at: null }],
    staff: [{ account_id: ACC, id: 'stf1', name: 'Laxmi Walikar' }, { account_id: ACC2, id: 'stf1', name: 'Someone Else' }],
    sync_status: [{ account_id: ACC, device_id: 'd1', last_pull_at: '2026-10-19T20:00:00Z' }, { account_id: ACC, device_id: 'd0', last_pull_at: '2026-10-01T20:00:00Z' }],
  });
  const B = o => Object.assign({ account_id: ACC, id: 'b', guest_name: 'Anita Rao', guests: 2, property_id: 'p1', check_in: '2026-10-18', check_out: '2026-10-21',
    source: 'Direct', total_amount: 6000, paid: 2000, round_off: 0, status: 'checkedin', deleted_at: null }, o);

  console.log('\n— 9 AM, from `stay` —');
  { const W = world({ ...base(), bookings: [B({ id: 'arr', check_in: '2026-10-21', check_out: '2026-10-24', status: 'confirmed' }), B({ id: 'bal' }),
      B({ id: 'bal2', account_id: ACC2, source: 'Booking.com' }), B({ id: 'ro', check_out: '2026-10-21', total_amount: 4632.47, paid: 4630, round_off: 2.47 })] });
    const r = await (await F.handle(post({ job: 'daily' }, CRON), ENV, W.fetch, NOW)).json();
    const mine = await got(W, iphone), co = await got(W, coPhone);
    ok('arrival tomorrow: to the owner', mine.some(m => m.title === 'Guest arriving tomorrow' && /Raaya Vasyam/.test(m.body)), mine.map(m => m.title));
    ok('balance at check-out tomorrow, from the amounts (₹4,000)', mine.some(m => /₹4,000 to collect · Raaya Vasyam/.test(m.body)));
    ok('round off settles it: no alert for ₹2.47', !mine.some(m => /₹2.47/.test(m.body)));
    ok('every owner of the account gets them, on their own phone', co.length === mine.length && co.length === 2, [co.length, mine.length]);
    ok('a manager does not (phase 8 decides)', (await got(W, mgrPhone)).length === 0);
    ok('the account\'s own list of who pays the house: Booking.com is not on ACC2\'s', (await got(W, otherPhone)).every(m => !/to collect/.test(m.body)));
    ok('the newest sync of any device counts: not stale', ![...mine, ...co].some(m => /not synced/.test(m.title)));
    ok('each recipient has their own inbox row', W.stay.push_log.filter(l => l.key === 'arrival:arr:2026-10-21').map(l => l.recipient).sort().join() === [CO, OWNER].sort().join());
    ok('only app_status read from the old tables', W.touchedPublic.every(x => x === 'GET app_status'), W.touchedPublic);
    await F.handle(post({ job: 'daily' }, CRON), ENV, W.fetch, NOW + 60e3);
    ok('once per reminder per person', (await got(W, iphone)).length === mine.length);
    ok('report lists them', r.ok && r.report.length >= 4, r); }
  { const W = world({ ...base(), notification_prefs: [{ account_id: ACC, user_id: CO, prefs: { arrivals: false } }],
      bookings: [B({ id: 'arr', check_in: '2026-10-21', check_out: '2026-10-24', status: 'confirmed' })] });
    await F.handle(post({ job: 'daily' }, CRON), ENV, W.fetch, NOW);
    ok('choices are per person: off for one owner, on for the other', (await got(W, coPhone)).length === 0 && (await got(W, iphone)).length === 1); }
  { const W = world({ ...base(), sync_status: [{ account_id: ACC, device_id: 'd1', last_pull_at: '2026-10-15T20:00:00Z' }] });
    await F.handle(post({ job: 'daily' }, CRON), ENV, W.fetch, NOW);
    ok('no device synced in 2 days: the stale alert', (await got(W, iphone)).some(m => m.title === 'StayLog has not synced')); }

  console.log('\n— her marks, from `stay` —');
  { const W = world(base());
    const mark = { account_id: ACC, id: 'att_stf1_20261020', staff_id: 'stf1', date: '2026-10-20', marked_at: '2026-10-20T03:42:00Z', deleted_at: null };
    W.stay.attendance.push(mark);
    await F.handle(post({ type: 'INSERT', table: 'attendance', schema: 'stay', record: mark }, CRON), ENV, W.fetch, NOW);
    const m = await got(W, iphone);
    ok('she marks attendance: a push naming her', m.length === 1 && m[0].title === 'Laxmi came in today', m);
    ok('to every owner of the account, not another account', (await got(W, coPhone)).length === 1 && (await got(W, otherPhone)).length === 0);
    await F.handle(post({ type: 'INSERT', table: 'attendance', schema: 'stay', record: { ...mark, account_id: ACC2 } }, CRON), ENV, W.fetch, NOW);
    ok('a pointer naming another account finds no such mark there', (await got(W, otherPhone)).length === 0);
    await F.handle(post({ type: 'INSERT', table: 'attendance', schema: 'stay', record: { id: mark.id } }, CRON), ENV, W.fetch, NOW);
    ok('a pointer without its account sends nothing', (await got(W, iphone)).length === 1); }

  console.log('\n— new stays from the calendar —');
  { const W = world({ ...base(), ical_events: [{ account_id: ACC, feed_id: 'f1', uid: 'u1', property_id: 'p1', platform: 'Airbnb',
      start_date: '2026-10-25', end_date: '2026-10-27', kind: 'reserved', gone_at: null }] });
    await F.handle(post({ job: 'new-bookings', events: [{ feed_id: 'f1', uid: 'u1' }] }, CRON), ENV, W.fetch, NOW);
    const m = await got(W, iphone);
    ok('announced, with the account\'s property name', m.length === 1 && m[0].title === 'New Airbnb booking' && /Raaya Vasyam/.test(m[0].body), m); }

  console.log('\n— Send test —');
  { const W = world(base());
    const r = await (await F.handle(post({ job: 'test' }, { authorization: 'Bearer tok-owner' }), ENV, W.fetch, NOW)).json();
    ok('only the asker\'s own devices', r.sent === 1 && (await got(W, iphone)).length === 1 && (await got(W, coPhone)).length === 0, r); }

  console.log('\n— gone devices —');
  { const W = world({ ...base(), bookings: [B({ id: 'arr', check_in: '2026-10-21', check_out: '2026-10-24', status: 'confirmed' })] });
    W.gone.add(iphone.row.endpoint);
    await F.handle(post({ job: 'daily' }, CRON), ENV, W.fetch, NOW);
    ok('a device gone for good is removed, only that one', !W.stay.push_subscriptions.some(s => s.endpoint === iphone.row.endpoint)
      && W.stay.push_subscriptions.some(s => s.endpoint === coPhone.row.endpoint)); }

  console.log('\n— the old model still, when app_status says so —');
  { const W = world(base(), { app_status: [{ id: 1, model: 'public' }], push_subscriptions: [], sync_status: [] });
    await F.handle(post({ job: 'daily' }, CRON), ENV, W.fetch, NOW);
    ok('model public: nothing read from `stay`', W.pushes.length === 0 && W.touchedPublic.includes('GET push_subscriptions')); }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
