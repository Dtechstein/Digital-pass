/**
 * page.js — THE HOSTED CARD PAGE (build 4.65). The card is the doorway; this is the room.
 *
 *   GET  /p/{serial}           the guest's page: photo hero, Share/Download (the gift),
 *                              promise band, movement counter, completion flow, wallet CTAs.
 *   POST /p/{serial}/complete  { story?, consent } → act_stories row, card celebrates,
 *                              lock screen congratulates. Once per card (v1 self-report).
 *   GET  /p/{serial}/google    upsert Google object → redirect to the save link
 *                              (kept out of page render so the page stays instant).
 *
 * Consent is explicit and never pre-checked. No consent → story stays private, forever.
 * Design: David-approved photo-page sample (2026-08-05).
 */

import { notifyAllPlatforms, logEvent } from './platform.js';

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => Number(n).toLocaleString('en-US');

/* ── color helpers: the page inherits the brand's card colors ── */
function rgbParts(rgb) {
  const m = /rgb\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/.exec(String(rgb || ''));
  return m ? [+m[1], +m[2], +m[3]] : [164, 19, 60];
}
const shade = (rgb, f) => `rgb(${rgbParts(rgb).map((v) => Math.max(0, Math.min(255, Math.round(v * f)))).join(', ')})`;
const tint = (rgb, f) => `rgb(${rgbParts(rgb).map((v) => Math.round(v + (255 - v) * f)).join(', ')})`;

export function movementBase(env) {
  const n = parseInt(env.MOVEMENT_BASE, 10);
  return Number.isFinite(n) ? n : 251442;
}

export async function getStory(env, serial) {
  return env.DB.prepare('SELECT * FROM act_stories WHERE serial=?').bind(serial).first();
}

/* ═══════════════ GET /p/{serial} ═══════════════ */
export async function renderCardPage(env, pass, template) {
  const f = JSON.parse(pass.fields_json || '{}');
  const t = template;
  const story = await getStory(env, pass.serial);
  const done = !!story;

  const brandColor = t.colors.bg;                       // page theme = card theme
  const deep = shade(brandColor, 0.78);
  const bright = tint(brandColor, 0.18);
  const blush = tint(brandColor, 0.94);
  const line = tint(brandColor, 0.82);

  const who = f.guest || f.clientName || f.name || '';
  const promise = f.promise || '';
  const due = f.due || '';
  const event = f.event || '';
  const photo = f.photoUrl || '';
  const org = t.orgName || 'Your Card';
  const appleUrl = `${env.BASE_URL}/v1/passes/${pass.serial}/apple.pkpass?t=${pass.auth_token}`;
  const googleUrl = env.GOOGLE_SA_KEY_JSON ? `${env.BASE_URL}/p/${pass.serial}/google` : '';

  const actNumber = done ? story.act_number : null;
  const pct = actNumber ? Math.min(100, (actNumber / 1e6) * 100).toFixed(1) : null;
  const movementText = done && actNumber ? `Act #${fmt(actNumber)} of one million` : (f.movement || '');
  const isLove = /love/i.test(org) || !!f.movement;      // movement box is Love-flavored

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(who ? who + ' — ' : '')}${esc(org)}</title>
<style>
  :root{--crimson:${brandColor};--deep:${deep};--bright:${bright};--blush:${blush};--ink:#221016;--soft:#8a6b74;--line:${line};}
  *{box-sizing:border-box;margin:0;padding:0;}
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif;background:#fff;color:var(--ink);}
  .phone-frame{max-width:430px;margin:0 auto;min-height:100vh;background:#fff;box-shadow:0 0 60px rgba(0,0,0,.12);}
  .hero{position:relative;}
  .hero img{width:100%;aspect-ratio:4/5;object-fit:cover;display:block;}
  .hero .veil{position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,0,0,.25) 0%,transparent 30%,transparent 55%,${deep.replace('rgb','rgba').replace(')', ',.88)')} 100%);}
  .hero.nophoto{background:linear-gradient(135deg,var(--deep),var(--bright));padding:64px 20px 20px;}
  .brand{position:absolute;top:16px;left:16px;display:flex;align-items:center;gap:8px;color:#fff;font-weight:700;font-size:14px;text-shadow:0 1px 8px rgba(0,0,0,.4);}
  .hero.nophoto .brand{position:static;margin-bottom:28px;}
  .brand .dot{width:26px;height:26px;border-radius:8px;background:rgba(255,255,255,.22);backdrop-filter:blur(6px);display:grid;place-items:center;font-size:13px;}
  .meta{position:absolute;left:20px;right:20px;bottom:18px;color:#fff;}
  .hero.nophoto .meta{position:static;}
  .meta .who{font-size:24px;font-weight:800;letter-spacing:-.3px;}
  .meta .where{font-size:13.5px;opacity:.9;margin-top:2px;}
  .promise{background:var(--deep);color:#fff;padding:16px 20px;display:flex;align-items:center;justify-content:space-between;gap:12px;}
  .promise .lbl{font-size:10px;font-weight:800;letter-spacing:1.2px;opacity:.75;}
  .promise .val{font-size:15.5px;font-weight:700;margin-top:2px;}
  .promise .due{text-align:right;flex-shrink:0;}
  .actions{display:grid;grid-template-columns:1fr 1fr;gap:12px;padding:18px 20px 6px;}
  .btn{border:0;border-radius:14px;padding:15px 10px;font-size:15px;font-weight:700;font-family:inherit;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px;transition:transform .12s;}
  .btn:active{transform:scale(.97);}
  .btn.share{background:var(--crimson);color:#fff;box-shadow:0 8px 22px -8px rgba(0,0,0,.4);}
  .btn.download{background:var(--blush);color:var(--crimson);border:1.5px solid var(--line);}
  .btn.complete{grid-column:1/-1;background:#fff;border:2px dashed var(--crimson);color:var(--crimson);padding:16px;font-size:16px;}
  .btn.complete.done{background:linear-gradient(120deg,var(--deep),var(--bright));color:#fff;border:0;box-shadow:0 10px 26px -8px rgba(0,0,0,.45);}
  .storybox{display:none;margin:10px 20px 0;background:var(--blush);border:1px solid var(--line);border-radius:16px;padding:16px;}
  .storybox.open{display:block;animation:pop .4s ease;}
  .storybox h3{font-size:13px;color:var(--crimson);margin-bottom:8px;}
  .storybox textarea{width:100%;min-height:88px;border:1px solid var(--line);border-radius:10px;padding:10px;font-family:inherit;font-size:14px;resize:vertical;background:#fff;}
  .consent{display:flex;gap:9px;align-items:flex-start;margin:12px 0;font-size:13px;color:var(--ink);line-height:1.45;}
  .consent input{margin-top:2px;width:17px;height:17px;accent-color:var(--crimson);flex-shrink:0;}
  .storyrow{display:flex;gap:10px;}
  .btn.small{flex:1;padding:12px;font-size:14px;border-radius:11px;}
  .btn.ghost{background:#fff;border:1.5px solid var(--line);color:var(--soft);}
  .btn.go{background:var(--crimson);color:#fff;}
  .movement{margin:16px 20px;background:var(--blush);border:1px solid var(--line);border-radius:16px;padding:16px 18px;}
  .movement .top{display:flex;justify-content:space-between;align-items:baseline;}
  .movement .lbl{font-size:10.5px;font-weight:800;letter-spacing:1.2px;color:var(--crimson);}
  .movement .count{font-size:13px;color:var(--soft);}
  .movement .big{font-size:21px;font-weight:800;color:var(--deep);margin:6px 0 10px;}
  .bar{height:8px;background:#fff;border-radius:99px;overflow:hidden;border:1px solid var(--line);}
  .bar i{display:block;height:100%;background:linear-gradient(90deg,var(--crimson),var(--bright));border-radius:99px;transition:width .8s ease;}
  .walletcta{margin:6px 20px 14px;text-align:center;padding:14px;border-radius:16px;border:1px solid var(--line);}
  .walletcta .t{font-size:13.5px;color:var(--soft);margin-bottom:10px;}
  .walletcta .badges{display:flex;gap:10px;justify-content:center;}
  .badge{background:#000;color:#fff;border-radius:9px;padding:8px 14px;font-size:12.5px;font-weight:600;display:flex;align-items:center;gap:6px;cursor:pointer;text-decoration:none;}
  footer{padding:18px 20px 30px;text-align:center;font-size:12.5px;color:var(--soft);line-height:1.6;}
  footer b{color:var(--crimson);}
  .toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%) translateY(8px);background:var(--ink);color:#fff;font-size:13px;padding:10px 18px;border-radius:99px;opacity:0;transition:all .25s;pointer-events:none;z-index:9;}
  .toast.show{opacity:1;transform:translateX(-50%) translateY(0);}
  @keyframes pop{0%{transform:scale(.94);opacity:0}60%{transform:scale(1.02)}100%{transform:scale(1);opacity:1}}
  .celebrate{animation:pop .5s ease;}
</style>
</head>
<body>
<div class="phone-frame">
  ${photo ? `
  <div class="hero">
    <img src="${esc(photo)}" alt="${esc(who)}'s photo">
    <div class="veil"></div>
    <div class="brand"><span class="dot">💗</span> ${esc(org)}</div>
    <div class="meta"><div class="who">${esc(who)}</div><div class="where">${esc(event)}</div></div>
  </div>` : `
  <div class="hero nophoto">
    <div class="brand"><span class="dot">💗</span> ${esc(org)}</div>
    <div class="meta"><div class="who">${esc(who)}</div><div class="where">${esc(event)}</div></div>
  </div>`}

  ${promise ? `
  <div class="promise">
    <div class="p"><div class="lbl">MY PROMISE</div><div class="val" id="promiseText">${done ? 'I completed my act of kindness 🎉' : esc(promise)}</div></div>
    ${due ? `<div class="due"><div class="lbl">DUE</div><div class="val">${esc(due)}</div></div>` : ''}
  </div>` : ''}

  <div class="actions">
    ${photo ? `<button class="btn share" onclick="sharePhoto()">📤 Share</button>
    <button class="btn download" onclick="downloadPhoto()">⬇ Download</button>` : ''}
    ${promise ? `<button class="btn complete${done ? ' done' : ''}" id="completeBtn" onclick="startComplete()">
      ${done ? `🎉 &nbsp;Act #${fmt(actNumber)} of one million — thank you 💗` : '✓ &nbsp;I did my act of kindness'}
    </button>` : ''}
  </div>

  <div class="storybox" id="storyBox">
    <h3>💗 You did it. Want to tell us what you did?</h3>
    <textarea id="storyText" maxlength="2000" placeholder="I helped… (totally optional — but your story might inspire the next act)"></textarea>
    <label class="consent"><input type="checkbox" id="consentBox">
      <span>${esc(org)} may share my story (first name only) to inspire others. Unchecked = it stays private, always.</span></label>
    <div class="storyrow">
      <button class="btn small ghost" onclick="submitComplete(true)">Skip — just count it</button>
      <button class="btn small go" onclick="submitComplete(false)">Complete my act 💗</button>
    </div>
  </div>

  ${isLove && movementText ? `
  <div class="movement" id="movementBox">
    <div class="top"><span class="lbl">THE MOVEMENT</span><span class="count" id="pctText">${pct ? pct + '% of the way' : ''}</span></div>
    <div class="big" id="actNum">${esc(movementText)}</div>
    <div class="bar"><i id="barFill" style="width:${pct || 24.8}%"></i></div>
  </div>` : ''}

  <div class="walletcta">
    <div class="t">Keep it in your pocket — live updates, reminders, your stats</div>
    <div class="badges">
      <a class="badge" href="${esc(appleUrl)}"><svg width="12" height="14" viewBox="0 0 814 1000" fill="#fff"><path d="M788 341c-6 4-107 61-107 187 0 146 128 197 132 199-1 3-21 71-68 141-42 61-87 123-154 123s-85-39-163-39c-76 0-103 40-165 40s-105-57-155-127C50 782 4 654 4 533c0-194 126-297 250-297 66 0 121 43 163 43 39 0 101-46 176-46 28 0 129 3 195 108zM555 172c31-37 53-88 53-139 0-7-1-14-2-20-50 2-110 34-146 76-29 32-55 83-55 135 0 8 1 16 2 18 3 1 8 2 13 2 45 0 102-30 135-72z"/></svg> Add to Apple Wallet</a>
      ${googleUrl ? `<a class="badge" href="${esc(googleUrl)}">G Add to Google Wallet</a>` : ''}
    </div>
  </div>

  <footer>One photo. One promise. <b>One million acts of kindness.</b><br>${esc(org)}</footer>
</div>
<div class="toast" id="toast"></div>

<script>
const PHOTO=${JSON.stringify(photo)};
const WHO=${JSON.stringify(who || 'my')};
const DONE=${JSON.stringify(done)};
function toast(t){const el=document.getElementById('toast');el.textContent=t;el.classList.add('show');setTimeout(()=>el.classList.remove('show'),2600);}
async function sharePhoto(){
  if(navigator.share){
    try{
      const res=await fetch(PHOTO);const blob=await res.blob();
      const file=new File([blob],WHO.toLowerCase().replace(/\\W/g,'')+'-photo.jpg',{type:blob.type||'image/jpeg'});
      if(navigator.canShare&&navigator.canShare({files:[file]})){
        await navigator.share({files:[file],title:document.title,text:'One photo. One promise 💗 '+location.href});return;
      }
      await navigator.share({title:document.title,text:'One photo. One promise 💗',url:location.href});
    }catch{}
  }else{toast('Open this on your phone to share 📤');}
}
async function downloadPhoto(){
  try{
    const res=await fetch(PHOTO);const blob=await res.blob();
    const a=document.createElement('a');a.href=URL.createObjectURL(blob);
    a.download=WHO.toLowerCase().replace(/\\W/g,'')+'-photo.jpg';
    document.body.appendChild(a);a.click();a.remove();toast('Saving your photo ⬇');
  }catch{toast("Couldn't download — try press-and-hold on the photo");}
}
function startComplete(){
  if(DONE){toast('Already counted — thank you 💗');return;}
  document.getElementById('storyBox').classList.add('open');
  document.getElementById('storyBox').scrollIntoView({behavior:'smooth',block:'center'});
}
let sending=false;
async function submitComplete(skip){
  if(sending)return;sending=true;
  const story=skip?'':document.getElementById('storyText').value.trim();
  const consent=!skip&&!!document.getElementById('consentBox').checked&&!!story;
  try{
    const res=await fetch(location.pathname+'/complete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({story,consent})});
    const data=await res.json();
    if(!res.ok)throw new Error(data.error||'failed');
    document.getElementById('storyBox').classList.remove('open');
    const btn=document.getElementById('completeBtn');
    btn.classList.add('done','celebrate');
    btn.innerHTML='🎉 &nbsp;Act #'+Number(data.actNumber).toLocaleString()+' of one million — thank you 💗';
    const p=document.getElementById('promiseText');if(p)p.textContent='I completed my act of kindness 🎉';
    const a=document.getElementById('actNum');if(a)a.textContent='Act #'+Number(data.actNumber).toLocaleString()+' of one million';
    const b=document.getElementById('barFill');if(b)b.style.width=Math.min(100,data.actNumber/1e6*100).toFixed(1)+'%';
    const c=document.getElementById('pctText');if(c)c.textContent=Math.min(100,data.actNumber/1e6*100).toFixed(1)+'% of the way';
    toast('Your card just updated — check your lock screen 💗');
  }catch(e){
    toast(e.message==='already_completed'?'Already counted — thank you 💗':'Hmm, that didn\\'t go through — try again?');
  }
  sending=false;
}
</script>
</body>
</html>`;
}

/* ═══════════════ POST /p/{serial}/complete ═══════════════ */
export async function handleComplete(env, pass, body) {
  const existing = await getStory(env, pass.serial);
  if (existing) return { status: 409, data: { error: 'already_completed', actNumber: existing.act_number } };

  const story = String(body.story || '').slice(0, 2000).trim();
  const consent = body.consent === true && story ? 1 : 0;   // consent means nothing without a story
  const now = Math.floor(Date.now() / 1000);

  const cnt = await env.DB.prepare('SELECT COUNT(*) AS n FROM act_stories').first();
  const actNumber = movementBase(env) + (cnt && cnt.n ? cnt.n : 0) + 1;

  await env.DB.prepare(
    'INSERT INTO act_stories (serial, story, photo_url, consent, consented_at, act_number, created_at) VALUES (?,?,?,?,?,?,?)'
  ).bind(pass.serial, story || null, null, consent, consent ? now : null, actNumber, now).run();

  // the card celebrates
  const f = JSON.parse(pass.fields_json || '{}');
  const celebration = `🎉 You did it — act #${fmt(actNumber)} of one million 💗`;
  if (f.promise) f.promise = 'I completed my act of kindness 🎉';
  f.acts = String((parseInt(f.acts, 10) || 0) + 1);
  f.movement = `Act #${fmt(actNumber)} of one million`;
  f.latest = celebration;
  await env.DB.prepare('UPDATE passes SET fields_json=?, updated_at=? WHERE serial=?')
    .bind(JSON.stringify(f), now, pass.serial).run();

  const notified = await notifyAllPlatforms(env, { ...pass, fields_json: JSON.stringify(f) }, f, celebration);
  await logEvent(env, pass.serial, 'completed', {
    message: `act #${fmt(actNumber)}${story ? ' + story' : ''}${consent ? ' (consented)' : ''}`,
    apple: notified.pushed, google: notified.google,
  });

  return { status: 200, data: { ok: true, actNumber, consent: !!consent } };
}
