// StayLog · ical-sync — reads the Booking.com / Airbnb calendar export links
// and records what is in them in public.ical_events. The phone does the rest.
// ─────────────────────────────────────────────────────────────────────────────
// One file, no imports, so it can be pasted into the dashboard editor and so
// the tests can run it in Node against a fake network.
//
// Who may run it:
//   • the cron job, with header  x-cron-secret: <ICAL_CRON_SECRET>  → every feed
//   • a signed-in owner (the app's "Import now")                    → their feeds
// Anything else gets 401. Turn OFF "Verify JWT" for this function: it checks
// for itself, and the cron job has no user token.
//
// Environment (Supabase provides the first two to every function):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ICAL_CRON_SECRET (you add this one)
// ─────────────────────────────────────────────────────────────────────────────

export type Env = { SUPABASE_URL?: string; SUPABASE_SERVICE_ROLE_KEY?: string; ICAL_CRON_SECRET?: string };
export type IcsEvent = { uid: string; start: string; end: string; summary: string; description: string; status: string };
type Fetch = (input: string, init?: Record<string, unknown>) => Promise<Response>;

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info, x-cron-secret',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

const FEED_TIMEOUT_MS = 20000;
const FEED_MAX_BYTES = 5_000_000;

// ── iCal parsing ─────────────────────────────────────────────────────────────
// Only what these two feeds use: VEVENTs with all-day dates, folded lines and
// escaped text. A datetime is cut to its date — both platforms send VALUE=DATE.
const unescapeText = (v: string) =>
  v.replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');

function toIsoDate(v: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(v.trim());
  return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
}
function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);     // UTC on a UTC date: no IST shift here
}

export function parseIcs(text: string): IcsEvent[] {
  const lines = String(text || '').replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  const out: IcsEvent[] = [];
  let cur: Record<string, string> | null = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { cur = {}; continue; }
    if (line === 'END:VEVENT') {
      if (cur) {
        const start = toIsoDate(cur.DTSTART || '');
        let end = toIsoDate(cur.DTEND || '');
        if (start) {
          if (!end || end <= start) end = addDays(start, 1);
          const summary = unescapeText(cur.SUMMARY || '');
          out.push({
            uid: cur.UID || `nouid-${start}-${end}-${summary}`,
            start, end, summary,
            description: unescapeText(cur.DESCRIPTION || ''),
            status: (cur.STATUS || '').toUpperCase(),
          });
        }
      }
      cur = null; continue;
    }
    if (!cur) continue;
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const name = line.slice(0, colon).split(';')[0].toUpperCase();
    if (!(name in cur)) cur[name] = line.slice(colon + 1);
  }
  return out.filter(e => e.status !== 'CANCELLED');
}

// Airbnb says "Reserved" for a guest and "… (Not available)" for dates closed
// by hand or mirrored from another calendar. Booking.com says "CLOSED - Not
// available" for everything, guest or not, so every Booking.com event counts
// as a stay; the phone links it to a matching booking instead of duplicating.
export function kindOf(platform: string, summary: string): 'reserved' | 'blocked' {
  if (platform === 'Airbnb') return /reserved/i.test(summary) ? 'reserved' : 'blocked';
  return 'reserved';
}

// ── Talking to the database ──────────────────────────────────────────────────
function db(env: Env, fetchImpl: Fetch) {
  const base = String(env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = String(env.SUPABASE_SERVICE_ROLE_KEY || '');
  // A legacy service_role key is a JWT and goes in Authorization too; a new
  // sb_secret_ key is accepted as apikey alone.
  const headers: Record<string, string> = { apikey: key, 'Content-Type': 'application/json' };
  if (key.startsWith('eyJ')) headers.Authorization = `Bearer ${key}`;
  const call = async (method: string, path: string, body?: unknown, extra: Record<string, string> = {}) => {
    const res = await fetchImpl(`${base}/rest/v1/${path}`, {
      method, headers: { ...headers, ...extra }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${method} ${path.split('?')[0]}: HTTP ${res.status} ${await res.text().catch(() => '')}`.trim());
    const t = await res.text();
    return t ? JSON.parse(t) : null;
  };
  return {
    base, key,
    get: (path: string) => call('GET', path),
    upsert: (table: string, rows: unknown[], onConflict: string) =>
      call('POST', `${table}?on_conflict=${onConflict}`, rows, { Prefer: 'resolution=merge-duplicates,return=minimal' }),
    patch: (path: string, body: unknown) => call('PATCH', path, body, { Prefer: 'return=minimal' }),
  };
}

function sameSecret(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function whoIsAsking(req: Request, env: Env, fetchImpl: Fetch): Promise<{ all: true } | { owner: string } | null> {
  const secret = String(env.ICAL_CRON_SECRET || '');
  const given = req.headers.get('x-cron-secret') || '';
  if (given) return sameSecret(given, secret) ? { all: true } : null;
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const { base, key } = db(env, fetchImpl);
  const res = await fetchImpl(`${base}/auth/v1/user`, { headers: { apikey: key, Authorization: `Bearer ${token}` } });
  if (!res.ok) return null;
  const user = await res.json().catch(() => null);
  return user && user.id ? { owner: String(user.id) } : null;
}

async function readFeed(url: string, fetchImpl: Fetch): Promise<string> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FEED_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { headers: { 'User-Agent': 'StayLog calendar import', Accept: 'text/calendar, */*' }, signal: ctl.signal });
    if (!res.ok) throw new Error(`the feed answered HTTP ${res.status}`);
    const text = await res.text();
    if (text.length > FEED_MAX_BYTES) throw new Error('the feed is unexpectedly large');
    if (!text.includes('BEGIN:VCALENDAR')) throw new Error('the link did not return a calendar');
    return text;
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') throw new Error('the feed did not answer in time');
    throw err;
  } finally { clearTimeout(timer); }
}

type Feed = { id: string; owner_id: string; property_id: string; platform: string; url: string };

async function syncFeed(feed: Feed, d: ReturnType<typeof db>, fetchImpl: Fetch, now: string) {
  const report: Record<string, unknown> = { id: feed.id, platform: feed.platform, property_id: feed.property_id };
  try {
    const events = parseIcs(await readFeed(feed.url, fetchImpl));
    const known: { uid: string; gone_at: string | null }[] =
      await d.get(`ical_events?feed_id=eq.${feed.id}&select=uid,gone_at`) || [];
    if (events.length) {
      await d.upsert('ical_events', events.map(e => ({
        feed_id: feed.id, uid: e.uid, owner_id: feed.owner_id, property_id: feed.property_id,
        platform: feed.platform, start_date: e.start, end_date: e.end, summary: e.summary,
        description: e.description, kind: kindOf(feed.platform, e.summary), updated_at: now, gone_at: null,
      })), 'feed_id,uid');
    }
    // Gone from the feed: flagged, never deleted. An empty answer where there
    // used to be several stays looks like a glitch at their end, not a wave of
    // cancellations, so it flags nothing and says so.
    const present = new Set(events.map(e => e.uid));
    const vanished = known.filter(k => !k.gone_at && !present.has(k.uid));
    let warning = '';
    if (!events.length && vanished.length >= 3) {
      warning = `the feed came back empty; ${vanished.length} stays were left as they were`;
    } else {
      for (const k of vanished)
        await d.patch(`ical_events?feed_id=eq.${feed.id}&uid=eq.${encodeURIComponent(k.uid)}`, { gone_at: now });
    }
    await d.patch(`ical_feeds?id=eq.${feed.id}`, {
      last_fetched_at: now, last_ok_at: warning ? undefined : now, last_error: warning || null, last_count: events.length,
    });
    Object.assign(report, { ok: !warning, count: events.length, gone: warning ? 0 : vanished.length, error: warning || undefined });
  } catch (err) {
    // A network error from fetch quotes the URL, and the URL is the feed's
    // password. Nothing that is stored or shown may carry it.
    const msg = ((err as Error)?.message || String(err)).split(feed.url).join('(the link)')
      .replace(/https?:\/\/\S+/gi, '(the link)');
    await d.patch(`ical_feeds?id=eq.${feed.id}`, { last_fetched_at: now, last_error: msg }).catch(() => {});
    Object.assign(report, { ok: false, error: msg });
  }
  return report;
}

// ── The handler ──────────────────────────────────────────────────────────────
export async function handle(req: Request, env: Env, fetchImpl: Fetch = fetch as unknown as Fetch): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return json({ error: 'function is missing its Supabase settings' }, 500);
  const who = await whoIsAsking(req, env, fetchImpl);
  if (!who) return json({ error: 'not allowed' }, 401);
  const d = db(env, fetchImpl);
  const feeds: Feed[] = await d.get('owner' in who
    ? `ical_feeds?owner_id=eq.${who.owner}&select=id,owner_id,property_id,platform,url`
    : 'ical_feeds?select=id,owner_id,property_id,platform,url') || [];
  const now = new Date().toISOString();
  const results = [];
  for (const f of feeds) results.push(await syncFeed(f, d, fetchImpl, now));   // a handful of feeds; one at a time is polite
  return json({ ok: true, at: now, feeds: results });
}

// deno-lint-ignore no-explicit-any
declare const Deno: any;
if (typeof Deno !== 'undefined' && Deno.serve) {
  Deno.serve((req: Request) => handle(req, {
    SUPABASE_URL: Deno.env.get('SUPABASE_URL'),
    SUPABASE_SERVICE_ROLE_KEY: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
    ICAL_CRON_SECRET: Deno.env.get('ICAL_CRON_SECRET'),
  }));
}
