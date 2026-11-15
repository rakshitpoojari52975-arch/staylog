/* The team-invite Edge Function (v65), in Node against a fake Supabase:
   peek shows what an invite is for and nothing private; accept makes the
   manager's login (or uses a signed-in one), joins them with the invite's
   properties and permissions, and uses the invite once; a used, withdrawn or
   expired invite, or one that would make an owner, does nothing; a failure
   half-way leaves no login and frees the invite. */
const path = require('path');
const FN = path.resolve(__dirname, '../supabase/functions/team-invite/index.ts');
let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (x !== undefined ? '  → ' + JSON.stringify(x) : ''))); };
const A = '11111111-1111-1111-1111-111111111111';
const NOW = Date.parse('2026-11-15T06:00:00Z');
const PINV = 'platformplatformplatform', CODE = 'abcdefghijklmnopqrstuvwx', OLD = 'oldoldoldoldoldoldoldold', OWN = 'ownerownerownerownerowner';

function world(o = {}) {
  const W = { users: { 'tok-ravi': 'u-ravi', 'tok-owner': 'u-owner' }, auth: [{ id: 'u-ravi', email: 'ravi@example.com' }, { id: 'u-owner', email: 'owner@example.com' }],
    stay: {
      accounts: [{ id: A, name: 'Raaya Vasyam' }],
      properties: [{ account_id: A, id: 'p1', name: 'Raaya Vasyam', deleted_at: null }, { account_id: A, id: 'p2', name: 'Sea View', deleted_at: null }],
      members: [{ account_id: A, user_id: 'u-owner', role: 'owner', active: true }],
      member_properties: [],
      invites: [{ code: CODE, account_id: A, role: 'manager', property_ids: ['p2'], permissions: { see_money: true, send_messages: false }, label: 'Priya',
        expires_at: '2026-11-20T00:00:00Z', used_by: null },
        { code: OLD, account_id: A, role: 'manager', property_ids: ['p1'], permissions: {}, label: '', expires_at: '2026-11-01T00:00:00Z', used_by: null },
        { code: OWN, account_id: A, role: 'owner', property_ids: [], permissions: {}, label: '', expires_at: '2026-11-20T00:00:00Z', used_by: null }],
      platform_invites: [{ code: PINV, label: 'Asha, Goa', expires_at: '2026-11-25T00:00:00Z', used_by: null, account_id: null }],
    }, failMembers: !!o.failMembers, failOpen: !!o.failOpen, opened: [] };
  const match = (r, q) => q.every(([k, v]) => {
    if (['select', 'on_conflict'].includes(k)) return true;
    if (v === 'is.null') return r[k] == null; if (v === 'is.true') return r[k] === true;
    if (v.startsWith('eq.')) return String(r[k]) === decodeURIComponent(v.slice(3));
    if (v.startsWith('gt.')) return String(r[k]) > decodeURIComponent(v.slice(3));
    if (v.startsWith('in.(')) return v.slice(4, -1).split(',').map(decodeURIComponent).includes(String(r[k]));
    return true; });
  W.fetch = async (url, init = {}) => {
    const u = new URL(url), m = (init.method || 'GET').toUpperCase(), h = init.headers || {};
    const res = (s, b) => new Response(b === undefined ? null : JSON.stringify(b), { status: s });
    if (h.apikey !== 'service-key') return res(401, {});
    if (u.pathname === '/auth/v1/user') { const id = W.users[(h.Authorization || '').replace('Bearer ', '')]; return id ? res(200, { id }) : res(401, {}); }
    if (u.pathname.startsWith('/auth/v1/admin/users')) {
      const body = init.body ? JSON.parse(init.body) : {}, id = u.pathname.split('/')[5];
      if (m === 'POST') { if (W.auth.some(a => a.email === body.email)) return res(422, {}); const n = { id: 'u-new' + W.auth.length, email: body.email, password: body.password }; W.auth.push(n); return res(200, n); }
      if (m === 'DELETE') { W.auth = W.auth.filter(a => a.id !== id); return res(200, {}); }
    }
    if (u.pathname === '/rest/v1/rpc/open_account') {
      // as stay.open_account does, in one go
      const a = JSON.parse(init.body), inv = W.stay.platform_invites.find(x => x.code === a.p_invite);
      if (W.failOpen) return new Response(JSON.stringify({ message: 'boom' }), { status: 500 });
      if (!inv || inv.used_by) return new Response(JSON.stringify({ message: 'invite: used, withdrawn or expired' }), { status: 400 });
      if (W.stay.accounts.some(x => x.code === a.p_code)) return new Response(JSON.stringify({ message: 'code: taken' }), { status: 409 });
      const id = 'acct-new-' + (W.opened.length + 1);
      W.stay.accounts.push({ id, name: a.p_business, code: a.p_code, time_zone: a.p_time_zone, currency: a.p_currency });
      W.stay.members.push({ account_id: id, user_id: a.p_user, role: 'owner', active: true, display_name: a.p_owner_name });
      Object.assign(inv, { used_by: a.p_user, account_id: id }); W.opened.push(a);
      return new Response(JSON.stringify(id), { status: 200 });
    }
    const t = u.pathname.slice(9), T = W.stay[t] || [], q = [...u.searchParams];
    if (m === 'GET') return res(200, T.filter(r => match(r, q)));
    if (m === 'PATCH') { const p = JSON.parse(init.body), hit = T.filter(r => match(r, q)); hit.forEach(r => Object.assign(r, p)); return res(200, hit); }
    if (m === 'POST') {
      if (t === 'members' && W.failMembers) return res(500, {});
      const rows = JSON.parse(init.body);
      for (const r of rows) { const i = T.findIndex(x => x.account_id === r.account_id && x.user_id === r.user_id && (t !== 'member_properties' || x.property_id === r.property_id));
        i < 0 ? T.push(r) : Object.assign(T[i], r); }
      return res(201, rows);
    }
    return res(404, {});
  };
  return W;
}
const ENV = { SUPABASE_URL: 'https://proj.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-key' };
let F;
const call = async (W, body, tok) => { const r = await F.handle(new Request('https://proj.supabase.co/functions/v1/team-invite',
  { method: 'POST', headers: { 'content-type': 'application/json', ...(tok ? { authorization: 'Bearer ' + tok } : {}) }, body: JSON.stringify(body) }), ENV, W.fetch, NOW);
  return { status: r.status, body: await r.json() }; };

(async () => {
  F = await import(FN);
  console.log('\n— peek —');
  { const W = world();
    const r = await call(W, { action: 'peek', code: CODE });
    ok('what it is for: business, properties, who it is for', r.status === 200 && r.body.business === 'Raaya Vasyam' && r.body.properties.join() === 'Sea View' && r.body.label === 'Priya', r);
    ok('nothing private in it (no account id, no permissions)', !JSON.stringify(r.body).includes(A) && !('permissions' in r.body));
    ok('an expired invite: says so', (await call(W, { action: 'peek', code: OLD })).status === 404);
    ok('an invite that would make an owner: refused', (await call(W, { action: 'peek', code: OWN })).status === 404);
    ok('a made-up code: refused', (await call(W, { action: 'peek', code: 'short' })).status === 404); }

  console.log('\n— accept, with a new login —');
  { const W = world();
    let r = await call(W, { action: 'accept', code: CODE, name: 'Priya', email: 'priya@example.com', password: 'short' });
    ok('a short password: refused, nothing made', r.status === 400 && W.auth.length === 2, r);
    r = await call(W, { action: 'accept', code: CODE, name: 'Priya', email: 'Priya@Example.com', password: 'priya-pass-1' });
    ok('joined', r.status === 200 && r.body.account === A && r.body.properties.join() === 'Sea View', r);
    const u = W.auth.find(a => a.email === 'priya@example.com');
    ok('her login made (email lower-cased)', !!u, W.auth);
    const mem = W.stay.members.find(x => x.user_id === u.id);
    ok('a manager, with the invite\'s permissions and her name', mem && mem.role === 'manager' && mem.permissions.see_money === true && mem.permissions.send_messages === false && mem.display_name === 'Priya', mem);
    ok('holding the invite\'s properties', W.stay.member_properties.map(x => x.property_id).join() === 'p2');
    ok('the invite is used', W.stay.invites[0].used_by === u.id);
    r = await call(W, { action: 'accept', code: CODE, name: 'X', email: 'x@example.com', password: 'xxxxxxxx1' });
    ok('used once only', r.status === 404 && !W.auth.some(a => a.email === 'x@example.com'), r); }
  { const W = world();
    const r = await call(W, { action: 'accept', code: CODE, name: 'Ravi', email: 'ravi@example.com', password: 'ravi-pass-1' });
    ok('an email that already has a login: sign in first, then open the link', r.status === 409 && /Sign in with it/.test(r.body.error) && !W.stay.invites[0].used_by, r); }

  console.log('\n— accept, signed in —');
  { const W = world();
    let r = await call(W, { action: 'accept', code: CODE, name: 'Ravi' }, 'tok-ravi');
    ok('the signed-in login joins; no new login made', r.status === 200 && W.auth.length === 2 && W.stay.members.some(m => m.user_id === 'u-ravi' && m.role === 'manager'), r);
    W.stay.invites.push({ code: 'zzzzzzzzzzzzzzzzzzzzzzzz', account_id: A, role: 'manager', property_ids: ['p1'], permissions: {}, expires_at: '2026-11-20T00:00:00Z', used_by: null });
    r = await call(W, { action: 'accept', code: 'zzzzzzzzzzzzzzzzzzzzzzzz' }, 'tok-owner');
    ok('someone already on the team: says so, and the invite stays free', r.status === 409 && !W.stay.invites[3].used_by, r);
    ok('a bad token: refused', (await call(W, { action: 'accept', code: 'zzzzzzzzzzzzzzzzzzzzzzzz' }, 'tok-forged')).status === 401); }

  console.log('\n— nothing half-made —');
  { const W = world({ failMembers: true });
    const r = await call(W, { action: 'accept', code: CODE, name: 'Priya', email: 'priya@example.com', password: 'priya-pass-1' });
    ok('joining failed: the login made is deleted again and the invite is free', r.status === 500 && !W.auth.some(a => a.email === 'priya@example.com') && !W.stay.invites[0].used_by, { r, auth: W.auth, inv: W.stay.invites[0] }); }

  console.log('\n— a new owner, from a platform invite (v71) —');
  { const W = world();
    let r = await call(W, { action: 'owner-peek', code: PINV });
    ok('peek: who it is for, nothing else', r.status === 200 && r.body.label === 'Asha, Goa' && Object.keys(r.body).sort().join() === 'expires_at,label,ok', r);
    ok('a team invite is not an owner invite', (await call(W, { action: 'owner-peek', code: CODE })).status === 404);
    const asha = { action: 'owner-accept', code: PINV, name: 'Asha', email: 'Asha@Example.com', password: 'asha-pass-1', business: 'Sea Breeze Stays', account_code: 'SeaBreeze', time_zone: 'Asia/Kolkata', currency: 'inr' };
    r = await call(W, { ...asha, account_code: 'sea breeze' });
    ok('an account code with a space: refused before any login is made', r.status === 400 && /2 to 12/.test(r.body.error) && W.auth.length === 2, r);
    r = await call(W, { ...asha, business: '' });
    ok('no business name: refused', r.status === 400 && /name/.test(r.body.error));
    W.stay.accounts[0].code = 'raaya';
    r = await call(W, { ...asha, account_code: 'raaya' });
    ok('a code already taken: says so, nothing made', r.status === 409 && /taken/.test(r.body.error) && W.auth.length === 2, r);
    r = await call(W, asha);
    const u = W.auth.find(a => a.email === 'asha@example.com');
    ok('opened: her login, then the account through stay.open_account (code lower-cased, currency upper-cased)', r.status === 200 && u && W.opened.length === 1
      && W.opened[0].p_user === u.id && W.opened[0].p_code === 'seabreeze' && W.opened[0].p_currency === 'INR' && W.opened[0].p_owner_name === 'Asha', { r, opened: W.opened });
    ok('she is its owner', W.stay.members.some(m => m.user_id === u.id && m.role === 'owner' && m.account_id === r.body.account));
    r = await call(W, { ...asha, email: 'b@example.com', account_code: 'other' });
    ok('used once only', r.status === 404 && !W.auth.some(a => a.email === 'b@example.com'), r); }
  { const W = world();
    const r = await call(W, { action: 'owner-accept', code: PINV, business: 'Ravi Homes', account_code: 'ravi', currency: 'INR' }, 'tok-ravi');
    ok('signed in already: that login opens the account, no new login', r.status === 200 && W.auth.length === 2 && W.opened[0].p_user === 'u-ravi', r); }
  { const W = world({ failOpen: true });
    const r = await call(W, { action: 'owner-accept', code: PINV, name: 'Asha', email: 'asha@example.com', password: 'asha-pass-1', business: 'Sea Breeze', account_code: 'seabreeze' });
    ok('opening fails: the login made is deleted again and the invite stays free', r.status === 500 && !W.auth.some(a => a.email === 'asha@example.com') && !W.stay.platform_invites[0].used_by, r); }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
