/* The VAPID private key appears in no file of this public repository, and in
   no commit of its history (or of staylog-history.bundle). Anyone holding it
   can send notifications as StayLog. It lives only in Supabase's secrets.

   Looked for by shape (PEM blocks, JWK "d" members, web-push's JSON, an
   assigned VAPID_PRIVATE_KEY) and by mathematics: every 43-character token
   that could be a P-256 private key is tried against the public key in
   cloud-config.js, so even a bare, unlabelled copy is caught once that key
   is set. STAYLOG_REAL_VAPID_PRIVATE=<key> also searches for it by value.
     node tests/test_push_keys.js */
const fs=require('fs'),path=require('path'),os=require('os'),crypto=require('crypto'),{execFileSync}=require('child_process');
const ROOT=path.resolve(__dirname,'..');
let pass=0,fail=0;
const ok=(n,c,x)=>{c?(pass++,console.log('  ✓ '+n)):(fail++,console.log('  ✗ '+n+(x!==undefined?'  → '+JSON.stringify(x):'')));};
const git=(args,cwd=ROOT)=>{try{return execFileSync('git',args,{cwd,encoding:'utf8',maxBuffer:1<<30});}catch{return '';}};

const cfg=fs.readFileSync(path.join(ROOT,'cloud-config.js'),'utf8');
const PUB=((cfg.match(/vapidPublicKey:\s*'([^']*)'/)||[])[1]||'').trim();
const real=(process.env.STAYLOG_REAL_VAPID_PRIVATE||'').trim();

const SHAPES=[
  ['PEM private key',/-----BEGIN (?:EC |ENCRYPTED )?PRIVATE KEY-----/g],
  ['JWK private member',/"d"\s*:\s*"[A-Za-z0-9_-]{40,}"/g],
  ['web-push privateKey',/privateKey["']?\s*[:=]\s*["'][A-Za-z0-9_-]{40,}["']/g],
  ['VAPID_PRIVATE_KEY with a value',/VAPID_PRIVATE_KEY["']?\s*[:=]\s*["']?[A-Za-z0-9_-]{40,}/g],
];
// A P-256 private key in base64url is exactly 43 characters.
const TOKEN=/(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g;
const matchesPublic=(tok,pub=PUB)=>{
  if(!pub)return false;
  try{const e=crypto.createECDH('prime256v1');e.setPrivateKey(Buffer.from(tok,'base64url'));
    return e.getPublicKey().toString('base64url')===pub;}catch{return false;}
};
function scan(label,text){
  const hits=[];
  for(const [kind,re] of SHAPES)for(const m of text.match(re)||[])hits.push(`${label}: ${kind} (${m.slice(0,24)}…)`);
  if(PUB)for(const t of new Set(text.match(TOKEN)||[]))if(matchesPublic(t))hits.push(`${label}: THE private key for the configured public key`);
  if(real&&text.includes(real))hits.push(`${label}: your real private key`);
  return hits;
}

console.log('\n— every file —');
const files=git(['ls-files','--cached','--others','--exclude-standard']).trim().split('\n').filter(Boolean);
let hits=[],scanned=0;
for(const f of files){
  let b;try{b=fs.readFileSync(path.join(ROOT,f));}catch{continue;}
  if(b.includes(0))continue;
  scanned++; hits.push(...scan(f,b.toString('utf8')));
}
ok(`no private key in any of the ${scanned} text files`, scanned>50&&hits.length===0, hits);

console.log('\n— every commit —');
const hist=git(['log','--all','-p','--no-color']);
ok('none in the history of any branch', hist.length>0&&scan('history',hist).length===0, scan('history',hist).slice(0,5));
const bundle=path.join(ROOT,'staylog-history.bundle');
if(fs.existsSync(bundle)){
  // A thin bundle: its base commits are this repo's, so borrow its objects.
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'staylog-bundle-'));
  git(['init','-q','--bare',dir]);
  fs.writeFileSync(path.join(dir,'objects/info/alternates'),path.join(git(['rev-parse','--absolute-git-dir']).trim(),'objects')+'\n');
  git(['fetch','-q',bundle,'refs/*:refs/*'],dir);
  const bh=git(['log','--all','-p','--no-color'],dir);
  if(bh)ok('none in staylog-history.bundle either', scan('bundle',bh).length===0, scan('bundle',bh).slice(0,5));
  else console.log('  (staylog-history.bundle could not be read here — its base commits are missing)');
  fs.rmSync(dir,{recursive:true,force:true});
}

console.log('\n— where the keys are meant to be —');
const fn=fs.readFileSync(path.join(ROOT,'supabase/functions/notify/index.ts'),'utf8');
ok('the function reads the private key from its Supabase secret', /Deno\.env\.get\('VAPID_PRIVATE_KEY'\)/.test(fn));
ok('the app never mentions it', !/VAPID_PRIVATE|privateKey/i.test(fs.readFileSync(path.join(ROOT,'app.js'),'utf8')+fs.readFileSync(path.join(ROOT,'cloud.js'),'utf8')));
ok('cloud-config.js holds only a public key', PUB===''||/^B[A-Za-z0-9_-]{86}$/.test(PUB), PUB);
const gen=fs.readFileSync(path.join(ROOT,'tools/vapid-keys.html'),'utf8');
ok('the key generator sends nothing anywhere', !/fetch\(|XMLHttpRequest|sendBeacon|<script[^>]+src=|localStorage|<form/i.test(gen));
// The detectors themselves, on a key made here and now (never written down).
{ const e=crypto.createECDH('prime256v1');e.generateKeys();
  const d=e.getPrivateKey().toString('base64url').padStart(43,'A'), pub=e.getPublicKey().toString('base64url');
  ok('the shape checks catch a labelled key', scan('t',`VAPID_PRIVATE_KEY=${d}`).length===1&&scan('t',`{"privateKey":"${d}"}`).length===1
     &&scan('t',`{"kty":"EC","d":"${d}"}`).length===1);
  const bare=`some notes\n${d}\nmore notes`, toks=bare.match(TOKEN)||[];
  ok('and the maths recognises a bare one by its public key', toks.some(t=>matchesPublic(t,pub))
     &&!toks.some(t=>matchesPublic(t,Buffer.concat([Buffer.from([4]),Buffer.alloc(64,7)]).toString('base64url')))); }
if(!PUB)console.log('  (no vapidPublicKey in cloud-config.js yet: the bare-key search switches on once it is set)');
if(!real)console.log('  (set STAYLOG_REAL_VAPID_PRIVATE to also search for your actual private key by value)');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
