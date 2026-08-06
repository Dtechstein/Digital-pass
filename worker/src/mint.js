/**
 * mint.js — THE MINT. One act, one design, one number, forever.
 *
 * Generative certificate art, deterministically seeded by the act itself:
 * act number + card serial + name + completion moment. The same act always
 * re-renders its own certificate; no other act can ever produce it.
 * No image API, no cost, no latency — the design is born from the act.
 *
 *   GET /p/{serial}/mint.svg   the certificate (public; only exists once completed)
 *
 * Visual language: a radiant "act bloom" — petals, orbits and sparks whose
 * count, angles, colors and rhythm all derive from the seed — over the brand's
 * colors, with the act number stamped like an edition mark.
 */

/* ── tiny deterministic PRNG (mulberry32) seeded from the act's identity ── */
function seedFrom(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return h >>> 0;
}
function prng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => Number(n).toLocaleString('en-US');

function rgbParts(rgb) {
  const m = /rgb\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/.exec(String(rgb || ''));
  return m ? [+m[1], +m[2], +m[3]] : [164, 19, 60];
}
const rgbStr = (p) => `rgb(${p.map((v) => Math.max(0, Math.min(255, Math.round(v)))).join(',')})`;
const mix = (a, b, t) => rgbStr(rgbParts(a).map((v, i) => v + (rgbParts(b)[i] - v) * t));

/**
 * Render the certificate SVG.
 * @param {object} p  { actNumber, name, serial, completedAt (unix s), template }
 */
export function renderMintSvg({ actNumber, name, serial, completedAt, template }) {
  const seedStr = `act:${actNumber}|${serial}|${name || ''}|${completedAt || 0}`;
  const rnd = prng(seedFrom(seedStr));
  const t = template || {};
  const bg = (t.colors && t.colors.bg) || 'rgb(164, 19, 60)';
  const label = (t.colors && t.colors.label) || 'rgb(255, 214, 224)';
  const org = t.orgName || 'All About Love';

  const W = 800, H = 1000, cx = W / 2, cy = 430;
  const deep = mix(bg, 'rgb(0,0,0)', 0.55);
  const deeper = mix(bg, 'rgb(0,0,0)', 0.75);
  const glow = mix(bg, 'rgb(255,255,255)', 0.35);

  // ── every act blooms differently ──
  const petals = 7 + Math.floor(rnd() * 10);            // 7–16 petals
  const layers = 2 + Math.floor(rnd() * 3);             // 2–4 layers
  const twist = (rnd() - 0.5) * 60;                     // layer rotation drift
  const orbits = 2 + Math.floor(rnd() * 3);             // 2–4 orbit rings
  const sparks = 14 + Math.floor(rnd() * 22);           // 14–35 sparks
  const hueShift = rnd();                                // color personality

  const petalColor = (li) => {
    const base = mix(bg, glow, 0.25 + 0.5 * (li / Math.max(1, layers - 1)));
    return mix(base, hueShift > 0.66 ? 'rgb(255,209,102)' : hueShift > 0.33 ? 'rgb(255,255,255)' : label, 0.18 * li);
  };

  let art = '';
  // orbit rings
  for (let o = 0; o < orbits; o++) {
    const r = 150 + o * (60 + rnd() * 40);
    const dash = 3 + rnd() * 14;
    art += `<circle cx="${cx}" cy="${cy}" r="${r.toFixed(1)}" fill="none" stroke="${glow}" stroke-opacity="${(0.12 + rnd() * 0.14).toFixed(2)}" stroke-width="1.4" stroke-dasharray="${dash.toFixed(1)} ${(dash * (1 + rnd())).toFixed(1)}"/>`;
  }
  // petal layers
  for (let li = layers - 1; li >= 0; li--) {
    const rOut = 120 + li * (52 + rnd() * 26);
    const rIn = rOut * (0.34 + rnd() * 0.14);
    const width = 0.5 + rnd() * 0.35;
    const rot = li * twist + rnd() * 360;
    const col = petalColor(li);
    const op = (0.5 + 0.5 * (1 - li / layers)).toFixed(2);
    for (let i = 0; i < petals; i++) {
      const a = (i / petals) * Math.PI * 2 + (rot * Math.PI) / 180;
      const spread = (Math.PI / petals) * width;
      const x1 = cx + Math.cos(a - spread) * rIn, y1 = cy + Math.sin(a - spread) * rIn;
      const x2 = cx + Math.cos(a) * rOut, y2 = cy + Math.sin(a) * rOut;
      const x3 = cx + Math.cos(a + spread) * rIn, y3 = cy + Math.sin(a + spread) * rIn;
      const bulge = rOut * (1.06 + rnd() * 0.1);
      const bx = cx + Math.cos(a) * bulge, by = cy + Math.sin(a) * bulge;
      art += `<path d="M ${x1.toFixed(1)} ${y1.toFixed(1)} Q ${bx.toFixed(1)} ${by.toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)} Q ${bx.toFixed(1)} ${by.toFixed(1)} ${x3.toFixed(1)} ${y3.toFixed(1)} Z" fill="${col}" fill-opacity="${op}"/>`;
    }
  }
  // sparks — the acts of light around it
  for (let i = 0; i < sparks; i++) {
    const a = rnd() * Math.PI * 2;
    const r = 90 + rnd() * 290;
    const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r * 0.92;
    const s = 1 + rnd() * 3.4;
    art += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${s.toFixed(1)}" fill="${rnd() > 0.5 ? glow : 'rgb(255,209,102)'}" fill-opacity="${(0.35 + rnd() * 0.5).toFixed(2)}"/>`;
  }
  // heart core
  const heartS = 3.1 + rnd() * 0.9;
  art += `<g transform="translate(${cx},${cy}) scale(${heartS.toFixed(2)})"><path d="M0 6 C -1 2 -8 -1 -8 -6 C -8 -10 -5 -12 -2.5 -12 C -1 -12 0 -11 0 -10 C 0 -11 1 -12 2.5 -12 C 5 -12 8 -10 8 -6 C 8 -1 1 2 0 6 Z" fill="#fff" fill-opacity="0.96"/></g>`;

  const dateStr = completedAt
    ? new Date(completedAt * 1000).toISOString().slice(0, 10)
    : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <defs>
    <radialGradient id="sky" cx="50%" cy="40%" r="75%">
      <stop offset="0%" stop-color="${mix(deep, bg, 0.5)}"/>
      <stop offset="60%" stop-color="${deep}"/>
      <stop offset="100%" stop-color="${deeper}"/>
    </radialGradient>
    <radialGradient id="halo" cx="50%" cy="43%" r="40%">
      <stop offset="0%" stop-color="${glow}" stop-opacity="0.5"/>
      <stop offset="100%" stop-color="${glow}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#sky)"/>
  <rect x="26" y="26" width="${W - 52}" height="${H - 52}" fill="none" stroke="${glow}" stroke-opacity="0.4" stroke-width="1.6" rx="26"/>
  <ellipse cx="${cx}" cy="${cy}" rx="330" ry="330" fill="url(#halo)"/>
  ${art}
  <text x="${cx}" y="120" text-anchor="middle" fill="${label}" font-size="21" letter-spacing="7" font-weight="700">${esc(org.toUpperCase())}</text>
  <text x="${cx}" y="152" text-anchor="middle" fill="${glow}" font-size="14" letter-spacing="4" opacity="0.85">CERTIFICATE OF KINDNESS</text>
  <text x="${cx}" y="790" text-anchor="middle" fill="#fff" font-size="52" font-weight="800" letter-spacing="-1">Act #${fmt(actNumber)}</text>
  <text x="${cx}" y="826" text-anchor="middle" fill="${label}" font-size="19" opacity="0.95">of one million</text>
  ${name ? `<text x="${cx}" y="884" text-anchor="middle" fill="#fff" font-size="26" font-weight="700">${esc(name)}</text>` : ''}
  <text x="${cx}" y="916" text-anchor="middle" fill="${glow}" font-size="14" opacity="0.8">${dateStr ? 'completed ' + dateStr + ' · ' : ''}minted once, never again</text>
  <text x="${cx}" y="${H - 42}" text-anchor="middle" fill="${glow}" font-size="12" letter-spacing="2" opacity="0.55">MINT ${esc(String(serial).slice(0, 8).toUpperCase())}·${fmt(actNumber)}</text>
</svg>`;
}
