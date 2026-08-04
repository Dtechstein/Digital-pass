# Digital Pass

Self-deployed Apple & Google Wallet pass service. Your Cloudflare account, your Apple certificate, your pass type ID — **you own your passes**, and nothing breaks if any vendor (including us) disappears.

Wallet passes are the only way to put reminders on a user's lock screen without an app, a phone number, or an email open. This service makes that a simple API for any product.

## Layout

```
worker/   Cloudflare Worker backend — signing, PassKit web service, APNs, Google Wallet, D1
admin/    Companion builder UI (ships inside the Worker at /admin)
cli/      Setup wizard (npx create-pass-service) — scaffolds, guides certs, deploys
docs/     Setup guides
scripts/  Key/CSR generation, asset embedding
test/     Local verification (runs without real Apple certs)
assets/   Pass images (embedded into the Worker at build time)
```

## Status: build-order step 1 — .pkpass signing spike ✅ (code-verified)

Pure-JS signing (node-forge + fflate, no filesystem, no OpenSSL binary) proven locally:
manifest hashes verified, PKCS#7 detached signature independently confirmed via `openssl smime`.

```bash
npm install
npm run test:sign     # builds + verifies a .pkpass with a throwaway self-signed cert
```

**Next:** real Apple certs (see [docs/apple-setup.md](docs/apple-setup.md), ~20 min), then `npm run deploy`, then open `/v1/test-pass` on an iPhone → card lands in Wallet. That completes step 1 for real.

## Build order

1. ✅ Prove .pkpass signing on Workers (static pass → iPhone)
2. Apple web-service endpoints + APNs → field update produces a lock-screen notification
3. Google generic pass class + save link + `addMessage` notification
4. Multi-brand config + API keys + D1 persistence
5. Integrate All About Love (Kindness Card)
6. Onboard Binah, ADAM
7. Productize: companion builder, CLI wizard, packaging

Full context lives in the project brief (Claude project "Digital Pass").
