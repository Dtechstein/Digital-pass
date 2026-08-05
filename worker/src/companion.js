/**
 * companion.js — the builder's AI brain (Claude).
 *
 * One job: take a plain-English request + the current card template,
 * return { reply, template } where template is the COMPLETE updated
 * template (or null when nothing changed — questions, advice, etc).
 *
 * Uses forced tool-use so the answer is always valid JSON — no parsing
 * of free text. Needs the ANTHROPIC_API_KEY secret; model can be
 * overridden with the COMPANION_MODEL var.
 */

const DEFAULT_MODEL = 'claude-haiku-4-5';

const SYSTEM = `You are the design companion inside Digital Pass, a wallet-card builder.
You help a NON-TECHNICAL person edit their Apple/Google Wallet card by chatting.

You receive the card's current template as JSON. When the user asks for a change,
return the COMPLETE updated template. When they only ask a question, return no template.

TEMPLATE SHAPE (keep this exact structure):
- orgName, logoText, description: strings.
- colors: { bg, fg, label } — CSS "rgb(r, g, b)" strings ONLY (never hex).
- fields: { header, primary, secondary, auxiliary, back } — arrays of
  { key, label, value?, changeMessage? }. key is a short camelCase id and must stay
  stable once created; label is what shows on the card (usually UPPERCASE);
  value may use placeholders {barcode} and {photoUrl}; changeMessage is the push
  notification format, must contain %@ where the new value goes.
- barcode: { source: 'barcode'|'photoUrl'|'fixed', fixed?, altText? }.
- defaults: { key: value } starting values for new cards.

PLAIN-LANGUAGE MAP (the user sees these names, not the technical ones):
header = "Top corner", primary = "Headline", secondary = "Details row 1",
auxiliary = "Details row 2", back = "Back of card".

HARD RULES:
1. Space is real: header fits 1 small item, primary 1 big line, secondary/auxiliary
   2-3 short items each. Never overcrowd; suggest the back of the card for long text.
2. Contrast matters: fg and label must stay readable on bg. If the user picks a light
   background, darken the text colors yourself and say you did.
3. Never delete or rename a field's key unless the user clearly asks to remove or
   rename that field. Never invent URLs or images.
4. The back field with key "latest" and changeMessage "%@" is the notification inbox —
   warn before removing it (notifications stop showing).
5. Keep replies to 1-3 warm, jargon-free sentences. Say what you changed in card
   terms ("the top corner now shows…"), never JSON terms. If a request is ambiguous,
   make the most reasonable choice and say what you chose.
6. If asked to do something a wallet card cannot do (videos, buttons, animations),
   say so kindly and offer the closest real option.`;

const TOOL = {
  name: 'card_update',
  description: 'Return your reply to the user, plus the complete updated template when the card changed.',
  input_schema: {
    type: 'object',
    properties: {
      reply: { type: 'string', description: 'Your short, friendly answer to the user.' },
      changed: { type: 'boolean', description: 'true only if the template was modified' },
      template: { type: 'object', description: 'The COMPLETE updated template. Omit when changed is false.' },
    },
    required: ['reply', 'changed'],
  },
};

export async function companionChat(env, { message, template, history }) {
  const messages = [];
  for (const h of (history || []).slice(-10)) {
    if ((h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string' && h.content) {
      messages.push({ role: h.role, content: h.content.slice(0, 2000) });
    }
  }
  messages.push({
    role: 'user',
    content: `CURRENT TEMPLATE:\n${JSON.stringify(template)}\n\nUSER SAYS: ${String(message).slice(0, 2000)}`,
  });

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: env.COMPANION_MODEL || DEFAULT_MODEL,
      max_tokens: 3000,
      system: SYSTEM,
      tools: [TOOL],
      tool_choice: { type: 'tool', name: 'card_update' },
      messages,
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`companion_api_${res.status}: ${detail.slice(0, 300)}`);
  }
  const data = await res.json();
  const call = (data.content || []).find((b) => b.type === 'tool_use');
  if (!call || !call.input || !call.input.reply) throw new Error('companion_bad_response');

  const out = { reply: call.input.reply, template: null };
  if (call.input.changed && call.input.template && typeof call.input.template === 'object') {
    out.template = sanitizeTemplate(call.input.template, template);
  }
  return out;
}

/** Guardrails: whatever the model returns, the card must stay renderable. */
function sanitizeTemplate(next, prev) {
  const t = { ...prev, ...next };
  if (!t.colors || typeof t.colors !== 'object') t.colors = prev.colors;
  t.colors = { ...prev.colors, ...t.colors };
  for (const k of ['bg', 'fg', 'label']) {
    if (typeof t.colors[k] !== 'string') t.colors[k] = prev.colors[k];
    // accept hex despite instructions — convert to rgb() so Apple accepts it
    const hex = /^#([0-9a-f]{6})$/i.exec(t.colors[k].trim());
    if (hex) {
      const n = parseInt(hex[1], 16);
      t.colors[k] = `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
    }
  }
  if (!t.fields || typeof t.fields !== 'object') t.fields = prev.fields;
  for (const s of ['header', 'primary', 'secondary', 'auxiliary', 'back']) {
    if (!Array.isArray(t.fields[s])) t.fields[s] = Array.isArray(prev.fields?.[s]) ? prev.fields[s] : [];
    t.fields[s] = t.fields[s]
      .filter((f) => f && typeof f === 'object' && typeof f.key === 'string' && f.key)
      .map((f) => ({ ...f, key: f.key.replace(/\W/g, '').slice(0, 24) || 'field' }));
  }
  if (!t.barcode || typeof t.barcode !== 'object') t.barcode = prev.barcode;
  if (!t.defaults || typeof t.defaults !== 'object') t.defaults = prev.defaults || {};
  return t;
}
