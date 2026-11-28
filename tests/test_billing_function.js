/* The billing Edge Function (v75), run in Node against a fake Supabase and a
   fake Razorpay (Node 22.18+ strips the .ts types).
     - the webhook: a wrong or missing signature changes nothing; a right one
       is recorded with its event id (or a hash of the body); the database
       failing → 500 so Razorpay retries; a second subscription is cancelled
       at Razorpay at once
     - the sweep: only with the cron secret
     - subscribe / cancel: only with a token, through billing_prepare's
       verdict; Razorpay's page returned; nothing noted when Razorpay fails;
       cancel at the cycle's end; no keys → "not set up"
     - no secret ever in an answer or a log line */
const path = require('path');
const FN = path.resolve(__dirname, '../supabase/functions/billing/index.ts');
let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (x !== undefined ? '  → ' + JSON.stringify(x) : ''))); };
const A = '11111111-1111-1111-1111-111111111111';
const SECRETS = { RAZORPAY_KEY_ID: 'rzp_test_FAKEKEYID000', RAZORPAY_KEY_SECRET: 'fake-key-secret-for-tests',
  RAZORPAY_WEBHOOK_SECRET: 'fake-webhook-secret', PUSH_CRON_SECRET: 'fake-cron-secret' };
const ENV = { SUPABASE_URL: 'https://proj.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-key', ...SECRETS };

function world(o = {}) {
  const W = { rpc: [], rz: [], prepare: o.prepare || { razorpay_plan_id: 'plan_PROM', period: 'monthly', plan: 'pro' },
    record: o.record || { result: 'active', account: A }, recordFails: !!o.recordFails, rzFails: !!o.rzFails };
  W.fetch = async (url, init = {}) => {
    const u = new URL(url), m = (init.method || 'GET').toUpperCase(), h = init.headers || {};
    const res = (s, b) => new Response(b === undefined ? null : JSON.stringify(b), { status: s });
    if (u.host === 'api.razorpay.com') {
      W.rz.push({ path: u.pathname, auth: h.Authorization, body: JSON.parse(init.body || '{}') });
      if (h.Authorization !== 'Basic ' + Buffer.from(SECRETS.RAZORPAY_KEY_ID + ':' + SECRETS.RAZORPAY_KEY_SECRET).toString('base64')) return res(401, {});
      if (W.rzFails) return res(502, { error: { description: 'down' } });
      if (u.pathname === '/v1/subscriptions') return res(200, { id: 'sub_NEW', short_url: 'https://rzp.io/i/abc', status: 'created' });
      if (/\/cancel$/.test(u.pathname)) return res(200, { id: u.pathname.split('/')[3], status: 'cancelled' });
      return res(404, {});
    }
    if (h.apikey !== 'service-key') return res(401, {});
    if (u.pathname === '/auth/v1/user') return (h.Authorization === 'Bearer tok-owner') ? res(200, { id: 'u-owner' }) : res(401, {});
    if (u.pathname.startsWith('/rest/v1/rpc/')) {
      if (h['Content-Profile'] !== 'stay') return res(404, {});
      const name = u.pathname.slice(13), args = JSON.parse(init.body || '{}');
      W.rpc.push({ name, args });
      if (name === 'billing_record') return W.recordFails ? res(500, { message: 'down' }) : res(200, W.record);
      if (name === 'billing_prepare') return res(200, args.p_plan === null ? (o.cancelPrepare || { subscription: 'sub_A', status: 'active',
        cancel_at_period_end: false, current_period_end: '2026-12-21T00:00:00Z' }) : W.prepare);
      if (name === 'billing_sweep') return res(200, { trials_ended: 1, cancelled: 0, payment_due: 0, expired: 0 });
      return res(200, null);
    }
    return res(404, {});
  };
  return W;
}
const crypto = require('crypto');
const sign = (body, secret = SECRETS.RAZORPAY_WEBHOOK_SECRET) => crypto.createHmac('sha256', secret).update(body).digest('hex');
const req = (headers, body) => new Request('https://proj.supabase.co/functions/v1/billing',
  { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
let F;
const logs = []; const realLog = console.log;
const run = async (W, r, env = ENV) => { console.log = (...a) => logs.push(a.join(' ')); try { const x = await F.handle(r, env, W.fetch);
  return { status: x.status, body: await x.json().catch(() => null) }; } finally { console.log = realLog; } };

(async () => {
  F = await import(FN);
  const EVENT = JSON.stringify({ entity: 'event', event: 'subscription.activated', created_at: 1790000000,
    payload: { subscription: { entity: { id: 'sub_A', plan_id: 'plan_PROM', notes: { account_id: A } } } } });

  console.log('\n— the webhook —');
  { const W = world();
    let r = await run(W, req({ 'x-razorpay-signature': 'deadbeef' }, EVENT));
    ok('a wrong signature: 401, nothing recorded', r.status === 401 && !W.rpc.length);
    r = await run(W, req({ 'x-razorpay-signature': sign(EVENT, 'another-secret') }, EVENT));
    ok('signed with another secret: 401', r.status === 401 && !W.rpc.length);
    r = await run(W, req({ 'x-razorpay-signature': sign(EVENT) }, EVENT.replace('sub_A', 'sub_X')));
    ok('a body changed after signing: 401', r.status === 401 && !W.rpc.length);
    r = await run(W, req({ 'x-razorpay-signature': sign(EVENT), 'x-razorpay-event-id': 'evt_1' }, EVENT));
    ok('signed right: recorded once with its event id, 200', r.status === 200 && W.rpc.length === 1 && W.rpc[0].name === 'billing_record'
      && W.rpc[0].args.p_event_id === 'evt_1' && W.rpc[0].args.p_payload.event === 'subscription.activated', W.rpc);
    r = await run(W, req({ 'x-razorpay-signature': sign(EVENT).toUpperCase() }, EVENT));
    ok('no event id header: a hash of the body stands in (the same body, the same id)', r.status === 200
      && /^sha256:[0-9a-f]{64}$/.test(W.rpc[1].args.p_event_id));
    await run(W, req({ 'x-razorpay-signature': sign(EVENT) }, EVENT));
    ok('…so a repeat without the header is still caught as a repeat', W.rpc[2].args.p_event_id === W.rpc[1].args.p_event_id); }
  { const W = world({ recordFails: true });
    const r = await run(W, req({ 'x-razorpay-signature': sign(EVENT), 'x-razorpay-event-id': 'evt_1' }, EVENT));
    ok('the database did not take it: 500, so Razorpay sends it again', r.status === 500); }
  { const W = world();
    const r = await run(W, req({ 'x-razorpay-signature': sign(EVENT) }, EVENT), { ...ENV, RAZORPAY_WEBHOOK_SECRET: '' });
    ok('no webhook secret set: refused, nothing recorded', r.status === 500 && !W.rpc.length); }
  { const W = world({ record: { result: 'second subscription', account: A, cancel_subscription: 'sub_B' } });
    const r = await run(W, req({ 'x-razorpay-signature': sign(EVENT), 'x-razorpay-event-id': 'evt_2' }, EVENT));
    ok('a second subscription: cancelled at Razorpay at once', r.status === 200 && W.rz.length === 1
      && W.rz[0].path === '/v1/subscriptions/sub_B/cancel' && W.rz[0].body.cancel_at_cycle_end === 0, W.rz); }
  { const W = world({ record: { result: 'unknown account' } });
    const r = await run(W, req({ 'x-razorpay-signature': sign(EVENT), 'x-razorpay-event-id': 'evt_3' }, EVENT));
    ok('an event for no known account: 200 (a retry would not help), nothing at Razorpay', r.status === 200 && !W.rz.length); }

  console.log('\n— the sweep —');
  { const W = world();
    let r = await run(W, req({ 'x-cron-secret': 'wrong' }, { job: 'sweep' }));
    ok('a wrong cron secret: 401', r.status === 401 && !W.rpc.length);
    r = await run(W, req({ 'x-cron-secret': SECRETS.PUSH_CRON_SECRET }, { job: 'sweep' }));
    ok('the cron secret: billing_sweep runs', r.status === 200 && W.rpc[0].name === 'billing_sweep' && r.body.trials_ended === 1);
    ok('…then the audit log\'s housekeeping (v77)', W.rpc[1] && W.rpc[1].name === 'audit_housekeeping'); }

  console.log('\n— subscribe and cancel —');
  { const W = world();
    let r = await run(W, req({}, { action: 'subscribe', account: A, plan: 'pro_monthly' }));
    ok('no token: 401', r.status === 401 && !W.rpc.length && !W.rz.length);
    r = await run(W, req({ authorization: 'Bearer forged' }, { action: 'subscribe', account: A, plan: 'pro_monthly' }));
    ok('a token Supabase does not know: 401', r.status === 401 && !W.rz.length);
    r = await run(W, req({ authorization: 'Bearer tok-owner' }, { action: 'subscribe', account: A, plan: 'pro_monthly' }));
    ok('the owner: billing_prepare asked with their own user id', W.rpc[0].name === 'billing_prepare' && W.rpc[0].args.p_user === 'u-owner'
      && W.rpc[0].args.p_plan === 'pro_monthly');
    ok('…a Razorpay subscription with the account in its notes', W.rz[0].path === '/v1/subscriptions' && W.rz[0].body.plan_id === 'plan_PROM'
      && W.rz[0].body.notes.account_id === A && W.rz[0].body.total_count === 120, W.rz[0]);
    ok('…noted as pending, and Razorpay\'s page returned', r.status === 200 && r.body.url === 'https://rzp.io/i/abc'
      && W.rpc[1].name === 'billing_pending' && W.rpc[1].args.p_subscription === 'sub_NEW', r.body); }
  { const W = world({ prepare: { razorpay_plan_id: 'plan_PROY', period: 'yearly', plan: 'pro' } });
    await run(W, req({ authorization: 'Bearer tok-owner' }, { action: 'subscribe', account: A, plan: 'pro_yearly' }));
    ok('yearly: 10 cycles', W.rz[0].body.total_count === 10); }
  { const W = world({ prepare: { error: 'Only the owner can change the plan.' } });
    const r = await run(W, req({ authorization: 'Bearer tok-owner' }, { action: 'subscribe', account: A, plan: 'pro_monthly' }));
    ok('billing_prepare refuses: its words, 403, nothing at Razorpay', r.status === 403 && r.body.error === 'Only the owner can change the plan.' && !W.rz.length); }
  { const W = world({ rzFails: true });
    const r = await run(W, req({ authorization: 'Bearer tok-owner' }, { action: 'subscribe', account: A, plan: 'pro_monthly' }));
    ok('Razorpay down: says nothing was charged, nothing noted', r.status === 502 && /nothing was charged/.test(r.body.error)
      && !W.rpc.some(c => c.name === 'billing_pending')); }
  { const W = world();
    const r = await run(W, req({ authorization: 'Bearer tok-owner' }, { action: 'subscribe', account: A, plan: 'pro_monthly' }),
      { ...ENV, RAZORPAY_KEY_ID: '', RAZORPAY_KEY_SECRET: '' });
    ok('no Razorpay keys: "Billing is not set up yet"', r.status === 503 && /not set up/.test(r.body.error) && !W.rz.length); }
  { const W = world();
    let r = await run(W, req({ authorization: 'Bearer tok-owner' }, { action: 'subscribe', account: 'not-a-uuid', plan: 'pro_monthly' }));
    ok('a malformed account: refused before anything', r.status === 400 && !W.rpc.length);
    r = await run(W, req({ authorization: 'Bearer tok-owner' }, { action: 'subscribe', account: A, plan: "x'; drop" }));
    ok('a malformed plan: refused before anything', r.status === 400 && !W.rpc.length); }
  { const W = world();
    const r = await run(W, req({ authorization: 'Bearer tok-owner' }, { action: 'cancel', account: A }));
    ok('cancel: at the end of the period paid for, then noted', r.status === 200 && W.rz[0].path === '/v1/subscriptions/sub_A/cancel'
      && W.rz[0].body.cancel_at_cycle_end === 1 && W.rpc.some(c => c.name === 'billing_cancelling') && r.body.until === '2026-12-21T00:00:00Z', W.rz); }
  { const W = world({ cancelPrepare: { subscription: 'sub_A', status: 'active', cancel_at_period_end: true, current_period_end: 'x' } });
    const r = await run(W, req({ authorization: 'Bearer tok-owner' }, { action: 'cancel', account: A }));
    ok('already cancelling: nothing sent again', r.status === 200 && !W.rz.length); }
  { const W = world({ cancelPrepare: { subscription: null, status: 'trialing' } });
    const r = await run(W, req({ authorization: 'Bearer tok-owner' }, { action: 'cancel', account: A }));
    ok('nothing to cancel: 404 in words', r.status === 404 && /no paid plan/.test(r.body.error)); }
  { const W = world({ rzFails: true });
    const r = await run(W, req({ authorization: 'Bearer tok-owner' }, { action: 'cancel', account: A }));
    ok('Razorpay down on cancel: the plan is unchanged, nothing noted', r.status === 502 && !W.rpc.some(c => c.name === 'billing_cancelling')); }

  console.log('\n— secrets —');
  const all = logs.join('\n');
  ok('no secret in any log line', Object.values(SECRETS).every(s => !all.includes(s)) && !all.includes('service-key'));
  ok('constant-time compare: equal and unequal, different lengths', F.sameText('abc', 'abc') && !F.sameText('abc', 'abd') && !F.sameText('abc', 'abcd'));
  ok('the HMAC matches Node\'s', await F.hmacHex('k', 'body') === crypto.createHmac('sha256', 'k').update('body').digest('hex'));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
