/* The staff-login Edge Function (v64), run in Node against a fake Supabase:
   Auth admin and the `stay` tables. Who may create, reset and switch off a
   staff login, the address it makes, and that nothing is left half-made. */
const path = require('path');
const FN = path.resolve(__dirname, '../supabase/functions/staff-login/index.ts');
let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (x !== undefined ? '  → ' + JSON.stringify(x) : ''))); };
const A = '11111111-1111-1111-1111-111111111111', B = '22222222-2222-2222-2222-222222222222';

function world(o = {}) {
  const W = { users: { 'tok-owner': 'u-owner', 'tok-mgr': 'u-mgr', 'tok-mgr2': 'u-mgr2', 'tok-x': 'u-x', 'tok-ownerB': 'u-ownerB' },
    auth: [{ id: 'u-laxmi', email: 'laxmi@staff.raayavasyam.invalid', password: 'old-pass-1', banned: false }],
    stay: {
      members: [{ account_id: A, user_id: 'u-owner', role: 'owner', active: true, permissions: {} },
        { account_id: A, user_id: 'u-mgr', role: 'manager', active: true, permissions: { manage_staff: true } },
        { account_id: A, user_id: 'u-mgr2', role: 'manager', active: true, permissions: {} },
        { account_id: B, user_id: 'u-ownerB', role: 'owner', active: true, permissions: {} }],
      accounts: [{ id: A, code: 'raaya' }, { id: B, code: 'other' }],
      staff: [{ account_id: A, id: 's1', name: 'Lakshmi Walikar', deleted_at: null }, { account_id: A, id: 's2', name: 'Ravi', deleted_at: null },
        { account_id: B, id: 's9', name: 'Someone', deleted_at: null }],
      staff_logins: [{ account_id: A, user_id: 'u-laxmi', staff_id: 's1', username: 'laxmi', active: true }],
    }, failInsert: !!o.failInsert, calls: [] };
  const match = (r, q) => q.every(([k, v]) => ['select'].includes(k) ? true : v === 'is.null' ? r[k] == null : v === 'is.true' ? r[k] === true
    : v.startsWith('eq.') ? String(r[k]) === decodeURIComponent(v.slice(3)) : true);
  W.fetch = async (url, init = {}) => {
    const u = new URL(url), m = (init.method || 'GET').toUpperCase(), h = init.headers || {};
    W.calls.push(m + ' ' + u.pathname);
    const res = (s, b) => new Response(b === undefined ? null : JSON.stringify(b), { status: s });
    if (h.apikey !== 'service-key') return res(401, {});
    if (u.pathname === '/auth/v1/user') { const id = W.users[(h.Authorization || '').replace('Bearer ', '')]; return id ? res(200, { id }) : res(401, {}); }
    if (u.pathname.startsWith('/auth/v1/admin/users')) {
      const id = u.pathname.split('/')[5], body = init.body ? JSON.parse(init.body) : {};
      if (m === 'POST') { if (W.auth.some(a => a.email === body.email)) return res(422, { msg: 'exists' });
        const n = { id: 'u-new-' + W.auth.length, email: body.email, password: body.password, banned: false, app_metadata: body.app_metadata }; W.auth.push(n); return res(200, n); }
      const a = W.auth.find(x => x.id === id); if (!a) return res(404, {});
      if (m === 'PUT') { if (body.password) a.password = body.password; if (body.ban_duration) a.banned = body.ban_duration !== 'none'; return res(200, a); }
      if (m === 'DELETE') { W.auth = W.auth.filter(x => x.id !== id); return res(200, {}); }
    }
    if (u.pathname.startsWith('/rest/v1/')) {
      if (h['Accept-Profile'] !== 'stay') return res(404, {});
      const t = u.pathname.slice(9), T = W.stay[t] || [], q = [...u.searchParams];
      if (m === 'GET') return res(200, T.filter(r => match(r, q)));
      if (m === 'POST') { if (W.failInsert) return res(500, { message: 'boom' }); const rows = JSON.parse(init.body); T.push(...rows); return res(201, rows); }
      if (m === 'PATCH') { const p = JSON.parse(init.body), out = T.filter(r => match(r, q)); out.forEach(r => Object.assign(r, p)); return res(200, out); }
    }
    return res(404, {});
  };
  return W;
}
const ENV = { SUPABASE_URL: 'https://proj.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-key' };
const call = async (W, tok, body) => { const r = await F.handle(new Request('https://proj.supabase.co/functions/v1/staff-login',
  { method: 'POST', headers: { 'content-type': 'application/json', ...(tok ? { authorization: 'Bearer ' + tok } : {}) }, body: JSON.stringify(body) }), ENV, W.fetch);
  return { status: r.status, body: await r.json().catch(() => null) }; };
let F;

(async () => {
  F = await import(FN);
  console.log('\n— who may —');
  { const W = world();
    ok('no token: 401', (await call(W, null, { action: 'create', account: A, staff_id: 's2' })).status === 401);
    ok('a stranger: refused', (await call(W, 'tok-x', { action: 'create', account: A, staff_id: 's2', username: 'ravi', password: 'longenough' })).status === 403);
    ok('a manager without "manage staff": refused', (await call(W, 'tok-mgr2', { action: 'create', account: A, staff_id: 's2', username: 'ravi', password: 'longenough' })).status === 403);
    ok('another account\'s owner: refused here', (await call(W, 'tok-ownerB', { action: 'reset', account: A, staff_id: 's1', password: 'longenough' })).status === 403);
    ok('a staff member of another account: not found', (await call(W, 'tok-owner', { action: 'create', account: A, staff_id: 's9', username: 'x1', password: 'longenough' })).status === 404);
    ok('nothing was made by any of that', W.auth.length === 1 && W.stay.staff_logins.length === 1); }

  console.log('\n— create —');
  { const W = world();
    let r = await call(W, 'tok-owner', { action: 'create', account: A, staff_id: 's2', username: 'ra', password: 'short' });
    ok('a password under 8 characters is refused', r.status === 400 && /8 characters/.test(r.body.error), r);
    r = await call(W, 'tok-owner', { action: 'create', account: A, staff_id: 's2', username: 'Ravi K', password: 'longenough' });
    ok('a username with a space is refused', r.status === 400 && /username/.test(r.body.error), r);
    r = await call(W, 'tok-owner', { action: 'create', account: A, staff_id: 's2', username: 'laxmi', password: 'longenough' });
    ok('a username already used in the account is refused', r.status === 409 && /already taken/.test(r.body.error), r);
    r = await call(W, 'tok-owner', { action: 'create', account: A, staff_id: 's1', username: 'lakshmi', password: 'longenough' });
    ok('a staff member who has a login gets "reset instead"', r.status === 409 && /Reset its password/.test(r.body.error), r);
    r = await call(W, 'tok-owner', { action: 'create', account: A, staff_id: 's2', username: 'Ravi', password: 'longenough1' });
    ok('created: username and account code back, no password', r.status === 200 && r.body.username === 'ravi' && r.body.code === 'raaya' && !JSON.stringify(r.body).includes('longenough1'), r);
    const u = W.auth.find(a => a.email === 'ravi.raaya@staff.staylog.invalid');
    ok('the address is <username>.<code>@staff.staylog.invalid, with that password', u && u.password === 'longenough1', W.auth);
    ok('…and a staff_logins row in the account', W.stay.staff_logins.some(l => l.account_id === A && l.staff_id === 's2' && l.username === 'ravi' && l.user_id === u.id && l.active)); }
  { const W = world();
    const r = await call(W, 'tok-mgr', { action: 'create', account: A, staff_id: 's2', username: 'ravi', password: 'longenough' });
    ok('a manager allowed to manage staff can create one', r.status === 200, r); }
  { const W = world({ failInsert: true });
    const r = await call(W, 'tok-owner', { action: 'create', account: A, staff_id: 's2', username: 'ravi', password: 'longenough' });
    ok('if the row cannot be saved, the login is taken back: nothing half-made', r.status === 500 && W.auth.length === 1, { r, auth: W.auth }); }

  console.log('\n— reset, switch off, switch on —');
  { const W = world();
    let r = await call(W, 'tok-owner', { action: 'reset', account: A, staff_id: 's1', password: 'new-pass-22' });
    ok('reset works on a login made before v64 (old address)', r.status === 200 && W.auth[0].password === 'new-pass-22' && r.body.username === 'laxmi', r);
    r = await call(W, 'tok-owner', { action: 'reset', account: A, staff_id: 's2', password: 'new-pass-22' });
    ok('no login yet: says so', r.status === 404 && /no login yet/.test(r.body.error), r);
    r = await call(W, 'tok-owner', { action: 'disable', account: A, staff_id: 's1' });
    ok('switched off: signing in is blocked, and the row says so', r.status === 200 && W.auth[0].banned === true && W.stay.staff_logins[0].active === false, r);
    r = await call(W, 'tok-owner', { action: 'enable', account: A, staff_id: 's1' });
    ok('switched on again', r.status === 200 && W.auth[0].banned === false && W.stay.staff_logins[0].active === true, r);
    ok('every read was filtered by the account', W.calls.filter(c => c.startsWith('GET /rest')).length > 0); }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
