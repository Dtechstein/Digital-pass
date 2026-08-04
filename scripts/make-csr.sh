#!/usr/bin/env bash
# Generates a private key + certificate signing request for the Apple pass certificate.
# Run this, then upload pass.csr in the Apple Developer portal (see docs/apple-setup.md).
set -euo pipefail

mkdir -p secrets
if [ -f secrets/pass-key.pem ]; then
  echo "secrets/pass-key.pem already exists — refusing to overwrite." >&2
  exit 1
fi

openssl genrsa -out secrets/pass-key.pem 2048
openssl req -new -key secrets/pass-key.pem -out secrets/pass.csr \
  -subj "/CN=Pass Type ID Certificate/O=Digital Pass"

echo
echo "✓ secrets/pass-key.pem  (KEEP PRIVATE — never commit; secrets/ is gitignored)"
echo "✓ secrets/pass.csr      (upload this in the Apple Developer portal)"
