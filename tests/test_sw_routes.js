/* The rule the whole service worker exists to enforce: live data is never
   cached. Loads the real sw.js outside a browser and asks it, request by
   request, what it would do. If anyone ever widens what it caches, this fails. */
const fs=require('fs'),vm=require('vm');
const ROOT=require('path').resolve(__dirname,'..'), TMP=require('path').join(__dirname,'fixtures');
let pass=0,fail=0;
const ok=(n,c,x)=>{c?(pass++,console.log('  ✓ '+n)):(fail++,console.log('  ✗ '+n+(x!==undefined?'  → '+JSON.stringify(x):'')));};

function load(file){
  const sandbox={self:{location:{origin:'https://rakshitpoojari52975-arch.github.io'},
    addEventListener(){}, clients:{claim(){}}, skipWaiting(){}},
    caches:{}, fetch(){}, Response:{error(){}}, URL, module:{exports:{}}, console};
  vm.createContext(sandbox); vm.runInContext(fs.readFileSync(file,'utf8'),sandbox);
  return sandbox.module.exports.routeFor || null;
}
const req=(url,{method='GET',mode='cors',auth=false}={})=>({url,method,mode,
  headers:{get:h=>h==='authorization'&&auth?'Bearer x':null}});
const SB='https://fnpuswexdaeqebrordvv.supabase.co';
const APP='https://rakshitpoojari52975-arch.github.io/staylog';

const routeFor=load(ROOT+'/sw.js');
ok('sw.js exposes its routing decision for testing', typeof routeFor==='function');

console.log('\n— live data is never touched —');
for(const [label,r] of [
  ['the attendance read',          req(SB+'/rest/v1/attendance?select=id&owner_id=eq.x&deleted_at=is.null',{auth:true})],
  ['the same read without a token',req(SB+'/rest/v1/attendance?select=id')],
  ['any Supabase table',           req(SB+'/rest/v1/expenses?select=*',{auth:true})],
  ['restoring from the cloud',     req(SB+'/rest/v1/bookings?select=*&deleted_at=is.null',{auth:true})],
  ['sign-in',                      req(SB+'/auth/v1/token?grant_type=password',{method:'POST'})],
  ['a token refresh',              req(SB+'/auth/v1/user',{auth:true})],
  ['her page’s functions',    req(SB+'/rest/v1/rpc/staff_standing',{method:'POST',auth:true})],
  ['a stamp',                      req(SB+'/rest/v1/attendance?id=eq.x',{method:'PATCH',auth:true})],
  ['a same-origin request carrying a token', req(APP+'/api/thing',{auth:true})],
  ['some other website',           req('https://example.com/data.json')],
]) ok(`${label} → passed straight through`, routeFor(r)===null, routeFor(r));

console.log('\n— the app still works offline —');
for(const [label,r,want] of [
  ['opening the app',      req(APP+'/',{mode:'navigate'}), 'shell'],
  ['index.html',           req(APP+'/index.html'),         'shell'],
  ['app.js',               req(APP+'/app.js'),             'shell'],
  ['cloud.js',             req(APP+'/cloud.js'),           'shell'],
  ['staff.html',           req(APP+'/staff.html',{mode:'navigate'}), 'shell'],
  ['the PDF library',      req(APP+'/vendor/jspdf.umd.min.js'), 'static'],
  ['the Supabase library', req(APP+'/vendor/supabase.umd.js'),  'static'],
  ['the app icon',         req(APP+'/icons/icon-192.png'),      'static'],
  ['the font stylesheet',  req('https://fonts.googleapis.com/css2?family=Prata'), 'static'],
  ['a font file',          req('https://fonts.gstatic.com/s/prata/v1/x.woff2'),  'static'],
  ['the icon font',        req('https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@3.19.0/x.css'), 'static'],
]) ok(`${label} → ${want}`, routeFor(r)===want, routeFor(r));

console.log('\n— and the version that caused this would fail here —');
// The shipped worker had no routeFor; reconstruct its decision from its code:
// anything that was a GET and not same-origin app shell went to cache-first.
const shipped=fs.readFileSync(TMP+'/sw-before-fix.js','utf8');
ok('the shipped worker sent every non-shell GET to the cache',
   /Vendored and third-party assets: cache first/.test(shipped));
ok('which included Supabase, because it never checked the host',
   !/supabase/i.test(shipped.split('self.addEventListener(\'fetch\'')[1]||''));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
