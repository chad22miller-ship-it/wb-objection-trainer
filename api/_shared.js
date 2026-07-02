// Shared helpers for the chat endpoints (api/chat.js and api/chat-stream.js).
// Underscore-prefixed so Vercel never treats it as its own serverless route.

export const GEMINI_MODEL = 'gemini-2.5-flash';
export const GROQ_MODEL = 'llama-3.3-70b-versatile';
export const OPENROUTER_MODEL = 'meta-llama/llama-3.3-70b-instruct:free';

// Comma-separated env keys → trimmed list.
export const parseKeys = (name) =>
  (process.env[name] || '').split(',').map((k) => k.trim()).filter(Boolean);

// Per-instance rate-limit cooldown. Each serverless function imports its own copy
// of this module (and its own Map) — the code is shared, the state stays isolated.
const cooldowns = new Map();
export const isReady = (id) => Date.now() >= (cooldowns.get(id) || 0);
export const setCooldown = (id, ms) => cooldowns.set(id, Date.now() + ms);
export const coolingCount = (prefix, n) => {
  const now = Date.now();
  let c = 0;
  for (let i = 0; i < n; i += 1) if ((cooldowns.get(`${prefix}:${i}`) || 0) > now) c += 1;
  return c;
};

// Per-prefix round-robin counters — each provider rotates independently.
const _rrMap = new Map();
export const roundRobin = (prefix, n) => {
  if (n === 0) return 0;
  const c = (_rrMap.get(prefix) || 0) % n;
  _rrMap.set(prefix, c + 1);
  return c;
};

// When all keys for a prefix are cooling, return the index whose cooldown
// expires soonest so we can try it immediately instead of hard-failing.
export const leastCooledIndex = (prefix, n) => {
  let best = 0, bestTime = Infinity;
  for (let i = 0; i < n; i++) {
    const t = cooldowns.get(`${prefix}:${i}`) || 0;
    if (t < bestTime) { bestTime = t; best = i; }
  }
  return best;
};

// Validate the shared chat request body. Returns { error, status } on failure, or
// { system, messages, max_tokens } on success. Endpoints pass their own token
// default/ceiling (chat: 2048/4096, chat-stream: 512/1024).
export const validateChatBody = (body, { defaultMax, maxCeil }) => {
  const { system } = body;
  const messages = body.messages;
  if (!Array.isArray(messages)) return { error: 'messages must be an array', status: 400 };
  if (messages.length > 80) return { error: 'too many messages', status: 400 };
  if (system != null && typeof system !== 'string') return { error: 'system must be a string', status: 400 };
  const approxSize = (system ? system.length : 0) +
    messages.reduce((n, m) => n + (typeof m?.content === 'string' ? m.content.length : 0), 0);
  if (approxSize > 200000) return { error: 'request too large', status: 413 };
  const max_tokens = Math.min(Math.max(Number(body.max_tokens) || defaultMax, 1), maxCeil);
  return { system, messages, max_tokens };
};

// Gemini generateContent body (thinking disabled). Used by both endpoints.
export const buildGeminiBody = (messages, system, max_tokens) => {
  const contents = messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: typeof m.content === 'string' ? m.content : '' }],
  }));
  const body = {
    contents,
    generationConfig: { maxOutputTokens: max_tokens, thinkingConfig: { thinkingBudget: 0 } },
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  return body;
};

// OpenAI-style message array (Groq / OpenRouter), prepending the system turn.
export const toOpenAIMessages = (system, messages) => {
  const msgs = [];
  if (system) msgs.push({ role: 'system', content: system });
  msgs.push(...(messages || []).map((m) => ({ role: m.role, content: m.content })));
  return msgs;
};

// Gate the chat endpoints behind a real Supabase login so the public Vercel URL
// can't be curled by anyone to drain the free-tier AI keys (denial-of-wallet) or
// be used as a free general-purpose LLM proxy. Verifies the caller's access token
// against Supabase's auth server with the anon key (same key the browser already
// has — no service role needed). Returns { ok } — handlers 403 on !ok.
//
// If Supabase isn't configured (VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY unset),
// the app runs in its no-auth local mode (App.jsx supports this), so we skip the
// gate rather than lock everyone out — mirroring admin.js's ADMIN_EMAIL handling.
// Fails CLOSED on a bad/absent token or an unreachable auth server: protecting the
// keys is the whole point, and a Supabase outage would break sign-in anyway.
export const verifyAuth = async (req) => {
  const url = process.env.VITE_SUPABASE_URL;
  const anon = process.env.VITE_SUPABASE_ANON_KEY;
  if (!url || !anon) return { ok: true }; // no-auth local/dev mode
  const token = ((req.headers && req.headers.authorization) || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return { ok: false };
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 5000);
    const r = await fetch(`${url}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: anon },
      signal: ac.signal,
    });
    clearTimeout(timer);
    if (!r.ok) return { ok: false };
    const u = await r.json().catch(() => null);
    return u && u.id ? { ok: true } : { ok: false };
  } catch (e) {
    return { ok: false };
  }
};
