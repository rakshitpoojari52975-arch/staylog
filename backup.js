/* StayLog · encrypted backup
   ────────────────────────────────────────────────────────────────────────────
   Your data lives on your phone. The cloud keeps a copy it cannot read: the
   whole app data as JSON, encrypted here before it leaves, and decrypted only
   here. Supabase sees ciphertext, a salt, an IV, the iteration count, the app
   version, the size and when it was made — no names, no counts, nothing else.

   PBKDF2-SHA256 (600,000 iterations, a random salt) turns the passphrase into
   an AES-256-GCM key; every backup gets a fresh random IV. The key is kept on
   this phone as a NON-EXTRACTABLE CryptoKey in its own IndexedDB database, so
   backups run without retyping and the key can be used but never read out.
   The passphrase itself is never stored and never sent: forget it, and no one
   can open the backups — not Supabase, not the app.

   Guest ID photographs (idProofImage) are left out: they never leave the
   phone, encrypted or not.
   ──────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  const ITERATIONS = 600000, SALT_BYTES = 16, IV_BYTES = 12, MIN_PASS = 12;
  const FORMAT = 'staylog-backup', FORMAT_V = 1, KEEP_DAYS = 30;
  const KEY_DB = 'staylog_keys', KEY_STORE = 'keys', KEY_ID = 'backup';
  const LOG = 'staylog_backup_log', DEBOUNCE_MS = 15000;
  const CHECK_TEXT = 'staylog-key-check';
  const te = new TextEncoder(), td = new TextDecoder();
  const subtle = () => crypto.subtle;

  // ── bytes ⇄ base64 ─────────────────────────────────────────────────────────
  function b64(buf) {
    const u = new Uint8Array(buf); let s = '';
    for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
    return btoa(s);
  }
  const unb64 = s => Uint8Array.from(atob(String(s || '')), c => c.charCodeAt(0));
  const random = n => crypto.getRandomValues(new Uint8Array(n));

  // ── the key, on this phone only ────────────────────────────────────────────
  function keyDb() {
    return new Promise((res, rej) => {
      const r = indexedDB.open(KEY_DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(KEY_STORE);
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
  }
  async function keyOp(mode, fn) {
    const db = await keyDb();
    try {
      return await new Promise((res, rej) => {
        const tx = db.transaction(KEY_STORE, mode), st = tx.objectStore(KEY_STORE), r = fn(st);
        tx.oncomplete = () => res(r && r.result); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error);
      });
    } finally { db.close(); }
  }
  const keyGet = () => keyOp('readonly', st => st.get(KEY_ID));
  const keyPut = rec => keyOp('readwrite', st => st.put(rec, KEY_ID));
  const keyDel = () => keyOp('readwrite', st => st.delete(KEY_ID));

  async function derive(pass, salt, iterations) {
    const base = await subtle().importKey('raw', te.encode(pass), 'PBKDF2', false, ['deriveKey']);
    return subtle().deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
      base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);   // false: never extractable
  }
  // A small encrypted marker stored with the key, so a passphrase can be
  // checked on the phone without fetching a backup.
  async function makeKeyRecord(pass) {
    const salt = random(SALT_BYTES), key = await derive(pass, salt, ITERATIONS), iv = random(IV_BYTES);
    const check = await subtle().encrypt({ name: 'AES-GCM', iv }, key, te.encode(CHECK_TEXT));
    return { key, salt: b64(salt), iterations: ITERATIONS, check: b64(check), checkIv: b64(iv), setAt: new Date().toISOString() };
  }
  async function passMatches(pass, rec) {
    try {
      const key = await derive(pass, unb64(rec.salt), rec.iterations);
      const pt = await subtle().decrypt({ name: 'AES-GCM', iv: unb64(rec.checkIv) }, key, unb64(rec.check));
      return td.decode(pt) === CHECK_TEXT;
    } catch { return false; }
  }

  // ── what goes in ───────────────────────────────────────────────────────────
  function withoutPhotos(data) {
    const copy = JSON.parse(JSON.stringify(data || {}));
    (copy.bookings || []).forEach(b => { delete b.idProofImage; });
    return copy;
  }
  async function hashOf(text) { return b64(await subtle().digest('SHA-256', te.encode(text))); }
  async function seal(rec, data, appVersion) {
    const body = JSON.stringify(withoutPhotos(data));
    const iv = random(IV_BYTES), createdAt = new Date().toISOString();
    const plain = `{"format":"${FORMAT}","v":${FORMAT_V},"created_at":"${createdAt}","app_version":${JSON.stringify(appVersion || '')},"data":${body}}`;
    const ct = await subtle().encrypt({ name: 'AES-GCM', iv }, rec.key, te.encode(plain));
    return { row: { ciphertext: b64(ct), salt: rec.salt, iv: b64(iv), iterations: rec.iterations,
                    app_version: String(appVersion || ''), size: ct.byteLength }, hash: await hashOf(body) };
  }
  // Opens a stored backup (a row, or a saved file with the same fields).
  async function openWith(key, row) {
    let pt;
    try { pt = await subtle().decrypt({ name: 'AES-GCM', iv: unb64(row.iv) }, key, unb64(row.ciphertext)); }
    catch { throw new Error('Wrong passphrase'); }   // AES-GCM refuses anything else: a wrong key or altered bytes
    const p = JSON.parse(td.decode(pt));
    if (!p || p.format !== FORMAT || !p.data) throw new Error('This is not a StayLog backup');
    return p;
  }
  // With the passphrase typed now; `cache` saves deriving again for a salt seen before.
  async function openWithPass(pass, row, cache) {
    const k = `${row.salt}|${row.iterations}`;
    let key = cache && cache[k];
    if (!key) { key = await derive(pass, unb64(row.salt), Number(row.iterations) || ITERATIONS); if (cache) cache[k] = key; }
    return openWith(key, row);
  }

  // ── what is kept: the latest, plus the newest of each day for 30 days ──────
  const istDay = iso => new Date(Date.parse(iso) + 5.5 * 3600e3).toISOString().slice(0, 10);
  function planPrune(rows, nowMs) {
    const sorted = [...rows].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
    const cutoff = istDay(new Date(nowMs - KEEP_DAYS * 86400e3).toISOString());
    const days = new Set(), drop = [];
    sorted.forEach((r, i) => {
      const d = istDay(r.created_at);
      if (i === 0) { days.add(d); return; }
      if (d > cutoff && !days.has(d)) { days.add(d); return; }
      drop.push(r.id);
    });
    return drop;
  }

  // ── status, kept on this phone ─────────────────────────────────────────────
  let log = {};
  try { log = JSON.parse(localStorage.getItem(LOG) || '{}') || {}; } catch { log = {}; }
  const saveLog = () => { try { localStorage.setItem(LOG, JSON.stringify(log)); } catch {} };
  let hasKey = null;                     // null until the key store has been read
  const listeners = [];
  const changed = () => listeners.forEach(fn => { try { fn(); } catch {} });
  keyGet().then(r => { hasKey = !!(r && r.key); changed(); }, () => { hasKey = false; changed(); });

  const cloud = () => window.StayLogCloud;
  async function db() {
    const C = cloud();
    if (!C || !C.status().signedIn) throw new Error('Sign in to Cloud sync first');
    return { c: await C.client(), owner: C.status().userId };
  }
  const explain = e => /PGRST205|42P01|does not exist|schema cache/i.test(`${(e && e.code) || ''} ${(e && e.message) || e}`)
    ? 'the backups table is not set up — run supabase/backups.sql in Supabase' : (e && e.message) || String(e);

  async function list() {
    const { c, owner } = await db();
    const { data, error } = await c.from('backups').select('id,created_at,app_version,size')
      .eq('owner_id', owner).order('created_at', { ascending: false });
    if (error) throw new Error(explain(error));
    return data || [];
  }
  async function fetchRow(id) {
    const { c, owner } = await db();
    let q = c.from('backups').select('id,created_at,ciphertext,salt,iv,iterations,app_version').eq('owner_id', owner);
    q = id ? q.eq('id', id) : q.order('created_at', { ascending: false }).limit(1);
    const { data, error } = await q;
    if (error) throw new Error(explain(error));
    if (!data || !data[0]) throw new Error('There is no backup in the cloud yet');
    return data[0];
  }

  let running = null;
  async function backupNow(data, opts) {
    opts = opts || {};
    if (running) return running;
    running = (async () => {
      const rec = await keyGet();
      if (!rec || !rec.key) throw new Error('Set a backup passphrase first');
      const { c, owner } = await db();
      const sealed = await seal(rec, data, opts.appVersion || window.STAYLOG_APP_VERSION);
      // Nothing new since a backup made today: no need for another.
      if (!opts.force && log.lastHash === sealed.hash && log.lastAt && istDay(log.lastAt) === istDay(new Date().toISOString())) return { skipped: 'unchanged' };
      const { data: ins, error } = await c.from('backups').insert({ owner_id: owner, ...sealed.row }).select('id,created_at');
      if (error) throw new Error(explain(error));
      log = { ...log, lastAt: (ins && ins[0] && ins[0].created_at) || new Date().toISOString(), lastHash: sealed.hash, lastError: '' };
      saveLog();
      await prune().catch(() => {});
      return { ok: true };
    })().catch(err => { log = { ...log, lastError: err.message || String(err), lastTry: new Date().toISOString() }; saveLog(); throw err; })
      .finally(() => { running = null; changed(); });
    return running;
  }
  async function prune(nowMs) {
    const { c } = await db();
    const ids = planPrune(await list(), nowMs || Date.now());
    if (!ids.length) return 0;
    const { error } = await c.from('backups').delete().in('id', ids);
    if (error) throw new Error(explain(error));
    return ids.length;
  }

  // After each good sync, a few seconds later; a burst of syncs makes one backup.
  let timer = null;
  function schedule(getData) {
    if (!hasKey) return;
    clearTimeout(timer);
    timer = setTimeout(() => { const d = getData && getData(); if (d) backupNow(d).catch(() => {}); },
      Number(window.STAYLOG_BACKUP_DEBOUNCE_MS) || DEBOUNCE_MS);   // the tests shorten it
  }

  function checkPass(p1, p2) {
    if (String(p1 || '').length < MIN_PASS) throw new Error(`Use at least ${MIN_PASS} characters`);
    if (p1 !== p2) throw new Error('The two passphrases do not match');
  }
  async function setPassphrase(p1, p2, data) {
    checkPass(p1, p2);
    await keyPut(await makeKeyRecord(p1));
    hasKey = true; log = { ...log, lastHash: '' }; saveLog(); changed();
    if (data) await backupNow(data, { force: true });
  }

  const COUNTED = [['properties', 'properties'], ['bookings', 'bookings'], ['expenses', 'expenses'], ['staff', 'staff'],
                   ['loans', 'loans'], ['attendance', 'attendance']];
  function counts(d) {
    const out = {};
    COUNTED.forEach(([k]) => { out[k] = ((d && d[k]) || []).length; });
    out.repayments = ((d && d.loans) || []).reduce((n, l) => n + ((l.repayments || []).length), 0);
    return out;
  }
  // Decrypts the latest backup with the passphrase typed now, and compares.
  // Changes nothing on the phone.
  async function verify(pass, phoneData) {
    const row = await fetchRow();
    const p = await openWithPass(pass, row);
    const a = counts(p.data), b = counts(phoneData);
    const diffs = Object.keys(b).filter(k => a[k] !== b[k]).map(k => ({ table: k, backup: a[k], phone: b[k] }));
    return { ok: diffs.length === 0, createdAt: row.created_at, counts: a, diffs };
  }
  // A backup from the cloud (latest, or one by id) or from a saved file.
  // Returns the data; the app decides whether to replace the phone's.
  async function restore(pass, source) {
    const row = source && source.ciphertext ? source : await fetchRow(source && source.id);
    const p = await openWithPass(pass, row);
    // The passphrase works: keep its key so this phone's backups carry on.
    if (!hasKey) {
      try { await keyPut(await makeKeyRecord(pass)); hasKey = true; changed(); } catch {}
    }
    return { data: p.data, createdAt: row.created_at || p.created_at, appVersion: row.app_version || p.app_version };
  }
  async function file(data) {
    const rec = await keyGet();
    if (!rec || !rec.key) throw new Error('Set a backup passphrase first');
    const sealed = await seal(rec, data, window.STAYLOG_APP_VERSION);
    const doc = { format: FORMAT + '-file', v: FORMAT_V, created_at: new Date().toISOString(), ...sealed.row };
    const name = `staylog-backup-${doc.created_at.slice(0, 10)}.staylog`;
    return new File([JSON.stringify(doc)], name, { type: 'application/octet-stream' });
  }
  function readFile(text) {
    let doc; try { doc = JSON.parse(text); } catch { throw new Error('This is not a StayLog backup file'); }
    if (!doc || doc.format !== FORMAT + '-file' || !doc.ciphertext) throw new Error('This is not a StayLog backup file');
    return doc;
  }
  // New passphrase: a new key on the phone, a fresh backup under it, and every
  // older backup in the cloud opened with the current passphrase and sealed
  // again. Any that cannot be rewritten still open with the old one.
  async function changePassphrase(current, p1, p2, data) {
    const rec = await keyGet();
    if (!rec || !rec.key) throw new Error('Set a backup passphrase first');
    if (!(await passMatches(current, rec))) throw new Error('Wrong passphrase');
    checkPass(p1, p2);
    const { c, owner } = await db();
    const fresh = await makeKeyRecord(p1);
    const rows = (await c.from('backups').select('id,created_at,ciphertext,salt,iv,iterations,app_version').eq('owner_id', owner)).data || [];
    await keyPut(fresh); hasKey = true; changed();
    await backupNow(data, { force: true });
    let rewritten = 0, kept = 0; const cache = {};
    for (const row of rows) {
      try {
        const p = await openWithPass(current, row, cache);
        const iv = random(IV_BYTES);
        const ct = await subtle().encrypt({ name: 'AES-GCM', iv }, fresh.key, te.encode(JSON.stringify(p)));
        const { error } = await c.from('backups').update({ ciphertext: b64(ct), salt: fresh.salt, iv: b64(iv),
          iterations: fresh.iterations, size: ct.byteLength }).eq('id', row.id);
        if (error) throw error;
        rewritten++;
      } catch { kept++; }
    }
    return { rewritten, kept };
  }

  window.StayLogBackup = {
    status: () => ({ hasKey, lastAt: log.lastAt || '', lastError: log.lastError || '', lastTry: log.lastTry || '', running: !!running }),
    onChange: fn => listeners.push(fn),
    setPassphrase, backupNow, schedule, list, verify, restore, file, readFile, changePassphrase, prune,
    forgetKey: async () => { await keyDel(); hasKey = false; changed(); },
    MIN_PASS, ITERATIONS,
    _planPrune: planPrune, _counts: counts,     // for the tests
  };
})();
