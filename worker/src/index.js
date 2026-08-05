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
import { PASS_IMAGES } from './assets.gen.js';

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
    const serial = seg[6];
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
        `SELECT p.serial, p.created_at, p.updated_at,
                (SELECT COUNT(*) FROM apple_registrations r WHERE r.serial = p.serial) AS registrations
         FROM passes p ORDER BY p.created_at DESC LIMIT 50`
      ).all();
      return json({ passes: rows.results || [] });
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
      return json({ ok: true, serial, updated_at: now, pushed: results.length, results });
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
