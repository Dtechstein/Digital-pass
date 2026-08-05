# Step 2 deploy — updates & lock-screen notifications (~10 min)

Prereq: the APNs auth key (`.p8`) downloaded from the portal into `secrets/`, and its 10-char Key ID.

All commands run from the `Digital-pass` folder.

## 1. Create the database

```bash
npx wrangler d1 create digital-pass
```

Copy the `database_id` from the output, then wire it and your APNs Key ID into the config
(replace the two placeholders with your real values):

```bash
sed -i '' 's/REPLACE_DATABASE_ID/PASTE-DATABASE-ID-HERE/' worker/wrangler.toml
sed -i '' 's/REPLACE_KEY_ID/PASTE-KEY-ID-HERE/' worker/wrangler.toml
```

## 2. Apply the schema

```bash
npx wrangler d1 execute digital-pass --remote --file=worker/schema.sql --config worker/wrangler.toml
```

## 3. Store the new secrets

```bash
# use your .p8 file's actual name:
npx wrangler secret put APNS_KEY_PEM --config worker/wrangler.toml < secrets/AuthKey_XXXXXXXXXX.p8
# make up an admin password (you'll use it in curl commands):
npx wrangler secret put ADMIN_KEY --config worker/wrangler.toml
```

## 4. Deploy

```bash
npm run deploy
```

## 5. Get the new card on your iPhone

The old test card can't receive updates (it was built without a web service URL) — remove it
from Wallet, then open this in Safari on the iPhone and Add:

```
https://digital-pass.small-bread-a578.workers.dev/v1/test-pass
```

Within a few seconds of adding, the iPhone silently registers with the worker.

## 6. Fire a notification 🎯

From your Mac (fill in your admin password; first command shows the serial + confirms
`registrations: 1`):

```bash
curl -s https://digital-pass.small-bread-a578.workers.dev/v1/passes -H "X-Admin-Key: YOUR-PASSWORD"

curl -s -X PATCH "https://digital-pass.small-bread-a578.workers.dev/v1/passes/THE-SERIAL" \
  -H "X-Admin-Key: YOUR-PASSWORD" -H "Content-Type: application/json" \
  -d '{"fields":{"acts":"1","movement":"Act #251,442 of one million"},"changeMessage":"You did it — act #251,442 of one million 💗"}'
```

**Lock your iPhone first**, then run the PATCH — the notification appears on the lock screen,
and opening the card shows the updated numbers.

## Troubleshooting

- `registrations: 0` after adding the card → check `npx wrangler tail --config worker/wrangler.toml`
  while re-adding; Apple logs errors to `/v1/log`, which shows up there.
- PATCH returns `pushed: 0` → the device never registered (see above).
- Push status 403 → APNS_KEY_ID / Team ID mismatch; 410 → stale token (re-add the card).
