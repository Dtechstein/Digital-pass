/**
 * page-test.mjs — hosted page + completion flow regression.
 * 1. Page renders every section from a real pass (hero, promise, story box, wallet CTAs).
 * 2. Completion: act number assigned, card fields celebrate, consent recorded.
 * 3. Once per card enforced (409 on second attempt).
 * 4. Consent without a story is meaningless (privacy-safe default).
 * Run: node test/page-test.mjs
 */
import { renderCardPage, handleComplete } from '../worker/src/page.js';
import { DEFAULT_TEMPLATE } from '../worker/src/template.js';

const rows = []; let updated = null;
const db = { prepare(q) { return { bind(...a) { return {
  async first() { if (q.includes('act_stories') && q.includes('SELECT * ')) return rows[0] || null; if (q.includes('COUNT')) return { n: rows.length }; return null; },
  async run() { if (q.startsWith('INSERT')) rows.push({ serial: a[0], story: a[1], consent: a[3], act_number: a[5] }); if (q.startsWith('UPDATE passes')) updated = a[0]; return {}; },
  async all() { return { results: [] }; },
}; }, async first() { if (q.includes('COUNT')) return { n: rows.length }; return null; } }; } };

const env = { DB: db, BASE_URL: 'https://x.test', MOVEMENT_BASE: '251442' };
const pass = { serial: 's1', auth_token: 'tok', fields_json: JSON.stringify({
  guest: 'Sarah', promise: 'I promised an act of kindness', due: 'Aug 12', event: 'Rivera Wedding',
  acts: '0', movement: 'Act #247,801 of one million', photoUrl: 'https://pic.test/p.jpg', latest: 'hi',
}) };

const html = await renderCardPage(env, pass, DEFAULT_TEMPLATE);
for (const c of ['Sarah', 'Rivera Wedding', 'I promised an act', 'apple.pkpass?t=tok', 'storyBox', 'consentBox', 'THE MOVEMENT', 'Share']) {
  if (!html.includes(c)) throw new Error('page missing: ' + c);
}
console.log('• page renders with all sections ✓');

const r1 = await handleComplete(env, pass, { story: "I paid for a stranger's coffee", consent: true });
if (r1.status !== 200 || r1.data.actNumber !== 251443 || !r1.data.consent) throw new Error('complete failed');
const nf = JSON.parse(updated);
if (nf.acts !== '1' || !nf.latest.includes('251,443') || !nf.promise.includes('completed')) throw new Error('fields not celebrated');
console.log('• completion celebrates the card ✓');

const r2 = await handleComplete(env, pass, { story: 'again' });
if (r2.status !== 409) throw new Error('double-complete not blocked');
console.log('• once-per-card enforced ✓');

rows.length = 0;
const r3 = await handleComplete(env, pass, { story: '', consent: true });
if (r3.data.consent !== false) throw new Error('consent without story should not count');
console.log('• consent means nothing without a story ✓');

console.log('\nPASS — the doorway opens: page, celebration, privacy all hold.');
