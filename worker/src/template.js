/**
 * template.js — THE TEMPLATE ENGINE (build step 4.6).
 *
 * Every card renders from a template object stored on its brand row
 * (brands.template_json), not from code. The Kindness Card is just the
 * built-in default template. Templates render LIVE: editing a brand's
 * template restyles every existing card on its next fetch.
 *
 * Field entry: { key, label, changeMessage?, value? }
 *   value omitted  → card's field value (fields[key] ?? defaults[key])
 *   value "…"      → fixed text; "{barcode}"/"{photoUrl}" placeholders allowed
 */

export const DEFAULT_TEMPLATE = {
  orgName: 'All About Love',
  logoText: 'All About Love',
  description: 'Kindness Card',
  colors: { bg: 'rgb(164, 19, 60)', fg: 'rgb(255, 255, 255)', label: 'rgb(255, 214, 224)' },
  fields: {
    header: [{ key: 'due', label: 'DUE', changeMessage: 'Due date: %@' }],
    primary: [{ key: 'promise', label: 'MY PROMISE' }],
    secondary: [
      { key: 'guest', label: 'GUEST' },
      { key: 'event', label: 'EVENT' },
    ],
    auxiliary: [
      { key: 'acts', label: 'ACTS DONE' },
      { key: 'movement', label: 'THE MOVEMENT' },
    ],
    back: [
      { key: 'latest', label: 'LATEST', changeMessage: '%@' },
      { key: 'album', label: 'YOUR PHOTO — VIEW · SHARE · DOWNLOAD', value: '{barcode}' },
      { key: 'about', label: 'ABOUT', value: 'One photo. One promise. One million acts of kindness.' },
    ],
  },
  messageField: 'latest',
  barcode: { source: 'barcode', altText: 'scan to open your photo' },
  defaults: {
    due: 'Aug 11',
    promise: 'I promised an act of kindness',
    guest: 'Sarah',
    event: 'Test Event',
    acts: '0',
    movement: 'Act #247,801 of one million',
    latest: 'Welcome to the movement 💗',
  },
};

/** Deep-ish merge: brand template overrides default (sections replace wholesale). */
export function mergeTemplate(brandTemplate) {
  const t = brandTemplate || {};
  return {
    ...DEFAULT_TEMPLATE,
    ...t,
    colors: { ...DEFAULT_TEMPLATE.colors, ...(t.colors || {}) },
    fields: t.fields ? { ...DEFAULT_TEMPLATE.fields, ...t.fields } : DEFAULT_TEMPLATE.fields,
    barcode: { ...DEFAULT_TEMPLATE.barcode, ...(t.barcode || {}) },
    defaults: { ...DEFAULT_TEMPLATE.defaults, ...(t.defaults || {}) },
  };
}

/** Load the template for a pass (via its brand row). Legacy/unknown → default. */
export async function resolveTemplate(env, pass) {
  if (!pass || !pass.brand_id) return DEFAULT_TEMPLATE;
  const brand = await env.DB.prepare('SELECT template_json, name FROM brands WHERE id=?')
    .bind(pass.brand_id).first();
  if (!brand) return DEFAULT_TEMPLATE;
  let t = {};
  try { t = JSON.parse(brand.template_json || '{}'); } catch {}
  if (!t.orgName && brand.name) t.orgName = brand.name;
  return mergeTemplate(t);
}

function barcodeValue(template, f) {
  const src = (template.barcode && template.barcode.source) || 'barcode';
  if (src === 'fixed') return template.barcode.fixed || '';
  if (src === 'photoUrl') return f.photoUrl || f.barcode || '';
  return f.barcode || f.photoUrl || '';
}

/** Every card's links default to ITS OWN hosted page (/p/{serial}) unless the brand set one. */
export function withPageLink(env, serial, fields) {
  const f = { ...(fields || {}) };
  if (!f.barcode && env && env.BASE_URL && serial) f.barcode = `${env.BASE_URL}/p/${serial}`;
  return f;
}

function fieldValue(entry, template, f) {
  if (entry.value != null) {
    return String(entry.value)
      .replace('{barcode}', barcodeValue(template, f) || '')
      .replace('{photoUrl}', f.photoUrl || '');
  }
  const v = f[entry.key] ?? template.defaults[entry.key];
  return v == null ? null : String(v);
}

function renderSection(entries, template, f) {
  const out = [];
  for (const e of entries || []) {
    const value = fieldValue(e, template, f);
    if (value == null || value === '') continue;
    const field = { key: e.key, label: e.label || e.key.toUpperCase(), value };
    if (e.changeMessage) field.changeMessage = e.changeMessage;
    out.push(field);
  }
  return out;
}

/** Apple pass.json from a template. */
export function buildPassJson(env, { serial, authToken, fields, template }) {
  const t = template || DEFAULT_TEMPLATE;
  const f = withPageLink(env, serial, fields);
  const bc = barcodeValue(t, f);
  const pass = {
    formatVersion: 1,
    passTypeIdentifier: env.APPLE_PASS_TYPE_ID,
    teamIdentifier: env.APPLE_TEAM_ID,
    organizationName: t.orgName,
    serialNumber: serial,
    description: t.description || t.orgName,
    logoText: t.logoText,
    webServiceURL: env.BASE_URL,
    authenticationToken: authToken,
    backgroundColor: t.colors.bg,
    foregroundColor: t.colors.fg,
    labelColor: t.colors.label,
    generic: {
      headerFields: renderSection(t.fields.header, t, f),
      primaryFields: renderSection(t.fields.primary, t, f),
      secondaryFields: renderSection(t.fields.secondary, t, f),
      auxiliaryFields: renderSection(t.fields.auxiliary, t, f),
      backFields: renderSection(t.fields.back, t, f),
    },
  };
  if (bc) {
    pass.barcodes = [{
      format: 'PKBarcodeFormatQR',
      message: bc,
      messageEncoding: 'iso-8859-1',
      altText: (t.barcode && t.barcode.altText) || undefined,
    }];
  }
  return pass;
}

/** Hex color for Google (accepts rgb(…) or #hex in template). */
export function bgHex(template) {
  const c = (template.colors && template.colors.bg) || 'rgb(164,19,60)';
  if (c.startsWith('#')) return c;
  const m = c.match(/(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (!m) return '#a4133c';
  return '#' + [m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('');
}

/** Data for the Google object renderer. */
export function googleView(template, f) {
  const primary = renderSection(template.fields.primary, template, f)[0];
  const sub = renderSection(template.fields.secondary, template, f)
    .map((x) => x.value).join(' · ');
  const modules = [
    ...renderSection(template.fields.header, template, f),
    ...renderSection(template.fields.auxiliary, template, f),
  ].map((x) => ({ id: x.key, header: x.label, body: x.value }));
  return {
    cardTitle: template.orgName,
    header: primary ? primary.value : template.orgName,
    subheader: sub || undefined,
    hexBackgroundColor: bgHex(template),
    textModules: modules,
    barcode: barcodeValue(template, f),
    barcodeAlt: (template.barcode && template.barcode.altText) || undefined,
  };
}

export const DEFAULT_FIELDS = DEFAULT_TEMPLATE.defaults;
