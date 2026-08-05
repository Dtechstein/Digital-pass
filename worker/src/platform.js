/**
 * platform.js — brands, creation API helpers, scheduler, message log (step 4).
 */

import { pushPassUpdate } from './apns.js';
import { upsertObject, objectExists, addMessage } from './google.js';
import { resolveTemplate } from './template.js';

const encoder = new TextEncoder();

/* ── crypto ── */
export async function sha256Hex(s) {
  const d = await crypto.subtle.digest('SHA-256', encoder.encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function randomKey(prefix) {
  const u8 = crypto.getRandomValues(new Uint8Array(24));
  const s = [...u8].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${prefix}_${s}`;
}

/* ── brand auth ── */
export async function brandFromBearer(request, env) {
  const h = request.headers.get('Authorization') || '';
  if (!h.startsWith('Bearer ')) return null;
  const hash = await sha256Hex(h.slice(7).trim());
  return env.DB.prepare('SELECT * FROM brands WHERE api_key_hash=?').bind(hash).first();
}

/* ── message log ── */
export async function logEvent(env, serial, kind, { message = null, apple = null, google = null } = {}) {
  try {
    await env.DB.prepare(
      'INSERT INTO update_log (serial, at, kind, message, apple, google) VALUES (?,?,?,?,?,?)'
    ).bind(serial, Math.floor(Date.now() / 1000), kind, message, apple, google).run();
  } catch (e) {
    console.log('log_event_failed', String(e && e.message)); // table may pre-date migration 003
  }
}

/* ── shared notify path (used by PATCH and the scheduler) ── */
export async function notifyAllPlatforms(env, pass, fields, changeMessage) {
  // Apple: push every registered device
  const regs = await env.DB.prepare(
    'SELECT device_id, push_token FROM apple_registrations WHERE serial=?'
  ).bind(pass.serial).all();
  let pushed = 0;
  for (const r of regs.results || []) {
    const res = await pushPassUpdate(env, r.push_token);
    if (res.ok) pushed++;
    if (res.gone) {
      await env.DB.prepare('DELETE FROM apple_registrations WHERE device_id=? AND serial=?')
        .bind(r.device_id, pass.serial).run();
    }
  }

  // Google: mirror if an object exists
  let google = 'not_configured';
  if (env.GOOGLE_SA_KEY_JSON) {
    try {
      if (await objectExists(env, pass.serial)) {
        const template = await resolveTemplate(env, pass);
        await upsertObject(env, pass.serial, fields, template, pass.brand_id);
        google = 'updated';
        if (changeMessage) {
          const msg = await addMessage(env, pass.serial, changeMessage, template);
          google = msg.ok ? 'updated+notified' : `updated (notify ${msg.status})`;
        }
      } else {
        google = 'no_object';
      }
    } catch (err) {
      google = 'error: ' + String(err && err.message).slice(0, 120);
    }
  }
  return { pushed, google };
}

/* ── scheduler tick (cron) ── */
export async function runScheduler(env) {
  const now = Math.floor(Date.now() / 1000);
  const due = await env.DB.prepare(
    'SELECT * FROM scheduled_messages WHERE sent_at IS NULL AND send_at <= ? ORDER BY send_at LIMIT 20'
  ).bind(now).all();

  for (const item of due.results || []) {
    const pass = await env.DB.prepare('SELECT * FROM passes WHERE serial=?').bind(item.serial).first();
    if (!pass) {
      await env.DB.prepare('UPDATE scheduled_messages SET sent_at=? WHERE id=?').bind(now, item.id).run();
      continue;
    }
    const fields = { ...JSON.parse(pass.fields_json), latest: item.message };
    await env.DB.prepare('UPDATE passes SET fields_json=?, updated_at=? WHERE serial=?')
      .bind(JSON.stringify(fields), now, pass.serial).run();
    const { pushed, google } = await notifyAllPlatforms(env, pass, fields, item.message);
    await env.DB.prepare('UPDATE scheduled_messages SET sent_at=? WHERE id=?').bind(now, item.id).run();
    await logEvent(env, pass.serial, 'scheduled_sent', {
      message: item.message, apple: `pushed:${pushed}`, google,
    });
    console.log('scheduled_sent', pass.serial.slice(0, 8), item.message.slice(0, 40));
  }
  return (due.results || []).length;
}
