// StayLog · team-invite — a manager joins an account from the owner's link.
// ─────────────────────────────────────────────────────────────────────────────
// One file, no imports (like the other functions): pastes into the dashboard,
// and the tests run it in Node against a fake Supabase.
//
// The owner makes the invite in the app (Team → Invite a manager): a row in
// stay.invites with a long random code, the properties and the permissions.
// The link carries the code. Public sign-up stays off: the login is made here,
// and only for someone holding a live invite.
//   {"action":"peek","code":…}       what the invite is for (business, the
//                                    properties' names, who it is for) — no
//                                    sign-in needed, nothing private
//   {"action":"accept","code":…,"name":…,"email":…,"password":…}
//                                    makes their login and joins them; or, with
//                                    a signed-in user's token instead of email
//                                    and password, joins that login
// An invite is used once (claimed atomically) and only before it expires. It
// can only make a manager. If joining fails half-way, the login made here is
// deleted again and the invite is free again.
// Turn OFF "Verify JWT" for this function (it checks a token itself when one comes).
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
const CODE = /^[A-Za-z0-9_-]{16,64}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
class Refusal extends Error { status: number; constructor(msg: string, status = 400) { super(msg); this.status = status; } }

function api(env: Env, fetchImpl: Fetch) {
  const base = String(env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = String(env.SUPABASE_SERVICE_ROLE_KEY || '');
  const headers: Record<string, string> = { apikey: key, 'Content-Type': 'application/json' };
  if (key.startsWith('eyJ')) headers.Authorization = `Bearer ${key}`;
  const stay = { 'Accept-Profile': 'stay', 'Content-Profile': 'stay' };
  const call = async (method: string, path: string, body?: unknown, extra: Record<string, string> = {}) => {
    const res = await fetchImpl(`${base}${path}`, { method, headers: { ...headers, ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
    const t = await res.text(); let data: unknown = null; try { data = t ? JSON.parse(t) : null; } catch { data = t; }
    return { ok: res.ok, status: res.status, data };
  };
  return {
    base, key,
    get: async (path: string) => { const r = await call('GET', `/rest/v1/${path}`, undefined, stay);
      if (!r.ok) throw new Error(`read failed (HTTP ${r.status})`); return (r.data as Record<string, any>[]) || []; },
    write: (method: string, path: string, body: unknown, prefer = 'return=representation') =>
      call(method, `/rest/v1/${path}`, body, { ...stay, Prefer: prefer }),
    admin: (method: string, path: string, body?: unknown) => call(method, `/auth/v1/admin/${path}`, body),
  };
}

export async function handle(req: Request, env: Env, fetchImpl: Fetch = fetch as unknown as Fetch, nowMs = Date.now()): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return json({ error: 'function is missing its Supabase settings' }, 500);
  const d = api(env, fetchImpl);
  try {
    const body = await req.json().catch(() => ({})) as Record<string, any>;
    const code = String(body.code || '');
    if (!CODE.test(code)) throw new Refusal('That invite link is not complete. Ask for it again.', 404);
    const now = new Date(nowMs).toISOString();
    const live = async () => (await d.get(`invites?code=eq.${encodeURIComponent(code)}&used_by=is.null&expires_at=gt.${encodeURIComponent(now)}` +
      '&select=code,account_id,role,property_ids,permissions,label,expires_at'))[0];
    const inv = await live();
    if (!inv || inv.role !== 'manager') throw new Refusal('This invite has been used, withdrawn or has expired. Ask the owner for a new link.', 404);
    const acct = (await d.get(`accounts?id=eq.${inv.account_id}&select=name`))[0] || {};
    const props = (inv.property_ids || []).length
      ? await d.get(`properties?account_id=eq.${inv.account_id}&id=in.(${(inv.property_ids as string[]).map(encodeURIComponent).join(',')})&deleted_at=is.null&select=id,name`)
      : [];

    if (body.action === 'peek') {
      return json({ ok: true, business: acct.name || '', label: inv.label || '', properties: props.map((p: Record<string, string>) => p.name),
        expires_at: inv.expires_at });
    }
    if (body.action !== 'accept') throw new Refusal('unknown action');

    // Who joins: the signed-in user (a token), or a new login made here.
    const name = String(body.name || '').trim().slice(0, 60);
    let userId = '', made = false;
    const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    if (token) {
      const who = await fetchImpl(`${d.base}/auth/v1/user`, { headers: { apikey: d.key, Authorization: `Bearer ${token}` } });
      const user = who.ok ? await who.json().catch(() => null) : null;
      if (!user || !user.id) throw new Refusal('Your sign-in has expired. Sign in again, then open the link.', 401);
      userId = String(user.id);
    } else {
      const email = String(body.email || '').trim().toLowerCase(), password = String(body.password || '');
      if (!name) throw new Refusal('Please give your name.');
      if (!EMAIL.test(email)) throw new Refusal('That email address does not look right.');
      if (password.length < 8) throw new Refusal('The password needs at least 8 characters.');
      const r = await d.admin('POST', 'users', { email, password, email_confirm: true, user_metadata: { name } });
      if (!r.ok) throw new Refusal(r.status === 422 ? 'That email already has a StayLog login. Sign in with it in the app, then open this link again.'
        : 'Your login could not be made. Try again.', r.status === 422 ? 409 : 500);
      userId = String((r.data as Record<string, any>).id); made = true;
    }
    const undo = async () => { if (made) await d.admin('DELETE', `users/${userId}`); };

    if ((await d.get(`members?account_id=eq.${inv.account_id}&user_id=eq.${userId}&active=is.true&select=role`)).length) {
      await undo(); throw new Refusal('You are already on this team.', 409);
    }
    // Use the invite, once: only if it is still unused and live at this moment.
    const claim = await d.write('PATCH', `invites?code=eq.${encodeURIComponent(code)}&used_by=is.null&expires_at=gt.${encodeURIComponent(now)}`,
      { used_by: userId, used_at: now });
    if (!claim.ok || !Array.isArray(claim.data) || !claim.data.length) { await undo(); throw new Refusal('This invite has just been used. Ask the owner for a new link.', 409); }
    const free = () => d.write('PATCH', `invites?code=eq.${encodeURIComponent(code)}&used_by=eq.${userId}`, { used_by: null, used_at: null });

    const mem = await d.write('POST', 'members?on_conflict=account_id,user_id', [{ account_id: inv.account_id, user_id: userId, role: 'manager',
      display_name: name || null, permissions: inv.permissions || {}, active: true }], 'resolution=merge-duplicates,return=representation');
    const held = props.map((p: Record<string, string>) => ({ account_id: inv.account_id, user_id: userId, property_id: p.id }));
    const mp = held.length ? await d.write('POST', 'member_properties?on_conflict=account_id,user_id,property_id', held, 'resolution=ignore-duplicates,return=minimal')
      : { ok: true };
    if (!mem.ok || !mp.ok) { await free(); await undo(); throw new Refusal('You could not be added to the team. Try the link again.', 500); }
    return json({ ok: true, account: inv.account_id, business: acct.name || '', properties: props.map((p: Record<string, string>) => p.name) });
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
