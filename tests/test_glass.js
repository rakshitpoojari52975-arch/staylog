/* The tab bar is clear glass (v58): a very thin tint over a light blur, so
   the page behind it stays plainly readable through it.
   Checked in light and dark: the pill's and ⋯'s computed background is
   translucent (alpha < 0.6) with backdrop-filter set; the page is really seen
   through it (pixels under the pill change with what scrolls behind); with
   reduced transparency both fall back to solid; and the labels stay readable
   — measured from real pixels, not from the stylesheet. For each label the
   page is drawn twice, once with the text and once with only its halo
   (color: transparent keeps the text-shadow), so the glyph pixels and what
   sits behind each of them are known; the contrast of the label colour
   against those backdrop pixels must be at least 4.5:1, over a plain card
   and over a busy one (stripes, colour blocks and bold text). */
const { chromium } = require('playwright');
const http=require('http'),fs=require('fs'),path=require('path'),zlib=require('zlib');
const ROOT=path.resolve(__dirname,'..');
const T={'.html':'text/html','.js':'text/javascript','.json':'application/json'};
let pass=0,fail=0;
const ok=(n,c,x)=>{c?(pass++,console.log('  ✓ '+n)):(fail++,console.log('  ✗ '+n+(x!==undefined?'  → '+JSON.stringify(x):'')));};
const srv=http.createServer((q,r)=>{const p=path.join(ROOT,(q.url.split('?')[0]).replace(/^\/+/,'')||'index.html');
 if(!fs.existsSync(p)||fs.statSync(p).isDirectory()){r.writeHead(404);return r.end();}
 r.writeHead(200,{'Content-Type':T[path.extname(p)]||'text/plain'});r.end(fs.readFileSync(p));}).listen(0);

// A small PNG reader (8-bit RGB/RGBA, as Chromium writes): no dependencies.
function png(buf){
  let i=8,w,h,ct,idat=[];
  while(i<buf.length){const len=buf.readUInt32BE(i),type=buf.toString('latin1',i+4,i+8),d=buf.slice(i+8,i+8+len);
    if(type==='IHDR'){w=d.readUInt32BE(0);h=d.readUInt32BE(4);ct=d[9];}
    if(type==='IDAT')idat.push(d); i+=12+len;}
  const bpp=ct===6?4:3, raw=zlib.inflateSync(Buffer.concat(idat)), out=Buffer.alloc(w*h*4), stride=w*bpp;
  let prev=Buffer.alloc(stride);
  for(let y=0;y<h;y++){const f=raw[y*(stride+1)], line=Buffer.from(raw.slice(y*(stride+1)+1,(y+1)*(stride+1)));
    for(let x=0;x<stride;x++){const a=x>=bpp?line[x-bpp]:0,b=prev[x],c=x>=bpp?prev[x-bpp]:0;
      const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);
      line[x]=(line[x]+(f===1?a:f===2?b:f===3?(a+b)>>1:f===4?(pa<=pb&&pa<=pc?a:pb<=pc?b:c):0))&255;}
    for(let x=0;x<w;x++){out[(y*w+x)*4]=line[x*bpp];out[(y*w+x)*4+1]=line[x*bpp+1];out[(y*w+x)*4+2]=line[x*bpp+2];out[(y*w+x)*4+3]=255;}
    prev=line;}
  return {w,h,px:out};
}
const lin=c=>{c/=255;return c<=0.04045?c/12.92:Math.pow((c+0.055)/1.055,2.4);};
const lum=(r,g,b)=>0.2126*lin(r)+0.7152*lin(g)+0.0722*lin(b);
const contrast=(a,b)=>{const [x,y]=a>b?[a,b]:[b,a];return (x+0.05)/(y+0.05);};
const alpha=c=>{const m=/rgba?\(([^)]+)\)/.exec(c);const p=m?m[1].split(/[ ,/]+/).filter(Boolean).map(Number):[];return p.length===4?p[3]:1;};

const W=390,H=844;
const D=n=>{const d=new Date();d.setDate(d.getDate()+n);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;};
const SEED={properties:[{id:'p1',name:'Raaya Vasyam',rooms:1}],staff:[],loans:[],expenses:[],attendance:[],
  bookings:Array.from({length:10},(_,i)=>({id:'b'+i,propertyId:'p1',guestName:'Guest '+i,phone:'9876543210',
    checkIn:D(i*3-20),checkOut:D(i*3-18),guests:2,totalAmount:5000,paid:5000,source:'Direct',status:'checkedout',notes:'',msgSent:{}}))};

// What sits behind the bar: a plain card, or a busy one.
const BEHIND={
  plain:`<div class="card" style="height:150px;padding:14px;font-size:14px">Anita Rao · 2 guests · ₹6,000 paid</div>`,
  busy:`<div style="height:150px;border-radius:12px;overflow:hidden;position:relative;
    background:repeating-linear-gradient(90deg,#111 0 6px,#fff 6px 12px,#c0392b 12px 18px,#1f5fbf 18px 24px,#f1c40f 24px 30px)">
    <div style="position:absolute;inset:0;font:900 30px/1.1 sans-serif;color:#000;text-shadow:0 0 1px #fff;padding:8px">
      ₹12,345 PAID · CHECK-IN · ₹9,999 DUE · NOV</div></div>`,
};

(async()=>{
const base='http://127.0.0.1:'+srv.address().port, br=await chromium.launch();
const open=async(o={})=>{
  const ctx=await br.newContext({serviceWorkers:'block',viewport:{width:W,height:H},deviceScaleFactor:1,colorScheme:o.dark?'dark':'light'});
  for(const g of ['**://*.supabase.co/**','**fonts.googleapis.com**','**cdn.jsdelivr.net**','**vendor/supabase.umd.js'])await ctx.route(g,r=>r.abort());
  const page=await ctx.newPage(); const errs=[];
  page.on('pageerror',e=>errs.push(e.message));
  if(o.reducedTransparency){const cdp=await ctx.newCDPSession(page);
    await cdp.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-transparency',value:'reduce'},
      {name:'prefers-color-scheme',value:o.dark?'dark':'light'}]});}
  await page.addInitScript(s=>localStorage.setItem('staylog_v2',JSON.stringify(s)),SEED);
  await page.goto(base+'/index.html');
  await page.waitForFunction(()=>typeof state!=='undefined'&&!state._loading);
  await page.evaluate(()=>{state.loggedIn=true;state.tab='bookings';render();});
  await page.waitForTimeout(250);
  return {ctx,page,errs};
};
// Puts a card right behind the bar (fixed, under it in z-order).
const behind=(page,kind)=>page.evaluate(html=>{document.getElementById('glass-probe')?.remove();
  const el=document.createElement('div');el.id='glass-probe';
  el.style.cssText='position:fixed;left:8px;right:8px;bottom:0;height:150px;z-index:50';el.innerHTML=html;
  document.body.appendChild(el);},BEHIND[kind]);
const shot=async(page,clip)=>png(await page.screenshot({clip,animations:'disabled'}));

for(const dark of [false,true]){
  const mode=dark?'dark':'light';
  console.log(`\n— ${mode} mode —`);
  const {ctx,page,errs}=await open({dark});
  const st=await page.evaluate(()=>['.tabbar .pill','.tabbar .navmore','[data-tab][aria-current="page"]'].map(sel=>{
    const c=getComputedStyle(document.querySelector(sel));
    return {bg:c.backgroundColor,bf:c.backdropFilter||'',wbf:c.webkitBackdropFilter||'',border:c.borderTopColor,shadow:c.boxShadow};}));
  ok('the pill is clear glass: tint alpha ≤ 0.15', alpha(st[0].bg)<=0.15&&alpha(st[0].bg)>0, st[0].bg);
  ok('so is the ⋯ button', alpha(st[1].bg)<=0.15&&alpha(st[1].bg)>0, st[1].bg);
  const blurPx=f=>{const m=/blur\(([\d.]+)px\)/.exec(f||'');return m?+m[1]:NaN;};
  ok('a light blur (≤ 4px) and saturate, on both', [st[0],st[1]].every(s=>blurPx(s.bf||s.wbf)<=4&&blurPx(s.bf||s.wbf)>0&&/saturate\(/.test(s.bf||s.wbf)), st.map(s=>s.bf||s.wbf));
  ok(`a hairline border, ${dark?'about 18%':'about 35%'} white, and a soft shadow`, [st[0],st[1]].every(s=>
    /^rgba\(255, 255, 255,/.test(s.border)&&Math.abs(alpha(s.border)-(dark?0.18:0.35))<0.03&&/rgba/.test(s.shadow)), st);
  ok('the active tab is a slightly more opaque capsule (about 22%)', alpha(st[2].bg)>alpha(st[0].bg)&&Math.abs(alpha(st[2].bg)-0.22)<0.03, st[2].bg);

  // The page really shows through: the same pixels under the pill change with what is behind.
  const pill=await page.locator('.tabbar .pill').boundingBox(), more=await page.locator('[data-navmore]').boundingBox();
  const mean=img=>{let s=[0,0,0];for(let i=0;i<img.px.length;i+=4){s[0]+=img.px[i];s[1]+=img.px[i+1];s[2]+=img.px[i+2];}return s.map(v=>v/(img.px.length/4));};
  for(const [name,b] of [['pill',pill],['⋯',more]]){
    const clip={x:Math.round(b.x+b.width/2-14),y:Math.round(b.y+4),width:28,height:6};
    await behind(page,'plain'); const a=mean(await shot(page,clip));
    await behind(page,'busy');  const c=mean(await shot(page,clip));
    const d=Math.max(...a.map((v,i)=>Math.abs(v-c[i])));
    ok(`content behind the ${name} is visibly seen through it`, d>12, {plain:a.map(Math.round),busy:c.map(Math.round)});
  }

  // Label contrast, from pixels.
  for(const kind of ['plain','busy']){
    await behind(page,kind);
    const res=[];
    for(const t of ['dashboard','bookings','expenses','loans','reports']){
      const span=page.locator(`[data-tab="${t}"] span`), b=await span.boundingBox();
      const clip={x:Math.floor(b.x)-1,y:Math.floor(b.y)-1,width:Math.ceil(b.width)+2,height:Math.ceil(b.height)+2};
      const color=await span.evaluate(e=>getComputedStyle(e).color);
      const withText=await shot(page,clip);
      await span.evaluate(e=>e.style.color='transparent');
      const halo=await shot(page,clip);
      await span.evaluate(e=>e.style.color='');
      const [r,g,bl]=color.match(/\d+(\.\d+)?/g).map(Number), L=lum(r,g,bl), cs=[];
      for(let i=0;i<withText.px.length;i+=4){
        const dd=Math.abs(withText.px[i]-halo.px[i])+Math.abs(withText.px[i+1]-halo.px[i+1])+Math.abs(withText.px[i+2]-halo.px[i+2]);
        if(dd>60)cs.push(contrast(L,lum(halo.px[i],halo.px[i+1],halo.px[i+2])));   // a glyph pixel
      }
      cs.sort((x,y)=>x-y);
      res.push({t,glyph:cs.length,p5:cs.length?+cs[Math.floor(cs.length*0.05)].toFixed(2):0});
    }
    ok(`labels read at 4.5:1 or better over a ${kind} card`, res.every(x=>x.glyph>10&&x.p5>=4.5), res);
  }
  const w=await page.evaluate(()=>{const c=getComputedStyle(document.querySelector('[data-tab] span'));return {w:+c.fontWeight,ts:c.textShadow};});
  const cream=await page.evaluate(()=>{const p=document.createElement('div');p.style.color='var(--cream)';document.body.appendChild(p);
    const c=getComputedStyle(p).color;p.remove();return c;});
  const moreTs=await page.evaluate(()=>getComputedStyle(document.querySelector('[data-navmore]')).textShadow);
  ok('labels are bold (700), with a thin halo in the page\'s own background colour', w.w>=700&&w.ts.includes(cream)
     &&/2px/.test(w.ts)&&/4px/.test(w.ts), {w,cream});
  ok('the ⋯ icon has the same halo', moreTs.includes(cream)&&/2px/.test(moreTs), moreTs);
  ok('no page errors', errs.length===0, errs);
  await ctx.close();

  console.log(`\n— ${mode} mode, reduced transparency —`);
  const r=await open({dark,reducedTransparency:true});
  const matched=await r.page.evaluate(()=>matchMedia('(prefers-reduced-transparency: reduce)').matches);
  const st2=await r.page.evaluate(()=>['.tabbar .pill','.tabbar .navmore'].map(sel=>{const c=getComputedStyle(document.querySelector(sel));
    return {bg:c.backgroundColor,bf:c.backdropFilter||c.webkitBackdropFilter||'none'};}));
  const white=await r.page.evaluate(()=>{const p=document.createElement('div');p.style.background='var(--white)';document.body.appendChild(p);
    const c=getComputedStyle(p).backgroundColor;p.remove();return c;});
  ok('the browser reports reduced transparency', matched);
  ok('the pill and ⋯ fall back to the solid theme background', st2.every(s=>s.bg===white&&alpha(s.bg)===1), {st2,white});
  ok('with no blur', st2.every(s=>s.bf==='none'), st2);
  await r.ctx.close();
}

console.log('\n— where backdrop-filter is unsupported —');
{ const css=fs.readFileSync(path.join(ROOT,'index.html'),'utf8');
  ok('@supports not (backdrop-filter): solid background', /@supports not \(\(-webkit-backdrop-filter: blur\(1px\)\) or \(backdrop-filter: blur\(1px\)\)\)\s*\{\s*\.tabbar \.pill, \.tabbar \.navmore \{ background: var\(--white\); \}/.test(css));
  ok('both the -webkit- prefix and the standard property, from --nav-blur and --nav-saturate',
     /-webkit-backdrop-filter: blur\(var\(--nav-blur\)\) saturate\(var\(--nav-saturate\)\);\s*backdrop-filter: blur\(var\(--nav-blur\)\) saturate\(var\(--nav-saturate\)\)/.test(css));
  ok('--nav-blur 3px, --nav-saturate 140%', /--nav-blur:\s*3px;/.test(css)&&/--nav-saturate:\s*140%;/.test(css));
  const tok=n=>[...css.matchAll(new RegExp(`--${n}:\\s*([^;]+);`,'g'))].map(m=>m[1].trim());
  ok('every glass colour is a theme token, defined for light and both dark blocks', ['nav-glass','nav-active','nav-line','nav-rim','nav-ink','nav-active-ink'].every(n=>tok(n).length===3), ['nav-glass','nav-active'].map(n=>tok(n)));
  ok('tints: .12 light, .14 dark (both dark blocks)', JSON.stringify(tok('nav-glass'))==='["rgba(255,253,248,.12)","rgba(30,33,24,.14)","rgba(30,33,24,.14)"]', tok('nav-glass')); }

await br.close(); srv.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
})();
