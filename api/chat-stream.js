// Vercel serverless function — STREAMING chat for live call mode.
// Streams tokens back as Server-Sent Events so the browser can start speaking
// the first sentence while the rest is still generating.
//
// Provider order is FAST-FIRST (the opposite of /api/chat): Groq → Gemini.
// Groq's Llama is dramatically lower-latency, which is what makes the live call
// feel instant. /api/chat (Gemini-first, non-streaming) is still the brain for
// drills, debriefs, hints, and as the client-side fallback if streaming fails.

const GEMINI_MODEL = 'gemini-2.5-flash';
const GROQ_MODEL = 'llama-3.3-70b-versatile';

// Per-instance cooldown so a rate-limited key is skipped for a minute instead of
// being re-hit on every concurrent request (mirrors api/chat.js).
const cooldowns = new Map();
function isReady(id) { return Date.now() >= (cooldowns.get(id) || 0); }
function setCooldown(id, ms) { cooldowns.set(id, Date.now() + ms); }

// Read an upstream SSE stream and re-emit clean {text} events. `extractDelta`
// pulls the provider-specific text out of each parsed data line (Groq vs Gemini).
// Mid-stream read failures are caught internally so the caller never falls through
// to another provider and double-streams a reply.
async function pipeSSE(upstream, res, extractDelta) {
  const reader = upstream.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let wrote = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const p = line.slice(5).trim();
        if (!p || p === '[DONE]') continue;
        try {
          const delta = extractDelta(JSON.parse(p));
          if (delta) { res.write(`data: ${JSON.stringify({ text: delta })}\n\n`); wrote = true; }
        } catch (e) { /* partial/keepalive line — ignore */ }
      }
    }
  } catch (e) { /* upstream dropped mid-stream — keep whatever we already sent */ }
  return wrote;
}

const groqDelta = (obj) => obj.choices?.[0]?.delta?.content || '';
const geminiDelta = (obj) => obj.candidates?.[0]?.content?.parts?.map((x) => x.text).join('') || '';

async function streamGroq(apiKey, system, messages, max_tokens, res) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 30000);
  try {
    const msgs = [];
    if (system) msgs.push({ role: 'system', content: system });
    msgs.push(...(messages || []).map((m) => ({ role: m.role, content: m.content })));
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ model: GROQ_MODEL, messages: msgs, max_tokens, stream: true }),
      signal: ac.signal,
    });
    clearTimeout(timer);
    if (!r.ok || !r.body) return { ok: false, status: r.status };
    const wrote = await pipeSSE(r, res, groqDelta);
    return { ok: wrote, status: wrote ? 200 : 502 };
  } catch (err) {
    clearTimeout(timer);
    return { ok: false, status: err.name === 'AbortError' ? 408 : 500 };
  }
}

async function streamGemini(apiKey, geminiBody, res) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 30000);
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:streamGenerateContent?alt=sse&key=${apiKey}`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(geminiBody),
      signal: ac.signal,
    });
    clearTimeout(timer);
    if (!r.ok || !r.body) return { ok: false, status: r.status };
    const wrote = await pipeSSE(r, res, geminiDelta);
    return { ok: wrote, status: wrote ? 200 : 502 };
  } catch (err) {
    clearTimeout(timer);
    return { ok: false, status: err.name === 'AbortError' ? 408 : 500 };
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const geminiKeys = (process.env.GEMINI_API_KEY || '').split(',').map((k) => k.trim()).filter(Boolean);
  const groqKeys = (process.env.GROQ_API_KEY || '').split(',').map((k) => k.trim()).filter(Boolean);
  if (!geminiKeys.length && !groqKeys.length) {
    return res.status(500).json({ error: 'No API keys configured' });
  }

  const body = req.body || {};
  const { system } = body;
  const messages = body.messages;

  // --- Validate before we switch to streaming headers (so errors stay JSON) ---
  if (!Array.isArray(messages)) return res.status(400).json({ error: 'messages must be an array' });
  if (messages.length > 80) return res.status(400).json({ error: 'too many messages' });
  if (system != null && typeof system !== 'string') return res.status(400).json({ error: 'system must be a string' });
  const approxSize = (system ? system.length : 0) +
    messages.reduce((n, m) => n + (typeof m?.content === 'string' ? m.content.length : 0), 0);
  if (approxSize > 200000) return res.status(413).json({ error: 'request too large' });
  const max_tokens = Math.min(Math.max(Number(body.max_tokens) || 512, 1), 1024);

  // --- Build Gemini body (mirrors /api/chat) ---
  const contents = messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: typeof m.content === 'string' ? m.content : '' }],
  }));
  const geminiBody = {
    contents,
    generationConfig: { maxOutputTokens: max_tokens, thinkingConfig: { thinkingBudget: 0 } },
  };
  if (system) geminiBody.systemInstruction = { parts: [{ text: system }] };

  // --- Switch to SSE ---
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  if (res.flushHeaders) res.flushHeaders();

  // 1. Groq keys (fast), then 2. Gemini keys. First provider to emit a token wins.
  // Skip keys that are cooling down from a recent 429 (so 5 concurrent users don't
  // each waste a round trip re-hitting a rate-limited key), and cool a key on 429.
  for (let i = 0; i < groqKeys.length; i++) {
    const id = `groq:${i}`;
    if (!isReady(id)) continue;
    const r = await streamGroq(groqKeys[i], system, messages, max_tokens, res);
    if (r.ok) { res.write('data: [DONE]\n\n'); res.end(); return; }
    if (r.status === 429) setCooldown(id, 60000);
  }
  for (let i = 0; i < geminiKeys.length; i++) {
    const id = `gemini:${i}`;
    if (!isReady(id)) continue;
    const r = await streamGemini(geminiKeys[i], geminiBody, res);
    if (r.ok) { res.write('data: [DONE]\n\n'); res.end(); return; }
    if (r.status === 429) setCooldown(id, 60000);
  }

  res.write(`data: ${JSON.stringify({ error: 'AI is busy. Try again.' })}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}
