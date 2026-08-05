/**
 * apns-jwt-test.mjs — proves the APNs ES256 JWT without Apple.
 * Generates a P-256 keypair, builds the JWT via worker/src/apns.js,
 * then verifies signature + claims with node:crypto.
 * Run: node test/apns-jwt-test.mjs
 */
import { generateKeyPairSync, verify as nodeVerify } from 'node:crypto';
import { apnsJwt } from '../worker/src/apns.js';

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const p8pem = privateKey.export({ type: 'pkcs8', format: 'pem' });

const env = { APNS_KEY_PEM: p8pem, APNS_KEY_ID: 'TESTKEY123', APPLE_TEAM_ID: '67K25P7L5H' };
const jwt = await apnsJwt(env, Math.floor(Date.now() / 1000));

const [h, p, s] = jwt.split('.');
const header = JSON.parse(Buffer.from(h, 'base64url').toString());
const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
console.log('• header:', JSON.stringify(header));
console.log('• payload:', JSON.stringify(payload));

if (header.alg !== 'ES256' || header.kid !== 'TESTKEY123') throw new Error('bad header');
if (payload.iss !== '67K25P7L5H' || !payload.iat) throw new Error('bad payload');

const ok = nodeVerify(
  'sha256',
  Buffer.from(`${h}.${p}`),
  { key: publicKey, dsaEncoding: 'ieee-p1363' },
  Buffer.from(s, 'base64url')
);
if (!ok) throw new Error('signature verification FAILED');
console.log('• ES256 signature verifies with node:crypto ✓\n\nPASS');
