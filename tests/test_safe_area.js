/* The Home Screen app draws under the iPhone's status bar (viewport-fit=cover,
   black-translucent), so everything at the top of the screen must start below
   safe-area-inset-top. Chromium has no notch to emulate, so the pages read the
   inset through one CSS variable, --safe-top (= env(safe-area-inset-top)), and
   this test sets it to 47px, an iPhone's status bar. Checked: the header's ⋯
   and bell sit fully below it and take taps, the header's own background fills
   the strip in light and dark, the PIN screen, a sheet, the month picker and
   the toast, and staff.html (login and her page). With no inset the layout is
   as before. */
const { chromium } = require('playwright');
const http=require('http'),fs=require('fs'),path=require('path');
const ROOT=path.resolve(__dirname,'..');
const T={'.html':'text/html','.js':'text/javascript','.json':'application/json','.css':'text/css'};
let pass=0,fail=0;
const ok=(n,c,x)=>{c?(pass++,console.log('  ✓ '+n)):(fail++,console.log('  ✗ '+n+(x!==undefined?'  → '+JSON.stringify(x):'')));};
const srv=http.createServer((q,r)=>{const p=path.join(ROOT,(q.url.split('?')[0]).replace(/^\/+/,'')||'index.html');
 if(!fs.existsSync(p)||fs.statSync(p).isDirectory()){r.writeHead(404);return r.end();}
 r.writeHead(200,{'Content-Type':T[path.extname(p)]||'text/plain'});r.end(fs.readFileSync(p));}).listen(0);

const INSET=47;
const IPHONE='Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const D=n=>{const d=new Date();d.setDate(d.getDate()+n);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;};
const SEED={properties:[{id:'p1',name:'Raaya Vasyam'}],staff:[],loans:[],expenses:[],attendance:[],
  bookings:Array.from({length:12},(_,i)=>({id:'b'+i,propertyId:'p1',guestName:'Guest '+i,phone:'9876543210',checkIn:D(i*3-6),checkOut:D(i*3-4),
    guests:2,totalAmount:5000,paid:5000,source:'Direct',status:'confirmed',notes:'',msgSent:{}}))};

(async()=>{
const base='http://127.0.0.1:'+srv.address().port, br=await chromium.launch();
const open=async(url,o={})=>{
  const ctx=await br.newContext({serviceWorkers:'block',viewport:{width:390,height:o.height||844},userAgent:IPHONE,
    colorScheme:o.dark?'dark':'light',isMobile:true,hasTouch:false});
  for(const g of ['**://*.supabase.co/**','**fonts.googleapis.com**','**cdn.jsdelivr.net**'])await ctx.route(g,r=>r.abort());
  if(o.stub)await ctx.route('**vendor/supabase.umd.js',r=>r.fulfill({contentType:'text/javascript',body:o.stub}));
  else await ctx.route('**vendor/supabase.umd.js',r=>r.abort());
  const page=await ctx.newPage(); const errs=[];
  page.on('pageerror',e=>errs.push(e.message)); page.on('dialog',d=>d.accept());
  await page.addInitScript(([s,inset,pin])=>{
    localStorage.setItem('staylog_v2',JSON.stringify(s));
    if(pin)localStorage.setItem('staylog_auth',JSON.stringify({pin}));
    // the status bar: what env(safe-area-inset-top) is on an iPhone
    // (the init script can run before <html> exists: set it the moment it does)
    if(inset!==null){const set=()=>document.documentElement.style.setProperty('--safe-top',inset+'px');
      if(document.documentElement)set();
      else new MutationObserver((m,o)=>{if(document.documentElement){set();o.disconnect();}}).observe(document,{childList:true});}
  },[SEED,o.inset===undefined?INSET:o.inset,o.pin||null]);
  await page.goto(base+url);
  return {ctx,page,errs};
};
const box=(page,sel)=>page.locator(sel).first().boundingBox();
// Fully below the status bar, and the element itself is what a tap at its centre hits.
// Playwright's trial click scrolls it into view and fails if anything else would take the tap.
const tappable=async(page,sel)=>{const b=await box(page,sel);if(!b)return {ok:false,why:'not found'};
  const hit=await page.locator(sel).first().click({trial:true,timeout:2000}).then(()=>true,e=>e.message.split('\n')[0]);
  const top=(await box(page,sel)).y;
  return {ok:top>=INSET&&hit===true,top,hit};};
const app=async(o={})=>{const r=await open('/index.html',o);
  await r.page.waitForFunction(()=>typeof state!=='undefined'&&!state._loading);
  if(!o.locked)await r.page.evaluate(()=>{state.loggedIn=true;state.tab='dashboard';render();});
  await r.page.waitForTimeout(250); return r;};

console.log('\n— the pages read the inset from env() —');
for(const f of ['index.html','staff.html']){
  const s=fs.readFileSync(path.join(ROOT,f),'utf8');
  ok(`${f}: --safe-top is env(safe-area-inset-top, 0px)`, /--safe-top:\s*env\(safe-area-inset-top,\s*0px\)/.test(s));
  ok(`${f}: viewport-fit=cover and black-translucent kept`, /viewport-fit=cover/.test(s)&&/content="black-translucent"/.test(s));
}

console.log('\n— the header, with a 47px status bar —');
{ const {ctx,page,errs}=await app();
  const menu=await tappable(page,'[aria-label="Menu"]'), bell=await tappable(page,'[data-bell]');
  ok('the ⋯ button lies fully below 47px and takes the tap', menu.ok, menu);
  ok('so does the bell', bell.ok, bell);
  const title=await box(page,'.display');
  ok('and the StayLog title', title&&title.y>=INSET, title);
  const prop=await page.locator('button',{hasText:/All properties|Raaya Vasyam/}).first().boundingBox();
  ok('and the property picker', prop&&prop.y>=INSET, prop);
  const strip=await page.evaluate(()=>{const hd=document.querySelector('#app > div');const at=document.elementFromPoint(195,20);
    return {top:hd.getBoundingClientRect().top,inHeader:hd.contains(at),pad:getComputedStyle(hd).paddingTop,
      bg:getComputedStyle(hd).backgroundColor,white:getComputedStyle(document.documentElement).getPropertyValue('--white').trim()};});
  ok('the header reaches the top: the status bar strip is the header itself', strip.top===0&&strip.inHeader, strip);
  ok('its top padding is the inset + 9px', strip.pad==='56px', strip.pad);
  await page.click('[aria-label="Menu"]'); await page.waitForTimeout(250);
  ok('tapping ⋯ opens the menu', await page.evaluate(()=>state.modal)==='menu');
  const sheet=await page.evaluate(()=>{const s=[...document.body.children].pop().firstChild.getBoundingClientRect();return s.top;});
  ok('the menu sheet starts below the status bar', sheet>=INSET, sheet);
  const close=await tappable(page,'body > div:last-child button');
  ok('its × takes the tap', close.ok, close);
  await page.evaluate(()=>closeModal());
  await page.click('[data-bell]'); await page.waitForTimeout(250);
  ok('tapping the bell opens Notifications', await page.evaluate(()=>state.modal)==='inbox');
  await page.evaluate(()=>{closeModal();state.tab='bookings';render();window.scrollTo(0,600);}); await page.waitForTimeout(150);
  const after=await tappable(page,'[aria-label="Menu"]');
  ok('scrolled down, the sticky header still keeps ⋯ below the status bar', after.ok&&await page.evaluate(()=>scrollY)>0, after);
  // a sheet taller than the screen stops short of the status bar
  await page.evaluate(()=>{state.modal='addBooking';state.editItem=null;render();}); await page.waitForTimeout(400);
  const tall=await page.evaluate(()=>[...document.body.children].pop().firstChild.getBoundingClientRect().top);
  ok('a full-height sheet (the booking form) starts below the status bar', tall>=INSET, tall);
  ok('no page errors', errs.length===0, errs);
  await ctx.close(); }
{ const {ctx,page}=await app({height:568});
  await page.evaluate(()=>{state.modal='addBooking';state.editItem=null;render();}); await page.waitForTimeout(400);
  const tall=await page.evaluate(()=>[...document.body.children].pop().firstChild.getBoundingClientRect().top);
  ok('on a small iPhone too (568px tall)', tall>=INSET, tall);
  await ctx.close(); }

console.log('\n— dark mode —');
{ const {ctx,page}=await app({dark:true});
  const s=await page.evaluate(()=>{const hd=document.querySelector('#app > div');
    return {bg:getComputedStyle(hd).backgroundColor,body:getComputedStyle(document.body).backgroundColor,
      inHeader:hd.contains(document.elementFromPoint(195,20)),theme:matchMedia('(prefers-color-scheme: dark)').matches};});
  ok('the status bar strip is the header, in its dark background', s.theme&&s.inHeader&&s.bg!=='rgba(0, 0, 0, 0)'&&!/255, 25[0-9], 2[0-9][0-9]\)/.test(s.bg), s);
  ok('the ⋯ button and bell are still below 47px', (await tappable(page,'[aria-label="Menu"]')).ok&&(await tappable(page,'[data-bell]')).ok);
  await ctx.close(); }

console.log('\n— the PIN screen —');
for(const h of [844,568]){
  const {ctx,page}=await app({locked:true,pin:'1234',height:h});
  await page.waitForTimeout(200);
  const t=await page.evaluate(()=>{const els=[...document.querySelectorAll('#app *')].filter(e=>e.children.length===0&&e.textContent.trim());
    return Math.min(...els.map(e=>e.getBoundingClientRect().top));});
  ok(`nothing on it starts under the status bar (${h}px tall)`, t>=INSET, t);
  const k=await tappable(page,'#app button');
  ok('its first button takes the tap', k.ok, k);
  await ctx.close(); }

console.log('\n— the month picker and the toast —');
{ const {ctx,page}=await app();
  const label=page.locator('button',{hasText:/^(All Time|[A-Z][a-z]{2} \d{4})$/}).first();
  await label.click(); await page.waitForTimeout(150);
  const p=await page.evaluate(()=>document.querySelector('#month-picker-overlay > div').getBoundingClientRect().top);
  ok('the month picker opens below the status bar', p>=INSET, p);
  // opened from a label scrolled up near the top, it still stays clear
  await page.evaluate(()=>document.getElementById('month-picker-overlay').remove());
  await page.evaluate(()=>{const b=[...document.querySelectorAll('button')].find(x=>/^(All Time|[A-Z][a-z]{2} \d{4})$/.test(x.textContent));
    b.getBoundingClientRect=()=>({top:4,bottom:20,left:120,right:220,width:100,height:16});b.click();});
  const p2=await page.evaluate(()=>document.querySelector('#month-picker-overlay > div').getBoundingClientRect().top);
  ok('even from a label at the very top of the screen', p2>=INSET, p2);
  await page.evaluate(()=>{document.getElementById('month-picker-overlay').remove();showToast('Marked paid','Undo',()=>{});});
  const t=await box(page,'[data-toast]');
  ok('the toast sits above the tab bar, well clear of the status bar', t&&t.y>=INSET&&t.y+t.height<=844, t);
  await ctx.close(); }

console.log('\n— no inset (a browser tab, a phone without a notch): as before —');
{ const {ctx,page}=await app({inset:null});
  const m=await box(page,'[aria-label="Menu"]');
  const pad=await page.evaluate(()=>getComputedStyle(document.querySelector('#app > div')).paddingTop);
  ok('the header keeps its 9px', pad==='9px', pad);
  ok('the ⋯ button is near the top, as it was', m&&m.y<20, m);
  await ctx.close(); }

console.log('\n— staff.html —');
{ const {ctx,page,errs}=await open('/staff.html',{stub:`window.supabase={createClient:()=>({
    auth:{getSession:async()=>({data:{session:null}}),onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}})},
    rpc:async()=>({data:null,error:null})})};`});
  await page.waitForTimeout(600);
  const title=await box(page,'.display');
  ok('her sign-in screen starts below the status bar', title&&title.y>=INSET, title);
  const inp=await tappable(page,'input');
  ok('and its first field takes the tap', inp.ok, inp);
  ok('no page errors', errs.length===0, errs);
  await ctx.close(); }
{ const STUB=`window.supabase={createClient:()=>({
    auth:{getSession:async()=>({data:{session:{user:{id:'u-lakshmi'}}}}),onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}}),signOut:async()=>({})},
    rpc:async(n)=>n==='staff_calendar'?{data:[],error:null}:n==='staff_standing'?{data:{name:'Lakshmi',
      attendance:{today:'2026-10-28',marked:false,this_month:3},
      pending:{amount:0,count:0,oldest:null,earlier:0,days:[]},
      this_month:{amount:0,deducted:0},overall:{paid:0,deducted:0},last_payout:null,loans:[]},error:null}:{data:null,error:null}})};`;
  const {ctx,page,errs}=await open('/staff.html',{stub:STUB});
  await page.waitForTimeout(800);
  const title=await box(page,'.display');
  ok('her page: the Raaya Vasyam title is below the status bar', title&&title.y>=INSET, title);
  const so=await tappable(page,'button.btn-quiet');
  ok('and Sign out takes the tap', so.ok&&/Sign out/.test(await page.locator('button.btn-quiet').first().innerText()), so);
  const strip=await page.evaluate(()=>{const s=getComputedStyle(document.body,'::before');return {h:s.height,pos:s.position,bg:s.backgroundColor,
    page:getComputedStyle(document.body).backgroundColor};});
  ok('the status bar strip keeps the page colour while she scrolls', strip.h===INSET+'px'&&strip.pos==='fixed'&&strip.bg===strip.page, strip);
  ok('no page errors', errs.length===0, errs);
  await ctx.close(); }

await br.close(); srv.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
})();
