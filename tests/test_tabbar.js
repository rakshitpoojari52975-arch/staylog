/* The floating tab bar: a rounded pill of the five tabs inset 12px from the
   sides, with a round ⋯ of the same height beside it, above the home
   indicator. Chromium has no home indicator, so the pages read it through
   --safe-bottom (= env(safe-area-inset-bottom)) and this test sets 34px, an
   iPhone's. Checked in light and dark: every tab and ⋯ visible, at least
   44px and tappable above the inset; glass, with a solid fallback; the
   active tab a filled capsule; the last booking card and the toast clear of
   the bar; ⋯ opens the menu (Notifications first) and carries a red dot while
   anything is unread; scrolling down shrinks the bar, up or the top restores
   it; reduced motion means no animation. The header keeps the bell. */
const { chromium } = require('playwright');
const http=require('http'),fs=require('fs'),path=require('path');
const ROOT=path.resolve(__dirname,'..');
const T={'.html':'text/html','.js':'text/javascript','.json':'application/json'};
let pass=0,fail=0;
const ok=(n,c,x)=>{c?(pass++,console.log('  ✓ '+n)):(fail++,console.log('  ✗ '+n+(x!==undefined?'  → '+JSON.stringify(x):'')));};
const srv=http.createServer((q,r)=>{const p=path.join(ROOT,(q.url.split('?')[0]).replace(/^\/+/,'')||'index.html');
 if(!fs.existsSync(p)||fs.statSync(p).isDirectory()){r.writeHead(404);return r.end();}
 r.writeHead(200,{'Content-Type':T[path.extname(p)]||'text/plain'});r.end(fs.readFileSync(p));}).listen(0);

const W=390, H=844, INSET=34;
const IPHONE='Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const D=n=>{const d=new Date();d.setDate(d.getDate()+n);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;};
const SEED={properties:[{id:'p1',name:'Raaya Vasyam',rooms:1}],staff:[],loans:[],expenses:[],attendance:[],
  bookings:Array.from({length:14},(_,i)=>({id:'b'+i,propertyId:'p1',guestName:'Guest '+i,phone:'9876543210',
    checkIn:D(i*3-20),checkOut:D(i*3-18),guests:2,totalAmount:5000,paid:5000,source:'Direct',status:'checkedout',notes:'',msgSent:{}}))};
const unreadCache=n=>({at:new Date().toISOString(),pending:[],rows:Array.from({length:n},(_,i)=>({key:'stale:x'+i,alert:'stale',
  title:'StayLog has not synced',body:'b',url:'./#open=cloud',sent_at:new Date(Date.now()-60e3*(i+1)).toISOString(),delivered:true,read_at:null}))});

(async()=>{
const base='http://127.0.0.1:'+srv.address().port, br=await chromium.launch();
const open=async(o={})=>{
  const ctx=await br.newContext({serviceWorkers:'block',viewport:{width:W,height:H},userAgent:IPHONE,isMobile:true,
    colorScheme:o.dark?'dark':'light',reducedMotion:o.reduced?'reduce':'no-preference'});
  for(const g of ['**://*.supabase.co/**','**fonts.googleapis.com**','**cdn.jsdelivr.net**','**vendor/supabase.umd.js'])await ctx.route(g,r=>r.abort());
  const page=await ctx.newPage(); const errs=[];
  page.on('pageerror',e=>errs.push(e.message)); page.on('dialog',d=>d.accept());
  await page.addInitScript(([s,inset,cache])=>{
    localStorage.setItem('staylog_v2',JSON.stringify(s));
    if(cache)localStorage.setItem('staylog_inbox',JSON.stringify(cache));
    // the home indicator: what env(safe-area-inset-bottom) is on an iPhone
    const set=()=>document.documentElement.style.setProperty('--safe-bottom',inset+'px');
    if(document.documentElement)set();
    else new MutationObserver((m,ob)=>{if(document.documentElement){set();ob.disconnect();}}).observe(document,{childList:true});
  },[SEED,INSET,o.cache||null]);
  await page.goto(base+'/index.html');
  await page.waitForFunction(()=>typeof state!=='undefined'&&!state._loading);
  await page.evaluate(t=>{state.loggedIn=true;state.tab=t;render();},o.tab||'dashboard');
  await page.waitForTimeout(250);
  return {ctx,page,errs};
};
const box=(page,sel)=>page.locator(sel).first().boundingBox();
const tappable=async(page,sel)=>{
  const hit=await page.locator(sel).first().click({trial:true,timeout:2000}).then(()=>true,e=>e.message.split('\n')[0]);
  const b=await box(page,sel);
  return {ok:hit===true&&b.y>=0&&b.y+b.height<=H-INSET&&b.height>=44&&b.width>=44,b,hit};};
const TABS=['dashboard','bookings','expenses','loans','reports'];

for(const dark of [false,true]){
  console.log(`\n— ${dark?'dark':'light'} mode, a 34px home indicator —`);
  const {ctx,page,errs}=await open({dark});
  const bad=[];
  for(const t of TABS){const r=await tappable(page,`[data-tab="${t}"]`);if(!r.ok)bad.push({t,...r});}
  ok('all five tabs are visible, at least 44px, and take the tap above the inset', bad.length===0, bad);
  const more=await tappable(page,'[data-navmore]');
  ok('so is the round ⋯', more.ok, more);
  const labels=await page.locator('[data-tab]').evaluateAll(els=>els.map(e=>e.textContent.trim()));
  ok('Home, Bookings, Expenses, Loans, Reports', labels.join()==='Home,Bookings,Expenses,Loans,Reports', labels);
  const pill=await box(page,'.tabbar .pill'), m=await box(page,'[data-navmore]');
  ok('the pill floats 12px in from the left; ⋯ 12px in from the right', Math.round(pill.x)===12&&Math.round(W-(m.x+m.width))===12, {pill,m});
  ok('both sit above the home indicator, with a gap', pill.y+pill.height<=H-INSET-6&&m.y+m.height<=H-INSET-6, {pill,m});
  ok('⋯ is round and the same height as the pill', Math.abs(m.height-pill.height)<1&&Math.abs(m.width-m.height)<1, {pill,m});
  const st=await page.evaluate(()=>{const p=getComputedStyle(document.querySelector('.tabbar .pill'));
    const a=getComputedStyle(document.querySelector('[data-tab][aria-current="page"]'));
    const root=getComputedStyle(document.documentElement);
    const probe=document.createElement('div');probe.style.background='var(--accent-light)';document.body.appendChild(probe);
    const accent=getComputedStyle(probe).backgroundColor;probe.remove();
    return {blur:p.backdropFilter||p.webkitBackdropFilter,bg:p.backgroundColor,radius:p.borderRadius,shadow:p.boxShadow,
      active:a.backgroundColor,accent,activeRadius:a.borderRadius,glass:root.getPropertyValue('--nav-glass').trim()};});
  const alpha=c=>{const m=/rgba?\(([^)]+)\)/.exec(c);const p=m?m[1].split(',').map(Number):[];return p.length===4?p[3]:1;};
  ok('glass: a backdrop blur over a translucent background', /blur/.test(st.blur)&&alpha(st.bg)<0.6, st);
  ok('with a soft shadow and fully rounded ends', st.shadow!=='none'&&parseFloat(st.radius)>=25, st);
  ok(`its glass is the ${dark?'dark':'light'} theme's`, dark?/^rgba\(30, ?33, ?24/.test(st.glass):/^rgba\(255, ?253, ?248/.test(st.glass), st.glass);
  ok('the active tab is a filled capsule, a little more opaque than the glass', alpha(st.active)>alpha(st.bg)&&alpha(st.active)<1&&parseFloat(st.activeRadius)>=22, st);
  ok('only one tab is active', await page.locator('[data-tab][aria-current="page"]').count()===1);
  ok('the header keeps the title, property picker and bell, and no ⋯', await page.locator('header, #app > div').first().locator('[data-bell]').count()===1
     &&await page.locator('#app > div').first().locator('[aria-label="Menu"]').count()===0);
  await page.click('[data-tab="loans"]'); await page.waitForTimeout(100);
  ok('a tap changes the tab', await page.evaluate(()=>state.tab)==='loans');
  ok('no page errors', errs.length===0, errs);
  await ctx.close();
}

console.log('\n— a solid fallback where nothing can blur, or less transparency is asked for —');
{ const css=fs.readFileSync(path.join(ROOT,'index.html'),'utf8');
  ok('-webkit-backdrop-filter and backdrop-filter both set', /-webkit-backdrop-filter:\s*blur\(var\(--nav-blur\)\)/.test(css)&&/[^-]backdrop-filter:\s*blur\(var\(--nav-blur\)\)/.test(css));
  ok('@supports not (backdrop-filter) → solid --white', /@supports not \(\(-webkit-backdrop-filter: blur\(1px\)\) or \(backdrop-filter: blur\(1px\)\)\)\s*\{\s*\.tabbar \.pill, \.tabbar \.navmore \{ background: var\(--white\); \}/.test(css));
  ok('prefers-reduced-transparency → solid, no blur', /@media \(prefers-reduced-transparency: reduce\)\s*\{\s*\.tabbar \.pill, \.tabbar \.navmore \{ background: var\(--white\);\s*-webkit-backdrop-filter: none; backdrop-filter: none; \}/.test(css)); }

console.log('\n— nothing hides behind it —');
{ const {ctx,page}=await open({tab:'bookings'});
  await page.evaluate(()=>window.scrollTo(0,document.documentElement.scrollHeight)); await page.waitForTimeout(400);
  const last=await page.evaluate(()=>{const cards=[...document.querySelectorAll('#app .card')];const c=cards[cards.length-1];return c.getBoundingClientRect().toJSON();});
  const top=await page.evaluate(()=>Math.min(...[...document.querySelectorAll('.tabbar .pill, .tabbar .navmore')].map(e=>e.getBoundingClientRect().top)));
  ok('scrolled to the end, the last booking card is fully clear of the bar', last.bottom<=top-8, {last:last.bottom,top});
  await page.evaluate(()=>showToast('Marked paid','Undo',()=>{}));
  const t=await box(page,'[data-toast]');
  ok('the toast sits above the bar', t.y+t.height<=top-4, {t,top});
  for(const tab of ['dashboard','expenses','loans','reports','calendar']){
    await page.evaluate(x=>{state.tab=x;render();window.scrollTo(0,document.documentElement.scrollHeight);},tab); await page.waitForTimeout(150);
    const r=await page.evaluate(()=>{const kids=[...document.querySelector('[data-main]').querySelectorAll('*')].filter(e=>e.getBoundingClientRect().height>0);
      const bottom=Math.max(...kids.map(e=>e.getBoundingClientRect().bottom));
      const top=Math.min(...[...document.querySelectorAll('.tabbar .pill')].map(e=>e.getBoundingClientRect().top));return {bottom,top};});
    ok(`${tab}: the page's last content clears the bar`, r.bottom<=r.top-8, r);
  }
  await ctx.close(); }

console.log('\n— ⋯ opens the menu, with a dot while anything is unread —');
{ const {ctx,page}=await open({cache:unreadCache(3)});
  ok('3 unread: a red dot on ⋯', await page.locator('[data-navmore] [data-unread-dot]').count()===1);
  ok('and it says so to VoiceOver', /3 unread/.test(await page.locator('[data-navmore]').getAttribute('aria-label')));
  await page.click('[data-navmore]'); await page.waitForTimeout(250);
  ok('⋯ opens the menu sheet', await page.evaluate(()=>state.modal)==='menu');
  const first=await page.evaluate(()=>{const s=[...document.body.children].pop();const b=s.querySelector('button + div button, div[style] > button');
    return [...s.querySelectorAll('button')].map(b=>b.textContent.trim()).filter(Boolean)[1];});
  ok('Notifications is its first row, with the count', /^Notifications\s*3 unread/.test(first||''), first);
  await page.locator('button',{hasText:/^Notifications/}).first().click(); await page.waitForTimeout(200);
  ok('which opens the Notifications screen', await page.evaluate(()=>state.modal)==='inbox');
  await page.click('[data-inbox-all-read]'); await page.waitForTimeout(100);
  await page.evaluate(()=>closeModal()); await page.waitForTimeout(100);
  ok('everything read: no dot', await page.locator('[data-navmore] [data-unread-dot]').count()===0&&await page.locator('[data-navmore]').getAttribute('aria-label')==='Menu');
  await ctx.close(); }
{ const {ctx,page}=await open();
  ok('nothing unread: no dot', await page.locator('[data-unread-dot]').count()===0);
  await ctx.close(); }

console.log('\n— shrinks on the way down, back on the way up —');
{ const {ctx,page}=await open({tab:'bookings'});
  const h0=(await box(page,'.tabbar .pill')).height;
  await page.mouse.wheel(0,500); await page.waitForTimeout(450);
  const c=await page.evaluate(()=>({compact:document.querySelector('[data-tabbar]').classList.contains('compact'),y:scrollY,
    label:getComputedStyle(document.querySelector('[data-tab] span')).display,
    // (the icon font is not loaded here, so an icon is checked as shown, not by its size)
    icons:[...document.querySelectorAll('[data-tab] i')].length===5&&[...document.querySelectorAll('[data-tab] i')].every(i=>getComputedStyle(i).display!=='none'&&getComputedStyle(i).visibility!=='hidden')}));
  const h1=(await box(page,'.tabbar .pill')).height;
  ok('scrolling down shrinks the pill', c.compact&&h1<h0&&c.y>0, {c,h0,h1});
  ok('labels hide, icons stay', c.label==='none'&&c.icons, c);
  const small=[];for(const t of TABS){const r=await tappable(page,`[data-tab="${t}"]`);if(!r.ok)small.push({t,...r});}
  ok('every tab still at least 44px and tappable', small.length===0&&(await tappable(page,'[data-navmore]')).ok, small);
  ok('⋯ shrinks with it, the same height', Math.abs((await box(page,'[data-navmore]')).height-h1)<1);
  await page.mouse.wheel(0,-200); await page.waitForTimeout(450);
  ok('scrolling up restores it', !(await page.evaluate(()=>document.querySelector('[data-tabbar]').classList.contains('compact')))&&(await box(page,'.tabbar .pill')).height===h0);
  await page.mouse.wheel(0,400); await page.waitForTimeout(300);
  await page.evaluate(()=>window.scrollTo(0,0)); await page.waitForTimeout(300);
  ok('and so does being back at the top', !(await page.evaluate(()=>document.querySelector('[data-tabbar]').classList.contains('compact'))));
  await page.mouse.wheel(0,500); await page.waitForTimeout(300);
  await page.click('[data-tab="expenses"]'); await page.waitForTimeout(100);
  ok('a re-render keeps the state it was in', await page.evaluate(()=>document.querySelector('[data-tabbar]').classList.contains('compact')===navCompact));
  const anim=await page.evaluate(()=>getComputedStyle(document.querySelector('.tabbar .pill')).transitionDuration);
  ok('it animates normally', /0\.22s/.test(anim), anim);
  await ctx.close(); }
{ const {ctx,page}=await open({tab:'bookings',reduced:true});
  const anim=await page.evaluate(()=>getComputedStyle(document.querySelector('.tabbar .pill')).transitionDuration);
  ok('with reduced motion it changes without animating', anim.split(',').every(x=>parseFloat(x)===0), anim);
  await ctx.close(); }

await br.close(); srv.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
})();
