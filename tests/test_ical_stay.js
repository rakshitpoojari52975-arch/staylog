/* The ical-sync Edge Function in the new model (v62): with
   public.app_status.model = 'stay' it reads stay.ical_feeds and writes
   stay.ical_events, by account; Import now (a signed-in owner) reads only the
   feeds of accounts that login owns; nothing old touched but app_status. */
const path = require('path');
const FN = path.resolve(__dirname, '../supabase/functions/ical-sync/index.ts');
let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (x !== undefined ? '  → ' + JSON.stringify(x) : ''))); };
const ICS = (uid, a, b, summary) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:' + uid, `DTSTART;VALUE=DATE:${a}`, `DTEND;VALUE=DATE:${b}`,
  'SUMMARY:' + summary, 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');

function world(model) {
  const W = { pub: { app_status: [{ id: 1, model }], ical_feeds: [], ical_events: [] },
    stay: { members: [{ account_id: 'A', user_id: 'u-owner', role: 'owner', active: true }, { account_id: 'B', user_id: 'u-other', role: 'owner', active: true },
                      { account_id: 'A', user_id: 'u-mgr', role: 'manager', active: true }],
      ical_feeds: [{ account_id: 'A', id: 'f1', property_id: 'p1', platform: 'Airbnb', url: 'https://www.airbnb.com/calendar/ical/1.ics?s=secret', last_ok_at: '2026-10-01T00:00:00Z' },
                   { account_id: 'B', id: 'f2', property_id: 'p1', platform: 'Booking.com', url: 'https://admin.booking.com/ical.ics?t=other', last_ok_at: null }],
      ical_events: [{ account_id: 'A', feed_id: 'f1', uid: 'old@airbnb', property_id: 'p1', gone_at: null, imported_booking_id: 'ics_old' }] },
    feedsRead: [], touchedPublic: [], posted: [] };
  const match = (row, q) => q.every(([k, v]) => {
    if (['select', 'on_conflict'].includes(k)) return true;
    if (v.startsWith('in.(')) return v.slice(4, -1).split(',').includes(String(row[k]));
    if (v.startsWith('eq.')) return String(row[k]) === decodeURIComponent(v.slice(3));
    if (v === 'is.true') return row[k] === true;
    return true; });
  W.fetch = async (url, init = {}) => {
    const u = new URL(url), m = (init.method || 'GET').toUpperCase(), h = init.headers || {};
    if (u.host === 'proj.supabase.co') {
      if (u.pathname === '/auth/v1/user') { const id = { 'tok-owner': 'u-owner', 'tok-mgr': 'u-mgr' }[(h.Authorization || '').replace('Bearer ', '')];
        return new Response(id ? JSON.stringify({ id }) : '{}', { status: id ? 200 : 401 }); }
      if (u.pathname.startsWith('/functions/')) { W.posted.push(JSON.parse(init.body)); return new Response('{}', { status: 200 }); }
      const S = h['Accept-Profile'] === 'stay' ? W.stay : W.pub, t = u.pathname.replace('/rest/v1/', ''), q = [...u.searchParams];
      if (S === W.pub) W.touchedPublic.push(m + ' ' + t);
      const T = S[t] || [];
      if (m === 'GET') { if (t === 'ical_feeds') W.feedsRead.push(...T.filter(r => match(r, q)).map(r => r.id)); return new Response(JSON.stringify(T.filter(r => match(r, q))), { status: 200 }); }
      if (m === 'POST') { const keys = u.searchParams.get('on_conflict').split(',');
        for (const r of JSON.parse(init.body)) { const i = T.findIndex(x => keys.every(k => x[k] === r[k])); i < 0 ? T.push({ ...r }) : Object.assign(T[i], r); }
        return new Response(null, { status: 201 }); }
      if (m === 'PATCH') { const p = JSON.parse(init.body); for (const r of T) if (match(r, q)) Object.assign(r, p); return new Response(null, { status: 204 }); }
    }
    if (/airbnb/.test(url)) return new Response(ICS('new@airbnb', '20261110', '20261112', 'Reserved'), { status: 200 });
    if (/booking/.test(url)) return new Response(ICS('x@booking', '20261201', '20261203', 'CLOSED - Not available'), { status: 200 });
    return new Response('', { status: 404 });
  };
  return W;
}
const ENV = { SUPABASE_URL: 'https://proj.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-key', ICAL_CRON_SECRET: 'ical-secret', PUSH_CRON_SECRET: 'push-secret' };
const post = h => new Request('https://proj.supabase.co/functions/v1/ical-sync', { method: 'POST', headers: { 'content-type': 'application/json', ...h }, body: '{}' });

(async () => {
  const F = await import(FN);
  { const W = world('stay');
    const r = await (await F.handle(post({ 'x-cron-secret': 'ical-secret' }), ENV, W.fetch)).json();
    ok('the cron reads every account\'s feeds from stay', r.ok && r.feeds.length === 2 && r.feeds.every(f => f.ok), r);
    const ev = W.stay.ical_events.find(e => e.uid === 'new@airbnb');
    ok('events land in stay.ical_events with their account', ev && ev.account_id === 'A' && ev.feed_id === 'f1' && ev.kind === 'reserved' && !('owner_id' in ev), ev);
    ok('an event gone from the feed is flagged, not deleted', W.stay.ical_events.find(e => e.uid === 'old@airbnb').gone_at);
    ok('the feed\'s fetch record is written in stay', W.stay.ical_feeds.find(f => f.id === 'f1').last_count === 1);
    ok('a new stay on a feed already read is handed to notify; a first read announces nothing',
      W.posted.length === 1 && W.posted[0].events.length === 1 && W.posted[0].events[0].uid === 'new@airbnb', W.posted);
    ok('the old tables: only app_status read', W.touchedPublic.every(x => x === 'GET app_status'), W.touchedPublic); }
  { const W = world('stay');
    await F.handle(post({ authorization: 'Bearer tok-owner' }), ENV, W.fetch);
    ok('Import now: only the feeds of accounts this login owns', W.feedsRead.join() === 'f1', W.feedsRead); }
  { const W = world('stay');
    const r = await (await F.handle(post({ authorization: 'Bearer tok-mgr' }), ENV, W.fetch)).json();
    ok('a manager reads no calendar links', r.feeds.length === 0 && W.feedsRead.length === 0, r); }
  { const W = world('public');
    W.pub.ical_feeds.push({ id: 'g1', owner_id: 'u-owner', property_id: 'p1', platform: 'Airbnb', url: 'https://www.airbnb.com/calendar/ical/9.ics?s=x', last_ok_at: null });
    await F.handle(post({ 'x-cron-secret': 'ical-secret' }), ENV, W.fetch);
    ok('model public: the old tables, as before', W.pub.ical_events.some(e => e.owner_id === 'u-owner' && e.uid === 'new@airbnb')
      && !W.stay.ical_events.some(e => e.uid === 'new@airbnb')); }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
