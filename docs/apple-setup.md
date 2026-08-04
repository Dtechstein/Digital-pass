# Apple setup — one-time, ~20 minutes

Everything here happens once per brand. You need: an Apple Developer account ($99/yr) and this repo cloned locally with `openssl` available (macOS has it built in).

## Step 0 — Generate your key + CSR (terminal)

```bash
bash scripts/make-csr.sh
```

This writes `secrets/pass-key.pem` (your private key — stays on your machine, `secrets/` is gitignored) and `secrets/pass.csr` (safe to upload).

## Step 1 — Create the Pass Type ID

1. Go to [developer.apple.com/account](https://developer.apple.com/account) → **Certificates, Identifiers & Profiles** → **Identifiers**.
2. Click **+**, choose **Pass Type IDs**, click Continue.
3. Description: `Kindness Card`. Identifier: `pass.com.allaboutlove.kindness` (must match `APPLE_PASS_TYPE_ID` in `worker/wrangler.toml`).
4. Register.

## Step 2 — Create the pass certificate

1. Still in the portal: **Identifiers** → filter to Pass Type IDs → click your new ID.
2. Click **Create Certificate**.
3. When asked for a Certificate Signing Request, upload `secrets/pass.csr` from Step 0.
4. Download the resulting `pass.cer` into `secrets/`.
5. Convert to PEM:

```bash
openssl x509 -inform DER -in secrets/pass.cer -out secrets/pass-cert.pem
```

## Step 3 — Get Apple's WWDR intermediate certificate

Passes are signed with your cert *plus* Apple's Worldwide Developer Relations intermediate (currently **G4**).

```bash
curl -o secrets/wwdr.cer https://www.apple.com/certificateauthority/AppleWWDRCAG4.cer
openssl x509 -inform DER -in secrets/wwdr.cer -out secrets/wwdr.pem
```

## Step 4 — Find your Team ID

Portal → **Membership details** → copy the 10-character Team ID. Put it in `worker/wrangler.toml` under `APPLE_TEAM_ID`.

## Step 5 — Store secrets in Cloudflare

```bash
npx wrangler secret put APPLE_PASS_CERT_PEM --config worker/wrangler.toml < secrets/pass-cert.pem
npx wrangler secret put APPLE_PASS_KEY_PEM  --config worker/wrangler.toml < secrets/pass-key.pem
npx wrangler secret put APPLE_WWDR_PEM      --config worker/wrangler.toml < secrets/wwdr.pem
```

## Step 6 — Deploy and add the card

```bash
npm run deploy
```

Open `https://<your-worker>.workers.dev/v1/test-pass` **in Safari on your iPhone** → Wallet opens → **Add**. A crimson Kindness test card should land in your Wallet.

---

**Later (build-order step 2, notifications):** create an **APNs auth key** (portal → Keys → + → Apple Push Notifications service), download the `.p8` once, note the Key ID. One key serves all brands.

**Certificate expiry:** pass certificates last ~1 year. Expired = existing passes keep working, but no new passes and no updates. Renewal = repeat Steps 2 and 5 (same key, new cert).
