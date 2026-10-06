// The Wordy Wizard classroom service (a Cloudflare Worker).
// A teacher shares the week's spelling words under a 4-digit code; families enter the code to get them.
//   POST /classes                      { week, words, sortBy? }  -> { code, key }    create a class
//   GET  /classes/:code                                 -> { code, week, words, sortBy, updated }
//   PUT  /classes/:code  (Bearer key)  { week, words, sortBy? }  -> { code, week, words, sortBy, updated }
// sortBy is the teacher's choice for the Stable Sort game (how words are sorted), e.g. 'syllables'.
//   POST /voices                       { words: [...] } -> { ready, recorded, limited }   record spelling words
//   GET  /voices/:word                                  -> the word's recording (audio/wav), or 204 if not recorded yet
// Spelling words are read aloud by the MeloTTS voice (Cloudflare Workers AI). Each word is recorded once, the
// first time any list containing it is saved, kept in KV, and shared by every device after that.
// The code only lets someone read the words. Changing them needs the teacher's key, which only the
// teacher's device holds; the service keeps just a fingerprint (SHA-256) of it.

const WORD_RE = /^[A-Za-z][A-Za-z'’\- ]{0,29}$/, WEEK_RE = /^(\d{4}-\d{2}-\d{2})?$/, MAX_WORDS = 150;
const CREATES_PER_HOUR = 5;
// voice limits: single short words only (plus the Town Crier's two phrases), a few per request (the free plan
// allows ~10 ms of work per request), and daily caps that keep the service inside the free plan's 1,000 storage
// writes a day (each new recording is one write).
const SAY_RE = /^[A-Za-z][A-Za-z'’\-]{0,29}$/, PHRASES = new Set(['Hear ye, hear ye! The word is:', 'Huzzah!']);
const VOICE_BATCH = 4, RECORDS_PER_DAY = 600, RECORDS_PER_IP_DAY = 300;
const voiceKey = t => 'voice:melo1:' + (PHRASES.has(t) ? t : t.toLowerCase().replace(/’/g, "'"));   // per network address, so nobody can fill the service with junk classes

function allowedOrigin(origin) {
  try {
    const u = new URL(origin);
    return u.hostname === 'thewordywizard.com' || u.hostname === 'www.thewordywizard.com' || u.hostname === 'lukeszboy-design.github.io' || u.hostname === 'localhost' || u.hostname === '127.0.0.1' || /^192\.168\.\d+\.\d+$/.test(u.hostname);
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
  const week = String(body.week || ''), sortBy = String(body.sortBy || 'auto');
  if (!WEEK_RE.test(week) || !/^[a-z0-9-]{1,24}$/.test(sortBy)) return null;
  // say: how a grown-up asked some words to be said, e.g. { read: 'red' } (only words on the list, one word each)
  const say = {}, inList = new Set(words.map(w => w.toLowerCase()));
  for (const [k, v] of Object.entries(body.say && typeof body.say === 'object' ? body.say : {})) {
    if (!inList.has(k) || !SAY_RE.test(String(v))) return null;
    say[k] = String(v);
  }
  return { week, words, sortBy, say };
}
const view = (code, c) => ({ code, week: c.week, words: c.words, sortBy: c.sortBy || 'auto', say: c.say || {}, updated: c.updated });

// ---- spelling-word voices ----
async function voices(req, env, parts) {
  if (req.method === 'GET' && parts.length === 2) {
    let text; try { text = decodeURIComponent(parts[1]); } catch (e) { return oops(req, 404, 'not found'); }
    if (!SAY_RE.test(text) && !PHRASES.has(text)) return oops(req, 404, 'not found');
    const audio = await env.CLASSES.get(voiceKey(text), { type: 'arrayBuffer' });
    if (!audio) return reply(req, 204);   // not recorded yet (204, not 404, so browsers don't log it as an error)
    const h = new Headers(reply(req, 200, null).headers);
    h.set('Content-Type', 'audio/wav'); h.set('Cache-Control', 'public, max-age=86400');
    return new Response(audio, { status: 200, headers: h });
  }
  if (req.method === 'POST' && parts.length === 1) {
    if (!allowedOrigin(req.headers.get('Origin') || '')) return oops(req, 403, 'not allowed');
    let body; try { body = await req.json(); } catch (e) { return oops(req, 400, 'bad request'); }
    const words = [...new Set((Array.isArray(body && body.words) ? body.words : []).map(w => String(w).trim()))];
    if (!words.length || words.length > VOICE_BATCH || !words.every(w => SAY_RE.test(w) || PHRASES.has(w))) return oops(req, 400, 'only single short words can be recorded');
    const ready = [], missing = [];
    for (const w of words) {
      const st = await env.CLASSES.get(voiceKey(w), { type: 'stream' });
      if (st) { await st.cancel(); ready.push(w); } else missing.push(w);
    }
    if (!missing.length) return reply(req, 200, { ready, recorded: [], limited: [] });
    const day = Math.floor(Date.now() / 864e5), ip = req.headers.get('CF-Connecting-IP') || 'local';
    const dayKey = 'vday:' + day, ipKey = 'vip:' + ip + ':' + day;
    const usedDay = +(await env.CLASSES.get(dayKey) || 0), usedIp = +(await env.CLASSES.get(ipKey) || 0);
    const room = Math.max(0, Math.min(RECORDS_PER_DAY - usedDay, RECORDS_PER_IP_DAY - usedIp));
    const todo = missing.slice(0, room), limited = missing.slice(room), recorded = [];
    for (const w of todo) {
      try {
        const out = await env.AI.run('@cf/myshell-ai/melotts', { prompt: w, lang: 'en' });
        const bin = atob(out.audio), u8 = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
        await env.CLASSES.put(voiceKey(w), u8.buffer); recorded.push(w);
      } catch (e) { limited.push(w); }
    }
    if (recorded.length) {
      await env.CLASSES.put(dayKey, String(usedDay + recorded.length), { expirationTtl: 2 * 86400 });
      await env.CLASSES.put(ipKey, String(usedIp + recorded.length), { expirationTtl: 2 * 86400 });
    }
    return reply(req, 200, { ready: ready.concat(recorded), recorded, limited });
  }
  return oops(req, 405, 'not allowed');
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url), parts = url.pathname.split('/').filter(Boolean);
    if (req.method === 'OPTIONS') return reply(req, 204);
    if (parts[0] === 'voices' && parts.length <= 2) return voices(req, env, parts);
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
