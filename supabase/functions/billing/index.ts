// StayLog · billing — paid plans through Razorpay (v75).
// ─────────────────────────────────────────────────────────────────────────────
// One file, no imports (like the others): pastes into the dashboard, and the
// tests run it in Node against a fake Supabase and a fake Razorpay.
//
// Three callers, told apart by their headers:
//   1. Razorpay's webhook (header X-Razorpay-Signature). The signature is
//      HMAC-SHA256 of the raw body with RAZORPAY_WEBHOOK_SECRET, hex; checked
//      in constant time before anything else. Each event is recorded once
//      (its X-Razorpay-Event-Id, else a hash of the body) and applied by
//      stay.billing_record, in one transaction. A second subscription that
//      activates while one is live is cancelled at once, so nobody pays twice.
//      Answers 200 once recorded (even "unknown account": a retry would not
//      help), 500 when the database did not take it (Razorpay retries).
//   2. The daily cron (header x-cron-secret = PUSH_CRON_SECRET, the secret
//      notify already uses): {"job":"sweep"} → stay.billing_sweep, then
//      stay.audit_housekeeping (v77: sign-ins into the audit log, old rows out).
//   3. The app, with the owner's own token:
//        {"action":"subscribe","account":…,"plan":"pro_monthly"} → a Razorpay
//          subscription (the account id in its notes) and its hosted payment
//          page (short_url), which the app opens. No Razorpay code in the app.
//        {"action":"cancel","account":…} → cancelled at the end of the period
//          paid for (cancel_at_cycle_end).
//      stay.billing_prepare decides who may (an active owner, a plan on sale,
//      sales open — platform admins may test before), never this file alone.
//
// Turn OFF "Verify JWT" for this function (Razorpay sends no token).
// Secrets (Edge Functions → Secrets; never in the repository):
//   RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET,
//   PUSH_CRON_SECRET (already set for notify).
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase.
// Razorpay's event names, its event-id header and the subscription fields are
// from its SDK and memory: confirm them in the Razorpay dashboard's webhook
// settings before going live (test mode first).
// ─────────────────────────────────────────────────────────────────────────────

export type Env = {
  SUPABASE_URL?: string; SUPABASE_SERVICE_ROLE_KEY?: string;
  RAZORPAY_KEY_ID?: string; RAZORPAY_KEY_SECRET?: string; RAZORPAY_WEBHOOK_SECRET?: string;
  PUSH_CRON_SECRET?: string; RAZORPAY_API?: string;
};
type Fetch = (input: string, init?: Record<string, unknown>) => Promise<Response>;

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PLAN_ID = /^[a-z_]{3,40}$/;

class Refusal extends Error { status: number; constructor(msg: string, status = 400) { super(msg); this.status = status; } }

const enc = (s: string) => new TextEncoder().encode(s);
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
export async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc(body)));
}
// Equal strings in constant time (for the length of the longer one).
export function sameText(a: string, b: string): boolean {
  const x = enc(a), y = enc(b); let d = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] || 0) ^ (y[i] || 0);
  return d === 0;
}

function supa(env: Env, fetchImpl: Fetch) {
  const base = String(env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = String(env.SUPABASE_SERVICE_ROLE_KEY || '');
  const headers: Record<string, string> = { apikey: key, 'Content-Type': 'application/json',
    'Accept-Profile': 'stay', 'Content-Profile': 'stay' };
  if (key.startsWith('eyJ')) headers.Authorization = `Bearer ${key}`;
  return {
    base, key,
    async rpc(name: string, args: Record<string, unknown>) {
      const res = await fetchImpl(`${base}/rest/v1/rpc/${name}`, { method: 'POST', headers, body: JSON.stringify(args) });
      const t = await res.text();
      if (!res.ok) throw new Error(`${name} failed (HTTP ${res.status})`);
      try { return t ? JSON.parse(t) : null; } catch { return t; }
    },
    async user(token: string) {
      const who = await fetchImpl(`${base}/auth/v1/user`, { headers: { apikey: key, Authorization: `Bearer ${token}` } });
      const u = who.ok ? await who.json().catch(() => null) : null;
      return u && u.id ? String(u.id) : null;
    },
  };
}

function razorpay(env: Env, fetchImpl: Fetch) {
  const base = String(env.RAZORPAY_API || 'https://api.razorpay.com').replace(/\/+$/, '');
  const ready = !!(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET);
  const auth = ready ? 'Basic ' + btoa(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`) : '';
  return {
    ready,
    async post(path: string, body: unknown) {
      const res = await fetchImpl(`${base}/v1/${path}`, { method: 'POST',
        headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await res.json().catch(() => null) as Record<string, any> | null;
      return { ok: res.ok, status: res.status, data };
    },
  };
}

async function webhook(req: Request, env: Env, d: ReturnType<typeof supa>, rz: ReturnType<typeof razorpay>) {
  if (!env.RAZORPAY_WEBHOOK_SECRET) return json({ error: 'not set up' }, 500);
  const raw = await req.text();
  const given = (req.headers.get('x-razorpay-signature') || '').trim().toLowerCase();
  if (!sameText(given, await hmacHex(env.RAZORPAY_WEBHOOK_SECRET, raw))) {
    console.log('billing: webhook refused — signature does not match');
    return json({ error: 'bad signature' }, 401);
  }
  let payload: Record<string, any>;
  try { payload = JSON.parse(raw); } catch { return json({ error: 'not JSON' }, 400); }
  const id = (req.headers.get('x-razorpay-event-id') || '').trim()
    || 'sha256:' + hex(await crypto.subtle.digest('SHA-256', enc(raw)));
  let r: Record<string, any>;
  try { r = await d.rpc('billing_record', { p_event_id: id, p_payload: payload }) || {}; }
  catch (e) { console.log('billing: could not record', payload.event, String((e as Error).message)); return json({ error: 'not recorded' }, 500); }
  console.log('billing:', payload.event, '→', r.result, r.account ? `(account ${r.account})` : '');
  if (r.cancel_subscription && rz.ready) {
    const c = await rz.post(`subscriptions/${encodeURIComponent(r.cancel_subscription)}/cancel`, { cancel_at_cycle_end: 0 });
    console.log('billing: second subscription', r.cancel_subscription, c.ok ? 'cancelled' : `NOT cancelled (HTTP ${c.status}) — cancel it in Razorpay`);
  }
  return json({ ok: true, result: r.result });
}

export async function handle(req: Request, env: Env, fetchImpl: Fetch = fetch as unknown as Fetch): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return json({ error: 'function is missing its Supabase settings' }, 500);
  const d = supa(env, fetchImpl), rz = razorpay(env, fetchImpl);
  try {
    if (req.headers.has('x-razorpay-signature')) return await webhook(req, env, d, rz);

    const cron = req.headers.get('x-cron-secret');
    if (cron !== null) {
      if (!env.PUSH_CRON_SECRET || !sameText(cron, env.PUSH_CRON_SECRET)) return json({ error: 'not allowed' }, 401);
      const body = await req.json().catch(() => ({})) as Record<string, any>;
      if (body.job !== 'sweep') throw new Refusal('unknown job');
      const r = await d.rpc('billing_sweep', {});
      console.log('billing: sweep', JSON.stringify(r));
      // v77: the audit log's daily housekeeping (sign-ins copied, rows over a
      // year old removed). Before 15-privacy.sql there is none.
      let audit: unknown = null;
      try { audit = await d.rpc('audit_housekeeping', {}); } catch { audit = 'not set up (15-privacy.sql)'; }
      console.log('billing: audit housekeeping', JSON.stringify(audit));
      return json({ ok: true, ...r, audit });
    }

    const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const user = token ? await d.user(token) : null;
    if (!user) throw new Refusal('not allowed', 401);
    const body = await req.json().catch(() => ({})) as Record<string, any>;
    const action = String(body.action || ''), account = String(body.account || '');
    if (!UUID.test(account)) throw new Refusal('account needed');

    if (action === 'subscribe') {
      const plan = String(body.plan || '');
      if (!PLAN_ID.test(plan)) throw new Refusal('plan needed');
      const p = await d.rpc('billing_prepare', { p_account: account, p_user: user, p_plan: plan }) || {};
      if (p.error) throw new Refusal(p.error, 403);
      if (!rz.ready) throw new Refusal('Billing is not set up yet.', 503);
      const made = await rz.post('subscriptions', {
        plan_id: p.razorpay_plan_id, total_count: p.period === 'yearly' ? 10 : 120, quantity: 1, customer_notify: 1,
        notes: { account_id: account, plan } });
      const sub = made.data || {};
      if (!made.ok || !sub.id || !/^https:\/\//.test(String(sub.short_url || ''))) {
        console.log('billing: Razorpay did not make a subscription', made.status);
        throw new Refusal('Razorpay did not answer — nothing was charged. Try again in a minute.', 502);
      }
      await d.rpc('billing_pending', { p_account: account, p_subscription: sub.id });
      return json({ ok: true, url: sub.short_url, subscription: sub.id });
    }

    if (action === 'cancel') {
      const p = await d.rpc('billing_prepare', { p_account: account, p_user: user, p_plan: null }) || {};
      if (p.error) throw new Refusal(p.error, 403);
      if (!p.subscription || p.status !== 'active') throw new Refusal('There is no paid plan to cancel.', 404);
      if (p.cancel_at_period_end) return json({ ok: true, until: p.current_period_end });
      if (!rz.ready) throw new Refusal('Billing is not set up yet.', 503);
      const c = await rz.post(`subscriptions/${encodeURIComponent(p.subscription)}/cancel`, { cancel_at_cycle_end: 1 });
      if (!c.ok) throw new Refusal('Razorpay did not answer — your plan is unchanged. Try again in a minute.', 502);
      await d.rpc('billing_cancelling', { p_account: account });
      return json({ ok: true, until: p.current_period_end });
    }
    throw new Refusal('unknown action');
  } catch (e) {
    if (e instanceof Refusal) return json({ error: e.message }, e.status);
    console.log('billing: failed', String((e as Error).message));
    return json({ error: 'Something went wrong. Try again.' }, 500);
  }
}

// deno-lint-ignore no-explicit-any
declare const Deno: any;
if (typeof Deno !== 'undefined' && Deno.serve) {
  Deno.serve((req: Request) => handle(req, {
    SUPABASE_URL: Deno.env.get('SUPABASE_URL'),
    SUPABASE_SERVICE_ROLE_KEY: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
    RAZORPAY_KEY_ID: Deno.env.get('RAZORPAY_KEY_ID'),
    RAZORPAY_KEY_SECRET: Deno.env.get('RAZORPAY_KEY_SECRET'),
    RAZORPAY_WEBHOOK_SECRET: Deno.env.get('RAZORPAY_WEBHOOK_SECRET'),
    PUSH_CRON_SECRET: Deno.env.get('PUSH_CRON_SECRET'),
  }));
}
