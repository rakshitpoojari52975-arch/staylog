// StayLog · notify — push reminders to the owner's iPhone (a Home Screen web
// app, iOS 16.4+). Reminders only: nothing in the app depends on one arriving.
// ─────────────────────────────────────────────────────────────────────────────
// One file, no imports (like ical-sync): pastes into the dashboard, and the
// tests run it in Node and decrypt what it sends. Web Push encryption
// (RFC 8291, aes128gcm) and the VAPID signature (RFC 8292, ES256) are done
// with WebCrypto.
//
// Who may run it, and what:
//   • x-cron-secret: <PUSH_CRON_SECRET>
//       {"job":"daily"}                   the 9 AM IST run, every owner
//       a Database Webhook payload        Laxmi's attendance / utensil marks
//   • a signed-in owner (the app)
//       {"job":"test"}                    a test push to his own devices
// Anything else gets 401. Turn OFF "Verify JWT" for this function.
//
// Environment: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (provided by Supabase),
// VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT, PUSH_CRON_SECRET (yours).
// The private key lives only there — never in this repository.
// ─────────────────────────────────────────────────────────────────────────────

export type Env = {
  SUPABASE_URL?: string; SUPABASE_SERVICE_ROLE_KEY?: string;
  VAPID_PUBLIC_KEY?: string; VAPID_PRIVATE_KEY?: string; VAPID_SUBJECT?: string; PUSH_CRON_SECRET?: string;
};
type Fetch = (input: string, init?: Record<string, unknown>) => Promise<Response>;
export type Sub = { endpoint: string; p256dh: string; auth: string; owner_id?: string };
export type Push = { title: string; body: string; url: string; tag: string };

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info, x-cron-secret',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

// The alert types, each with an on/off in notification_prefs. Missing = on.
export const ALERTS = ['attendance', 'utensils', 'arrivals', 'balances', 'stale'] as const;
const STALE_DAYS = 2;
// Who pays at the property (as in the app: paysUsDirectly). Others never get a
// balance alert.
const PAYS_US = new Set(['Direct', 'Booking.com']);
// The app's balanceDue(): under ₹1 counts as fully paid (paise left over are
// not a debt); a real balance keeps its paise. Stored amounts are not rounded.
export const balanceDue = (b: { total_amount?: unknown; paid?: unknown }) => {
  const d = Math.round((Number(b.total_amount || 0) - Number(b.paid || 0)) * 100) / 100;
  return d < 1 ? 0 : d;
};

// ── bytes ────────────────────────────────────────────────────────────────────
const enc = new TextEncoder();
export function b64u(bytes: Uint8Array): string {
  let s = ''; for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function unb64u(str: string): Uint8Array {
  const s = String(str || '').replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '='.repeat((4 - s.length % 4) % 4));
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0; for (const p of parts) { out.set(p, i); i += p.length; } return out;
};
async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}

// ── RFC 8291: encrypt one payload for one subscription ───────────────────────
export async function encryptPayload(sub: Sub, payload: Uint8Array): Promise<Uint8Array> {
  const uaPublic = unb64u(sub.p256dh), authSecret = unb64u(sub.auth);
  if (uaPublic.length !== 65 || authSecret.length < 16) throw new Error('bad subscription keys');
  const as = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', as.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, as.privateKey, 256));
  // ikm = HKDF(auth, shared, "WebPush: info\0" || ua_public || as_public, 32)
  const prkKey = await hmac(authSecret, shared);
  const ikm = (await hmac(prkKey, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic, new Uint8Array([1])))).slice(0, 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, concat(enc.encode('Content-Encoding: aes128gcm\0'), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, concat(enc.encode('Content-Encoding: nonce\0'), new Uint8Array([1])))).slice(0, 12);
  const key = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  // One record, the last: payload then the 0x02 delimiter, no padding.
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, concat(payload, new Uint8Array([2]))));
  const rs = new Uint8Array([0, 0, 16, 0]);            // record size 4096
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, ct);
}

// ── RFC 8292: the VAPID header for one push service ──────────────────────────
export async function vapidAuthorization(endpoint: string, env: Env, nowSec: number): Promise<string> {
  const pub = unb64u(String(env.VAPID_PUBLIC_KEY || ''));
  const d = String(env.VAPID_PRIVATE_KEY || '');
  if (pub.length !== 65 || !d) throw new Error('VAPID keys are not set');
  const key = await crypto.subtle.importKey('jwk', {
    kty: 'EC', crv: 'P-256', d, x: b64u(pub.slice(1, 33)), y: b64u(pub.slice(33, 65)), ext: true,
  }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const head = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(enc.encode(JSON.stringify({
    aud: new URL(endpoint).origin, exp: nowSec + 12 * 3600, sub: env.VAPID_SUBJECT || 'mailto:owner@example.invalid',
  })));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${head}.${claims}`)));
  return `vapid t=${head}.${claims}.${b64u(sig)}, k=${env.VAPID_PUBLIC_KEY}`;
}

// Sends one push. Returns the push service's status; 404/410 mean the
// subscription is gone for good.
export async function sendPush(sub: Sub, push: Push, env: Env, fetchImpl: Fetch, nowSec: number): Promise<number> {
  const body = await encryptPayload(sub, enc.encode(JSON.stringify(push)));
  const res = await fetchImpl(sub.endpoint, {
    method: 'POST',
    headers: {
      Authorization: await vapidAuthorization(sub.endpoint, env, nowSec),
      'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream',
      TTL: '86400', Urgency: 'normal',
    },
    body,
  });
  return res.status;
}

// ── the database ─────────────────────────────────────────────────────────────
function db(env: Env, fetchImpl: Fetch) {
  const base = String(env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = String(env.SUPABASE_SERVICE_ROLE_KEY || '');
  const headers: Record<string, string> = { apikey: key, 'Content-Type': 'application/json' };
  if (key.startsWith('eyJ')) headers.Authorization = `Bearer ${key}`;
  const call = async (method: string, path: string, body?: unknown, extra: Record<string, string> = {}) => {
    const res = await fetchImpl(`${base}/rest/v1/${path}`, {
      method, headers: { ...headers, ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (!res.ok) throw new Error(`${method} ${path.split('?')[0]}: HTTP ${res.status}`);
    const t = await res.text(); return t ? JSON.parse(t) : null;
  };
  return {
    base, key,
    get: (p: string) => call('GET', p),
    del: (p: string) => call('DELETE', p),
    // Claims a log key; true if it was free. A second run finds it taken.
    claim: async (owner: string, k: string) => {
      const rows = await call('POST', 'push_log?on_conflict=owner_id,key', [{ owner_id: owner, key: k }],
        { Prefer: 'resolution=ignore-duplicates,return=representation' });
      return Array.isArray(rows) && rows.length > 0;
    },
  };
}

const sameSecret = (a: string, b: string) => {
  if (!a || !b || a.length !== b.length) return false;
  let x = 0; for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i); return x === 0;
};
const istDate = (ms: number, addDays = 0) => new Date(ms + 5.5 * 3600e3 + addDays * 86400e3).toISOString().slice(0, 10);
const istTime = (iso: string) => new Date(iso).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' });
const rupees = (n: number) => '₹' + Number(n).toLocaleString('en-IN', Number(n) % 1 ? { minimumFractionDigits: 2, maximumFractionDigits: 2 } : {});
const fmtDay = (iso: string) => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });

async function prefsOf(d: ReturnType<typeof db>, owner: string): Promise<Record<string, boolean>> {
  const rows = await d.get(`notification_prefs?owner_id=eq.${owner}&select=prefs`) || [];
  const p = (rows[0] && rows[0].prefs) || {};
  return Object.fromEntries(ALERTS.map(a => [a, p[a] !== false]));
}

// Sends to every device of one owner. Logged under `key` first, so it goes
// once however often this runs; un-logged again if no device took it.
async function deliver(owner: string, key: string | null, push: Push, d: ReturnType<typeof db>,
                       env: Env, fetchImpl: Fetch, nowMs: number) {
  const subs: Sub[] = await d.get(`push_subscriptions?owner_id=eq.${owner}&select=endpoint,p256dh,auth`) || [];
  if (!subs.length) return { sent: 0, gone: 0, skipped: 'no devices' };
  if (key && !(await d.claim(owner, key))) return { sent: 0, gone: 0, skipped: 'already sent' };
  let sent = 0, gone = 0;
  for (const s of subs) {
    let status = 0;
    try { status = await sendPush(s, push, env, fetchImpl, Math.floor(nowMs / 1000)); } catch { status = 0; }
    if (status >= 200 && status < 300) sent++;
    else if (status === 404 || status === 410) {           // the device unsubscribed for good
      gone++; await d.del(`push_subscriptions?endpoint=eq.${encodeURIComponent(s.endpoint)}`).catch(() => {});
    }
  }
  if (key && !sent) await d.del(`push_log?owner_id=eq.${owner}&key=eq.${encodeURIComponent(key)}`).catch(() => {});
  return { sent, gone };
}

// ── what to say ──────────────────────────────────────────────────────────────
// Every push carries a visible title and body: iOS may revoke a subscription
// that receives a push without showing one. url is opened on tap.
export async function dailyPushes(owner: string, d: ReturnType<typeof db>, nowMs: number):
    Promise<{ key: string; alert: string; push: Push }[]> {
  const tomorrow = istDate(nowMs, 1), today = istDate(nowMs);
  const out: { key: string; alert: string; push: Push }[] = [];
  const props: { id: string; name: string }[] = await d.get(`properties?owner_id=eq.${owner}&deleted_at=is.null&select=id,name`) || [];
  const propName = (id: string) => (props.find(p => p.id === id) || { name: '' }).name;
  const cols = 'id,guest_name,guests,property_id,check_in,check_out,source,total_amount,paid,status';

  const arriving = await d.get(`bookings?owner_id=eq.${owner}&deleted_at=is.null&status=neq.cancelled&check_in=eq.${tomorrow}&select=${cols}`) || [];
  for (const b of arriving) out.push({ alert: 'arrivals', key: `arrival:${b.id}:${b.check_in}`, push: {
    title: `Arriving tomorrow: ${b.guest_name}`,
    body: `${[propName(b.property_id), `${b.guests || 1} guest${(b.guests || 1) > 1 ? 's' : ''}`].filter(Boolean).join(' · ')}. Tap to send the arrival message.`,
    url: `./#open=${encodeURIComponent(b.id)}&send=arrival`, tag: `arrival-${b.id}` } });

  // The day before check-out only — never on the day itself; Direct and
  // Booking.com only; and only with money actually owed.
  const leaving = await d.get(`bookings?owner_id=eq.${owner}&deleted_at=is.null&status=neq.cancelled&check_out=eq.${tomorrow}&select=${cols}`) || [];
  for (const b of leaving) {
    const due = balanceDue(b);
    if (!PAYS_US.has((String(b.source || '').trim() || 'Direct')) || !(due > 0)) continue;
    out.push({ alert: 'balances', key: `balance:${b.id}:${b.check_out}`, push: {
      title: `Balance due at check-out tomorrow`,
      body: `${b.guest_name} owes ${rupees(due)}${propName(b.property_id) ? ' · ' + propName(b.property_id) : ''}. Tap to send the payment request.`,
      url: `./#open=${encodeURIComponent(b.id)}&send=payment`, tag: `balance-${b.id}` } });
  }

  const sync = (await d.get(`sync_status?owner_id=eq.${owner}&select=last_sync_at`) || [])[0];
  if (sync && Date.parse(sync.last_sync_at) < nowMs - STALE_DAYS * 86400e3) {
    const days = Math.floor((nowMs - Date.parse(sync.last_sync_at)) / 86400e3);
    out.push({ alert: 'stale', key: `stale:${today}`, push: {
      title: 'StayLog has not synced',
      body: `Last sync ${days} days ago, so these reminders may be out of date. Open the app to sync.`,
      url: './#open=cloud', tag: 'stale' } });
  }
  return out;
}

// A Database Webhook from attendance or utensil_marks. Only a mark that is new
// — inserted, or brought back after an undo — is worth a push; a stamp, an
// undo, or the same mark again is not (push_log keeps it to once per mark).
export async function eventPush(payload: Record<string, any>, d: ReturnType<typeof db>):
    Promise<{ owner: string; key: string; alert: string; push: Push } | null> {
  const table = payload.table, rec = payload.record || {}, old = payload.old_record || null;
  if (table !== 'attendance' && table !== 'utensil_marks') return null;
  if (!rec.owner_id || !rec.id || rec.deleted_at) return null;
  const fresh = payload.type === 'INSERT' || (payload.type === 'UPDATE' && old && old.deleted_at);
  if (!fresh) return null;
  const staff = (await d.get(`staff?id=eq.${encodeURIComponent(rec.staff_id)}&select=name`) || [])[0];
  const who = (staff && String(staff.name).split(/\s+/)[0]) || 'Your house help';
  const at = rec.marked_at ? ` at ${istTime(rec.marked_at)}` : '';
  return table === 'attendance'
    ? { owner: rec.owner_id, alert: 'attendance', key: `mark:${rec.id}`, push: {
        title: `${who} came in today`, body: `Marked present${at}, ${fmtDay(rec.date)}.`,
        url: './#open=cloud', tag: `att-${rec.id}` } }
    : { owner: rec.owner_id, alert: 'utensils', key: `mark:${rec.id}`, push: {
        title: `${who} cleaned the utensils`, body: `Reported${at}, ${fmtDay(rec.date)} — to be paid by you.`,
        url: './#open=cloud', tag: `ute-${rec.id}` } };
}

// ── the handler ──────────────────────────────────────────────────────────────
export async function handle(req: Request, env: Env, fetchImpl: Fetch = fetch as unknown as Fetch, nowMs = Date.now()): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return json({ error: 'function is missing its Supabase settings' }, 500);
  const d = db(env, fetchImpl);
  const body = await req.json().catch(() => ({}));

  const given = req.headers.get('x-cron-secret') || '';
  if (given) {
    if (!sameSecret(given, String(env.PUSH_CRON_SECRET || ''))) return json({ error: 'not allowed' }, 401);
    if (body && body.job === 'daily') {
      const subs: Sub[] = await d.get('push_subscriptions?select=owner_id') || [];
      const owners = [...new Set(subs.map(s => s.owner_id).filter(Boolean))] as string[];
      const report: unknown[] = [];
      for (const owner of owners) {
        const prefs = await prefsOf(d, owner);
        for (const item of await dailyPushes(owner, d, nowMs)) {
          if (!prefs[item.alert]) { report.push({ key: item.key, skipped: 'turned off' }); continue; }
          report.push({ key: item.key, ...(await deliver(owner, item.key, item.push, d, env, fetchImpl, nowMs)) });
        }
      }
      return json({ ok: true, job: 'daily', report });
    }
    if (body && body.table) {
      const ev = await eventPush(body, d);
      if (!ev) return json({ ok: true, skipped: 'not a new mark' });
      if (!(await prefsOf(d, ev.owner))[ev.alert]) return json({ ok: true, skipped: 'turned off' });
      return json({ ok: true, key: ev.key, ...(await deliver(ev.owner, ev.key, ev.push, d, env, fetchImpl, nowMs)) });
    }
    return json({ error: 'unknown job' }, 400);
  }

  // The app: a signed-in owner asking for a test push to his own devices.
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return json({ error: 'not allowed' }, 401);
  const who = await fetchImpl(`${d.base}/auth/v1/user`, { headers: { apikey: d.key, Authorization: `Bearer ${token}` } });
  const user = who.ok ? await who.json().catch(() => null) : null;
  if (!user || !user.id) return json({ error: 'not allowed' }, 401);
  if (!body || body.job !== 'test') return json({ error: 'unknown job' }, 400);
  const r = await deliver(String(user.id), null, {
    title: 'StayLog test', body: 'Notifications are on for this iPhone.', url: './#open=menu', tag: 'test' }, d, env, fetchImpl, nowMs);
  return json({ ok: true, ...r });
}

// deno-lint-ignore no-explicit-any
declare const Deno: any;
if (typeof Deno !== 'undefined' && Deno.serve) {
  Deno.serve((req: Request) => handle(req, {
    SUPABASE_URL: Deno.env.get('SUPABASE_URL'),
    SUPABASE_SERVICE_ROLE_KEY: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
    VAPID_PUBLIC_KEY: Deno.env.get('VAPID_PUBLIC_KEY'),
    VAPID_PRIVATE_KEY: Deno.env.get('VAPID_PRIVATE_KEY'),
    VAPID_SUBJECT: Deno.env.get('VAPID_SUBJECT'),
    PUSH_CRON_SECRET: Deno.env.get('PUSH_CRON_SECRET'),
  }));
}
