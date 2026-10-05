// The Wordy Wizard classroom service (a Cloudflare Worker).
// A teacher shares the week's spelling words under a 4-digit code; families enter the code to get them.
//   POST /classes                      { week, words }  -> { code, key }    create a class
//   GET  /classes/:code                                 -> { code, week, words, updated }
//   PUT  /classes/:code  (Bearer key)  { week, words }  -> { code, week, words, updated }
// The code only lets someone read the words. Changing them needs the teacher's key, which only the
// teacher's device holds; the service keeps just a fingerprint (SHA-256) of it.

const WORD_RE = /^[A-Za-z][A-Za-z'’\- ]{0,29}$/, WEEK_RE = /^(\d{4}-\d{2}-\d{2})?$/, MAX_WORDS = 150;
const CREATES_PER_HOUR = 5;   // per network address, so nobody can fill the service with junk classes

function allowedOrigin(origin) {
  try {
    const u = new URL(origin);
    return u.hostname === 'lukeszboy-design.github.io' || u.hostname === 'localhost' || u.hostname === '127.0.0.1' || /^192\.168\.\d+\.\d+$/.test(u.hostname);
  } catch (e) { return false; }
}
function reply(req, status, body) {
  const origin = req.headers.get('Origin') || '';
  const h = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Vary': 'Origin' };
  if (allowedOrigin(origin)) Object.assign(h, { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Max-Age': '86400' });
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: h });
}
const oops = (req, status, error) => reply(req, status, { error });

async function sha256(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function newKey() {
  const b = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_');
}
// a list of words that passes the same rules the game's word list uses
async function readList(req) {
  let body; try { body = await req.json(); } catch (e) { return null; }
  if (!body || !Array.isArray(body.words) || body.words.length > MAX_WORDS) return null;
  const words = body.words.map(w => String(w).trim().replace(/\s+/g, ' '));
  if (!words.every(w => WORD_RE.test(w))) return null;
  const week = String(body.week || '');
  if (!WEEK_RE.test(week)) return null;
  return { week, words };
}
const view = (code, c) => ({ code, week: c.week, words: c.words, updated: c.updated });

export default {
  async fetch(req, env) {
    const url = new URL(req.url), parts = url.pathname.split('/').filter(Boolean);
    if (req.method === 'OPTIONS') return reply(req, 204);
    if (parts[0] !== 'classes' || parts.length > 2) return oops(req, 404, 'not found');
    const origin = req.headers.get('Origin');

    if (req.method === 'POST' && parts.length === 1) {
      if (!allowedOrigin(origin || '')) return oops(req, 403, 'not allowed');
      const ip = req.headers.get('CF-Connecting-IP') || 'local', rlKey = 'rl:' + ip + ':' + Math.floor(Date.now() / 3600e3);
      const made = +(await env.CLASSES.get(rlKey) || 0);
      if (made >= CREATES_PER_HOUR) return oops(req, 429, 'too many new classrooms; try again later');
      const list = await readList(req); if (!list) return oops(req, 400, 'that word list could not be used');
      let code = null;
      for (let i = 0; i < 30 && !code; i++) { const c = String(1000 + Math.floor(Math.random() * 9000)); if (!(await env.CLASSES.get('class:' + c))) code = c; }
      if (!code) return oops(req, 503, 'no free codes right now');
      const key = newKey(), now = new Date().toISOString();
      await env.CLASSES.put('class:' + code, JSON.stringify({ ...list, keyHash: await sha256(key), created: now, updated: now }));
      await env.CLASSES.put(rlKey, String(made + 1), { expirationTtl: 3700 });
      return reply(req, 201, { code, key, updated: now });
    }

    const code = parts[1];
    if (!/^\d{4}$/.test(code || '')) return oops(req, 404, 'no classroom has that code');
    const raw = await env.CLASSES.get('class:' + code);
    if (!raw) return oops(req, 404, 'no classroom has that code');
    const cls = JSON.parse(raw);

    if (req.method === 'GET') return reply(req, 200, view(code, cls));
    if (req.method === 'PUT') {
      const key = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
      if (!key || (await sha256(key)) !== cls.keyHash) return oops(req, 403, 'only the teacher who made this classroom can change its words');
      const list = await readList(req); if (!list) return oops(req, 400, 'that word list could not be used');
      const next = { ...cls, ...list, updated: new Date().toISOString() };
      await env.CLASSES.put('class:' + code, JSON.stringify(next));
      return reply(req, 200, view(code, next));
    }
    return oops(req, 405, 'not allowed');
  }
};
