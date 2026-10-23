/* Face ID unlock: WebAuthn with the phone's own authenticator, a second key
   to the same local lock as the PIN. navigator.credentials is stubbed; the
   app is served at its real host, since the relying party ID must be
   rakshitpoojari52975-arch.github.io and the option hides anywhere else. */
const { chromium } = require('playwright');
const fs=require('fs'),path=require('path');
const ROOT=path.resolve(__dirname,'..');
const T={'.html':'text/html','.js':'text/javascript','.json':'application/json','.png':'image/png'};
let pass=0,fail=0;
const ok=(n,c,x)=>{c?(pass++,console.log('  ✓ '+n)):(fail++,console.log('  ✗ '+n+(x!==undefined?'  → '+JSON.stringify(x):'')));};
const HOST='https://rakshitpoojari52975-arch.github.io';
const SEED={properties:[],bookings:[],expenses:[],staff:[],loans:[],attendance:[]};

// The phone's authenticator. fx.get: 'ok' | 'cancel' | 'error' | 'noUV' | 'needTap' (refuses until a tap has happened).
function fakeAuthn(fx){
  window.__fx=Object.assign({created:[],gets:[],tapped:false},fx);
  const F=window.__fx;
  document.addEventListener('pointerdown',()=>{F.tapped=true;},true);
  document.addEventListener('click',()=>{F.tapped=true;},true);
  if(F.none)return;
  window.PublicKeyCredential={isUserVerifyingPlatformAuthenticatorAvailable:async()=>F.avail!==false};
  const ID=new Uint8Array([7,7,1,2,3,4,5,6]);
  const refuse=n=>Promise.reject(new DOMException('The operation either timed out or was not allowed.',n||'NotAllowedError'));
  Object.defineProperty(navigator,'credentials',{configurable:true,value:{
    create:async o=>{F.created.push(JSON.parse(JSON.stringify(o.publicKey,(k,v)=>v instanceof Uint8Array?'bytes':v)));
      if(F.create==='cancel')return refuse(); return {rawId:ID.buffer,type:'public-key'};},
    get:async o=>{const pk=o.publicKey;F.gets.push({rpId:pk.rpId,uv:pk.userVerification,
        ids:pk.allowCredentials.map(c=>Array.from(new Uint8Array(c.id.buffer||c.id)))});
      const mode=F.get||'ok';
      if(mode==='cancel')return refuse();
      if(mode==='error')return refuse('UnknownError');
      if(mode==='needTap'&&!F.tapped)return refuse();
      const ad=new Uint8Array(37); ad[32]=mode==='noUV'?0x01:0x05;     // UP, and UV unless told not
      return {rawId:ID.buffer,type:'public-key',response:{authenticatorData:ad.buffer,signature:new Uint8Array(70).buffer}};},
  }});
}

(async()=>{
const br=await chromium.launch();
const open=async({fx={},faceId=false,pin='1234',host=HOST}={})=>{
  const ctx=await br.newContext({serviceWorkers:'block',viewport:{width:390,height:844}});
  await ctx.route('**/*',r=>{const u=new URL(r.request().url());
    if(u.origin!==HOST&&u.origin!==host)return r.abort();
    const p=path.join(ROOT,u.pathname.replace(/^\/staylog\/?/,'').replace(/^\/+/,'')||'index.html');
    if(!fs.existsSync(p)||fs.statSync(p).isDirectory())return r.fulfill({status:404,body:''});
    if(/supabase\.umd\.js$/.test(p))return r.abort();
    r.fulfill({status:200,contentType:T[path.extname(p)]||'text/plain',body:fs.readFileSync(p)});});
  const page=await ctx.newPage(); const errs=[], dialogs=[];
  page.on('pageerror',e=>errs.push(e.message)); page.on('dialog',async d=>{dialogs.push(d.message());await d.accept();});
  await page.addInitScript(([s,pin,faceId,fx,fa])=>{
    localStorage.setItem('staylog_v2',JSON.stringify(s));
    if(pin)localStorage.setItem('staylog_auth',JSON.stringify({pin}));
    if(faceId)localStorage.setItem('staylog_faceid',JSON.stringify({id:'BwcBAgMEBQY'}));
    eval('('+fa+')')(fx);},[SEED,pin,faceId,fx,fakeAuthn.toString()]);
  await page.goto(host+'/staylog/index.html');
  await page.waitForFunction(()=>typeof state!=='undefined'&&!state._loading);
  await page.waitForTimeout(600);                         // the automatic prompt, if any
  return {ctx,page,errs,dialogs};
};
const FX=p=>p.evaluate(()=>window.__fx);
const loggedIn=p=>p.evaluate(()=>state.loggedIn);
const typePin=async(page,pin)=>{for(const d of pin)
  await page.locator('.numkey').filter({hasText:new RegExp('^'+d+'$')}).dispatchEvent('pointerup');
  await page.waitForTimeout(500);};
const openMenu=async page=>{await page.evaluate(()=>{state.modal='menu';render();});await page.waitForTimeout(100);};
const faceRow=page=>page.locator('button',{hasText:'Unlock with Face ID'});
const stored=page=>page.evaluate(()=>localStorage.getItem('staylog_faceid'));

console.log('\n— no WebAuthn: no Face ID, the PIN as ever —');
{ const {ctx,page,errs}=await open({fx:{none:true}});
  ok('no Face ID button on the lock screen', await page.locator('[data-faceid-unlock]').count()===0);
  await typePin(page,'1234');
  ok('the PIN unlocks', await loggedIn(page));
  await openMenu(page);
  ok('no Face ID row in the menu', await faceRow(page).count()===0);
  ok('no page errors', errs.length===0, errs);
  await ctx.close(); }
{ const {ctx,page}=await open({fx:{avail:false}});
  await typePin(page,'1234'); await openMenu(page);
  ok('no row when the phone has no Face ID either', await faceRow(page).count()===0);
  await ctx.close(); }
{ const {ctx,page}=await open({host:'https://example.github.io'});
  await typePin(page,'1234'); await openMenu(page);
  ok('no row on another host, where the RP ID cannot match', await faceRow(page).count()===0);
  await ctx.close(); }

console.log('\n— turning it on —');
{ const {ctx,page,errs}=await open({});
  ok('not set up: no prompt and no button on the lock screen', (await FX(page)).gets.length===0&&await page.locator('[data-faceid-unlock]').count()===0);
  await typePin(page,'1234'); await openMenu(page);
  ok('the menu offers it, off', /Off/.test(await faceRow(page).innerText()));
  await faceRow(page).click(); await page.waitForTimeout(150);
  await page.fill('[data-faceid-pin]','9999'); await page.click('[data-faceid-go]'); await page.waitForTimeout(150);
  ok('a wrong PIN sets nothing up', (await FX(page)).created.length===0&&!(await stored(page))&&
     /not your PIN/.test(await page.locator('[data-faceid-msg]').innerText()));
  await page.fill('[data-faceid-pin]','1234'); await page.click('[data-faceid-go]'); await page.waitForTimeout(250);
  const c=(await FX(page)).created[0];
  ok('the right PIN creates the credential', !!c);
  ok('on the phone\'s own authenticator, with user verification required',
     c&&c.authenticatorSelection.authenticatorAttachment==='platform'&&c.authenticatorSelection.userVerification==='required', c&&c.authenticatorSelection);
  ok('for the full host as the relying party', c&&c.rp.id==='rakshitpoojari52975-arch.github.io', c&&c.rp);
  ok('only the credential id is kept, on the phone', JSON.parse(await stored(page)||'{}').id==='BwcBAgMEBQY', await stored(page));
  ok('not in the app\'s data', !JSON.stringify(await page.evaluate(()=>state.data)).includes('BwcBAgMEBQY'));
  ok('the sheet closes', await page.evaluate(()=>state.modal)===null);
  await openMenu(page);
  ok('and the row says it is on', /On/.test(await faceRow(page).innerText()));

  console.log('\n— Lock app, then Face ID —');
  await page.click('button:has-text("Lock app")'); await page.waitForTimeout(700);
  const g=(await FX(page)).gets;
  ok('locking asks for Face ID straight away, once', g.length===1, g.length);
  ok('for this credential, under this RP, verification required', g[0]&&g[0].rpId==='rakshitpoojari52975-arch.github.io'&&g[0].uv==='required'
     &&JSON.stringify(g[0].ids)===JSON.stringify([[7,7,1,2,3,4,5,6]]), g[0]);
  ok('and it unlocks', await loggedIn(page));
  ok('no page errors', errs.length===0, errs);
  await ctx.close(); }
{ const {ctx,page}=await open({fx:{create:'cancel'}});
  await typePin(page,'1234'); await openMenu(page); await faceRow(page).click(); await page.waitForTimeout(100);
  await page.fill('[data-faceid-pin]','1234'); await page.click('[data-faceid-go]'); await page.waitForTimeout(200);
  ok('cancelling the Face ID step sets nothing up', !(await stored(page))&&/not set up/.test(await page.locator('[data-faceid-msg]').innerText()));
  await ctx.close(); }

console.log('\n— opening the app with Face ID on —');
{ const {ctx,page,errs}=await open({faceId:true});
  ok('it asks as the screen opens and unlocks', (await FX(page)).gets.length===1&&await loggedIn(page));
  ok('no page errors', errs.length===0, errs);
  await ctx.close(); }
for(const [label,mode] of [['cancelled','cancel'],['failed','error'],['without user verification','noUV']]){
  const {ctx,page,errs}=await open({faceId:true,fx:{get:mode}});
  ok(`Face ID ${label}: still locked`, !(await loggedIn(page)));
  ok('  a quiet note, not an error loop', /enter your PIN/.test(await page.locator('body').innerText()));
  await page.waitForTimeout(800);
  ok('  and no second prompt by itself', (await FX(page)).gets.length===1, (await FX(page)).gets.length);
  await typePin(page,'1234');
  ok('  the PIN pad unlocks', await loggedIn(page));
  ok('  no page errors', errs.length===0, errs);
  await ctx.close();
}
{ const {ctx,page}=await open({faceId:true,fx:{get:'needTap'}});
  ok('Safari refusing a prompt without a tap: still locked, the button is there', !(await loggedIn(page))&&await page.locator('[data-faceid-unlock]').count()===1);
  await page.click('[data-faceid-unlock]'); await page.waitForTimeout(500);
  ok('tapping it asks again and unlocks', (await FX(page)).gets.length===2&&await loggedIn(page), (await FX(page)).gets.length);
  await ctx.close(); }
{ const {ctx,page}=await open({faceId:true,fx:{get:'cancel'}});
  await typePin(page,'9999');
  ok('a wrong PIN after a cancelled Face ID is still refused', !(await loggedIn(page))&&/Incorrect PIN/.test(await page.locator('body').innerText()));
  await ctx.close(); }

console.log('\n— turning it off —');
{ const {ctx,page}=await open({faceId:true});
  await openMenu(page); await faceRow(page).click(); await page.waitForTimeout(100);
  await page.fill('[data-faceid-pin]','0000'); await page.click('[data-faceid-go]'); await page.waitForTimeout(100);
  ok('a wrong PIN leaves it on', !!(await stored(page)));
  await page.fill('[data-faceid-pin]','1234'); await page.click('[data-faceid-go]'); await page.waitForTimeout(100);
  ok('the right PIN turns it off', !(await stored(page)));
  await openMenu(page);
  ok('the row says off', /Off/.test(await faceRow(page).innerText()));
  await page.click('button:has-text("Lock app")'); await page.waitForTimeout(600);
  ok('the lock screen no longer asks or offers it', (await FX(page)).gets.length===1&&await page.locator('[data-faceid-unlock]').count()===0&&!(await loggedIn(page)));
  await ctx.close(); }

console.log('\n— Forgot / Reset PIN —');
{ const {ctx,page}=await open({faceId:true,fx:{get:'cancel'}});
  await page.click('button:has-text("Forgot / Reset PIN")'); await page.waitForTimeout(200);
  ok('clears the Face ID setup too', !(await stored(page))&&await page.evaluate(()=>state.auth)===null);
  ok('and the new-PIN screen has no Face ID', await page.locator('[data-faceid-unlock]').count()===0);
  await ctx.close(); }

await br.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
})();
