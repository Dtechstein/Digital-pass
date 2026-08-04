/**
 * Digital Pass — Cloudflare Worker entry.
 * Step 1 spike: GET /v1/test-pass returns a signed static .pkpass.
 */

import { buildPkpass } from './pkpass.js';
import { makeTestPassJson } from './testpass.js';
import { PASS_IMAGES } from './assets.gen.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return json({ ok: true, service: 'digital-pass', step: 1 });
    }

    if (url.pathname === '/v1/test-pass') {
      const missing = ['APPLE_PASS_CERT_PEM', 'APPLE_PASS_KEY_PEM', 'APPLE_WWDR_PEM']
        .filter((k) => !env[k]);
      if (missing.length) {
        return json(
          { error: 'missing_secrets', missing, hint: 'npx wrangler secret put <NAME> --config worker/wrangler.toml' },
          500
        );
      }
      if (!env.APPLE_TEAM_ID || env.APPLE_TEAM_ID === 'REPLACE_ME') {
        return json({ error: 'set APPLE_TEAM_ID in worker/wrangler.toml [vars]' }, 500);
      }

      try {
        const serial = crypto.randomUUID();
        const passJson = makeTestPassJson(env, serial);
        const pkpass = buildPkpass(passJson, PASS_IMAGES, {
          certPem: env.APPLE_PASS_CERT_PEM,
          keyPem: env.APPLE_PASS_KEY_PEM,
          wwdrPem: env.APPLE_WWDR_PEM,
        });
        return new Response(pkpass, {
          headers: {
            'Content-Type': 'application/vnd.apple.pkpass',
            'Content-Disposition': 'attachment; filename="kindness-test.pkpass"',
            'Cache-Control': 'no-store',
          },
        });
      } catch (err) {
        return json({ error: 'signing_failed', message: String(err && err.message) }, 500);
      }
    }

    return json({ error: 'not_found' }, 404);
  },
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
