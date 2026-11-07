/* Velan Joint Ventures: enquiry email endpoint (Vercel serverless function).
   Sends the enquiry by email through Resend's REST API.

   Required environment variables (set in Vercel > Project > Settings > Environment Variables; never in the website code):
     RESEND_API_KEY       API key from resend.com
     ENQUIRY_TO_EMAIL     inbox that receives enquiries (comma separated for more than one)
     ENQUIRY_FROM_EMAIL   verified sender, e.g. "Velan Joint Ventures <enquiries@yourdomain.in>"

   If any is missing the function answers 503 "not_configured" and the website falls back to WhatsApp only.
   It answers 200 {ok:true} only after Resend has accepted the message. */

'use strict';

const MAX_BODY = 20000;
const ALLOWED_HOSTS = ['www.velanjointventures.in', 'velanjointventures.in'];
const hits = new Map(); /* best-effort, per warm instance: 5 requests per 10 minutes per IP */

function clean(v, n) {
  return String(v == null ? '' : v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, n);
}
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function limited(ip) {
  const now = Date.now(), win = 10 * 60 * 1000;
  const list = (hits.get(ip) || []).filter(t => now - t < win);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 500) for (const k of hits.keys()) { if (!hits.get(k).some(t => now - t < win)) hits.delete(k); }
  return list.length > 5;
}
function originOk(req) {
  const o = req.headers.origin || req.headers.referer || '';
  if (!o) return false;
  try {
    const h = new URL(o).hostname;
    return ALLOWED_HOSTS.includes(h) || /\.vercel\.app$/.test(h) || h === 'localhost';
  } catch (e) { return false; }
}
function send(res, code, body) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}
async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body);
  let raw = '';
  for await (const c of req) { raw += c; if (raw.length > MAX_BODY) throw new Error('too_large'); }
  return JSON.parse(raw || '{}');
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return send(res, 405, { ok: false, error: 'method_not_allowed' }); }

  const key = process.env.RESEND_API_KEY, to = process.env.ENQUIRY_TO_EMAIL, from = process.env.ENQUIRY_FROM_EMAIL;
  if (!key || !to || !from) return send(res, 503, { ok: false, error: 'not_configured' });
  if (!originOk(req)) return send(res, 403, { ok: false, error: 'forbidden' });

  let b;
  try { b = await readBody(req); } catch (e) { return send(res, 400, { ok: false, error: 'bad_request' }); }
  if (!b || typeof b !== 'object') return send(res, 400, { ok: false, error: 'bad_request' });

  /* spam: honeypot filled, or form submitted impossibly fast. Pretend success so bots learn nothing. */
  if (b._gotcha) return send(res, 200, { ok: true });
  const elapsed = Number(b._t);
  if (!(elapsed >= 3000)) return send(res, 400, { ok: false, error: 'too_fast' });

  const ip = clean((req.headers['x-forwarded-for'] || '').split(',')[0] || (req.socket && req.socket.remoteAddress) || 'x', 60);
  if (limited(ip)) return send(res, 429, { ok: false, error: 'rate_limited' });

  const name = clean(b.name, 120), email = clean(b.email, 160), phone = clean(b.phone, 30);
  if (!name) return send(res, 400, { ok: false, error: 'invalid', field: 'name' });
  if (!/^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]{2,}$/.test(email)) return send(res, 400, { ok: false, error: 'invalid', field: 'email' });
  if (phone && !/^[+()\-\s\d]{7,20}$/.test(phone)) return send(res, 400, { ok: false, error: 'invalid', field: 'phone' });

  const fields = (Array.isArray(b.fields) ? b.fields : []).slice(0, 20)
    .map(f => ({ label: clean(f && f.label, 80), value: clean(f && f.value, 2000) }))
    .filter(f => f.label && f.value);
  if (!fields.length) return send(res, 400, { ok: false, error: 'invalid', field: 'message' });

  const formName = clean(b.form, 60) || 'enquiry', page = clean(b.page, 60) || 'home';
  const subject = 'Website enquiry from ' + name.replace(/[\r\n]/g, ' ');
  const text = fields.map(f => f.label + ': ' + f.value).join('\n') +
    '\n\nForm: ' + formName + ' (page: ' + page + ')\nSent via www.velanjointventures.in';
  const html = '<h2 style="font-family:Arial,sans-serif">New website enquiry</h2><table cellpadding="6" style="font-family:Arial,sans-serif;font-size:14px;border-collapse:collapse">' +
    fields.map(f => '<tr><td style="vertical-align:top;color:#555"><strong>' + esc(f.label) + '</strong></td><td style="white-space:pre-wrap">' + esc(f.value) + '</td></tr>').join('') +
    '</table><p style="font-family:Arial,sans-serif;font-size:12px;color:#777">Form: ' + esc(formName) + ' (page: ' + esc(page) + '). Reply to this email to reach the sender.</p>';

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: to.split(',').map(s => s.trim()).filter(Boolean), reply_to: email, subject, text, html }),
      signal: AbortSignal.timeout(10000)
    });
    if (!r.ok) { console.error('enquiry: email provider returned', r.status); return send(res, 502, { ok: false, error: 'delivery_failed' }); }
    return send(res, 200, { ok: true });
  } catch (e) {
    console.error('enquiry: email request failed', e && e.name);
    return send(res, 502, { ok: false, error: 'delivery_failed' });
  }
};
