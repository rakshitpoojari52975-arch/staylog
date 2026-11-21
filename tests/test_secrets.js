/* No server-side secret in this public repository: not in any file, not in
   any commit of any branch (v75). They live only in Supabase's secrets.
     - Razorpay: a live key id (rzp_live_…), a test key id that is not an
       obvious fake, RAZORPAY_KEY_SECRET / RAZORPAY_WEBHOOK_SECRET with a value
     - Supabase: a secret key (sb_secret_…), a JWT whose role is service_role,
       SUPABASE_SERVICE_ROLE_KEY with a value
     - the other function secrets with a value: FINGERPRINT_PEPPER,
       PUSH_CRON_SECRET, ICAL_CRON_SECRET, VAPID_PRIVATE_KEY (and
       test_push_keys.js checks the VAPID key by mathematics)
   A value is allowed only when it is plainly a test's own fake ("fake",
   "test", "example") or read from the environment. Also:
   STAYLOG_REAL_SECRETS="<a>,<b>" searches for your real values themselves.
     node tests/test_secrets.js */
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (x !== undefined ? '  → ' + JSON.stringify(x) : ''))); };
const git = args => { try { return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 30 }); } catch { return ''; } };

const NAMES = ['RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET', 'SUPABASE_SERVICE_ROLE_KEY', 'FINGERPRINT_PEPPER',
  'PUSH_CRON_SECRET', 'ICAL_CRON_SECRET', 'VAPID_PRIVATE_KEY'];
const ASSIGN = new RegExp(`(${NAMES.join('|')})["']?\\s*[:=]\\s*["'\`]?([^"'\`\\s,;)}]{12,})`, 'g');
const FAKE = /fake|test|example|dummy|placeholder|your[-_]|<|\$\{|Deno\.env|process\.env|env\.|\.\.\./i;
// words joined by hyphens or dots ("cron-secret-123", "s3cret-cron-value") are
// a person's made-up test value, never a generated secret
const WORDS = /^[a-z0-9]+(?:[-.][a-z0-9]+)+$/i;
const real = (process.env.STAYLOG_REAL_SECRETS || '').split(',').map(x => x.trim()).filter(x => x.length >= 8);

function jwtRole(tok) {
  try { const p = JSON.parse(Buffer.from(tok.split('.')[1], 'base64url').toString('utf8')); return p && p.role; } catch { return null; }
}
function scan(label, text) {
  const hits = [];
  for (const m of text.match(/rzp_live_[A-Za-z0-9]{8,}/g) || []) hits.push(`${label}: a live Razorpay key id`);
  for (const m of text.match(/rzp_test_[A-Za-z0-9]{8,}/g) || []) if (!/FAKE/i.test(m)) hits.push(`${label}: a Razorpay test key id (${m.slice(0, 13)}…)`);
  for (const m of text.match(/sb_secret_[A-Za-z0-9_-]{12,}/g) || []) hits.push(`${label}: a Supabase secret key`);
  for (const m of text.match(/eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g) || [])
    if (jwtRole(m) === 'service_role') hits.push(`${label}: a service_role JWT`);
  for (const m of text.matchAll(ASSIGN)) if (!FAKE.test(m[2]) && !WORDS.test(m[2])) hits.push(`${label}: ${m[1]} = ${m[2].slice(0, 4)}…`);
  for (const r of real) if (text.includes(r)) hits.push(`${label}: one of your real secrets`);
  return hits;
}

console.log('\n— the scanner itself —');
// (the samples are put together here so this file does not hold them whole)
const R = 'rzp_', SB = 'sb_' + 'secret_', SEC = '_SECRET';
const SAMPLES = [R + 'live_AbCdEfGhIjKlMn', R + 'test_AbCdEfGhIjKlMn', SB + 'abcdefghijklmnop', `RAZORPAY_KEY${SEC}='Xy12Ab34Cd56Ef78Gh90'`,
  `RAZORPAY_WEBHOOK${SEC}: "q8Hn2LwP0zR4tV6x"`, 'FINGERPRINT_' + 'PEPPER=Zk39fjq02nvL1p8s',
  'eyJhbGciOiJIUzI1NiJ9.' + Buffer.from('{"role":"service_role"}').toString('base64url') + '.abcdefghijk'];
const missed = SAMPLES.filter(x => scan('t', x).length !== 1);
ok('catches each kind', missed.length === 0, missed);
ok('lets a test\'s fakes and environment reads through', scan('t', `RAZORPAY_KEY${SEC}: 'fake-key-secret-for-tests'`).length === 0
  && scan('t', `RAZORPAY_KEY_ID: '${R}test_FAKEKEYID000'`).length === 0 && scan('t', `RAZORPAY_KEY${SEC}: Deno.env.get('X')`).length === 0
  && scan('t', `PUSH_CRON${SEC}:'cron-secret-123'`).length === 0
  && scan('t', 'eyJhbGciOiJIUzI1NiJ9.' + Buffer.from('{"role":"anon"}').toString('base64url') + '.abcdefghijk').length === 0);

console.log('\n— every file —');
const files = git(['ls-files', '--cached', '--others', '--exclude-standard']).trim().split('\n').filter(Boolean);
let hits = [], scanned = 0;
for (const f of files) {
  let b; try { b = fs.readFileSync(path.join(ROOT, f)); } catch { continue; }
  if (b.includes(0)) continue;
  scanned++; hits.push(...scan(f, b.toString('utf8')));
}
ok(`no secret in any of the ${scanned} text files`, scanned > 50 && hits.length === 0, hits);

console.log('\n— every commit —');
const hist = git(['log', '--all', '-p', '--no-color']);
const hh = scan('history', hist);
ok('none in the history of any branch', hist.length > 0 && hh.length === 0, hh.slice(0, 5));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
