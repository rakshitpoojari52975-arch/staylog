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
export type Push = { title: string; body: string; url: string; tag: string; badge?: number };

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info, x-cron-secret',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

// The alert types, each with an on/off in notification_prefs. Missing = on.
export const ALERTS = ['attendance', 'utensils', 'newBookings', 'arrivals', 'balances', 'stale', 'backup'] as const;
const STALE_DAYS = 2, BACKUP_DAYS = 3, INBOX_DAYS = 30, KEEP_LOG_DAYS = 60;
// Who pays at the property (as in the app: paysUsDirectly). Others never get a
// balance alert.
const PAYS_US = new Set(['Direct', 'Booking.com']);
// The app's balanceDue(): total − paid − round off (signed; only for guests
// who pay us, Direct or Booking.com), and under ₹1 still counts as fully paid
// for bookings from before round off. A real balance keeps its paise.
export const balanceDue = (b: { total_amount?: unknown; paid?: unknown; round_off?: unknown; source?: unknown }) => {
  const ro = PAYS_US.has(String(b.source || '').trim() || 'Direct') ? Number(b.round_off || 0) : 0;
  const d = Math.round((Number(b.total_amount || 0) - Number(b.paid || 0) - ro) * 100) / 100;
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
    if (!res.ok) throw new Error(`${method} ${path.split('?')[0]}: HTTP ${res.status} ${await res.text().catch(() => '')}`.trim());
    const t = await res.text(); return t ? JSON.parse(t) : null;
  };
  const log = (owner: string, k: string) => `push_log?owner_id=eq.${owner}&key=eq.${encodeURIComponent(k)}`;
  const d = {
    base, key,
    legacy: false,                       // push_log without the inbox columns (inbox.sql not run)
    get: (p: string) => call('GET', p),
    del: (p: string) => call('DELETE', p),
    // The claim and the record are separate. A row is both the inbox entry
    // (title, body, url, alert, sent_at, delivered, read_at) and, through
    // claimed_at, the right to send it now. A key is claimed when it is new,
    // or when it was never delivered and nobody holds it (no claim, or a claim
    // over 10 minutes old from a run that died). So a cron that fires twice
    // sends once, a reminder no device took is retried, and two runs at the
    // same moment cannot both send: Postgres re-checks the condition.
    claim: async (owner: string, k: string, alert: string, push: Push, nowMs: number): Promise<'new' | 'retry' | false> => {
      const at = new Date(nowMs).toISOString();
      const entry = { title: push.title, body: push.body, url: push.url, alert };
      if (!d.legacy) {
        try {
          const rows = await call('POST', 'push_log?on_conflict=owner_id,key',
            [{ owner_id: owner, key: k, ...entry, sent_at: at, delivered: false, claimed_at: at }],
            { Prefer: 'resolution=ignore-duplicates,return=representation' });
          if (Array.isArray(rows) && rows.length) return 'new';
          const stale = new Date(nowMs - 10 * 60e3).toISOString();
          for (const held of ['claimed_at=is.null', `claimed_at=lt.${stale}`]) {
            const got = await call('PATCH', `${log(owner, k)}&delivered=eq.false&${held}`, { ...entry, claimed_at: at },
              { Prefer: 'return=representation' });
            if (Array.isArray(got) && got.length) return 'retry';
          }
          return false;
        } catch (e) {
          if (!/column|PGRST204|42703|schema cache/i.test(String((e as Error).message))) throw e;
          d.legacy = true;                 // before inbox.sql: claim by key alone, as it used to
        }
      }
      const rows = await call('POST', 'push_log?on_conflict=owner_id,key', [{ owner_id: owner, key: k }],
        { Prefer: 'resolution=ignore-duplicates,return=representation' });
      return Array.isArray(rows) && rows.length > 0 ? 'new' : false;
    },
    // What happened, kept: delivered or not. The claim is let go either way.
    record: async (owner: string, k: string, delivered: boolean, nowMs: number) => {
      if (d.legacy) { if (!delivered) await call('DELETE', log(owner, k)).catch(() => {}); return; }
      await call('PATCH', log(owner, k), delivered
        ? { delivered: true, claimed_at: null, sent_at: new Date(nowMs).toISOString() }
        : { delivered: false, claimed_at: null }).catch(() => {});
    },
    // The inbox's unread count (last 30 days): the number on the app icon.
    unread: async (owner: string, nowMs: number): Promise<number | undefined> => {
      if (d.legacy) return undefined;
      const since = new Date(nowMs - INBOX_DAYS * 86400e3).toISOString();
      const rows = await call('GET', `push_log?owner_id=eq.${owner}&read_at=is.null&sent_at=gte.${since}&select=key`).catch(() => null);
      return Array.isArray(rows) ? rows.length : undefined;
    },
  };
  return d;
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

// Sends to every device of one owner. A keyed reminder is claimed first, so
// it goes once however often this runs, and kept in the inbox whether or not
// a device took it (delivered = false: retried the next time it comes up).
// Each push carries the inbox's unread count for the app icon's badge, and
// its key in the url, so tapping it marks it read.
async function deliver(owner: string, key: string | null, alert: string, push: Push, d: ReturnType<typeof db>,
                       env: Env, fetchImpl: Fetch, nowMs: number) {
  const subs: Sub[] = await d.get(`push_subscriptions?owner_id=eq.${owner}&select=endpoint,p256dh,auth`) || [];
  if (!key && !subs.length) return { sent: 0, gone: 0, skipped: 'no devices' };
  if (key && !(await d.claim(owner, key, alert, push, nowMs))) return { sent: 0, gone: 0, skipped: 'already sent' };
  if (!subs.length) { await d.record(owner, key as string, false, nowMs); return { sent: 0, gone: 0, skipped: 'no devices' }; }
  const out: Push = { ...push };
  if (key) {
    out.url = `${push.url}${push.url.includes('#') ? '&' : '#'}n=${encodeURIComponent(key)}`;
    const badge = await d.unread(owner, nowMs);
    if (badge !== undefined) out.badge = badge;
  }
  let sent = 0, gone = 0;
  for (const s of subs) {
    let status = 0;
    try { status = await sendPush(s, out, env, fetchImpl, Math.floor(nowMs / 1000)); } catch { status = 0; }
    if (status >= 200 && status < 300) sent++;
    else if (status === 404 || status === 410) {           // the device unsubscribed for good
      gone++; await d.del(`push_subscriptions?endpoint=eq.${encodeURIComponent(s.endpoint)}`).catch(() => {});
    }
  }
  if (key) await d.record(owner, key, sent > 0, nowMs);
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
  // Only the columns the minimal cloud keeps: no guest names, no amounts.
  const cols = 'id,guests,property_id,check_in,check_out,status';
  const stay = (b: Record<string, any>) => {
    const g = Number(b.guests) || 1, n = nightsBetween(b.check_in, b.check_out);
    return [`${g} guest${g > 1 ? 's' : ''}`, n > 0 ? `${n} night${n === 1 ? '' : 's'}` : '', propName(b.property_id)].filter(Boolean).join(' · ');
  };

  const arriving = await d.get(`bookings?owner_id=eq.${owner}&deleted_at=is.null&status=neq.cancelled&check_in=eq.${tomorrow}&select=${cols}`) || [];
  for (const b of arriving) out.push({ alert: 'arrivals', key: `arrival:${b.id}:${b.check_in}`, push: {
    title: 'Guest arriving tomorrow',
    body: `${stay(b)}. Tap to send the arrival message.`,
    url: `./#open=${encodeURIComponent(b.id)}&send=arrival`, tag: `arrival-${b.id}` } });

  // The day before check-out only — never on the day itself — and only with
  // money actually owed. The phone mirrors balance_due, by its own rule and
  // only for guests who pay us (Direct, Booking.com); it is empty for every
  // other platform. A database from before minimal-cloud.sql has no
  // balance_due yet: then, and only then, the old amounts are used.
  const leavingQ = `bookings?owner_id=eq.${owner}&deleted_at=is.null&status=neq.cancelled&check_out=eq.${tomorrow}&select=`;
  const leaving = await d.get(leavingQ + cols + ',balance_due')
    .catch(() => d.get(leavingQ + cols + ',source,total_amount,paid,round_off').catch(() => d.get(leavingQ + cols + ',source,total_amount,paid')))
    || [];
  for (const b of leaving) {
    const due = 'balance_due' in b
      ? (b.balance_due == null ? 0 : Number(b.balance_due))
      : ('total_amount' in b && PAYS_US.has(String(b.source || '').trim() || 'Direct') ? balanceDue(b) : 0);
    if (!(due > 0)) continue;
    out.push({ alert: 'balances', key: `balance:${b.id}:${b.check_out}`, push: {
      title: `Balance due at check-out tomorrow`,
      body: `${rupees(due)} to collect${propName(b.property_id) ? ' · ' + propName(b.property_id) : ''}. Tap to send the payment request.`,
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

  // The encrypted backup: none in 3 days. Like the sync warning, quiet until
  // the first backup exists (before then there is nothing to have stopped),
  // and quiet if backups.sql has not run.
  const last = (await d.get(`backups?owner_id=eq.${owner}&select=created_at&order=created_at.desc&limit=1`).catch(() => []) || [])[0];
  if (last && Date.parse(last.created_at) < nowMs - BACKUP_DAYS * 86400e3) {
    const days = Math.floor((nowMs - Date.parse(last.created_at)) / 86400e3);
    out.push({ alert: 'backup', key: `backup:${today}`, push: {
      title: 'No backup for ' + days + ' days',
      body: 'The last encrypted backup was ' + days + ' days ago. Open StayLog with a connection to back up.',
      url: './#open=backup', tag: 'backup' } });
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

// New stays from the calendar import. ical-sync names the events it has just
// seen for the first time on a feed it had already read once (so a feed's
// first read, which finds everything, announces nothing). Each is re-read
// here rather than trusted from the caller, and only a live, upcoming
// reservation counts: never an Airbnb block, a stay already begun before
// today, or dates that already match a booking (one Rakshit made himself).
// One push per stay, keyed by property and dates, so the same stay echoed in
// the other platform's feed is not announced twice; Airbnb "Reserved" goes
// first, as in the phone's planIcal(), so it names the platform when both
// arrive together.
const nightsBetween = (a: string, b: string) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400e3);
export function stayDates(ci: string, co: string) {
  const [y1, m1] = ci.split('-'), [y2, m2] = co.split('-');
  const from = y1 === y2 && m1 === m2 ? String(Number(ci.slice(8, 10))) : fmtDay(ci);
  return `${from} → ${fmtDay(co)}`;
}
export async function newBookingPushes(list: unknown, d: ReturnType<typeof db>, nowMs: number) {
  const out: { owner: string; key: string; alert: string; push: Push; skipped?: string }[] = [];
  const today = istDate(nowMs);
  const rows: Record<string, any>[] = [];
  for (const e of (Array.isArray(list) ? list : []).slice(0, 50) as Record<string, unknown>[]) {
    if (!e || typeof e.feed_id !== 'string' || typeof e.uid !== 'string') continue;
    const r = (await d.get(`ical_events?feed_id=eq.${encodeURIComponent(e.feed_id)}&uid=eq.${encodeURIComponent(e.uid)}` +
      '&select=owner_id,property_id,platform,start_date,end_date,kind,gone_at') || [])[0];
    if (r) rows.push(r);
  }
  rows.sort((a, b) => (a.platform === 'Airbnb' ? 0 : 1) - (b.platform === 'Airbnb' ? 0 : 1));
  for (const r of rows) {
    const key = `stay:${r.property_id}:${r.start_date}:${r.end_date}`;
    const skip = (why: string) => out.push({ owner: r.owner_id, key, alert: 'newBookings', push: null as unknown as Push, skipped: why });
    if (r.kind !== 'reserved') { skip('a block, not a stay'); continue; }
    if (r.gone_at) { skip('already gone from the feed'); continue; }
    if (r.start_date < today) { skip('check-in has passed'); continue; }
    const known = await d.get(`bookings?owner_id=eq.${r.owner_id}&property_id=eq.${encodeURIComponent(r.property_id)}` +
      `&check_in=eq.${r.start_date}&check_out=eq.${r.end_date}&deleted_at=is.null&status=neq.cancelled&select=id`) || [];
    if (known.length) { skip('already a booking'); continue; }
    const prop = (await d.get(`properties?id=eq.${encodeURIComponent(r.property_id)}&select=name`) || [])[0];
    const n = nightsBetween(r.start_date, r.end_date);
    out.push({ owner: r.owner_id, key, alert: 'newBookings', push: {
      title: `New ${r.platform} booking`,
      body: [stayDates(r.start_date, r.end_date), `${n} night${n === 1 ? '' : 's'}`, prop && prop.name].filter(Boolean).join(' · '),
      url: `./#open=stay&prop=${encodeURIComponent(r.property_id)}&in=${r.start_date}&out=${r.end_date}`,
      tag: `stay-${r.property_id}-${r.start_date}` } });
  }
  return out;
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
      // Everyone with a device, and everyone whose phone syncs: the inbox keeps
      // a reminder even when no device is left to take it.
      const subs: Sub[] = await d.get('push_subscriptions?select=owner_id') || [];
      const synced: { owner_id: string }[] = await d.get('sync_status?select=owner_id').catch(() => []) || [];
      const owners = [...new Set([...subs, ...synced].map(s => s.owner_id).filter(Boolean))] as string[];
      // Housekeeping: the log keeps 60 days (the inbox shows 30).
      await d.del(`push_log?sent_at=lt.${new Date(nowMs - KEEP_LOG_DAYS * 86400e3).toISOString()}`).catch(() => {});
      const report: unknown[] = [];
      for (const owner of owners) {
        const prefs = await prefsOf(d, owner);
        for (const item of await dailyPushes(owner, d, nowMs)) {
          if (!prefs[item.alert]) { report.push({ key: item.key, skipped: 'turned off' }); continue; }
          report.push({ key: item.key, ...(await deliver(owner, item.key, item.alert, item.push, d, env, fetchImpl, nowMs)) });
        }
      }
      return json({ ok: true, job: 'daily', report });
    }
    if (body && body.job === 'new-bookings') {
      const report: unknown[] = [];
      for (const item of await newBookingPushes(body.events, d, nowMs)) {
        if (item.skipped) { report.push({ key: item.key, skipped: item.skipped }); continue; }
        if (!(await prefsOf(d, item.owner))[item.alert]) { report.push({ key: item.key, skipped: 'turned off' }); continue; }
        report.push({ key: item.key, ...(await deliver(item.owner, item.key, item.alert, item.push, d, env, fetchImpl, nowMs)) });
      }
      return json({ ok: true, job: 'new-bookings', report });
    }
    if (body && body.table) {
      const ev = await eventPush(body, d);
      if (!ev) return json({ ok: true, skipped: 'not a new mark' });
      if (!(await prefsOf(d, ev.owner))[ev.alert]) return json({ ok: true, skipped: 'turned off' });
      return json({ ok: true, key: ev.key, ...(await deliver(ev.owner, ev.key, ev.alert, ev.push, d, env, fetchImpl, nowMs)) });
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
  const r = await deliver(String(user.id), null, 'test', {
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
