// Vercel serverless function — multi-provider AI with automatic failover.
// Tries: Gemini (multi-key) → Groq (multi-key) → OpenRouter → Anthropic
// All free tiers. The app should never go down.

import { createClient } from '@supabase/supabase-js';

// Verify the caller is a signed-in user (so the public endpoint can't be used to
// drain the shared AI keys). Returns true if the bearer token is valid, OR if
// Supabase isn't configured (local dev fallback so nothing breaks without env).
async function isAuthorized(req) {
  const supabaseUrl = process.env.VITE_SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseServiceKey) return true; // not configured -> don't enforce
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return false;
  try {
    const client = createClient(supabaseUrl, supabaseServiceKey);
    const { data, error } = await client.auth.getUser(token);
    return !error && !!data?.user;
  } catch (e) {
    return false;
  }
}

const GEMINI_MODEL = 'gemini-2.5-flash';
const GROQ_MODEL = 'llama-3.3-70b-versatile';
const OPENROUTER_MODEL = 'meta-llama/llama-3.3-70b-instruct:free';

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
    const msgs = [];
    if (system) msgs.push({ role: 'system', content: system });
    msgs.push(...(messages || []).map((m) => ({ role: m.role, content: m.content })));
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

async function callOpenRouter(apiKey, system, messages, max_tokens) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 30000);
  try {
    const msgs = [];
    if (system) msgs.push({ role: 'system', content: system });
    msgs.push(...(messages || []).map((m) => ({ role: m.role, content: m.content })));
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://wb-objection-trainer.vercel.app',
      },
      body: JSON.stringify({ model: OPENROUTER_MODEL, messages: msgs, max_tokens }),
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

async function callAnthropic(apiKey, system, messages, max_tokens) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 50000);
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens,
        system: system || '',
        messages: messages || [],
      }),
      signal: ac.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return { ok: false, status: res.status };
    const data = await res.json().catch(() => null);
    const text = data?.content?.find((b) => b.type === 'text')?.text || '';
    return text ? { ok: true, text } : { ok: false, status: 502 };
  } catch (err) {
    clearTimeout(timer);
    return { ok: false, status: err.name === 'AbortError' ? 408 : 500 };
  }
}

// --- Cooldown tracking (per serverless instance) ---
const cooldowns = new Map();
const startedAt = Date.now();

function isReady(id) { return Date.now() >= (cooldowns.get(id) || 0); }
function setCooldown(id, ms) { cooldowns.set(id, Date.now() + ms); }

// Honest, per-instance overload signal. Vercel runs many isolated serverless
// instances that don't share memory, so an exact fleet-wide quota total isn't
// available here. Instead we report a simple traffic-light health based on how
// many keys are currently rate-limited (cooling down):
//   ok        = nothing rate-limited, all keys responding
//   busy      = some keys rate-limited, but a backup still has capacity
//   overloaded = no provider has a free key right now (users may see delays)
export function getUsageStats() {
  const now = Date.now();
  const geminiKeys = (process.env.GEMINI_API_KEY || '').split(',').map((k) => k.trim()).filter(Boolean);
  const groqKeys = (process.env.GROQ_API_KEY || '').split(',').map((k) => k.trim()).filter(Boolean);

  const coolingCount = (prefix, n) => {
    let c = 0;
    for (let i = 0; i < n; i++) if ((cooldowns.get(`${prefix}:${i}`) || 0) > now) c++;
    return c;
  };
  const gCool = coolingCount('gemini', geminiKeys.length);
  const qCool = coolingCount('groq', groqKeys.length);
  const orCool = (cooldowns.get('openrouter:0') || 0) > now;
  const anCool = (cooldowns.get('anthropic:0') || 0) > now;

  const geminiFree = geminiKeys.length > 0 && gCool < geminiKeys.length;
  const groqFree = groqKeys.length > 0 && qCool < groqKeys.length;
  const orFree = !!process.env.OPENROUTER_API_KEY && !orCool;
  const anFree = !!process.env.ANTHROPIC_API_KEY && !anCool;

  const anythingFree = geminiFree || groqFree || orFree || anFree;
  const anyCooling = gCool + qCool + (orCool ? 1 : 0) + (anCool ? 1 : 0) > 0;
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

  // Require a signed-in user (skipped automatically if Supabase isn't configured).
  if (!(await isAuthorized(req))) {
    return res.status(401).json({ error: 'Please sign in again.' });
  }

  const geminiKeys = (process.env.GEMINI_API_KEY || '').split(',').map((k) => k.trim()).filter(Boolean);
  const groqKeys = (process.env.GROQ_API_KEY || '').split(',').map((k) => k.trim()).filter(Boolean);
  const openrouterKey = process.env.OPENROUTER_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  const totalProviders = geminiKeys.length + groqKeys.length + (openrouterKey ? 1 : 0) + (anthropicKey ? 1 : 0);
  if (!totalProviders) {
    return res.status(500).json({ error: 'No API keys configured' });
  }

  try {
    const body = req.body || {};
    const { system } = body;
    const messages = body.messages;

    // --- Input validation (reject abusive/malformed payloads with a clean 400) ---
    if (!Array.isArray(messages)) {
      return res.status(400).json({ error: 'messages must be an array' });
    }
    if (messages.length > 80) {
      return res.status(400).json({ error: 'too many messages' });
    }
    if (system != null && typeof system !== 'string') {
      return res.status(400).json({ error: 'system must be a string' });
    }
    // Cap total payload so a huge paste/transcript can't be used to burn quota.
    const approxSize = (system ? system.length : 0) +
      messages.reduce((n, m) => n + (typeof m?.content === 'string' ? m.content.length : 0), 0);
    if (approxSize > 200000) {
      return res.status(413).json({ error: 'request too large' });
    }
    // Clamp output tokens to a sane ceiling regardless of what the client asked for.
    const max_tokens = Math.min(Math.max(Number(body.max_tokens) || 2048, 1), 4096);

    // --- Build Gemini body ---
    const contents = messages.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: typeof m.content === 'string' ? m.content : '' }],
    }));
    const geminiBody = {
      contents,
      generationConfig: { maxOutputTokens: max_tokens, thinkingConfig: { thinkingBudget: 0 } },
    };
    if (system) geminiBody.systemInstruction = { parts: [{ text: system }] };

    // Track the most relevant failure so a real outage/bad-key/timeout isn't
    // mislabeled as a rate limit. allRateLimited stays true only if every
    // attempted provider returned 429.
    let lastStatus;
    let allRateLimited = true;
    const note = (s) => { lastStatus = s; if (s !== 429) allRateLimited = false; };

    // --- 1. Try Gemini keys ---
    for (let i = 0; i < geminiKeys.length; i++) {
      const id = `gemini:${i}`;
      if (!isReady(id)) continue;
      const result = await callGemini(geminiKeys[i], geminiBody);
      if (result.ok) {
        console.log(`[chat] ✓ Gemini key${i + 1}`);
        return res.status(200).json({ content: [{ type: 'text', text: result.text }] });
      }
      if (result.status === 429) setCooldown(id, 60000);
      note(result.status);
    }

    // --- 2. Try Groq keys ---
    for (let i = 0; i < groqKeys.length; i++) {
      const id = `groq:${i}`;
      if (!isReady(id)) continue;
      const result = await callGroq(groqKeys[i], system, messages, max_tokens);
      if (result.ok) {
        console.log(`[chat] ✓ Groq key${i + 1}`);
        return res.status(200).json({ content: [{ type: 'text', text: result.text }] });
      }
      if (result.status === 429) setCooldown(id, 60000);
      note(result.status);
    }

    // --- 3. Try OpenRouter ---
    if (openrouterKey && isReady('openrouter:0')) {
      const result = await callOpenRouter(openrouterKey, system, messages, max_tokens);
      if (result.ok) {
        console.log('[chat] ✓ OpenRouter');
        return res.status(200).json({ content: [{ type: 'text', text: result.text }] });
      }
      if (result.status === 429) setCooldown('openrouter:0', 60000);
      note(result.status);
    }

    // --- 4. Try Anthropic ---
    if (anthropicKey && isReady('anthropic:0')) {
      const result = await callAnthropic(anthropicKey, system, messages, max_tokens);
      if (result.ok) {
        console.log('[chat] ✓ Anthropic');
        return res.status(200).json({ content: [{ type: 'text', text: result.text }] });
      }
      if (result.status === 429) setCooldown('anthropic:0', 60000);
      note(result.status);
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
