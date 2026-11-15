// StayLog · staff-login — create, reset and disable staff logins from the app.
// ─────────────────────────────────────────────────────────────────────────────
// One file, no imports (like notify and ical-sync): pastes into the dashboard,
// and the tests run it in Node against a fake Supabase.
//
// A staff login is a Supabase Auth user with a made-up address she never sees:
//   <username>.<account code>@staff.staylog.invalid
// She signs in on staff.html with the account code, her username and her
// password. Logins made before v64 keep their old address (the page still
// tries it when no code is given), and reset / disable work on them too.
//
// Who may: a signed-in owner of the account, or a manager with the
// manage_staff permission. Everything is checked here, with the service role,
// and filtered by account_id; nothing about another account is ever touched.
//   {"action":"create","account":…,"staff_id":…,"username":…,"password":…}
//   {"action":"reset", "account":…,"staff_id":…,"password":…}
//   {"action":"disable"|"enable","account":…,"staff_id":…}
// Passwords: at least 8 characters. They are never stored or returned here.
// Turn OFF "Verify JWT" for this function (it checks the token itself).
// Environment: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (provided by Supabase).
// ─────────────────────────────────────────────────────────────────────────────

export type Env = { SUPABASE_URL?: string; SUPABASE_SERVICE_ROLE_KEY?: string };
type Fetch = (input: string, init?: Record<string, unknown>) => Promise<Response>;

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
export const STAFF_DOMAIN = 'staff.staylog.invalid';
export const staffEmail = (username: string, code: string) => `${username}.${code}@${STAFF_DOMAIN}`;
const USERNAME = /^[a-z0-9][a-z0-9_-]{1,23}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BAN_FOREVER = '876000h';

class Refusal extends Error { status: number; constructor(msg: string, status = 400) { super(msg); this.status = status; } }

function api(env: Env, fetchImpl: Fetch) {
  const base = String(env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = String(env.SUPABASE_SERVICE_ROLE_KEY || '');
  const headers: Record<string, string> = { apikey: key, 'Content-Type': 'application/json' };
  if (key.startsWith('eyJ')) headers.Authorization = `Bearer ${key}`;
  const call = async (method: string, path: string, body?: unknown, extra: Record<string, string> = {}) => {
    const res = await fetchImpl(`${base}${path}`, { method, headers: { ...headers, ...extra },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const t = await res.text();
    let data: unknown = null; try { data = t ? JSON.parse(t) : null; } catch { data = t; }
    return { ok: res.ok, status: res.status, data };
  };
  const stay = { 'Accept-Profile': 'stay', 'Content-Profile': 'stay' };
  return {
    base, key,
    get: async (path: string) => {
      const r = await call('GET', `/rest/v1/${path}`, undefined, stay);
      if (!r.ok) throw new Error(`read failed (HTTP ${r.status})`);
      return (r.data as Record<string, any>[]) || [];
    },
    post: (path: string, body: unknown) => call('POST', `/rest/v1/${path}`, body, { ...stay, Prefer: 'return=representation' }),
    patch: (path: string, body: unknown) => call('PATCH', `/rest/v1/${path}`, body, { ...stay, Prefer: 'return=representation' }),
    admin: (method: string, path: string, body?: unknown) => call(method, `/auth/v1/admin/${path}`, body),
  };
}

export async function handle(req: Request, env: Env, fetchImpl: Fetch = fetch as unknown as Fetch): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return json({ error: 'function is missing its Supabase settings' }, 500);
  const d = api(env, fetchImpl);
  try {
    // who is asking
    const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    if (!token) throw new Refusal('not allowed', 401);
    const who = await fetchImpl(`${d.base}/auth/v1/user`, { headers: { apikey: d.key, Authorization: `Bearer ${token}` } });
    const user = who.ok ? await who.json().catch(() => null) : null;
    if (!user || !user.id) throw new Refusal('not allowed', 401);

    const body = await req.json().catch(() => ({})) as Record<string, any>;
    const action = String(body.action || ''), account = String(body.account || ''), staffId = String(body.staff_id || '');
    if (!['create', 'reset', 'disable', 'enable'].includes(action)) throw new Refusal('unknown action');
    if (!UUID.test(account) || !staffId) throw new Refusal('account and staff member are needed');

    // may they manage staff in this account?
    const me = (await d.get(`members?account_id=eq.${account}&user_id=eq.${user.id}&active=is.true&select=role,permissions`))[0];
    const allowed = me && (me.role === 'owner' || (me.role === 'manager' && me.permissions && me.permissions.manage_staff === true));
    if (!allowed) throw new Refusal('Only the owner, or a manager allowed to manage staff, can do this.', 403);

    const staff = (await d.get(`staff?account_id=eq.${account}&id=eq.${encodeURIComponent(staffId)}&deleted_at=is.null&select=id,name`))[0];
    if (!staff) throw new Refusal('That staff member is not in this account.', 404);
    const acct = (await d.get(`accounts?id=eq.${account}&select=code`))[0];
    if (!acct || !acct.code) throw new Refusal('This account has no code yet.');
    const existing = (await d.get(`staff_logins?account_id=eq.${account}&staff_id=eq.${encodeURIComponent(staffId)}&select=user_id,username,active`))[0];

    const password = String(body.password || '');
    const checkPassword = () => { if (password.length < 8) throw new Refusal('The password needs at least 8 characters.'); };

    if (action === 'create') {
      if (existing) throw new Refusal(`${staff.name} already has a login (${existing.username}). Reset its password instead.`, 409);
      const username = String(body.username || '').trim().toLowerCase();
      if (!USERNAME.test(username)) throw new Refusal('A username is 2 to 24 letters, digits, - or _, starting with a letter or digit.');
      checkPassword();
      if ((await d.get(`staff_logins?account_id=eq.${account}&username=eq.${encodeURIComponent(username)}&select=user_id`)).length)
        throw new Refusal(`The username ${username} is already taken in this account.`, 409);
      const made = await d.admin('POST', 'users', { email: staffEmail(username, acct.code), password, email_confirm: true,
        app_metadata: { staylog_staff: true, account: account } });
      const newId = made.ok && made.data && (made.data as Record<string, any>).id;
      if (!newId) throw new Refusal(made.status === 422 ? `The username ${username} is already taken.` : 'The login could not be made. Try again.', 409);
      const row = await d.post('staff_logins', [{ user_id: newId, account_id: account, staff_id: staffId, username,
        display_name: staff.name, active: true }]);
      if (!row.ok) {                                   // never leave a login no one can see
        await d.admin('DELETE', `users/${newId}`);
        throw new Refusal('The login could not be saved. Nothing was made; try again.', 500);
      }
      return json({ ok: true, username, code: acct.code, active: true });
    }

    if (!existing) throw new Refusal(`${staff.name} has no login yet.`, 404);
    if (action === 'reset') {
      checkPassword();
      const r = await d.admin('PUT', `users/${existing.user_id}`, { password });
      if (!r.ok) throw new Refusal('The password could not be changed. Try again.', 500);
      return json({ ok: true, username: existing.username, code: acct.code, active: existing.active });
    }
    const on = action === 'enable';
    const r = await d.admin('PUT', `users/${existing.user_id}`, { ban_duration: on ? 'none' : BAN_FOREVER });
    if (!r.ok) throw new Refusal('That could not be changed. Try again.', 500);
    await d.patch(`staff_logins?account_id=eq.${account}&user_id=eq.${existing.user_id}`, { active: on });
    return json({ ok: true, username: existing.username, code: acct.code, active: on });
  } catch (e) {
    if (e instanceof Refusal) return json({ error: e.message }, e.status);
    return json({ error: 'Something went wrong. Try again.' }, 500);
  }
}

// deno-lint-ignore no-explicit-any
declare const Deno: any;
if (typeof Deno !== 'undefined' && Deno.serve) {
  Deno.serve((req: Request) => handle(req, {
    SUPABASE_URL: Deno.env.get('SUPABASE_URL'),
    SUPABASE_SERVICE_ROLE_KEY: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
  }));
}
