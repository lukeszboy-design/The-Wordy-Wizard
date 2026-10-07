// The Wordy Wizard classroom service (a Cloudflare Worker).
// A teacher shares the week's spelling words under a 4-digit code; families enter the code to get them.
//   POST /classes                      { week, words, sortBy?, name? }  -> { code, key }    create a class
//   GET  /classes/:code                                 -> { code, name, week, words, sortBy, updated }
//   PUT  /classes/:code  (Bearer key)  { week, words, sortBy?, name? }  -> { code, name, week, words, sortBy, updated }
// sortBy is the teacher's choice for the Stable Sort game (how words are sorted), e.g. 'syllables'.
// name is what the class is called, e.g. 'Room 12', so children can check they joined the right one.
//   POST /voices                       { words: [...] } -> { ready, recorded, limited }   record spelling words
//   GET  /voices/:word                                  -> the word's recording (audio/wav), or 204 if not recorded yet
//   POST /clues                        { words: [...] } -> { clues: { word: clue }, limited, none }   clues for The Royal Map
// A clue is written once per word by a small language model (Cloudflare Workers AI), checked (short, plain,
// never containing the answer) and kept in KV for everyone. Clue sentences are recorded like words.
// Spelling words are read aloud by the MeloTTS voice (Cloudflare Workers AI). Each word is recorded once, the
// first time any list containing it is saved, kept in KV, and shared by every device after that.
// The code only lets someone read the words. Changing them needs the teacher's key, which only the
// teacher's device holds; the service keeps just a fingerprint (SHA-256) of it.

const WORD_RE = /^[A-Za-z][A-Za-z'’\- ]{0,29}$/, WEEK_RE = /^(\d{4}-\d{2}-\d{2})?$/, MAX_WORDS = 150;
const CREATES_PER_HOUR = 5;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 .,'’&\-]{0,39}$/;
// wrong codes allowed per network address per hour (a whole school shares one address, so it's generous;
// it only stops someone trying every code)
const MISSES_PER_HOUR = 60;
// voice limits: single short words only (plus the Town Crier's two phrases), a few per request (the free plan
// allows ~10 ms of work per request), and daily caps that keep the service inside the free plan's 1,000 storage
// writes a day (each new recording is one write).
const SAY_RE = /^[A-Za-z][A-Za-z'’\-]{0,29}$/, PHRASES = new Set(['Hear ye, hear ye! The word is:', 'Huzzah!']);
const VOICE_BATCH = 4, RECORDS_PER_DAY = 600, RECORDS_PER_IP_DAY = 300;
// clue sentences (also recordable, so the scroll can be read aloud in the word voice)
const CLUE_RE = /^[A-Za-z0-9][A-Za-z0-9 ,.'’!?\-]{7,99}$/;
const CLUE_WORD_RE = /^[A-Za-z]{2,20}$/, CLUE_BATCH = 4, CLUES_PER_DAY = 150, CLUES_PER_IP_DAY = 100;
// (each clue takes up to three tries of writing and checking, about 40 of the free plan's 10,000 daily units at
// most, so 150 a day leaves plenty for the voice. A word with no good clue isn't tried again for 3 days.)
const CLUE_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const CLUE_PROMPT = 'You write crossword clues for children aged 6 to 9. Reply with only the clue: one short sentence of at most 12 easy words, ending with a full stop. For a thing, action or feeling, say what it means. For a small word that is hard to describe (like said, the, was, of, because), write a short everyday sentence with the word replaced by the word blank, for example: She blank hello to me. Never use the answer word or any form of it. No quotation marks.';
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
  // clues: a grown-up's own Royal Map clues, e.g. { castle: 'Where a king lives.' }
  const clues = {};
  for (const [k, v] of Object.entries(body.clues && typeof body.clues === 'object' ? body.clues : {})) {
    if (!inList.has(k) || !CLUE_RE.test(String(v))) return null;
    clues[k] = String(v);
  }
  const list = { week, words, sortBy, say, clues };
  if ('name' in body) {   // (left out: the name stays as it was)
    const name = String(body.name || '').trim().replace(/\s+/g, ' ');
    if (name && !NAME_RE.test(name)) return null;
    list.name = name;
  }
  return list;
}
const view = (code, c) => ({ code, name: c.name || '', clues: c.clues || {}, week: c.week, words: c.words, sortBy: c.sortBy || 'auto', say: c.say || {}, updated: c.updated });

// ---- spelling-word voices ----
async function voices(req, env, parts) {
  if (req.method === 'GET' && parts.length === 2) {
    let text; try { text = decodeURIComponent(parts[1]); } catch (e) { return oops(req, 404, 'not found'); }
    if (!SAY_RE.test(text) && !PHRASES.has(text) && !CLUE_RE.test(text)) return oops(req, 404, 'not found');
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
    if (!words.length || words.length > VOICE_BATCH || !words.every(w => SAY_RE.test(w) || PHRASES.has(w) || CLUE_RE.test(w))) return oops(req, 400, 'only single short words and clues can be recorded');
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

// ---- clues for The Royal Map ----
function clueOk(clue, word) {
  if (!CLUE_RE.test(clue) || clue.split(' ').length > 16) return false;
  const w = word.toLowerCase(), stem = w.length >= 5 ? w.slice(0, w.length - 2) : w;
  return !clue.toLowerCase().split(/[^a-z]+/).some(t => t === w || t.startsWith(stem));
}
// a clue only counts if the model, shown just the clue and the length, comes back with the word
async function solves(env, clue, word) {
  try {
    const out = await env.AI.run(CLUE_MODEL, { messages: [{ role: 'system', content: 'Solve this crossword clue for children. If the clue has the word blank in it, give the word that fills the blank. Reply with only the answer word, lowercase.' }, { role: 'user', content: `${clue} (${word.length} letters)` }], max_tokens: 8, temperature: 0 });
    return String(out && out.response || '').trim().toLowerCase().replace(/[^a-z]/g, '') === word.toLowerCase();
  } catch (e) { return false; }
}
async function writeClue(env, word) {
  for (let i = 0; i < 3; i++) {
    try {
      const out = await env.AI.run(CLUE_MODEL, { messages: [{ role: 'system', content: CLUE_PROMPT }, { role: 'user', content: 'Answer: ' + word }], max_tokens: 40, temperature: i ? .8 : .3 });
      let c = String(out && out.response || '').trim().split('\n')[0].replace(/^clue:\s*/i, '').replace(/["“”]/g, '').trim();
      if (c && !/[.!?]$/.test(c)) c += '.';
      if (clueOk(c, word) && await solves(env, c, word)) return c;
    } catch (e) {}
  }
  return null;
}
async function clues(req, env) {
  if (req.method !== 'POST') return oops(req, 405, 'not allowed');
  if (!allowedOrigin(req.headers.get('Origin') || '')) return oops(req, 403, 'not allowed');
  let body; try { body = await req.json(); } catch (e) { return oops(req, 400, 'bad request'); }
  const words = [...new Set((Array.isArray(body && body.words) ? body.words : []).map(w => String(w).trim().toLowerCase()))];
  if (!words.length || words.length > CLUE_BATCH || !words.every(w => CLUE_WORD_RE.test(w))) return oops(req, 400, 'only single words can have clues');
  const out = {}, missing = [];
  const none = [];
  await Promise.all(words.map(async w => { const c = await env.CLASSES.get('clue:' + w); if (c === '-') none.push(w); else if (c) out[w] = c; else missing.push(w); }));
  if (!missing.length) return reply(req, 200, { clues: out, limited: [], none });
  const day = Math.floor(Date.now() / 864e5), ip = req.headers.get('CF-Connecting-IP') || 'local';
  const dayKey = 'cday:' + day, ipKey = 'cip:' + ip + ':' + day;
  const usedDay = +(await env.CLASSES.get(dayKey) || 0), usedIp = +(await env.CLASSES.get(ipKey) || 0);
  const room = Math.max(0, Math.min(CLUES_PER_DAY - usedDay, CLUES_PER_IP_DAY - usedIp));
  const todo = missing.slice(0, room), limited = missing.slice(room);
  let made = 0;
  await Promise.all(todo.map(async w => {
    const c = await writeClue(env, w);
    if (c) { await env.CLASSES.put('clue:' + w, c); out[w] = c; }
    else { await env.CLASSES.put('clue:' + w, '-', { expirationTtl: 3 * 86400 }); none.push(w); }
    made++;
  }));
  if (made) {
    await env.CLASSES.put(dayKey, String(usedDay + made), { expirationTtl: 2 * 86400 });
    await env.CLASSES.put(ipKey, String(usedIp + made), { expirationTtl: 2 * 86400 });
  }
  return reply(req, 200, { clues: out, limited, none });
}

export default {
  // any unexpected failure still answers with the usual headers, so the app sees it as an error it can handle
  async fetch(req, env) {
    try { return await handle(req, env); } catch (e) { return oops(req, 500, 'something went wrong; please try again'); }
  }
};
async function handle(req, env) {
  const url = new URL(req.url), parts = url.pathname.split('/').filter(Boolean);
  if (req.method === 'OPTIONS') return reply(req, 204);
  if (parts[0] === 'voices' && parts.length <= 2) return voices(req, env, parts);
  if (parts[0] === 'clues' && parts.length === 1) return clues(req, env);
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
  const ip = req.headers.get('CF-Connecting-IP') || 'local', missKey = 'miss:' + ip + ':' + Math.floor(Date.now() / 3600e3);
  const missed = +(await env.CLASSES.get(missKey) || 0);
  if (missed >= MISSES_PER_HOUR) return oops(req, 429, 'too many wrong codes; try again in a little while');
  const raw = /^\d{4}$/.test(code || '') ? await env.CLASSES.get('class:' + code) : null;
  if (!raw) {
    await env.CLASSES.put(missKey, String(missed + 1), { expirationTtl: 3700 });
    return oops(req, 404, 'no classroom has that code');
  }
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
