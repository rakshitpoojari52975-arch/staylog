// StayLog · ical-sync — reads the Booking.com / Airbnb calendar export links,
// records what is in them, and (new model, v68) turns new stays into bookings
// itself, with the phone's own rules. Old model: the phone does the bookings.
// ─────────────────────────────────────────────────────────────────────────────
// One file, no imports, so it can be pasted into the dashboard editor and so
// the tests can run it in Node against a fake network.
//
// Who may run it:
//   • the cron job, with header  x-cron-secret: <ICAL_CRON_SECRET>  → every feed
//   • a signed-in owner (the app's "Import now")                    → their feeds,
//     at most once in 5 minutes per account (new model)
//
// A run (new model):
//   1. feeds are read in parallel, at most POOL at once, oldest-read first, at
//      most MAX_FEEDS_PER_ACCOUNT per account; none is started after the fetch
//      deadline (the rest are the oldest next time);
//   2. each account's stored events are planned against its bookings with
//      planIcal() — the phone's rules, copied word for word below — and the
//      bookings are created or updated directly (an update only on the
//      version it planned from, so an edit made meanwhile is never overwritten);
//   3. events not yet announced are settled: a stay this import created, live
//      and not yet begun, goes to notify (which pushes it once and stamps
//      announced_at); anything else is stamped as needing no push. A run cut
//      short leaves them unstamped, and the next run picks them up.
//   One account failing never stops the others.
// Anything else gets 401. Turn OFF "Verify JWT" for this function: it checks
// for itself, and the cron job has no user token.
//
// Environment (Supabase provides the first two to every function):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ICAL_CRON_SECRET (you add this one)
//   PUSH_CRON_SECRET (notify's; optional) — with it, new reservations are handed
//   to the notify function for a "New booking" push
// ─────────────────────────────────────────────────────────────────────────────

export type Env = { SUPABASE_URL?: string; SUPABASE_SERVICE_ROLE_KEY?: string; ICAL_CRON_SECRET?: string; PUSH_CRON_SECRET?: string;
  FINGERPRINT_PEPPER?: string };

// v75, one free trial per business: an Airbnb link names its listing
// (…/calendar/ical/<listing>.ics). Its keyed hash (FINGERPRINT_PEPPER) goes to
// stay.trial_fingerprint, which flags an account whose listing another
// account showed first (for the platform admin; the trial is not ended for
// it). Never the link or the listing id itself. No pepper: nothing is sent.
export function airbnbListing(url: string): string | null {
  const m = /airbnb\.[a-z.]+\/calendar\/ical\/(\d{3,20})\.ics/i.exec(String(url || ''));
  return m ? m[1] : null;
}
async function listingHash(pepper: string, listing: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(pepper), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return [...new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode('airbnb_listing:' + listing)))]
    .map(b => b.toString(16).padStart(2, '0')).join('');
}
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
export const POOL = 5;                        // feeds read at once
export const FETCH_DEADLINE_MS = 45000;       // no feed is started after this
export const MAX_FEEDS_PER_ACCOUNT = 20;      // per run; the rest wait their turn (oldest first)
export const MANUAL_EVERY_MS = 5 * 60e3;      // Import now: once in 5 minutes per account

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

// ── The import rules ─────────────────────────────────────────────────────────
// Copied word for word from cloud.js (planIcal and its helpers), so the server
// decides exactly as the phone did: tests/test_ical_server.js runs both on the
// same cases and fails if they ever differ. Change them together.
// Deterministic, and inside ID_OK: a re-run rewrites the same booking.
export function fnv(str, seed) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h.toString(16).padStart(8, '0');
}
export const icalBookingId = e => 'ics_' + fnv(e.feed_id + '|' + e.uid, 2166136261) + fnv(e.uid + '|' + e.feed_id, 33554467);
const placeholder = platform => `${platform} guest`;

function importNotes(e) {
  if (e.platform === 'Airbnb') {
    const url = (/(https:\/\/\S*airbnb\S*\/reservations\/\S+)/i.exec(e.description || '') || [])[1];
    const last4 = (/Last 4 Digits\)?:\s*(\d{4})/i.exec(e.description || '') || [])[1];
    return ['Imported from the Airbnb calendar.', url ? `Reservation: ${url}` : '',
            last4 ? `Guest phone ends ${last4}.` : ''].filter(Boolean).join('\n');
  }
  return `Imported from the ${e.platform} calendar. The feed carries no name or amount; fill them in.`;
}

// Pure: what the events mean for these bookings. Exposed for the tests.
//  • Airbnb "Reserved" first: those are certainly stays.
//  • Then Booking.com, whose events are all "CLOSED - Not available".
//  • Airbnb blocks last, and they never create a booking: with the two
//    calendars connected, a block is usually a Booking.com stay seen from
//    Airbnb's side, or dates closed by hand.
// An event whose property and exact dates match a live booking is linked to
// it instead of becoming a second booking. That one rule covers mirrors from
// the other platform and stays already typed in by hand.
export function planIcal(events, data, today) {
  const bookings = (data.bookings || []).map(b => ({ ...b }));   // copies: the plan writes nothing itself
  const byId = new Map(bookings.map(b => [b.id, b]));
  const props = new Set((data.properties || []).map(p => p.id));
  const rank = e => e.platform === 'Airbnb' && e.kind === 'reserved' ? 0 : e.kind === 'reserved' ? 1 : 2;
  const order = (events || []).slice().sort((a, b) => rank(a) - rank(b) ||
    String(a.start_date).localeCompare(String(b.start_date)) || String(a.uid).localeCompare(String(b.uid)));
  const plan = { create: [], update: [], stamp: [], counts: {
    events: order.length, created: 0, linked: 0, updated: 0, gone: 0, blocks: 0, past: 0, removed: 0, held: 0 } };
  const C = plan.counts;
  // A live booking with these dates; failing that, an import cancelled here
  // on these dates — the other feed's echo of a stay Rakshit cancelled is
  // the same stay, so it links to the cancelled one and is never re-created.
  // Where an import cancelled here now sits, by its own dates and by the
  // dates its linked events show (a platform may move a stay after it was
  // cancelled here; its echo then arrives on the new dates).
  const stayKey = (p, i, o) => p + '|' + i + '|' + o;
  const cancelledAt = new Map();
  for (const b of bookings) if (b.status === 'cancelled' && /^ics_/.test(b.id)) cancelledAt.set(stayKey(b.propertyId, b.checkIn, b.checkOut), b);
  for (const e of order) {
    const b = e.imported_booking_id && byId.get(e.imported_booking_id);
    if (b && b.status === 'cancelled' && /^ics_/.test(b.id) && !e.gone_at) cancelledAt.set(stayKey(e.property_id, e.start_date, e.end_date), b);
  }
  const sameStay = e => bookings.find(b => b.status !== 'cancelled' && b.propertyId === e.property_id &&
      b.checkIn === e.start_date && b.checkOut === e.end_date) ||
    cancelledAt.get(stayKey(e.property_id, e.start_date, e.end_date));
  const patch = (id, fields) => {
    const b = byId.get(id); Object.assign(b, fields);
    const u = plan.update.find(x => x.id === id);
    u ? Object.assign(u.fields, fields) : plan.update.push({ id, fields: { ...fields } });
  };

  for (const e of order) {
    const own = icalBookingId(e);
    if (e.imported_booking_id) {
      const b = byId.get(e.imported_booking_id);
      if (!b) { C.removed++; continue; }               // deleted on purpose; stays deleted
      if (b.id !== own) continue;                      // linked to a mirror or a hand-entered stay
      if (b.status === 'cancelled') continue;          // cancelled here: stays cancelled, untouched by the feed
      if (!e.gone_at && (b.checkIn !== e.start_date || b.checkOut !== e.end_date)) {
        patch(b.id, { checkIn: e.start_date, checkOut: e.end_date, icalMoved: today,
                      icalMovedFrom: { checkIn: b.checkIn, checkOut: b.checkOut } }); C.updated++;
      }
      if (e.gone_at && !b.icalGone && b.status !== 'cancelled') { patch(b.id, { icalGone: true }); C.gone++; }
      if (!e.gone_at && b.icalGone) patch(b.id, { icalGone: false });
      continue;
    }
    if (e.gone_at) continue;
    if (!(e.end_date > today)) { C.past++; continue; }   // history is not imported
    if (!props.has(e.property_id)) { C.held++; continue; }
    const already = byId.get(own);                     // made earlier; only the stamp failed
    const match = already || sameStay(e);
    if (match) {
      // A stay first seen through Booking.com's mirror of Airbnb, still untouched,
      // takes the right name once Airbnb's own event arrives.
      if (match.id !== own && match.status !== 'cancelled' && e.platform === 'Airbnb' && e.kind === 'reserved' &&
          /^ics_/.test(match.id) && match.source !== 'Airbnb' && match.guestName === placeholder(match.source)) {
        patch(match.id, { source: 'Airbnb', guestName: placeholder('Airbnb'), notes: importNotes(e) });
      }
      plan.stamp.push({ feed_id: e.feed_id, uid: e.uid, booking_id: match.id });
      if (!already) C.linked++;
      continue;
    }
    if (e.kind === 'blocked') { C.blocks++; continue; }
    const b = {
      id: own, propertyId: e.property_id, guestName: placeholder(e.platform), phone: '',
      checkIn: e.start_date, checkOut: e.end_date, guests: 1, totalAmount: '', paid: '',
      source: e.platform, status: 'confirmed', notes: importNotes(e),
      idProofType: '', idProofNumber: '', idProofImage: '', importedOn: today,
    };
    plan.create.push(b); bookings.push(b); byId.set(b.id, b);
    plan.stamp.push({ feed_id: e.feed_id, uid: e.uid, booking_id: b.id });
    C.created++;
  }

  // Per feed, worked out from the events and the bookings as they now stand,
  // so the figures are the same whichever sync computed them:
  //   added   — bookings this feed created (including any deleted since)
  //   updated — of those, how many the feed has moved to new dates
  //   removed — stays the feed no longer lists (flagged on their bookings)
  //   matched — events linked to a booking that was already there
  //   deleted — bookings it created that were deleted here, and stay deleted
  // run.* is what this sync itself changed.
  const stampOf = new Map(plan.stamp.map(x => [x.feed_id + '|' + x.uid, x.booking_id]));
  const createdIds = new Set(plan.create.map(b => b.id));
  const moved = new Set(plan.update.filter(u => 'checkIn' in u.fields).map(u => u.id));
  const flagged = new Set(plan.update.filter(u => u.fields.icalGone === true).map(u => u.id));
  plan.feeds = {};
  for (const e of order) {
    const F = plan.feeds[e.feed_id] = plan.feeds[e.feed_id] || { events: 0, added: 0, updated: 0, removed: 0,
      matched: 0, deleted: 0, blocks: 0, run: { added: 0, updated: 0, removed: 0 } };
    F.events++;
    const bid = e.imported_booking_id || stampOf.get(e.feed_id + '|' + e.uid);
    if (!bid) { if (e.kind === 'blocked' && !e.gone_at) F.blocks++; continue; }
    const b = byId.get(bid);
    if (bid === icalBookingId(e)) {
      F.added++;
      if (!b) F.deleted++;
      else if (b.icalMoved) F.updated++;
      if (createdIds.has(bid)) F.run.added++;
      if (moved.has(bid)) F.run.updated++;
      if (flagged.has(bid)) F.run.removed++;
    } else F.matched++;
    if (e.gone_at && b) F.removed++;
  }
  return plan;
}

// ── Talking to the database ──────────────────────────────────────────────────
function db(env: Env, fetchImpl: Fetch) {
  const base = String(env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = String(env.SUPABASE_SERVICE_ROLE_KEY || '');
  // A legacy service_role key is a JWT and goes in Authorization too; a new
  // sb_secret_ key is accepted as apikey alone.
  const headers: Record<string, string> = { apikey: key, 'Content-Type': 'application/json' };
  if (key.startsWith('eyJ')) headers.Authorization = `Bearer ${key}`;
  // Old model or new (v62): public.app_status.model says which. In the new
  // one every table is in `stay` and rows are by account_id.
  const call = async (method: string, path: string, body?: unknown, extra: Record<string, string> = {}, schema?: string) => {
    const sch = schema !== undefined ? schema : (d.stay ? 'stay' : '');
    const prof: Record<string, string> = sch ? { 'Accept-Profile': sch, 'Content-Profile': sch } : {};
    const res = await fetchImpl(`${base}/rest/v1/${path}`, {
      method, headers: { ...headers, ...prof, ...extra }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${method} ${path.split('?')[0]}: HTTP ${res.status} ${await res.text().catch(() => '')}`.trim());
    const t = await res.text();
    return t ? JSON.parse(t) : null;
  };
  const d = {
    base, key,
    stay: false,
    col: () => d.stay ? 'account_id' : 'owner_id',
    model: async () => {
      const rows = await call('GET', 'app_status?id=eq.1&select=model', undefined, {}, '').catch(() => null);
      d.stay = !!(Array.isArray(rows) && rows[0] && rows[0].model === 'stay');
    },
    get: (path: string) => call('GET', path),
    upsert: (table: string, rows: unknown[], onConflict: string) =>
      call('POST', `${table}?on_conflict=${onConflict}`, rows, { Prefer: 'resolution=merge-duplicates,return=minimal' }),
    patch: (path: string, body: unknown) => call('PATCH', path, body, { Prefer: 'return=minimal' }),
    // new rows only: one already there (made by a phone, or an earlier run) is left as it is
    insertNew: (table: string, rows: unknown[], onConflict: string) =>
      call('POST', `${table}?on_conflict=${onConflict}`, rows, { Prefer: 'resolution=ignore-duplicates,return=minimal' }),
    patchRows: (path: string, body: unknown) => call('PATCH', path, body, { Prefer: 'return=representation' }),
    rpc: (name: string, body: unknown) => call('POST', `rpc/${name}`, body),
  };
  return d;
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

async function readFeed(url: string, fetchImpl: Fetch, timeoutMs = FEED_TIMEOUT_MS): Promise<string> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), Math.max(1000, Math.min(FEED_TIMEOUT_MS, timeoutMs)));
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

// A network error from fetch quotes the URL, and the URL is the feed's
// password. Nothing that is stored or shown may carry it.
export const withoutLinks = (msg: string, url = '') =>
  (url ? msg.split(url).join('(the link)') : msg).replace(/https?:\/\/\S+/gi, '(the link)');

type Feed = { id: string; owner_id: string; account_id?: string; property_id: string; platform: string; url: string;
  last_ok_at?: string | null; last_fetched_at?: string | null };
type Fresh = { feed_id: string; uid: string };

async function syncFeed(feed: Feed, d: ReturnType<typeof db>, fetchImpl: Fetch, now: string, fresh: Fresh[] = [], timeoutMs = FEED_TIMEOUT_MS) {
  const report: Record<string, unknown> = { id: feed.id, platform: feed.platform, property_id: feed.property_id };
  try {
    const events = parseIcs(await readFeed(feed.url, fetchImpl, timeoutMs));
    const known: { uid: string; gone_at: string | null; imported_booking_id?: string | null }[] =
      await d.get(`ical_events?${d.col()}=eq.${feed.owner_id}&feed_id=eq.${feed.id}&select=uid,gone_at,imported_booking_id`) || [];
    // Once a stay is imported, its Airbnb reservation text (the link, the last
    // 4 digits of the guest's phone) is in the booking's notes and has no
    // reason to stay in the events table: it is not written again.
    const imported = new Set(known.filter(k => k.imported_booking_id).map(k => k.uid));
    const seen = new Set(known.map(k => k.uid));
    const rowOf = (e: IcsEvent) => ({
      feed_id: feed.id, uid: e.uid, [d.col()]: feed.owner_id, property_id: feed.property_id,
      platform: feed.platform, start_date: e.start, end_date: e.end, summary: e.summary,
      description: imported.has(e.uid) ? null : e.description, kind: kindOf(feed.platform, e.summary), updated_at: now, gone_at: null,
    });
    if (d.stay) {
      // New model: an event seen for the first time waits to be announced
      // (announced_at null) — unless this is the feed's first good read, which
      // finds everything already there, or it is a block, which is never news.
      const old = events.filter(e => seen.has(e.uid)), fresh_ = events.filter(e => !seen.has(e.uid));
      if (old.length) await d.upsert('ical_events', old.map(rowOf), 'account_id,feed_id,uid');
      if (fresh_.length) await d.upsert('ical_events', fresh_.map(e => ({ ...rowOf(e),
        announced_at: !feed.last_ok_at || kindOf(feed.platform, e.summary) === 'blocked' ? now : null })), 'account_id,feed_id,uid');
    } else if (events.length) {
      await d.upsert('ical_events', events.map(rowOf), 'feed_id,uid');
      // Old model: reservations this feed shows for the first time, for the
      // "New booking" push. Not on its first good read: that finds everything.
      // Blocks are not stays; moved dates keep their uid, so they are not new.
      if (feed.last_ok_at)
        for (const e of events)
          if (!seen.has(e.uid) && kindOf(feed.platform, e.summary) === 'reserved') fresh.push({ feed_id: feed.id, uid: e.uid });
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
        await d.patch(`ical_events?${d.col()}=eq.${feed.owner_id}&feed_id=eq.${feed.id}&uid=eq.${encodeURIComponent(k.uid)}`, { gone_at: now });
    }
    await d.patch(`ical_feeds?${d.col()}=eq.${feed.owner_id}&id=eq.${feed.id}`, {
      last_fetched_at: now, last_ok_at: warning ? undefined : now, last_error: warning || null, last_count: events.length,
    });
    Object.assign(report, { ok: !warning, count: events.length, gone: warning ? 0 : vanished.length, error: warning || undefined });
  } catch (err) {
    const msg = withoutLinks((err as Error)?.message || String(err), feed.url);
    await d.patch(`ical_feeds?${d.col()}=eq.${feed.owner_id}&id=eq.${feed.id}`, { last_fetched_at: now, last_error: msg }).catch(() => {});
    Object.assign(report, { ok: false, error: msg });
  }
  return report;
}

// At most `limit` at once, in the order given; nothing new is started once
// the deadline has passed (those come back undefined).
export async function inPool<T, R>(items: T[], limit: number, deadlineAt: number, clock: () => number,
  work: (item: T, msLeft: number) => Promise<R>): Promise<(R | undefined)[]> {
  const out: (R | undefined)[] = new Array(items.length).fill(undefined);
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const left = deadlineAt - clock();
      if (left <= 0) return;
      const i = next++;
      out[i] = await work(items[i], left);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, lane));
  return out;
}

// Hands new reservations to the notify function, which decides and sends.
// Function secrets are shared across a project, so PUSH_CRON_SECRET is here
// too once notifications are set up; without it, nothing is announced. A
// reminder only: a failure here never fails the import.
async function announce(fresh: Fresh[], env: Env, fetchImpl: Fetch, account?: string) {
  if (!fresh.length || !env.PUSH_CRON_SECRET) return 0;
  try {
    const res = await fetchImpl(`${String(env.SUPABASE_URL).replace(/\/+$/, '')}/functions/v1/notify`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-cron-secret': env.PUSH_CRON_SECRET },
      body: JSON.stringify({ job: 'new-bookings', ...(account ? { account } : {}), events: fresh }) });
    return res.ok ? fresh.length : 0;
  } catch { return 0; }
}

// ── The new model: bookings written here ─────────────────────────────────────
// "Today" where the account is (accounts.time_zone; India unless set).
export function dayIn(tz: string | null | undefined, ms: number): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
  } catch { return new Date(ms + 5.5 * 3600e3).toISOString().slice(0, 10); }
}
const EVENT_COLS = 'feed_id,uid,property_id,platform,start_date,end_date,summary,description,kind,gone_at,imported_booking_id,announced_at';
const BOOKING_COLS = 'id,property_id,check_in,check_out,status,source,guest_name,ical_gone,ical_moved,version';

// The phone's names for a booking's fields ⇄ the stay columns (only the ones
// the import reads or writes).
const COLUMN: Record<string, string> = { propertyId: 'property_id', guestName: 'guest_name', checkIn: 'check_in', checkOut: 'check_out',
  icalMoved: 'ical_moved', icalMovedFrom: 'ical_moved_from', icalGone: 'ical_gone', importedOn: 'imported_on',
  source: 'source', status: 'status', notes: 'notes', guests: 'guests', phone: 'phone' };
const toColumns = (fields: Record<string, unknown>) => {
  const row: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) if (COLUMN[k]) row[COLUMN[k]] = v === '' ? null : v;
  return row;
};
const enc = encodeURIComponent;

// Every row, a page at a time (the API returns at most 1000 at once, and an
// account's events and bookings pile up over the years).
async function allRows(d: ReturnType<typeof db>, path: string, order: string) {
  const out: Record<string, any>[] = [];
  for (let from = 0; ; from += 1000) {
    const page = await d.get(`${path}&order=${order}&limit=1000&offset=${from}`) || [];
    out.push(...page);
    if (page.length < 1000) return out;
  }
}

// One account: plan its stored events against its bookings and write the result.
// `announce` false (09-calendar.sql not run yet): the stored events' announced_at
// has not been filled in, so nothing is announced or stamped.
export async function importAccount(account: string, today: string, d: ReturnType<typeof db>, env: Env, fetchImpl: Fetch, now: string,
  previous: Record<string, any> = {}, announcing = true) {
  const events = await allRows(d, `ical_events?account_id=eq.${account}&select=${EVENT_COLS}`, 'feed_id,uid');
  const rows = await allRows(d, `bookings?account_id=eq.${account}&select=${BOOKING_COLS}`, 'id');
  const props = await d.get(`properties?account_id=eq.${account}&deleted_at=is.null&select=id`) || [];
  const version = new Map(rows.map(r => [r.id, r.version]));
  const data = { properties: props, bookings: rows.map(r => ({ id: r.id, propertyId: r.property_id, checkIn: r.check_in, checkOut: r.check_out,
    status: r.status, source: r.source || '', guestName: r.guest_name || '', icalGone: !!r.ical_gone, icalMoved: r.ical_moved || '' })) };
  const plan: any = planIcal(events, data, today);
  const counts = { ...plan.counts, skipped: 0, announced: 0, waiting: 0 };

  // New stays: inserted only if their id is not there yet (a phone on an old
  // copy, or an earlier run cut short, may have made one).
  if (plan.create.length)
    await d.insertNew('bookings', plan.create.map((b: Record<string, unknown>) => ({ account_id: account, id: b.id,
      ...toColumns({ propertyId: b.propertyId, guestName: b.guestName, checkIn: b.checkIn, checkOut: b.checkOut, guests: b.guests,
        source: b.source, status: b.status, notes: b.notes, importedOn: b.importedOn }) })), 'account_id,id');
  // Changes, each only on the version it was planned from: an edit made since
  // on a phone wins, and the next run plans again from it.
  for (const u of plan.update) {
    const hit = await d.patchRows(`bookings?account_id=eq.${account}&id=eq.${enc(u.id)}&version=eq.${version.get(u.id)}`, toColumns(u.fields)) || [];
    if (!hit.length) counts.skipped++;
  }
  // Stamp last: if a stamp fails, the next run finds the booking by its id.
  for (const s of plan.stamp)
    await d.patch(`ical_events?account_id=eq.${account}&feed_id=eq.${s.feed_id}&uid=eq.${enc(s.uid)}`, { imported_booking_id: s.booking_id });

  // Announcements. A stay is news when this import made its booking (not a
  // link to one typed in by hand or seen on the other platform), it is still
  // live and on the feed, and it has not begun. Anything else needs no push.
  const stamped = new Map(plan.stamp.map((s: Fresh & { booking_id: string }) => [s.feed_id + '|' + s.uid, s.booking_id]));
  const status = new Map(data.bookings.map(b => [b.id, b.status]));
  for (const b of plan.create) status.set(b.id, b.status);
  const news: Fresh[] = [], quiet: Record<string, string[]> = {};
  for (const e of events) {
    if (e.announced_at || !announcing) continue;
    const bid = e.imported_booking_id || stamped.get(e.feed_id + '|' + e.uid);
    const isNews = e.kind === 'reserved' && !e.gone_at && e.start_date >= today && bid === icalBookingId(e) &&
      status.has(bid) && status.get(bid) !== 'cancelled';
    if (isNews) news.push({ feed_id: e.feed_id, uid: e.uid });
    else (quiet[e.feed_id] = quiet[e.feed_id] || []).push(e.uid);
  }
  for (const [feed, uids] of Object.entries(quiet))
    for (const uid of uids)
      await d.patch(`ical_events?account_id=eq.${account}&feed_id=eq.${feed}&uid=eq.${enc(uid)}&announced_at=is.null`, { announced_at: now });
  if (news.length) {
    // notify stamps announced_at on each one it settles; until then they wait
    // for the next run (the push itself is claimed once per stay).
    counts.announced = await announce(news, env, fetchImpl, account);
    counts.waiting = news.length - counts.announced;
  }

  // What each feed led to, for the Calendar sync panel; "last change" is kept
  // from run to run.
  const at = now, feeds: Record<string, unknown> = {};
  for (const [fid, F] of Object.entries(plan.feeds as Record<string, any>)) {
    const changed = F.run.added || F.run.updated || F.run.removed;
    feeds[fid] = { ...F, lastChange: changed ? { at, ...F.run } : (previous.feeds && previous.feeds[fid] && previous.feeds[fid].lastChange) || null };
  }
  return { at, ...counts, feeds };
}

async function runStay(who: { all: true } | { owner: string }, d: ReturnType<typeof db>, env: Env, fetchImpl: Fetch,
  clock: () => number, fetchDeadlineMs: number) {
  const started = clock(), now = new Date(started).toISOString();
  let accounts: string[];
  if ('owner' in who) {
    // Import now: the feeds of every account this login owns (links are
    // owner-only, as before).
    accounts = (await d.get(`members?user_id=eq.${who.owner}&role=eq.owner&active=is.true&select=account_id`) || [])
      .map((m: { account_id: string }) => m.account_id);
  } else {
    accounts = [...new Set((await d.get('ical_feeds?select=account_id') || []).map((f: { account_id: string }) => f.account_id))] as string[];
  }
  if (!accounts.length) return { ok: true, at: now, feeds: [], accounts: [] };
  // v74: an account that cannot be written (its trial or plan has ended) is
  // skipped: Postgres would refuse its bookings anyway. Before 12-plans.sql
  // there is no such function, and every account is read.
  const skipped: { account: string; reason: string }[] = [];
  try {
    const rows: { account_id: string; can_write: boolean }[] = await d.rpc('accounts_can_write', { p_accounts: accounts }) || [];
    const off = new Set(rows.filter(x => x.can_write === false).map(x => x.account_id));
    for (const a of accounts.filter(x => off.has(x))) {
      skipped.push({ account: a, reason: 'read_only' });
      console.log(`ical-sync: account ${a} skipped — read-only (trial or plan ended)`);
    }
    accounts = accounts.filter(x => !off.has(x));
  } catch { /* 12-plans.sql not run yet */ }
  if (!accounts.length) return { ok: true, at: now, feeds: [], accounts: [], skipped };
  // The run record per account (made if missing; the function alone writes it).
  // Without it (09-calendar.sql not run yet) the import still runs, but
  // nothing is announced (every stored event would look new) or held back.
  const runs = await d.insertNew('ical_runs', accounts.map(a => ({ account_id: a })), 'account_id').then(() => true, () => false);
  const throttled: { account: string; next_at: string }[] = [];
  if ('owner' in who && runs) {
    // Once in 5 minutes per account, claimed atomically: two taps at once
    // cannot both get through.
    const cutoff = new Date(started - MANUAL_EVERY_MS).toISOString();
    const free: string[] = [];
    for (const a of accounts) {
      const got = await d.patchRows(`ical_runs?account_id=eq.${a}&or=(last_manual_at.is.null,last_manual_at.lt.${cutoff})`,
        { last_manual_at: now }).catch(() => null);
      if (got && got.length) { free.push(a); continue; }
      const row = (await d.get(`ical_runs?account_id=eq.${a}&select=last_manual_at`).catch(() => []) || [])[0];
      throttled.push({ account: a, next_at: new Date(Date.parse((row && row.last_manual_at) || now) + MANUAL_EVERY_MS).toISOString() });
    }
    accounts = free;
  }
  if (!accounts.length) return { ok: true, at: now, feeds: [], accounts: [], throttled, ...(skipped.length ? { skipped } : {}) };
  const inList = `in.(${accounts.join(',')})`;
  const all: Feed[] = (await d.get(`ical_feeds?account_id=${inList}&select=id,account_id,property_id,platform,url,last_ok_at,last_fetched_at`) || [])
    .map((f: Record<string, string>) => ({ ...f, owner_id: f.account_id }) as unknown as Feed);
  // Oldest read first; at most MAX_FEEDS_PER_ACCOUNT of one account in a run.
  all.sort((a, b) => String(a.last_fetched_at || '').localeCompare(String(b.last_fetched_at || '')) || a.id.localeCompare(b.id));
  if (env.FINGERPRINT_PEPPER) {
    const byAcct: Record<string, Set<string>> = {};
    for (const f of all) { const l = f.platform === 'Airbnb' ? airbnbListing(f.url) : null; if (l) (byAcct[f.owner_id] ||= new Set()).add(l); }
    for (const [a, ls] of Object.entries(byAcct)) {
      try { await d.rpc('trial_fingerprint', { p_account: a, p_kind: 'airbnb_listing',
        p_hashes: await Promise.all([...ls].map(l => listingHash(env.FINGERPRINT_PEPPER as string, l))) }); }
      catch { /* 13-billing.sql not run yet */ }
    }
  }
  const per: Record<string, number> = {}, feeds: Feed[] = [], later: Feed[] = [];
  for (const f of all) ((per[f.owner_id] = (per[f.owner_id] || 0) + 1) <= MAX_FEEDS_PER_ACCOUNT ? feeds : later).push(f);
  const done = await inPool(feeds, POOL, started + fetchDeadlineMs, clock, (f, left) => syncFeed(f, d, fetchImpl, now, [], left));
  const reports: Record<string, unknown>[] = feeds.map((f, i) => done[i] ||
    { id: f.id, platform: f.platform, property_id: f.property_id, ok: false, later: true, error: 'not read this time; it goes first next time' });
  for (const f of later) reports.push({ id: f.id, platform: f.platform, property_id: f.property_id, ok: false, later: true,
    error: `more than ${MAX_FEEDS_PER_ACCOUNT} links in this account; read in turn` });

  const zones = new Map((await d.get(`accounts?id=${inList}&select=id,time_zone`) || []).map((a: { id: string; time_zone: string }) => [a.id, a.time_zone]));
  const prev = new Map((await d.get(`ical_runs?account_id=${inList}&select=account_id,result`).catch(() => []) || [])
    .map((r: { account_id: string; result: unknown }) => [r.account_id, r.result || {}]));
  const results: Record<string, unknown>[] = [];
  for (const a of accounts) {
    // One account's trouble is its own: the others still import.
    let result: Record<string, unknown>;
    try { result = await importAccount(a, dayIn(zones.get(a) as string, started), d, env, fetchImpl, now, prev.get(a) as Record<string, any>, runs); }
    catch (err) { result = { at: now, error: 'The import could not finish — ' + withoutLinks((err as Error)?.message || String(err)),
      feeds: ((prev.get(a) as Record<string, any>) || {}).feeds || {} }; }
    if (runs) await d.patch(`ical_runs?account_id=eq.${a}`, { last_run_at: now, result, updated_at: now }).catch(() => {});
    results.push({ account: a, ...result });
  }
  return { ok: true, at: now, feeds: reports, accounts: results, ...(throttled.length ? { throttled } : {}), ...(skipped.length ? { skipped } : {}) };
}

// ── The handler ──────────────────────────────────────────────────────────────
export async function handle(req: Request, env: Env, fetchImpl: Fetch = fetch as unknown as Fetch,
  opts: { clock?: () => number; fetchDeadlineMs?: number } = {}): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return json({ error: 'function is missing its Supabase settings' }, 500);
  const who = await whoIsAsking(req, env, fetchImpl);
  if (!who) return json({ error: 'not allowed' }, 401);
  const clock = opts.clock || Date.now, deadline = opts.fetchDeadlineMs ?? FETCH_DEADLINE_MS;
  const d = db(env, fetchImpl);
  await d.model();
  if (d.stay) return json(await runStay(who, d, env, fetchImpl, clock, deadline));

  // Old model: events only; the phone makes the bookings.
  const filter = 'owner' in who ? `owner_id=eq.${who.owner}&` : '';
  const feeds: Feed[] = (await d.get(`ical_feeds?${filter}select=id,owner_id,property_id,platform,url,last_ok_at`) || []) as Feed[];
  const now = new Date(clock()).toISOString(), started = clock();
  const fresh: Fresh[] = [];
  const done = await inPool(feeds, POOL, started + deadline, clock, (f, left) => syncFeed(f, d, fetchImpl, now, fresh, left));
  const results = feeds.map((f, i) => done[i] || { id: f.id, platform: f.platform, property_id: f.property_id, ok: false, later: true });
  const announced = await announce(fresh, env, fetchImpl);
  return json({ ok: true, at: now, feeds: results, ...(announced ? { announced } : {}) });
}

// deno-lint-ignore no-explicit-any
declare const Deno: any;
if (typeof Deno !== 'undefined' && Deno.serve) {
  Deno.serve((req: Request) => handle(req, {
    SUPABASE_URL: Deno.env.get('SUPABASE_URL'),
    SUPABASE_SERVICE_ROLE_KEY: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
    ICAL_CRON_SECRET: Deno.env.get('ICAL_CRON_SECRET'),
    PUSH_CRON_SECRET: Deno.env.get('PUSH_CRON_SECRET'),
    FINGERPRINT_PEPPER: Deno.env.get('FINGERPRINT_PEPPER'),
  }));
}
