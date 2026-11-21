/* Stage 1 of billing and data protection (v73): the legal pages and documents.
   - privacy, terms, refund and contact pages exist, are marked DRAFT, carry
     the same version as supabase/stay/11-legal.sql, and link to each other
   - the grievance contact: name, email and postal address
   - the Privacy Policy explains both roles (Fiduciary for owners, Processor
     for guests and staff) and lists every sub-processor
   - the Terms carry the data processing section and the owner's duties
   - the refund policy covers cancellation and refunds (Razorpay needs it)
   - the breach runbook and the region note exist with their key steps
   - the staff page's notice and the app link the pages */
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (x !== undefined ? '  → ' + JSON.stringify(x) : ''))); };
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const text = html => html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const sqlVersions = Object.fromEntries([...read('supabase/stay/11-legal.sql').matchAll(/\('(terms|privacy|refund|staff_notice)', '([\d-]+)'\)/g)].map(m => [m[1], m[2]]));

const PAGES = { 'terms.html': 'terms', 'privacy.html': 'privacy', 'refund.html': 'refund', 'contact.html': 'refund' };
for (const [page, doc] of Object.entries(PAGES)) {
  const h = read(page), t = text(h);
  ok(`${page}: marked DRAFT for legal review`, /data-draft/.test(h) && /DRAFT for legal review/.test(t));
  ok(`${page}: carries the version in force (${sqlVersions[doc]})`, h.includes(`Version ${sqlVersions[doc]}`), sqlVersions);
  ok(`${page}: links the other pages`, ['terms.html', 'privacy.html', 'refund.html', 'contact.html'].every(p => h.includes(`href="${p}"`)));
  ok(`${page}: a phone-width page with the app's icon`, /width=device-width/.test(h) && /favicon-32\.png/.test(h));
}
const privacy = text(read('privacy.html')), terms = text(read('terms.html')), refund = text(read('refund.html')), contact = text(read('contact.html'));
ok('the grievance contact: name, email and address, on Contact and in the Privacy Policy',
  [contact, privacy].every(t => /Rakshit Poojari/.test(t) && /rakshitpoojari52975@gmail\.com/.test(t) && /1331, 3rd floor, Sector 37/.test(t) && /Faridabad 121003/.test(t)));
ok('the Privacy Policy explains both roles', /StayLog is the Data Fiduciary/.test(privacy) && /owner is the Data Fiduciary/.test(privacy) && /Data Processor/.test(privacy));
for (const sp of ['Supabase', 'GitHub', 'Apple', 'Google', 'Mozilla', 'Razorpay', 'jsDelivr'])
  ok(`sub-processor listed: ${sp}`, new RegExp(sp).test(privacy));
ok('the Privacy Policy covers retention, rights, breach, and where data is stored (India, Mumbai — checked 21 Nov 2026)', /How long we keep it/.test(privacy) && /Your rights/.test(privacy)
  && /breach/.test(privacy) && /in India, in its Mumbai region \(ap-south-1\)/.test(privacy) && /Data Protection Board/.test(privacy));
ok('ID photos are said never to leave the phone', /Photographs of identity documents never leave the owner's phone/.test(privacy));
ok('the Terms: a data processing section, StayLog as Processor, the owner as Fiduciary with their duties', /Data processing/.test(terms)
  && /StayLog is your Data Processor/.test(terms) && /you are the Data Fiduciary/.test(terms) && /Form C/.test(terms) && /last 4 digits of an Aadhaar/.test(terms));
ok('the Terms: trial, read-only not deleted, 180 days', /7-day free trial/.test(terms) && /data is not deleted/.test(terms) && /180 days/.test(terms));
ok('the refund policy: cancel any time, end of the period, refunds for errors', /Cancel any time/.test(refund) && /end of the period/.test(refund) && /duplicate charge/.test(refund));
const runbook = read('docs/breach-runbook.md');
ok('the breach runbook: detect, contain, assess, notify (owners and the Board, 72 hours), recover, an email template',
  ['## 1. Detect', '## 2. Contain', '## 3. Assess', '## 4. Notify', '## 5. Recover'].every(h => runbook.includes(h)) && /72 hours/.test(runbook)
  && /Email to affected owners \(template\)/.test(runbook) && /rotate it now/.test(runbook));
const region = read('docs/region.md');
ok('the region note: how to check, and a move plan not run', /Project Settings → General/.test(region) && /ap-south-1/.test(region) && /a plan to move \(not run\)/.test(region)
  && /Edge Functions/.test(region) && /cloud-config\.js/.test(region));
const app = read('app.js'), staff = read('staff.js');
ok('the app links all four pages (⋯ → Terms, privacy and contact) and the sign-up sheets tick the Terms and Privacy Policy',
  ['terms.html', 'privacy.html', 'refund.html', 'contact.html'].every(p => app.includes(`'${p}'`)) && /data-join-accept/.test(app) && /data-start-accept/.test(app));
ok('the staff notice links the contact page', /contact\.html/.test(staff));
ok('no secret or key in the pages', !/sb_secret_|service_role|eyJhbGci|rzp_(live|test)_/.test(['terms.html', 'privacy.html', 'refund.html', 'contact.html'].map(read).join('')));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
