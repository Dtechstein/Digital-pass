/**
 * Digital Pass — Cloudflare Worker entry (step 4: the platform).
 *
 * Brand API (Authorization: Bearer <brand key>):
 *   POST  /v1/passes               create card (idempotent by externalId) → both wallet links
 *
 * Admin (X-Admin-Key):
 *   POST  /v1/brands               create brand → returns API key ONCE
 *   GET   /v1/brands               list brands
 *   GET   /v1/passes               list cards (+names, registrations, archived)
 *   GET   /v1/passes/{serial}      current state
 *   GET   /v1/passes/{serial}/log  event timeline
 *   GET   /v1/passes/{serial}/apple-link | /google-link
 *   PATCH /v1/passes/{serial}      fields/changeMessage → notify BOTH platforms
 *   POST  /v1/passes/{serial}?action=archive|unarchive
 *   DELETE /v1/passes/{serial}     privacy purge (X-Confirm-Purge: serial)
 *
 * Public:
 *   GET /admin                     admin UI     GET /health
 *   GET /v1/test-pass              mint legacy test card
 *   GET /v1/passes/{serial}/apple.pkpass?t=token   re-download existing card
 *
 * Apple PassKit web service (devices; ApplePass auth):
 *   POST/DELETE /v1/devices/{did}/registrations/{ptid}/{serial}
 *   GET  /v1/devices/{did}/registrations/{ptid}
 *   GET  /v1/passes/{ptid}/{serial}
 *   POST /v1/log
 *
 * Cron: fires due scheduled_messages (see platform.js).
 */

import { buildPkpass } from './pkpass.js';
import { buildPassJson, DEFAULT_FIELDS, resolveTemplate, mergeTemplate } from './template.js';
import { upsertObject, saveUrl } from './google.js';
import {
  brandFromBearer, sha256Hex, randomKey, logEvent, notifyAllPlatforms, runScheduler,
} from './platform.js';
import { appleThumbnails } from './images.js';
import { PASS_IMAGES } from './assets.gen.js';
import { ADMIN_HTML, BUILDER_HTML } from './admin.gen.js';
import { companionChat } from './companion.js';
import { renderCardPage, handleComplete } from './page.js';

export default {
  async fetch(request, env) {
    try {
      return await route(request, env);
    } catch (err) {
      console.log('unhandled_error', String(err && err.stack));
      return json({ error: 'internal', message: String(err && err.message) }, 500);
    }
  },
  async scheduled(event, env) {
    const n = await runScheduler(env);
    if (n) console.log('scheduler_tick', n, 'sent');
  },
};

async function route(request, env) {
  const url = new URL(request.url);
  const p = url.pathname.replace(/\/+$/, '');
  const seg = p.split('/').filter(Boolean);
  const m = request.method;

  if (p === '/health') return json({ ok: true, service: 'digital-pass', step: 4, db: !!env.DB });

  // ── admin UI + builder ───────────────────────────────────────
  if ((p === '/admin' || p === '') && m === 'GET') {
    return new Response(ADMIN_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }
  if (p === '/admin/builder' && m === 'GET') {
    return new Response(BUILDER_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }

  // ── mint a legacy test pass ──────────────────────────────────
  if (p === '/v1/test-pass' && m === 'GET') {
    const err = readiness(env);
    if (err) return err;
    const serial = crypto.randomUUID();
    const authToken = crypto.randomUUID().replace(/-/g, '');
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
      'INSERT INTO passes (serial, auth_token, fields_json, created_at, updated_at) VALUES (?,?,?,?,?)'
    ).bind(serial, authToken, JSON.stringify(DEFAULT_FIELDS), now, now).run();
    await logEvent(env, serial, 'created', { message: 'test card minted' });
    return servePkpass(env, { serial, authToken, fields: DEFAULT_FIELDS }, now);
  }

  // ── Brand API: create a card ─────────────────────────────────
  if (p === '/v1/passes' && m === 'POST') {
    const brand = await brandFromBearer(request, env);
    if (!brand) return json({ error: 'unauthorized', hint: 'Authorization: Bearer <brand API key>' }, 401);
    const body = await request.json().catch(() => null);
    if (!body || !body.externalId) return json({ error: 'bad_request', hint: 'externalId is required' }, 400);

    // idempotency: same (brand, externalId) → same card
    let pass = await env.DB.prepare(
      'SELECT * FROM passes WHERE brand_id=? AND external_id=?'
    ).bind(brand.id, body.externalId).first();
    let created = false;

    if (!pass) {
      const serial = crypto.randomUUID();
      const authToken = crypto.randomUUID().replace(/-/g, '');
      const now = Math.floor(Date.now() / 1000);
      const template = await resolveTemplate(env, { brand_id: brand.id });
      const fields = { ...template.defaults, ...(body.fields || {}) };
      if (body.photoUrl || body.imageUrl) fields.photoUrl = body.photoUrl || body.imageUrl;
      if (body.barcode) fields.barcode = body.barcode; // guest's photo page URL (QR + links)
      await env.DB.prepare(
        `INSERT INTO passes (serial, auth_token, fields_json, created_at, updated_at, brand_id, external_id)
         VALUES (?,?,?,?,?,?,?)`
      ).bind(serial, authToken, JSON.stringify(fields), now, now, brand.id, body.externalId).run();
      pass = { serial, auth_token: authToken, fields_json: JSON.stringify(fields) };
      created = true;

      // schedule: [{inMinutes | at (unix seconds or ISO), message}]
      for (const s of body.schedule || []) {
        let sendAt = null;
        if (s.inMinutes != null) sendAt = now + Math.round(Number(s.inMinutes) * 60);
        else if (typeof s.at === 'number') sendAt = Math.floor(s.at);
        else if (typeof s.at === 'string') sendAt = Math.floor(Date.parse(s.at) / 1000);
        if (sendAt && s.message) {
          await env.DB.prepare(
            'INSERT INTO scheduled_messages (serial, send_at, message) VALUES (?,?,?)'
          ).bind(serial, sendAt, String(s.message)).run();
        }
      }
      await logEvent(env, serial, 'created', {
        message: `via API by brand ${brand.id}` + ((body.schedule || []).length ? ` (+${body.schedule.length} scheduled)` : ''),
      });
    }

    // Google object (best effort)
    let googleSaveUrl = null;
    if (env.GOOGLE_SA_KEY_JSON) {
      try {
        const tpl = await resolveTemplate(env, { brand_id: brand.id });
        await upsertObject(env, pass.serial, JSON.parse(pass.fields_json), tpl, brand.id);
        googleSaveUrl = await saveUrl(env, pass.serial);
      } catch (e) {
        console.log('google_create_failed', String(e && e.message));
      }
    }

    return json({
      serial: pass.serial,
      created,
      appleUrl: `${env.BASE_URL}/v1/passes/${pass.serial}/apple.pkpass?t=${pass.auth_token}`,
      googleSaveUrl,
    }, created ? 201 : 200);
  }

  // ── Admin: brands ────────────────────────────────────────────
  if (p === '/v1/brands') {
    if (!adminOk(request, env)) return json({ error: 'unauthorized' }, 401);
    if (m === 'POST') {
      const body = await request.json().catch(() => null);
      if (!body || !body.id || !body.name) return json({ error: 'bad_request', hint: 'need {id, name}' }, 400);
      const key = randomKey(body.id);
      await env.DB.prepare(
        'INSERT INTO brands (id, name, api_key_hash, template_json, created_at) VALUES (?,?,?,?,?)'
      ).bind(body.id, body.name, await sha256Hex(key), JSON.stringify(body.template || {}), Math.floor(Date.now() / 1000)).run();
      return json({ ok: true, id: body.id, apiKey: key, note: 'Save this key now — it is never shown again.' }, 201);
    }
    if (m === 'GET') {
      const rows = await env.DB.prepare('SELECT id, name, created_at FROM brands').all();
      return json({ brands: rows.results || [] });
    }
  }

  // ── Admin: brand template read/write (the engine's editing surface) ──
  if (seg[0] === 'v1' && seg[1] === 'brands' && seg[3] === 'template') {
    if (!adminOk(request, env)) return json({ error: 'unauthorized' }, 401);
    const brand = await env.DB.prepare('SELECT * FROM brands WHERE id=?').bind(seg[2]).first();
    if (!brand) return json({ error: 'not_found' }, 404);
    let stored = {};
    try { stored = JSON.parse(brand.template_json || '{}'); } catch {}

    if (m === 'GET') {
      return json({ id: brand.id, template: stored, effective: mergeTemplate({ orgName: brand.name, ...stored }) });
    }
    if (m === 'PUT') {
      const body = await request.json().catch(() => null);
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return json({ error: 'bad_request', hint: 'PUT the template object' }, 400);
      }
      await env.DB.prepare('UPDATE brands SET template_json=? WHERE id=?')
        .bind(JSON.stringify(body), brand.id).run();
      return json({ ok: true, id: brand.id, effective: mergeTemplate({ orgName: brand.name, ...body }) });
    }
  }

  // ── Admin: the stories (consent-gated treasure) ──────────────
  if (p === '/v1/stories' && m === 'GET') {
    if (!adminOk(request, env)) return json({ error: 'unauthorized' }, 401);
    const rows = await env.DB.prepare(
      `SELECT s.serial, s.story, s.consent, s.consented_at, s.act_number, s.created_at, p.fields_json
       FROM act_stories s LEFT JOIN passes p ON p.serial = s.serial
       ORDER BY s.created_at DESC LIMIT 200`
    ).all();
    const stories = (rows.results || []).map((r) => {
      let who = '';
      try { const f = JSON.parse(r.fields_json || '{}'); who = f.guest || f.clientName || f.name || ''; } catch {}
      return { serial: r.serial, who, story: r.story, consent: !!r.consent, actNumber: r.act_number, createdAt: r.created_at };
    });
    return json({ stories });
  }

  // ── Admin: the builder's AI brain (Claude) ───────────────────
  if (p === '/v1/companion' && m === 'POST') {
    if (!adminOk(request, env)) return json({ error: 'unauthorized' }, 401);
    if (!env.ANTHROPIC_API_KEY) {
      return json({ error: 'no_brain', hint: 'Run: npx wrangler secret put ANTHROPIC_API_KEY' }, 503);
    }
    const body = await request.json().catch(() => null);
    if (!body || !body.message || !body.template) {
      return json({ error: 'bad_request', hint: 'message and template are required' }, 400);
    }
    try {
      return json(await companionChat(env, body));
    } catch (err) {
      console.log('companion_error', String(err && err.message));
      return json({ error: 'companion_failed', message: String(err && err.message) }, 502);
    }
  }

  // ── Public: THE HOSTED CARD PAGE (the card is the doorway) ───
  if (seg[0] === 'p' && seg.length >= 2) {
    const pass = await getPass(env, seg[1]);
    if (!pass || pass.archived_at) return new Response('This page has moved on. 💗', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });

    if (seg.length === 2 && m === 'GET') {
      const tpl = await resolveTemplate(env, pass);
      return new Response(await renderCardPage(env, pass, tpl), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
    if (seg[2] === 'complete' && m === 'POST') {
      const body = await request.json().catch(() => ({}));
      const r = await handleComplete(env, pass, body || {});
      return json(r.data, r.status);
    }
    if (seg[2] === 'google' && m === 'GET') {
      if (!env.GOOGLE_SA_KEY_JSON) return new Response('Google Wallet not configured', { status: 404 });
      try {
        const tpl = await resolveTemplate(env, pass);
        await upsertObject(env, pass.serial, JSON.parse(pass.fields_json), tpl, pass.brand_id);
        return Response.redirect(await saveUrl(env, pass.serial), 302);
      } catch (err) {
        return new Response('Google Wallet hiccup — try again in a minute', { status: 502 });
      }
    }
  }

  // ── Public: re-download existing card (token-gated) ──────────
  if (seg[0] === 'v1' && seg[1] === 'passes' && seg[3] === 'apple.pkpass' && m === 'GET') {
    const pass = await getPass(env, seg[2]);
    if (!pass) return new Response(null, { status: 404 });
    if (url.searchParams.get('t') !== pass.auth_token) return new Response(null, { status: 401 });
    return servePkpass(env, { serial: pass.serial, authToken: pass.auth_token, fields: JSON.parse(pass.fields_json) }, pass.updated_at, await resolveTemplate(env, pass));
  }

  // ── Admin: apple/google links + log (precede Apple 4-seg GET) ──
  if (seg[0] === 'v1' && seg[1] === 'passes' && seg.length === 4 && m === 'GET'
      && ['apple-link', 'google-link', 'log'].includes(seg[3])) {
    if (!adminOk(request, env)) return json({ error: 'unauthorized' }, 401);
    const pass = await getPass(env, seg[2]);
    if (!pass) return json({ error: 'not_found' }, 404);

    if (seg[3] === 'apple-link') {
      return json({ url: `${env.BASE_URL}/v1/passes/${pass.serial}/apple.pkpass?t=${pass.auth_token}` });
    }
    if (seg[3] === 'google-link') {
      if (!env.GOOGLE_SA_KEY_JSON) return json({ error: 'google_not_configured' }, 500);
      try {
        const tpl = await resolveTemplate(env, pass);
        await upsertObject(env, pass.serial, JSON.parse(pass.fields_json), tpl, pass.brand_id);
        return json({ saveUrl: await saveUrl(env, pass.serial) });
      } catch (err) {
        return json({ error: 'google_failed', message: String(err && err.message) }, 500);
      }
    }
    // log
    const rows = await env.DB.prepare(
      'SELECT at, kind, message, apple, google FROM update_log WHERE serial=? ORDER BY at DESC, id DESC LIMIT 50'
    ).bind(pass.serial).all();
    const sched = await env.DB.prepare(
      'SELECT send_at, message, sent_at FROM scheduled_messages WHERE serial=? ORDER BY send_at'
    ).bind(pass.serial).all();
    return json({ events: rows.results || [], scheduled: sched.results || [] });
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
      await env.DB.prepare('DELETE FROM apple_registrations WHERE device_id=? AND serial=?')
        .bind(deviceId, serial).run();
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
    return servePkpass(env, { serial: pass.serial, authToken: pass.auth_token, fields: JSON.parse(pass.fields_json) }, pass.updated_at, await resolveTemplate(env, pass));
  }

  // ── Apple web service: log ───────────────────────────────────
  if (p === '/v1/log' && m === 'POST') {
    const body = await request.json().catch(() => ({}));
    console.log('apple_log', JSON.stringify(body.logs || body));
    return new Response(null, { status: 200 });
  }

  // ── Admin: list / get / update / archive / purge ─────────────
  if (seg[0] === 'v1' && seg[1] === 'passes' && seg.length <= 3) {
    if (!adminOk(request, env)) return json({ error: 'unauthorized' }, 401);

    if (m === 'GET' && seg.length === 2) {
      const rows = await env.DB.prepare(
        `SELECT p.serial, p.fields_json, p.created_at, p.updated_at, p.archived_at, p.brand_id,
                (SELECT COUNT(*) FROM apple_registrations r WHERE r.serial = p.serial) AS registrations,
                (SELECT COUNT(*) FROM scheduled_messages s WHERE s.serial = p.serial AND s.sent_at IS NULL) AS pending_msgs
         FROM passes p ORDER BY p.created_at DESC LIMIT 100`
      ).all();
      const passes = (rows.results || []).map((r) => {
        let f = {};
        try { f = JSON.parse(r.fields_json); } catch {}
        return {
          serial: r.serial, guest: f.guest || null, event: f.event || null,
          brand: r.brand_id || 'love', created_at: r.created_at, updated_at: r.updated_at,
          archived_at: r.archived_at || null, registrations: r.registrations,
          pending_msgs: r.pending_msgs || 0,
        };
      });
      return json({ passes });
    }

    const serial = seg[2];
    const pass = serial && (await getPass(env, serial));
    if (!pass) return json({ error: 'not_found' }, 404);

    if (m === 'POST' && url.searchParams.get('action') === 'archive') {
      await env.DB.prepare('UPDATE passes SET archived_at=? WHERE serial=?')
        .bind(Math.floor(Date.now() / 1000), serial).run();
      return json({ ok: true, archived: serial });
    }
    if (m === 'POST' && url.searchParams.get('action') === 'unarchive') {
      await env.DB.prepare('UPDATE passes SET archived_at=NULL WHERE serial=?').bind(serial).run();
      return json({ ok: true, unarchived: serial });
    }

    if (m === 'DELETE') {
      if (request.headers.get('X-Confirm-Purge') !== serial) {
        return json({ error: 'purge_not_confirmed', hint: 'set X-Confirm-Purge: <serial>. For normal removal use ?action=archive.' }, 400);
      }
      await env.DB.prepare('DELETE FROM apple_registrations WHERE serial=?').bind(serial).run();
      await env.DB.prepare('DELETE FROM passes WHERE serial=?').bind(serial).run();
      return json({ ok: true, purged: serial });
    }

    if (m === 'GET') {
      return json({
        serial: pass.serial, fields: JSON.parse(pass.fields_json),
        created_at: pass.created_at, updated_at: pass.updated_at,
      });
    }

    if (m === 'PATCH') {
      const body = await request.json().catch(() => null);
      if (!body || (!body.fields && !body.changeMessage)) {
        return json({ error: 'bad_request', hint: 'send {fields} and/or {changeMessage}' }, 400);
      }
      const fields = { ...JSON.parse(pass.fields_json), ...(body.fields || {}) };
      if (body.changeMessage) fields.latest = body.changeMessage;
      const now = Math.floor(Date.now() / 1000);
      await env.DB.prepare('UPDATE passes SET fields_json=?, updated_at=? WHERE serial=?')
        .bind(JSON.stringify(fields), now, serial).run();

      const { pushed, google } = await notifyAllPlatforms(env, pass, fields, body.changeMessage);
      await logEvent(env, serial, body.changeMessage ? 'notified' : 'updated', {
        message: body.changeMessage || null, apple: `pushed:${pushed}`, google,
      });
      return json({ ok: true, serial, updated_at: now, pushed, google });
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
  if (!env.DB) return json({ error: 'no_d1_binding' }, 500);
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

async function servePkpass(env, passData, updatedAt, template) {
  passData = { ...passData, template };
  // generic style: no strip files in the bundle; photo = square thumbnail
  const images = Object.fromEntries(
    Object.entries(PASS_IMAGES).filter(([name]) => !name.startsWith('strip'))
  );
  if (passData.fields && passData.fields.photoUrl) {
    Object.assign(images, await appleThumbnails(passData.fields.photoUrl));
  }
  const pkpass = buildPkpass(buildPassJson(env, passData), images, {
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
