# Personal data breach runbook (DRAFT for legal review)

Who: **Rakshit Poojari** (rakshitpoojari52975@gmail.com) runs StayLog alone, so
he is the incident lead, the person who contains, and the person who notifies.
Keep this page printed or saved offline: a breach may lock you out of the
tools you would normally use.

StayLog's roles (see `privacy.html`, `terms.html#processing`): for owners' and
managers' own account data StayLog is the **Data Fiduciary** and notifies them
and the Data Protection Board itself. For guest and staff data the **owner** is
the Fiduciary; StayLog, as their **Processor**, tells each affected owner at once
and gives them what they need to notify their guests, staff and the Board.

> The timelines below follow the DPDP Rules, 2025 as understood when this was
> written (intimation "without delay"; a detailed report to the Board within
> 72 hours). **Confirm them with the lawyer and update this page.**

## 1. Detect (minutes)

Signs that should start this runbook:
- Supabase: sign-ins or API traffic you don't recognise (Dashboard → Logs →
  Auth / API), a spike in exports (`stay.audit_log`, action `export`), rows
  changed that nobody changed, new members or staff logins nobody created.
- A secret seen where it should not be (repository, chat, screenshot): the
  service key, the Razorpay key secret or webhook secret, the VAPID private
  key, the fingerprint pepper, a calendar link.
- Razorpay: payments or refunds you didn't make; webhook calls failing their
  signature check in large numbers (the billing function's logs).
- A phone with StayLog lost or stolen (yours, a manager's or staff member's).
- A report from an owner, guest, staff member or researcher.

Write down at once, in a dated note: what was seen, when, by whom, and the
first time it could have started. Keep every log; do not delete anything.

## 2. Contain (first hour)

Pick the steps that fit; it is fine to over-contain.
- **A login is misused:** Supabase → Authentication → Users → the user →
  revoke sessions / ban. In the app: Team → switch the manager off; Staff →
  switch the staff login off.
- **A secret leaked:** rotate it now.
  - Supabase service key: Project Settings → API → roll the secret key; paste
    the new one only into Edge Function secrets.
  - Razorpay: Dashboard → Settings → API keys → regenerate; webhook secret →
    change in Razorpay and in Supabase secrets.
  - VAPID private key: make a new pair (`tools/vapid-keys.html`), update the
    secret and `cloud-config.js` (a release), owners turn notifications on again.
  - A calendar link: regenerate it on Airbnb / Booking.com and save the new one.
- **The database is being read or changed by an attacker:** pause the
  project's API (Project Settings → Pause, or set the Data API off) while
  investigating. Owners see "can't reach the server"; their phones keep their
  copies.
- **A phone is lost:** the owner signs out other sessions by changing their
  password; Team → switch the person off; their PIN still protects the local
  copy.
- Preserve evidence: download the relevant logs (Auth, API, Edge Functions,
  Razorpay) before they age out.

## 3. Assess (within 24 hours)

- Which accounts? Which people (owners, managers, guests, staff)? Which data
  (names, phone numbers, ID numbers, amounts, calendar links)?
- How many records, over what period, and is it still happening?
- Likely consequences for the people affected (fraud, misuse of ID numbers,
  unwanted contact).

## 4. Notify

**Owners and managers (StayLog as Fiduciary), and every affected owner for
their guests and staff (StayLog as Processor): without delay.** Use the
template below, by email.

**Data Protection Board:** an intimation without delay, then a detailed report
within 72 hours of becoming aware (or longer if the Board allows), as the Rules
set out: what happened, the nature, extent, timing and location, likely
consequences, what was done to mitigate, what was done about the cause, the
intimations made to people affected, and a contact. Use the Board's online
process. Keep a copy.

**Guests and staff:** the owner informs them (they are the owner's data
principals); StayLog helps with the facts. Where an owner cannot be reached
and the risk is serious, take advice on informing guests directly.

### Email to affected owners (template)

> Subject: Important: a security incident affecting your StayLog account
>
> Dear <owner name>,
>
> On <date> we found <what happened, in one or two plain sentences>. It
> affected <which data> for <which people> in your account "<business>",
> between <start> and <end>.
>
> What we have done: <contained how; keys rotated; access removed>.
>
> What you need to do:
> 1. <e.g. change your password / check your team / regenerate calendar links>.
> 2. As the Data Fiduciary for your guests and staff, inform the people
>    affected without delay. Tell them what happened, what data was involved,
>    the likely consequences, what you and we have done, what they can do to
>    protect themselves, and how to contact you. A draft you can send:
>    "<short guest/staff notice>".
> 3. Reply to this email with any questions; we will help.
>
> We have reported this to the Data Protection Board of India.
>
> Rakshit Poojari, StayLog · rakshitpoojari52975@gmail.com

## 5. Recover and learn

- Fix the cause; add a test that would have caught it (the repository's tests
  run for every release).
- Restore from backup if data was damaged (supabase/README.md, the quarterly
  restore checklist).
- Write a short report: timeline, cause, impact, notifications sent (with
  times), fixes. Keep it with the audit log for at least a year.
- Update this runbook and `CLAUDE.md` with what was learned.
