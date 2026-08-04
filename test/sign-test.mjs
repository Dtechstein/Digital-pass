/**
 * sign-test.mjs — proves the signing pipeline without real Apple certs.
 *
 * 1. Generates a throwaway self-signed cert (stands in for the pass cert;
 *    also reused as the "WWDR" placeholder — chain validity isn't testable
 *    without Apple, but signature integrity is).
 * 2. Builds the actual Kindness test .pkpass via worker/src code.
 * 3. Re-opens the zip, recomputes every manifest hash.
 * 4. Independently verifies the PKCS#7 signature with the openssl binary.
 *
 * Run: npm run test:sign
 */
import forge from 'node-forge';
import { unzipSync } from 'fflate';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { buildPkpass } from '../worker/src/pkpass.js';
import { makeTestPassJson } from '../worker/src/testpass.js';
import { PASS_IMAGES } from '../worker/src/assets.gen.js';

// ── 1. throwaway cert ──────────────────────────────────────────
console.log('• generating self-signed test certificate…');
const keys = forge.pki.rsa.generateKeyPair(2048);
const cert = forge.pki.createCertificate();
cert.publicKey = keys.publicKey;
cert.serialNumber = '01';
cert.validity.notBefore = new Date();
cert.validity.notAfter = new Date(Date.now() + 365 * 864e5);
const attrs = [
  { name: 'commonName', value: 'Pass Type ID: pass.test.digitalpass' },
  { name: 'organizationName', value: 'Digital Pass Test' },
];
cert.setSubject(attrs);
cert.setIssuer(attrs);
cert.sign(keys.privateKey, forge.md.sha256.create());

const creds = {
  certPem: forge.pki.certificateToPem(cert),
  keyPem: forge.pki.privateKeyToPem(keys.privateKey),
  wwdrPem: forge.pki.certificateToPem(cert), // placeholder chain
};

// ── 2. build the pkpass ────────────────────────────────────────
console.log('• building .pkpass…');
const env = { APPLE_PASS_TYPE_ID: 'pass.test.digitalpass', APPLE_TEAM_ID: 'TESTTEAM01', ORG_NAME: 'Test' };
const pkpass = buildPkpass(makeTestPassJson(env, 'serial-test-1'), PASS_IMAGES, creds);
console.log(`  ${pkpass.length} bytes`);

// ── 3. verify zip + manifest ───────────────────────────────────
const entries = unzipSync(pkpass);
const names = Object.keys(entries).sort();
console.log('• zip entries:', names.join(', '));

const required = ['pass.json', 'manifest.json', 'signature', 'icon.png'];
for (const r of required) {
  if (!entries[r]) throw new Error(`missing required entry: ${r}`);
}

const manifest = JSON.parse(Buffer.from(entries['manifest.json']).toString());
let hashOk = true;
for (const [name, expected] of Object.entries(manifest)) {
  const actual = createHash('sha1').update(entries[name]).digest('hex');
  if (actual !== expected) {
    hashOk = false;
    console.error(`  ✗ hash mismatch for ${name}`);
  }
}
if (!hashOk) throw new Error('manifest hash verification failed');
console.log(`• manifest: all ${Object.keys(manifest).length} hashes match ✓`);

// ── 4. independent signature check via openssl ─────────────────
const dir = mkdtempSync(join(tmpdir(), 'pkpass-'));
writeFileSync(join(dir, 'manifest.json'), entries['manifest.json']);
writeFileSync(join(dir, 'signature.der'), entries['signature']);
writeFileSync(join(dir, 'cert.pem'), creds.certPem);
try {
  execFileSync('openssl', [
    'smime', '-verify', '-inform', 'DER',
    '-in', join(dir, 'signature.der'),
    '-content', join(dir, 'manifest.json'),
    '-certfile', join(dir, 'cert.pem'),
    '-noverify', // skip chain validation (self-signed) — checks signature math only
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  console.log('• openssl smime verify: signature valid ✓');
} catch (e) {
  console.error(String(e.stderr));
  throw new Error('openssl signature verification FAILED');
}

writeFileSync(join(dir, 'test.pkpass'), pkpass);
console.log(`\nPASS — test bundle written to ${join(dir, 'test.pkpass')}`);
console.log('With real Apple certs, this same code path produces an iPhone-installable pass.');
