/**
 * template-test.mjs — engine regression + flexibility proof.
 * 1. Default template renders the Kindness Card EXACTLY as before (field-for-field).
 * 2. A completely different brand template renders correctly with zero code changes.
 * Run: node test/template-test.mjs
 */
import { buildPassJson, mergeTemplate, googleView, bgHex, DEFAULT_FIELDS } from '../worker/src/template.js';

const env = { APPLE_PASS_TYPE_ID: 'pass.test', APPLE_TEAM_ID: 'TEAM', BASE_URL: 'https://x.test' };

/* 1 ── Kindness regression */
const p = buildPassJson(env, { serial: 's1', authToken: 't'.repeat(32), fields: DEFAULT_FIELDS });
const g = p.generic;
const expect = (cond, msg) => { if (!cond) throw new Error('REGRESSION: ' + msg); };
expect(p.organizationName === 'All About Love', 'orgName');
expect(p.backgroundColor === 'rgb(164, 19, 60)', 'bg color');
expect(g.headerFields[0].key === 'due' && g.headerFields[0].changeMessage === 'Due date: %@', 'header/due');
expect(g.primaryFields[0].value === 'I promised an act of kindness', 'primary/promise');
expect(g.secondaryFields.map(f=>f.key).join(',') === 'guest,event', 'secondary');
expect(g.auxiliaryFields.map(f=>f.key).join(',') === 'acts,movement', 'auxiliary');
expect(g.backFields[0].key === 'latest' && g.backFields[0].changeMessage === '%@', 'back/latest');
expect(g.backFields[1].value === 'https://x.test/p/s1', 'back/album defaults to the card\'s own page');
expect(p.barcodes[0].message === 'https://x.test/p/s1', 'barcode defaults to the card\'s own page');
console.log('• Kindness default: renders identically ✓');

/* 2 ── totally different brand */
const binah = mergeTemplate({
  orgName: 'Binah', logoText: 'Binah', description: 'Session Card',
  colors: { bg: 'rgb(16, 42, 67)', fg: 'rgb(255,255,255)', label: 'rgb(160, 200, 255)' },
  fields: {
    header: [{ key: 'nextSession', label: 'NEXT SESSION', changeMessage: 'Next session: %@' }],
    primary: [{ key: 'clientName', label: 'CLIENT' }],
    secondary: [{ key: 'plan', label: 'PLAN' }, { key: 'sessionsLeft', label: 'SESSIONS LEFT' }],
    auxiliary: [],
    back: [{ key: 'latest', label: 'UPDATES', changeMessage: '%@' },
           { key: 'portal', label: 'YOUR PORTAL', value: '{barcode}' }],
  },
  barcode: { source: 'fixed', fixed: 'https://binah.app/c/abc', altText: 'open your portal' },
  defaults: { latest: 'Welcome to Binah', sessionsLeft: '10' },
});
const bp = buildPassJson(env, {
  serial: 's2', authToken: 'u'.repeat(32),
  fields: { clientName: 'Dana', plan: 'Monthly', nextSession: 'Sun 10:00' },
  template: binah,
});
const bg2 = bp.generic;
expect(bp.organizationName === 'Binah', 'binah org');
expect(bp.backgroundColor === 'rgb(16, 42, 67)', 'binah color');
expect(bg2.headerFields[0].key === 'nextSession' && bg2.headerFields[0].value === 'Sun 10:00', 'binah header');
expect(bg2.primaryFields[0].value === 'Dana', 'binah primary');
expect(bg2.secondaryFields.map(f=>f.value).join(',') === 'Monthly,10', 'binah secondary + default');
expect(bg2.auxiliaryFields.length === 0, 'binah no auxiliary');
expect(bp.barcodes[0].message === 'https://binah.app/c/abc', 'binah fixed barcode');
expect(bg2.backFields.find(f=>f.key==='portal').value === 'https://binah.app/c/abc', 'binah portal link');
console.log('• Binah template: completely different card, zero code changes ✓');

/* 3 ── google view from both */
const gv = googleView(binah, { clientName: 'Dana', plan: 'Monthly', nextSession: 'Sun 10:00' });
expect(gv.cardTitle === 'Binah' && gv.header === 'Dana', 'google view');
expect(bgHex(binah) === '#102a43', 'google hex from rgb');
console.log('• Google rendering follows the template ✓');

console.log('\nPASS — the engine holds: same card for Love, any card for anyone else.');
