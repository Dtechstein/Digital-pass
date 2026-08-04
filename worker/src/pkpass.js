/**
 * pkpass.js — pure-JS .pkpass builder (runs on Cloudflare Workers AND Node).
 *
 * A .pkpass is a ZIP containing:
 *   pass.json            – the pass definition
 *   icon.png (+@2x/@3x)  – required images
 *   manifest.json        – SHA-1 hex digest of every other file
 *   signature            – PKCS#7 *detached* signature of manifest.json,
 *                          signed by the pass certificate, with Apple's
 *                          WWDR intermediate included in the chain.
 *
 * No filesystem, no OpenSSL binary: node-forge for PKCS#7, fflate for ZIP.
 */

import forge from 'node-forge';
import { zipSync } from 'fflate';

/** SHA-1 hex of a Uint8Array (forge is sync + pure JS; fine for small pass files). */
function sha1Hex(bytes) {
  const md = forge.md.sha1.create();
  md.update(uint8ToBinaryString(bytes));
  return md.digest().toHex();
}

function uint8ToBinaryString(u8) {
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < u8.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
  }
  return s;
}

function binaryStringToUint8(bin) {
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i) & 0xff;
  return u8;
}

/**
 * Create the PKCS#7 detached signature over manifest bytes.
 * @param {Uint8Array} manifestBytes
 * @param {{ certPem: string, keyPem: string, wwdrPem: string }} creds
 * @returns {Uint8Array} DER-encoded signature
 */
export function signManifest(manifestBytes, { certPem, keyPem, wwdrPem }) {
  const cert = forge.pki.certificateFromPem(certPem);
  const key = forge.pki.privateKeyFromPem(keyPem);
  const wwdr = forge.pki.certificateFromPem(wwdrPem);

  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(uint8ToBinaryString(manifestBytes));
  p7.addCertificate(wwdr);
  p7.addCertificate(cert);
  p7.addSigner({
    key,
    certificate: cert,
    digestAlgorithm: forge.pki.oids.sha1,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
      { type: forge.pki.oids.messageDigest }, // value auto-computed
      { type: forge.pki.oids.signingTime, value: new Date() },
    ],
  });
  p7.sign({ detached: true });

  const der = forge.asn1.toDer(p7.toAsn1()).getBytes();
  return binaryStringToUint8(der);
}

/**
 * Build a complete signed .pkpass.
 * @param {object} passJson – the pass.json object (already includes serial, ids…)
 * @param {Record<string, Uint8Array>} images – e.g. { 'icon.png': …, 'icon@2x.png': … }
 * @param {{ certPem: string, keyPem: string, wwdrPem: string }} creds
 * @returns {Uint8Array} the .pkpass file bytes
 */
export function buildPkpass(passJson, images, creds) {
  const files = {
    'pass.json': new TextEncoder().encode(JSON.stringify(passJson)),
    ...images,
  };

  const manifest = {};
  for (const [name, bytes] of Object.entries(files)) {
    manifest[name] = sha1Hex(bytes);
  }
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  const signature = signManifest(manifestBytes, creds);

  // level 0 = store; pass files are tiny and Wallet accepts stored entries
  const zipped = zipSync(
    { ...files, 'manifest.json': manifestBytes, signature },
    { level: 0 }
  );
  return zipped;
}
