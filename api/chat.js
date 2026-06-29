// Vercel serverless function — multi-provider AI with automatic failover.
// Tries: Gemini (multi-key) → Groq (multi-key) → OpenRouter → Anthropic
// All free tiers. The app should never go down.

import {
  GEMINI_MODEL, GROQ_MODEL,
  parseKeys, isReady, setCooldown, coolingCount, roundRobin, leastCooledIndex,
  validateChatBody, buildGeminiBody, toOpenAIMessages,
} from './_shared.js';

// --- Provider call functions ---

async function callGemini(apiKey, body) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 25000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return { ok: false, status: res.status };
    const data = await res.json().catch(() => null);
    const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
    // Empty text (e.g. budget eaten by thinking, or a safety block) => treat as a
    // miss so the failover loop moves on instead of returning a blank reply.
    return text ? { ok: true, text } : { ok: false, status: 502 };
  } catch (err) {
    clearTimeout(timer);
    return { ok: false, status: err.name === 'AbortError' ? 408 : 500 };
  }
}

async function callGroq(apiKey, system, messages, max_tokens) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 25000);
  try {
    const msgs = toOpenAIMessages(system, messages);
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ model: GROQ_MODEL, messages: msgs, max_tokens }),
      signal: ac.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return { ok: false, status: res.status };
    const data = await res.json().catch(() => null);
    const text = data?.choices?.[0]?.message?.content || '';
    return text ? { ok: true, text } : { ok: false, status: 502 };
  } catch (err) {
    clearTimeout(timer);
    return { ok: false, status: err.name === 'AbortError' ? 408 : 500 };
  }
}


// --- Cooldown tracking (per serverless instance) — helpers live in _shared.js ---
const startedAt = Date.now();

// Honest, per-instance overload signal. Vercel runs many isolated serverless
// instances that don't share memory, so an exact fleet-wide quota total isn't
// available here. Instead we report a simple traffic-light health based on how
// many keys are currently rate-limited (cooling down):
//   ok        = nothing rate-limited, all keys responding
//   busy      = some keys rate-limited, but a backup still has capacity
//   overloaded = no provider has a free key right now (users may see delays)
export function getUsageStats() {
  const now = Date.now();
  const geminiKeys = parseKeys('GEMINI_API_KEY');
  const groqKeys = parseKeys('GROQ_API_KEY');

  const gCool = coolingCount('gemini', geminiKeys.length);
  const qCool = coolingCount('groq', groqKeys.length);

  const geminiFree = geminiKeys.length > 0 && gCool < geminiKeys.length;
  const groqFree = groqKeys.length > 0 && qCool < groqKeys.length;

  const anythingFree = geminiFree || groqFree;
  const anyCooling = gCool + qCool > 0;
  const health = !anythingFree ? 'overloaded' : anyCooling ? 'busy' : 'ok';

  return {
    scope: 'instance',
    health,
    gemini: { cooling: gCool, total: geminiKeys.length },
    groq: { cooling: qCool, total: groqKeys.length },
    sinceMins: Math.round((now - startedAt) / 60000),
  };
}

// --- Main handler ---

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const geminiKeys = parseKeys('GEMINI_API_KEY');
  const groqKeys = parseKeys('GROQ_API_KEY');

  const totalProviders = geminiKeys.length + groqKeys.length;
  if (!totalProviders) {
    return res.status(500).json({ error: 'No API keys configured' });
  }

  try {
    const body = req.body || {};
    const v = validateChatBody(body, { defaultMax: 2048, maxCeil: 4096 });
    if (v.error) return res.status(v.status).json({ error: v.error });
    const { system, messages, max_tokens } = v;

    const geminiBody = buildGeminiBody(messages, system, max_tokens);

    // Track the most relevant failure so a real outage/bad-key/timeout isn't
    // mislabeled as a rate limit. allRateLimited stays true only if every
    // attempted provider returned 429.
    let lastStatus;
    let allRateLimited = true;
    const note = (s) => { lastStatus = s; if (s !== 429) allRateLimited = false; };

    // --- 1. Try Groq keys (round-robin, least-cooled fallback) ---
    {
      const start = roundRobin('groq', groqKeys.length);
      let tried = false;
      for (let j = 0; j < groqKeys.length; j++) {
        const i = (start + j) % groqKeys.length;
        const id = `groq:${i}`;
        if (!isReady(id)) continue;
        tried = true;
        const result = await callGroq(groqKeys[i], system, messages, max_tokens);
        if (result.ok) {
          console.log(`[chat] ✓ Groq key${i + 1}`);
          return res.status(200).json({ content: [{ type: 'text', text: result.text }] });
        }
        if (result.status === 429) setCooldown(id, 60000);
        note(result.status);
      }
      if (!tried && groqKeys.length > 0) {
        const i = leastCooledIndex('groq', groqKeys.length);
        const result = await callGroq(groqKeys[i], system, messages, max_tokens);
        if (result.ok) {
          console.log(`[chat] ✓ Groq key${i + 1} (recovered)`);
          return res.status(200).json({ content: [{ type: 'text', text: result.text }] });
        }
        if (result.status === 429) setCooldown(`groq:${i}`, 60000);
        note(result.status);
      }
    }

    // --- 2. Try Gemini keys (round-robin, least-cooled fallback) ---
    {
      const start = roundRobin('gemini', geminiKeys.length);
      let tried = false;
      for (let j = 0; j < geminiKeys.length; j++) {
        const i = (start + j) % geminiKeys.length;
        const id = `gemini:${i}`;
        if (!isReady(id)) continue;
        tried = true;
        const result = await callGemini(geminiKeys[i], geminiBody);
        if (result.ok) {
          console.log(`[chat] ✓ Gemini key${i + 1}`);
          return res.status(200).json({ content: [{ type: 'text', text: result.text }] });
        }
        if (result.status === 429) setCooldown(id, 60000);
        note(result.status);
      }
      if (!tried && geminiKeys.length > 0) {
        const i = leastCooledIndex('gemini', geminiKeys.length);
        const result = await callGemini(geminiKeys[i], geminiBody);
        if (result.ok) {
          console.log(`[chat] ✓ Gemini key${i + 1} (recovered)`);
          return res.status(200).json({ content: [{ type: 'text', text: result.text }] });
        }
        if (result.status === 429) setCooldown(`gemini:${i}`, 60000);
        note(result.status);
      }
    }

    console.log('[chat] ✗ All providers exhausted, lastStatus=', lastStatus);
    if (allRateLimited) {
      return res.status(429).json({ error: 'AI is busy. Wait a moment and try again.' });
    }
    const msg = lastStatus === 401 ? 'AI auth failed (bad or expired key).'
      : lastStatus === 408 ? 'AI timed out.'
      : lastStatus === 400 ? 'Bad request to AI.'
      : 'AI service error.';
    return res.status(lastStatus || 500).json({ error: msg, reason: 'all_providers_failed' });
  } catch (err) {
    console.error('API proxy error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}
