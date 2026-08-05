/**
 * Digital Pass — Cloudflare Worker entry (step 2: updates + notifications).
 *
 * Public/test:
 *   GET  /health
 *   GET  /v1/test-pass                      mint a new updatable Kindness test card
 *
 * Admin (X-Admin-Key header):
 *   GET   /v1/passes                        list passes + registration counts
 *   GET   /v1/passes/{serial}               current state
 *   PATCH /v1/passes/{serial}               {fields?, changeMessage?} → APNs push
 *
 * Apple PassKit web service (devices call these; ApplePass auth):
 *   POST   /v1/devices/{did}/registrations/{ptid}/{serial}   register (body: pushToken)
 *   DELETE /v1/devices/{did}/registrations/{ptid}/{serial}   unregister
 *   GET    /v1/devices/{did}/registrations/{ptid}[?passesUpdatedSince=ts]
 *   GET    /v1/passes/{ptid}/{serial}                        latest .pkpass
 *   POST   /v1/log
 */

import { buildPkpass } from './pkpass.js';
import { buildPassJson, DEFAULT_FIELDS } from './testpass.js';
import { pushPassUpdate } from './apns.js';
import { upsertObject, objectExists, addMessage, saveUrl } from './google.js';
import { PASS_IMAGES } from './assets.gen.js';
import { ADMIN_HTML } from './admin.gen.js';

export default {
  async fetch(request, env) {
    try {
      return await route(request, env);
    } catch (err) {
      console.log('unhandled_error', String(err && err.stack));
      return json({ error: 'internal', message: String(err && err.message) }, 500);
    }
  },
};

async function route(request, env) {
  const url = new URL(request.url);
  const p = url.pathname.replace(/\/+$/, '');
  const seg = p.split('/').filter(Boolean); // e.g. ['v1','passes','abc']
  const m = request.method;

  if (p === '/health') return json({ ok: true, service: 'digital-pass', step: 2, db: !!env.DB });

  // ── admin UI (ships inside the Worker) ───────────────────────
  if ((p === '/admin' || p === '') && m === 'GET') {
    return new Response(ADMIN_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }

  // ── mint a test pass ─────────────────────────────────────────
  if (p === '/v1/test-pass' && m === 'GET') {
    const err = readiness(env);
    if (err) return err;
    const serial = crypto.randomUUID();
    const authToken = crypto.randomUUID().replace(/-/g, ''); // 32 chars
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
      'INSERT INTO passes (serial, auth_token, fields_json, created_at, updated_at) VALUES (?,?,?,?,?)'
    ).bind(serial, authToken, JSON.stringify(DEFAULT_FIELDS), now, now).run();
    return servePkpass(env, { serial, authToken, fields: DEFAULT_FIELDS }, now);
  }

  // ── Apple web service: device registrations ──────────────────
  if (seg[0] === 'v1' && seg[1] === 'devices' && seg[3] === 'registrations') {
    const deviceId = seg[2];
    const passTypeId = seg[4];
    const serial = seg[5];
    if (passTypeId !== env.APPLE_PASS_TYPE_ID) return new Response(null, { status: 404 });

    if ((m === 'POST' || m === 'DELETE') && serial) {
      const pass = await getPass(env, serial);
      if (!pass) return new Response(null, { status: 404 });
      if (!appleAuthOk(request, pass)) return new Response(null, { status: 401 });

      if (m === 'POST') {
        const body = await request.json().catch(() => ({}));
        if (!body.pushToken) return new Response(null, { status: 400 });
        const existing = await env.DB.prepare(
          'SELECT 1 AS x FROM apple_registrations WHERE device_id=? AND serial=?'
        ).bind(deviceId, serial).first();
        await env.DB.prepare(
          'INSERT OR REPLACE INTO apple_registrations (device_id, serial, push_token, created_at) VALUES (?,?,?,?)'
        ).bind(deviceId, serial, body.pushToken, Math.floor(Date.now() / 1000)).run();
        console.log('device_registered', deviceId.slice(0, 8), serial.slice(0, 8));
        return new Response(null, { status: existing ? 200 : 201 });
      }
      // DELETE
      await env.DB.prepare(
        'DELETE FROM apple_registrations WHERE device_id=? AND serial=?'
      ).bind(deviceId, serial).run();
      return new Response(null, { status: 200 });
    }

    if (m === 'GET' && !serial) {
      const since = Number(url.searchParams.get('passesUpdatedSince') || 0);
      const rows = await env.DB.prepare(
        `SELECT p.serial, p.updated_at FROM passes p
         JOIN apple_registrations r ON r.serial = p.serial
         WHERE r.device_id = ? AND p.updated_at > ?`
      ).bind(deviceId, since).all();
      const results = rows.results || [];
      if (!results.length) return new Response(null, { status: 204 });
      const lastUpdated = String(Math.max(...results.map((r) => r.updated_at)));
      return json({ lastUpdated, serialNumbers: results.map((r) => r.serial) });
    }
  }

  // ── Public: re-download an existing card's .pkpass (token-gated) ──
  if (seg[0] === 'v1' && seg[1] === 'passes' && seg[3] === 'apple.pkpass' && m === 'GET') {
    const pass = await getPass(env, seg[2]);
    if (!pass) return new Response(null, { status: 404 });
    if (url.searchParams.get('t') !== pass.auth_token) return new Response(null, { status: 401 });
    return servePkpass(
      env,
      { serial: pass.serial, authToken: pass.auth_token, fields: JSON.parse(pass.fields_json) },
      pass.updated_at
    );
  }

  // ── Admin: Apple re-add link for an existing card ──────────────
  if (seg[0] === 'v1' && seg[1] === 'passes' && seg[3] === 'apple-link' && m === 'GET') {
    if (!adminOk(request, env)) return json({ error: 'unauthorized' }, 401);
    const pass = await getPass(env, seg[2]);
    if (!pass) return json({ error: 'not_found' }, 404);
    return json({ url: `${env.BASE_URL}/v1/passes/${pass.serial}/apple.pkpass?t=${pass.auth_token}` });
  }

  // ── Admin: Google Wallet save link (must precede Apple 4-seg GET) ──
  if (seg[0] === 'v1' && seg[1] === 'passes' && seg[3] === 'google-link' && m === 'GET') {
    if (!adminOk(request, env)) return json({ error: 'unauthorized' }, 401);
    if (!env.GOOGLE_SA_KEY_JSON) {
      return json({ error: 'google_not_configured', hint: 'npx wrangler secret put GOOGLE_SA_KEY_JSON --config worker/wrangler.toml < secrets/google-wallet-key.json' }, 500);
    }
    const pass = await getPass(env, seg[2]);
    if (!pass) return json({ error: 'not_found' }, 404);
    try {
      await upsertObject(env, pass.serial, JSON.parse(pass.fields_json));
      const url2 = await saveUrl(env, pass.serial);
      return json({ saveUrl: url2 });
    } catch (err) {
      return json({ error: 'google_failed', message: String(err && err.message) }, 500);
    }
  }

  // ── Apple web service: fetch latest pass ─────────────────────
  if (seg[0] === 'v1' && seg[1] === 'passes' && seg.length === 4 && m === 'GET') {
    const [, , passTypeId, serial] = seg;
    if (passTypeId !== env.APPLE_PASS_TYPE_ID) return new Response(null, { status: 404 });
    const pass = await getPass(env, serial);
    if (!pass) return new Response(null, { status: 404 });
    if (!appleAuthOk(request, pass)) return new Response(null, { status: 401 });

    const ims = request.headers.get('If-Modified-Since');
    if (ims && Math.floor(Date.parse(ims) / 1000) >= pass.updated_at) {
      return new Response(null, { status: 304 });
    }
    return servePkpass(
      env,
      { serial: pass.serial, authToken: pass.auth_token, fields: JSON.parse(pass.fields_json) },
      pass.updated_at
    );
  }

  // ── Apple web service: log ───────────────────────────────────
  if (p === '/v1/log' && m === 'POST') {
    const body = await request.json().catch(() => ({}));
    console.log('apple_log', JSON.stringify(body.logs || body));
    return new Response(null, { status: 200 });
  }

  // ── Admin: list / get / update ───────────────────────────────
  if (seg[0] === 'v1' && seg[1] === 'passes' && seg.length <= 3) {
    if (!adminOk(request, env)) return json({ error: 'unauthorized' }, 401);

    if (m === 'GET' && seg.length === 2) {
      const rows = await env.DB.prepare(
        `SELECT p.serial, p.fields_json, p.created_at, p.updated_at, p.archived_at,
                (SELECT COUNT(*) FROM apple_registrations r WHERE r.serial = p.serial) AS registrations
         FROM passes p ORDER BY p.created_at DESC LIMIT 100`
      ).all();
      const passes = (rows.results || []).map((r) => {
        let f = {};
        try { f = JSON.parse(r.fields_json); } catch {}
        return {
          serial: r.serial,
          guest: f.guest || null,
          event: f.event || null,
          created_at: r.created_at,
          updated_at: r.updated_at,
          archived_at: r.archived_at || null,
          registrations: r.registrations,
        };
      });
      return json({ passes });
    }

    const serial = seg[2];
    const pass = serial && (await getPass(env, serial));
    if (!pass) return json({ error: 'not_found' }, 404);

    if (m === 'GET') {
      return json({
        serial: pass.serial,
        fields: JSON.parse(pass.fields_json),
        created_at: pass.created_at,
        updated_at: pass.updated_at,
      });
    }

    // Archive / unarchive: data is NEVER destroyed. Archived cards still
    // serve updates to installed devices; they're just hidden from the
    // default admin list.
    if (m === 'POST' && url.searchParams.get('action') === 'archive') {
      await env.DB.prepare('UPDATE passes SET archived_at=? WHERE serial=?')
        .bind(Math.floor(Date.now() / 1000), serial).run();
      return json({ ok: true, archived: serial });
    }
    if (m === 'POST' && url.searchParams.get('action') === 'unarchive') {
      await env.DB.prepare('UPDATE passes SET archived_at=NULL WHERE serial=?').bind(serial).run();
      return json({ ok: true, unarchived: serial });
    }

    // Privacy purge (GDPR right-to-erasure) — deliberately API-only, no UI
    // button. Requires echoing the serial in X-Confirm-Purge to prevent
    // accidents. This is the ONLY true deletion path.
    if (m === 'DELETE') {
      if (request.headers.get('X-Confirm-Purge') !== serial) {
        return json({ error: 'purge_not_confirmed', hint: 'set X-Confirm-Purge: <serial>. For normal removal use ?action=archive.' }, 400);
      }
      await env.DB.prepare('DELETE FROM apple_registrations WHERE serial=?').bind(serial).run();
      await env.DB.prepare('DELETE FROM passes WHERE serial=?').bind(serial).run();
      return json({ ok: true, purged: serial });
    }

    if (m === 'PATCH') {
      const body = await request.json().catch(() => null);
      if (!body || (!body.fields && !body.changeMessage)) {
        return json({ error: 'bad_request', hint: 'send {fields} and/or {changeMessage}' }, 400);
      }
      const fields = { ...JSON.parse(pass.fields_json), ...(body.fields || {}) };
      if (body.changeMessage) fields.latest = body.changeMessage; // → lock-screen text
      const now = Math.floor(Date.now() / 1000);
      await env.DB.prepare('UPDATE passes SET fields_json=?, updated_at=? WHERE serial=?')
        .bind(JSON.stringify(fields), now, serial).run();

      // push to every registered device
      const regs = await env.DB.prepare(
        'SELECT device_id, push_token FROM apple_registrations WHERE serial=?'
      ).bind(serial).all();
      const results = [];
      for (const r of regs.results || []) {
        const res = await pushPassUpdate(env, r.push_token);
        results.push({ device: r.device_id.slice(0, 8), status: res.status });
        if (res.gone) {
          await env.DB.prepare(
            'DELETE FROM apple_registrations WHERE device_id=? AND serial=?'
          ).bind(r.device_id, serial).run();
        }
      }

      // Mirror to Google Wallet if this card has an object there
      let google = 'not_configured';
      if (env.GOOGLE_SA_KEY_JSON) {
        try {
          if (await objectExists(env, serial)) {
            await upsertObject(env, serial, fields);
            google = 'updated';
            if (body.changeMessage) {
              const msg = await addMessage(env, serial, body.changeMessage);
              google = msg.ok ? 'updated+notified' : `updated (notify ${msg.status})`;
            }
          } else {
            google = 'no_object';
          }
        } catch (err) {
          google = 'error: ' + String(err && err.message).slice(0, 120);
        }
      }
      return json({ ok: true, serial, updated_at: now, pushed: results.length, results, google });
    }
  }

  return json({ error: 'not_found' }, 404);
}

// ── helpers ────────────────────────────────────────────────────
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function readiness(env) {
  const missing = ['APPLE_PASS_CERT_PEM', 'APPLE_PASS_KEY_PEM', 'APPLE_WWDR_PEM'].filter((k) => !env[k]);
  if (missing.length) return json({ error: 'missing_secrets', missing }, 500);
  if (!env.DB) return json({ error: 'no_d1_binding', hint: 'npx wrangler d1 create digital-pass, set id in wrangler.toml, apply worker/schema.sql' }, 500);
  if (!env.BASE_URL || env.BASE_URL.includes('REPLACE')) return json({ error: 'set BASE_URL in wrangler.toml [vars]' }, 500);
  return null;
}

async function getPass(env, serial) {
  return env.DB.prepare('SELECT * FROM passes WHERE serial=?').bind(serial).first();
}

function appleAuthOk(request, pass) {
  const h = request.headers.get('Authorization') || '';
  return h === `ApplePass ${pass.auth_token}`;
}

function adminOk(request, env) {
  return env.ADMIN_KEY && request.headers.get('X-Admin-Key') === env.ADMIN_KEY;
}

function servePkpass(env, passData, updatedAt) {
  const pkpass = buildPkpass(buildPassJson(env, passData), PASS_IMAGES, {
    certPem: env.APPLE_PASS_CERT_PEM,
    keyPem: env.APPLE_PASS_KEY_PEM,
    wwdrPem: env.APPLE_WWDR_PEM,
  });
  return new Response(pkpass, {
    headers: {
      'Content-Type': 'application/vnd.apple.pkpass',
      'Content-Disposition': 'attachment; filename="kindness.pkpass"',
      'Last-Modified': new Date(updatedAt * 1000).toUTCString(),
      'Cache-Control': 'no-store',
    },
  });
}
