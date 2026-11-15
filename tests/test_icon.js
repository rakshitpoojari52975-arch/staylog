/* v72: the app icon. Every icon the manifest and the two pages name exists,
   is a PNG of the size it claims, and has no transparency (iOS fills a
   transparent Home Screen icon with black). The manifest offers an "any" and
   a separate "maskable" icon (a combined "any maskable" is discouraged), and
   both pages point iOS at the 180 × 180 apple-touch-icon. The source drawing
   is icons/icon.svg. */
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (x !== undefined ? '  → ' + JSON.stringify(x) : ''))); };
// PNG header: width, height, colour type (2 = RGB, 6 = RGBA, …)
const png = f => { const b = fs.readFileSync(path.join(ROOT, f));
  return b.slice(1, 4).toString() === 'PNG' ? { w: b.readUInt32BE(16), h: b.readUInt32BE(20), type: b[25] } : null; };
const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
for (const i of m.icons) {
  const p = fs.existsSync(path.join(ROOT, i.src)) && png(i.src), [w, h] = i.sizes.split('x').map(Number);
  ok(`manifest ${i.src} (${i.purpose}): there, ${i.sizes}, no transparency`, p && p.w === w && p.h === h && p.type === 2, p);
}
ok('an "any" icon and a separate "maskable" one, 512 each', m.icons.some(i => i.purpose === 'any' && i.sizes === '512x512')
  && m.icons.some(i => i.purpose === 'maskable' && i.sizes === '512x512') && !m.icons.some(i => /any maskable/.test(i.purpose)));
for (const page of ['index.html', 'staff.html']) {
  const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
  const t = /<link rel="apple-touch-icon" sizes="180x180" href="([^"]+)"/.exec(html), f = /<link rel="icon"[^>]*href="([^"]+)"/.exec(html);
  const tp = t && png(t[1]), fp = f && png(f[1]);
  ok(`${page}: the Home Screen icon is 180 × 180 with no transparency`, tp && tp.w === 180 && tp.h === 180 && tp.type === 2, tp);
  ok(`${page}: a 32 × 32 favicon`, fp && fp.w === 32, fp);
}
const svg = fs.readFileSync(path.join(ROOT, 'icons/icon.svg'), 'utf8');
ok('the source drawing is kept (icons/icon.svg) and fills the square (no transparent corners)', /<rect width="512" height="512"/.test(svg));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
