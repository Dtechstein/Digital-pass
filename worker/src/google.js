/**
 * google.js — Google Wallet integration (step 3).
 *
 * Auth: service-account JWT (RS256 via WebCrypto) → OAuth token exchange.
 * Passes: generic class (one per brand, lazily ensured) + generic object per
 * card. "Save to Google Wallet" = signed JWT link. Notifications = addMessage
 * (limit ≈3/card/day). Demo mode: saves work for console admins/test users
 * until publishing access is granted.
 */

import { googleHeroUrl } from './images.js';
import { DEFAULT_TEMPLATE, googleView, withPageLink } from './template.js';

const WALLET_API = 'https://walletobjects.googleapis.com/walletobjects/v1';
const SCOPE = 'https://www.googleapis.com/auth/wallet_object.issuer';
const encoder = new TextEncoder();
let tokenCache = { token: null, exp: 0 };

/* ── crypto helpers ── */
function b64url(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlJson(obj) { return b64url(encoder.encode(JSON.stringify(obj))); }
function pemToPkcs8(pem) {
  const body = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const bin = atob(body);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8.buffer;
}

async function importSaKey(saJson) {
  return crypto.subtle.importKey(
    'pkcs8', pemToPkcs8(saJson.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['sign']
  );
}

/** Sign an RS256 JWT with the service-account key. */
export async function signSaJwt(saJson, claims) {
  const key = await importSaKey(saJson);
  const input = `${b64urlJson({ alg: 'RS256', typ: 'JWT' })}.${b64urlJson(claims)}`;
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, encoder.encode(input));
  return `${input}.${b64url(new Uint8Array(sig))}`;
}

function sa(env) {
  return JSON.parse(env.GOOGLE_SA_KEY_JSON);
}

/** OAuth access token for the Wallet API (cached ~50 min). */
export async function googleAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (tokenCache.token && now < tokenCache.exp - 300) return tokenCache.token;
  const saJson = sa(env);
  const jwt = await signSaJwt(saJson, {
    iss: saJson.client_email,
    scope: SCOPE,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  });
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${jwt}`,
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('google_token_failed: ' + JSON.stringify(data));
  tokenCache = { token: data.access_token, exp: now + (data.expires_in || 3600) };
  return tokenCache.token;
}

async function api(env, method, path, body) {
  const token = await googleAccessToken(env);
  const res = await fetch(WALLET_API + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

/* ── class (one per brand) ── */
function classId(env, brandId) {
  // brand 'love' (and legacy cards) keep the original class so existing
  // Android cards aren't orphaned; other brands get their own.
  if (!brandId || brandId === 'love') return `${env.GOOGLE_ISSUER_ID}.kindness_love`;
  return `${env.GOOGLE_ISSUER_ID}.${brandId}`;
}

export async function ensureClass(env, brandId) {
  const id = classId(env, brandId);
  const r = await api(env, 'GET', `/genericClass/${id}`);
  if (r.status === 200) return { ok: true, existed: true };
  const c = await api(env, 'POST', '/genericClass', { id });
  if (c.status === 200 || c.status === 409) return { ok: true, existed: c.status === 409 };
  throw new Error(`google_class_failed ${c.status}: ${c.text.slice(0, 300)}`);
}

/* ── object (one per card) ── */
function objectId(env, serial) {
  // Google object ids allow [a-zA-Z0-9._-]; our serials are UUIDs (fine).
  return `${env.GOOGLE_ISSUER_ID}.${serial}`;
}

function objectPayload(env, serial, f, template, brandId) {
  const t = template || DEFAULT_TEMPLATE;
  f = withPageLink(env, serial, f);
  const v = googleView(t, f);
  const hero = f.photoUrl ? { heroImage: { sourceUri: { uri: googleHeroUrl(f.photoUrl) } } } : {};
  const payload = {
    ...hero,
    id: objectId(env, serial),
    classId: classId(env, brandId),
    state: 'ACTIVE',
    cardTitle: { defaultValue: { language: 'en-US', value: v.cardTitle } },
    header: { defaultValue: { language: 'en-US', value: v.header } },
    hexBackgroundColor: v.hexBackgroundColor,
    textModulesData: v.textModules,
  };
  if (v.subheader) payload.subheader = { defaultValue: { language: 'en-US', value: v.subheader } };
  if (v.barcode) {
    payload.linksModuleData = {
      uris: [{ id: 'album', uri: v.barcode, description: 'Your photo — view, share, download' }],
    };
    payload.barcode = { type: 'QR_CODE', value: v.barcode, alternateText: v.barcodeAlt };
  }
  return payload;
}

/** Create or update the object for a card. */
export async function upsertObject(env, serial, fields, template, brandId) {
  await ensureClass(env, brandId);
  const payload = objectPayload(env, serial, fields, template, brandId);
  const existing = await api(env, 'GET', `/genericObject/${objectId(env, serial)}`);
  if (existing.status === 200) {
    const r = await api(env, 'PUT', `/genericObject/${objectId(env, serial)}`, payload);
    if (r.status !== 200) throw new Error(`google_object_update_failed ${r.status}: ${r.text.slice(0, 300)}`);
    return { ok: true, created: false };
  }
  const r = await api(env, 'POST', '/genericObject', payload);
  if (r.status !== 200 && r.status !== 409) {
    throw new Error(`google_object_create_failed ${r.status}: ${r.text.slice(0, 300)}`);
  }
  return { ok: true, created: r.status === 200 };
}

/** True if a Google object exists for this card (used to mirror PATCHes). */
export async function objectExists(env, serial) {
  const r = await api(env, 'GET', `/genericObject/${objectId(env, serial)}`);
  return r.status === 200;
}

/** Notification: message appears on the card; Android may surface a push. ≈3/day limit. */
export async function addMessage(env, serial, message, template) {
  const r = await api(env, 'POST', `/genericObject/${objectId(env, serial)}/addMessage`, {
    message: {
      header: (template && template.orgName) || env.ORG_NAME || 'All About Love',
      body: message,
      messageType: 'TEXT_AND_NOTIFY',
    },
  });
  return { ok: r.status === 200, status: r.status };
}

/** Signed "Save to Google Wallet" URL for a card's object. */
export async function saveUrl(env, serial) {
  const saJson = sa(env);
  const now = Math.floor(Date.now() / 1000);
  const jwt = await signSaJwt(saJson, {
    iss: saJson.client_email,
    aud: 'google',
    typ: 'savetowallet',
    iat: now,
    payload: { genericObjects: [{ id: objectId(env, serial) }] },
  });
  return `https://pay.google.com/gp/v/save/${jwt}`;
}
