/**
 * apns.js — Apple Push Notification service client for pass updates.
 * Pure WebCrypto: ES256 JWT signed with the APNs auth key (p8), cached ~50 min.
 * A pass-update push is an empty {"aps":{}} payload to the pass's push token,
 * with apns-topic = the pass type identifier.
 */

const encoder = new TextEncoder();
let jwtCache = { token: null, iat: 0 };

function b64url(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pemToPkcs8(pem) {
  const body = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const bin = atob(body);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8.buffer;
}

/** Build (or reuse) the ES256 provider JWT. */
export async function apnsJwt(env, nowSeconds) {
  const now = nowSeconds ?? Math.floor(Date.now() / 1000);
  if (jwtCache.token && now - jwtCache.iat < 3000) return jwtCache.token; // <50 min old

  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToPkcs8(env.APNS_KEY_PEM),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );

  const header = b64url(encoder.encode(JSON.stringify({ alg: 'ES256', kid: env.APNS_KEY_ID })));
  const payload = b64url(encoder.encode(JSON.stringify({ iss: env.APPLE_TEAM_ID, iat: now })));
  const signingInput = `${header}.${payload}`;
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    encoder.encode(signingInput)
  );
  const token = `${signingInput}.${b64url(new Uint8Array(sig))}`;
  jwtCache = { token, iat: now };
  return token;
}

/**
 * Push "this pass changed" to one device.
 * @returns {{ok: boolean, status: number, gone: boolean}} gone=true → token invalid, delete registration
 */
export async function pushPassUpdate(env, pushToken) {
  const jwt = await apnsJwt(env);
  const res = await fetch(`https://api.push.apple.com/3/device/${pushToken}`, {
    method: 'POST',
    headers: {
      authorization: `bearer ${jwt}`,
      'apns-topic': env.APPLE_PASS_TYPE_ID,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'content-type': 'application/json',
    },
    body: '{"aps":{}}',
  });
  return { ok: res.status === 200, status: res.status, gone: res.status === 410 };
}
