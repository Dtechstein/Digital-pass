/**
 * google-jwt-test.mjs — proves the Google RS256 JWT signing without Google.
 * Generates an RSA keypair shaped like a service-account key, signs both the
 * OAuth assertion and a save-to-wallet JWT via worker/src/google.js, verifies
 * signatures + claims with node:crypto.
 * Run: node test/google-jwt-test.mjs
 */
import { generateKeyPairSync, verify as nodeVerify } from 'node:crypto';
import { signSaJwt } from '../worker/src/google.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const saJson = {
  client_email: 'pass-service@pass-service-504610.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
};

function check(name, jwt, expect) {
  const [h, p, s] = jwt.split('.');
  const header = JSON.parse(Buffer.from(h, 'base64url').toString());
  const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
  if (header.alg !== 'RS256') throw new Error(name + ': bad alg');
  for (const [k, v] of Object.entries(expect)) {
    if (JSON.stringify(payload[k]) !== JSON.stringify(v)) throw new Error(name + `: claim ${k} mismatch`);
  }
  const ok = nodeVerify('sha256', Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s, 'base64url'));
  if (!ok) throw new Error(name + ': signature FAILED');
  console.log(`• ${name}: claims + RS256 signature verify ✓`);
}

const now = Math.floor(Date.now() / 1000);

check('oauth assertion', await signSaJwt(saJson, {
  iss: saJson.client_email,
  scope: 'https://www.googleapis.com/auth/wallet_object.issuer',
  aud: 'https://oauth2.googleapis.com/token',
  iat: now, exp: now + 3600,
}), { iss: saJson.client_email, aud: 'https://oauth2.googleapis.com/token' });

check('save-to-wallet', await signSaJwt(saJson, {
  iss: saJson.client_email, aud: 'google', typ: 'savetowallet', iat: now,
  payload: { genericObjects: [{ id: '3388000000023184539.test-serial' }] },
}), { aud: 'google', typ: 'savetowallet' });

console.log('\nPASS');
