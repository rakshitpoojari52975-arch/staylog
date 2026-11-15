/* Phase 8 (v69): notifications for the team, in the new model.
     - who gets what: owners everything; a manager only the properties they
       hold and only with the permission an alert needs (balances: see_money;
       her marks: manage_staff); backups owners only; a device's own alerts
       (changes not sent, a change to look at) only to that device's person
     - each recipient's own inbox row (with its property) and badge
     - the daily run is hourly; each account from 9 AM on its own clock, its
       own "tomorrow", its own currency; once per reminder however often it runs
     - one account failing stops no other
     - Send test goes to the device that asked, only
   Each push is decrypted with the device's own keys. */
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
const NOW = Date.parse('2026-10-20T10:00:00Z');   // 3:30 PM in India, 6 AM in New York
// Two schemas. The function picks one with PostgREST's profile headers.
function world(stay, pub) {
  const W = { pub: Object.assign({ app_status: [{ id: 1, model: 'stay' }] }, pub || {}),
    stay: Object.assign({ members: [], accounts: [], push_subscriptions: [], notification_prefs: [], push_log: [], sync_status: [], backups: [],
      bookings: [], properties: [], staff: [], attendance: [], utensil_marks: [], ical_events: [], member_properties: [] }, stay),
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
  const ipad = await device('https://web.push.apple.com/A2', ACC, OWNER);
  const mgrPhone = await device('https://web.push.apple.com/M1', ACC, MGR);
  const otherPhone = await device('https://web.push.apple.com/O1', ACC2, OTHER);
  const got = async (W, dev) => Promise.all(W.pushes.filter(p => p.endpoint === dev.row.endpoint).map(p => decrypt(dev, p.body)));
  const titles = async (W, dev) => (await got(W, dev)).map(m => m.title + ' | ' + m.body);
  const MP = (extra = {}) => ({ account_id: ACC, user_id: MGR, role: 'manager', active: true, permissions: {}, ...extra });
  const base = (o = {}) => ({
    members: [{ account_id: ACC, user_id: OWNER, role: 'owner', active: true, permissions: {} }, MP(), { account_id: ACC2, user_id: OTHER, role: 'owner', active: true, permissions: {} }],
    member_properties: [{ account_id: ACC, user_id: MGR, property_id: 'p1' }],
    accounts: [{ id: ACC, time_zone: 'Asia/Kolkata', currency: 'INR', pays_directly_sources: ['Direct', 'Booking.com'] },
               { id: ACC2, time_zone: 'America/New_York', currency: 'USD', pays_directly_sources: ['Direct'] }],
    push_subscriptions: [{ ...iphone.row }, { ...ipad.row }, { ...mgrPhone.row }, { ...otherPhone.row }],
    properties: [{ account_id: ACC, id: 'p1', name: 'Raaya Vasyam', deleted_at: null }, { account_id: ACC, id: 'p2', name: 'Sea View', deleted_at: null },
                 { account_id: ACC2, id: 'q1', name: 'Hudson House', deleted_at: null }],
    staff: [{ account_id: ACC, id: 'stf1', name: 'Lakshmi Walikar', works_at: ['p1'] }, { account_id: ACC, id: 'stf2', name: 'Ravi Kumar', works_at: ['p2'] },
            { account_id: ACC, id: 'stf3', name: 'Asha Rao', works_at: [] }],
    sync_status: [], backups: [], ...o });
  const B = o => Object.assign({ account_id: ACC, id: 'b', guests: 2, property_id: 'p1', check_in: '2026-10-18', check_out: '2026-10-21',
    source: 'Direct', total_amount: 6000, paid: 2000, round_off: 0, status: 'confirmed', deleted_at: null }, o);
  const daily = (W, at = NOW) => F.handle(post({ job: 'daily' }, CRON), ENV, W.fetch, at).then(r => r.json());

  console.log('\n— who gets what —');
  { const W = world(base({ bookings: [B({ id: 'a1', check_in: '2026-10-21', check_out: '2026-10-23' }), B({ id: 'a2', property_id: 'p2', check_in: '2026-10-21', check_out: '2026-10-23' }),
      B({ id: 'bal' })], backups: [{ account_id: ACC, created_at: '2026-10-10T00:00:00Z' }] }));
    await daily(W);
    const own = await titles(W, iphone), mgr = await titles(W, mgrPhone);
    ok('the owner: both arrivals, the balance, the backup', own.filter(t => /arriving/.test(t)).length === 2 && own.some(t => /to collect/.test(t)) && own.some(t => /No backup/.test(t)), own);
    ok('the manager: the arrival at the property they hold only', mgr.filter(t => /arriving/.test(t)).length === 1 && mgr.some(t => /Raaya Vasyam/.test(t)) && !mgr.some(t => /Sea View/.test(t)), mgr);
    ok('…no balance without see_money, and never the backup', !mgr.some(t => /to collect|backup/i.test(t)), mgr);
    const row = W.stay.push_log.find(l => l.recipient === MGR && /^arrival:a1/.test(l.key));
    ok('each recipient has their own inbox row, with the property', row && row.property_id === 'p1' && W.stay.push_log.some(l => l.recipient === OWNER && /^arrival:a1/.test(l.key)), W.stay.push_log);
    const badges = { own: Math.max(...(await got(W, iphone)).map(m => m.badge)), mgr: Math.max(...(await got(W, mgrPhone)).map(m => m.badge)) };
    ok('…and their own badge (unread count)', badges.own === 4 && badges.mgr === 1, badges); }
  { const W = world(base({ members: [{ account_id: ACC, user_id: OWNER, role: 'owner', active: true, permissions: {} }, MP({ permissions: { see_money: true } })],
      bookings: [B({ id: 'bal' })] }));
    await daily(W);
    ok('a manager with see_money gets the balance at their property', (await titles(W, mgrPhone)).some(t => /₹4,000 to collect · Raaya Vasyam/.test(t))); }
  { const W = world(base({ members: [{ account_id: ACC, user_id: OWNER, role: 'owner', active: true, permissions: {} }, MP({ active: false })],
      bookings: [B({ id: 'a1', check_in: '2026-10-21', check_out: '2026-10-23' })] }));
    await daily(W);
    ok('a manager switched off gets nothing', (await got(W, mgrPhone)).length === 0); }
  { const W = world(base({ bookings: [B({ id: 'a1', check_in: '2026-10-21', check_out: '2026-10-23' })],
      notification_prefs: [{ account_id: ACC, user_id: MGR, prefs: { arrivals: false } }] }));
    await daily(W);
    ok('a manager\'s own choices count', (await got(W, mgrPhone)).length === 0 && (await got(W, iphone)).length >= 1); }

  console.log('\n— her marks —');
  const mark = (W, id, staff, prop, table = 'attendance') => {
    const m = { account_id: ACC, id, staff_id: staff, date: '2026-10-20', property_id: prop, marked_at: '2026-10-20T03:42:00Z', deleted_at: null };
    W.stay[table].push(m);
    return F.handle(post({ type: 'INSERT', table, schema: 'stay', record: { id, account_id: ACC } }, CRON), ENV, W.fetch, NOW);
  };
  { const W = world(base({ members: [{ account_id: ACC, user_id: OWNER, role: 'owner', active: true, permissions: {} }, MP({ permissions: { manage_staff: true } })] }));
    await mark(W, 'att_stf1_20261020', 'stf1', 'p1');
    const m = await got(W, mgrPhone);
    ok('a manager who manages staff, at the property she marked at: told, with her full name and the time there', m.length === 1 && m[0].title === 'Lakshmi Walikar came in today'
      && /9:12\s?am/i.test(m[0].body), m);
    await mark(W, 'att_stf2_20261020', 'stf2', null);
    ok('a mark with no property, by someone who works only at a property they do not hold: not told', (await got(W, mgrPhone)).length === 1);
    await mark(W, 'att_stf3_20261020', 'stf3', null);
    ok('…by someone who works everywhere: told', (await got(W, mgrPhone)).length === 2 && (await got(W, iphone)).length === 3); }
  { const W = world(base());
    await mark(W, 'att_stf1_20261020', 'stf1', 'p1');
    ok('a manager without manage_staff is not told (the owner is)', (await got(W, mgrPhone)).length === 0 && (await got(W, iphone)).length === 1); }

  console.log('\n— a device\'s own alerts —');
  { const W = world(base({ sync_status: [
      { account_id: ACC, device_id: 'dm', user_id: MGR, device_name: 'Android phone', oldest_unsent: '2026-10-16T00:00:00Z', conflicts: 0 },
      { account_id: ACC, device_id: 'do', user_id: OWNER, device_name: 'iPhone', oldest_unsent: null, conflicts: 2 }] }));
    await daily(W);
    const mgr = await titles(W, mgrPhone), own = await titles(W, iphone);
    ok('changes waiting 4 days on the manager\'s phone: told to the manager only', mgr.some(t => /Changes not sent yet \| Changes made on your Android phone 4 days ago/.test(t))
      && !own.some(t => /not sent/.test(t)), { mgr, own });
    ok('two changes to look at on the owner\'s iPhone: told to the owner only', own.some(t => /^2 changes to look at \| Something you changed on your iPhone/.test(t)) && !mgr.some(t => /look at/.test(t)), own);
    ok('…keyed per device and day', W.stay.push_log.some(l => l.key === 'conflict:do:2026-10-20') && W.stay.push_log.some(l => l.key === 'stale:dm:2026-10-20')); }
  { const W = world(base({ sync_status: [{ account_id: ACC, device_id: 'do', user_id: OWNER, device_name: 'iPhone', conflicts: 1 }],
      notification_prefs: [{ account_id: ACC, user_id: OWNER, prefs: { syncConflict: false } }] }));
    await daily(W);
    ok('the change-to-look-at alert has its own switch', !(await titles(W, iphone)).some(t => /look at/.test(t))); }

  console.log('\n— hourly, each account on its own clock —');
  { const W = world(base({ bookings: [B({ id: 'in1', check_in: '2026-10-21', check_out: '2026-10-23' }),
      B({ id: 'ny1', account_id: ACC2, property_id: 'q1', check_in: '2026-10-21', check_out: '2026-10-22' }),
      B({ id: 'ny2', account_id: ACC2, property_id: 'q1', check_in: '2026-10-19', check_out: '2026-10-21', total_amount: 120, paid: 80 })] }));
    let r = await daily(W, Date.parse('2026-10-20T02:00:00Z'));          // 7:30 AM in India
    ok('7:30 AM in India: nothing for the Indian account yet (New York, 10 PM the evening before, is handled on its own date)',
      (await got(W, iphone)).length === 0 && r.accounts === 1, r);
    r = await daily(W);                                                   // 3:30 PM India, 6 AM New York
    ok('3:30 PM in India: the Indian account\'s reminders; New York (6 AM) waits', (await got(W, iphone)).some(m => /arriving/.test(m.title)) && (await got(W, otherPhone)).length === 0 && r.accounts === 1, r);
    const n = W.pushes.length;
    await daily(W, Date.parse('2026-10-20T11:00:00Z'));
    ok('the next hour sends nothing again', W.pushes.length === n);
    await daily(W, Date.parse('2026-10-20T13:00:00Z'));                   // 9 AM in New York
    const ny = await titles(W, otherPhone);
    ok('9 AM in New York: its arrival tomorrow (its own date) and its balance in dollars', ny.some(t => /arriving/.test(t) && /Hudson House/.test(t)) && ny.some(t => /\$40 to collect · Hudson House/.test(t)), ny); }
  { const W = world(base({ bookings: [B({ id: 'in1', check_in: '2026-10-21', check_out: '2026-10-23' }), B({ id: 'ny1', account_id: ACC2, property_id: 'q1', check_in: '2026-10-21', check_out: '2026-10-22' })] }));
    const real = W.fetch;
    W.fetch = (url, init) => /\/rest\/v1\/properties\?account_id=eq\.acct-1/.test(url) ? Promise.resolve(new Response('{}', { status: 500 })) : real(url, init);
    const r = await daily(W, Date.parse('2026-10-20T13:00:00Z'));
    ok('one account failing stops no other', r.failed && r.failed.length === 1 && r.failed[0].account === ACC && (await got(W, otherPhone)).some(m => /arriving/.test(m.title)), r); }

  console.log('\n— Send test —');
  { const W = world(base());
    let r = await (await F.handle(post({ job: 'test', endpoint: ipad.row.endpoint }, { authorization: 'Bearer tok-owner' }), ENV, W.fetch, NOW)).json();
    ok('only the device that asked', r.sent === 1 && (await got(W, ipad)).length === 1 && (await got(W, iphone)).length === 0, r);
    r = await (await F.handle(post({ job: 'test', endpoint: mgrPhone.row.endpoint }, { authorization: 'Bearer tok-owner' }), ENV, W.fetch, NOW)).json();
    ok('never someone else\'s device, even when named', r.sent === 0 && (await got(W, mgrPhone)).length === 0, r);
    ok('a test push is not kept in the inbox', !W.stay.push_log.length); }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
