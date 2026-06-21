// Vercel serverless function — multi-provider AI with automatic failover.
// Tries: Gemini (multi-key) → Groq (multi-key) → OpenRouter → Anthropic
// All free tiers. The app should never go down.

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
    const data = await res.json();
    if (res.ok) {
      const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
      return { ok: true, text };
    }
    return { ok: false, status: res.status };
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
    const data = await res.json();
    if (res.ok) {
      const text = data.choices?.[0]?.message?.content || '';
      return { ok: true, text };
    }
    return { ok: false, status: res.status };
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
    const data = await res.json();
    if (res.ok) {
      const text = data.choices?.[0]?.message?.content || '';
      return { ok: true, text };
    }
    return { ok: false, status: res.status };
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
    const data = await res.json();
    if (res.ok) {
      const text = data.content?.find((b) => b.type === 'text')?.text || '';
      return { ok: true, text };
    }
    return { ok: false, status: res.status };
  } catch (err) {
    clearTimeout(timer);
    return { ok: false, status: 500 };
  }
}

// --- Cooldown & usage tracking ---
const cooldowns = new Map();
const usage = { gemini: [], groq: [], openrouter: [], anthropic: [], startedAt: Date.now() };

function isReady(id) { return Date.now() >= (cooldowns.get(id) || 0); }
function setCooldown(id, ms) { cooldowns.set(id, Date.now() + ms); }
function trackUsage(provider) { usage[provider].push(Date.now()); }

// Daily limits per key
const LIMITS = { gemini: 1500, groq: 14400, openrouter: 10000, anthropic: 1000 };

export function getUsageStats() {
  const now = Date.now();
  const dayAgo = now - 86400000;
  const geminiKeys = (process.env.GEMINI_API_KEY || '').split(',').map((k) => k.trim()).filter(Boolean);
  const groqKeys = (process.env.GROQ_API_KEY || '').split(',').map((k) => k.trim()).filter(Boolean);

  const count = (arr) => arr.filter((t) => t > dayAgo).length;
  const geminiUsed = count(usage.gemini);
  const groqUsed = count(usage.groq);
  const openrouterUsed = count(usage.openrouter);
  const anthropicUsed = count(usage.anthropic);

  const geminiMax = geminiKeys.length * LIMITS.gemini;
  const groqMax = groqKeys.length * LIMITS.groq;
  const openrouterMax = process.env.OPENROUTER_API_KEY ? LIMITS.openrouter : 0;
  const anthropicMax = process.env.ANTHROPIC_API_KEY ? LIMITS.anthropic : 0;

  const totalUsed = geminiUsed + groqUsed + openrouterUsed + anthropicUsed;
  const totalMax = geminiMax + groqMax + openrouterMax + anthropicMax;
  const pct = totalMax > 0 ? Math.round((totalUsed / totalMax) * 100) : 0;

  // Estimate time left based on recent rate
  const recentWindow = 600000; // 10 min
  const recentAll = [...usage.gemini, ...usage.groq, ...usage.openrouter, ...usage.anthropic].filter((t) => t > now - recentWindow);
  const ratePerMin = recentAll.length / (recentWindow / 60000);
  const remaining = totalMax - totalUsed;
  const minsLeft = ratePerMin > 0 ? Math.round(remaining / ratePerMin) : null;

  return {
    totalUsed, totalMax, pct,
    ratePerMin: Math.round(ratePerMin * 10) / 10,
    minsLeft,
    providers: {
      gemini: { used: geminiUsed, max: geminiMax, keys: geminiKeys.length },
      groq: { used: groqUsed, max: groqMax, keys: groqKeys.length },
      openrouter: { used: openrouterUsed, max: openrouterMax },
      anthropic: { used: anthropicUsed, max: anthropicMax },
    },
  };
}

// --- Main handler ---

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
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
    const { system, messages, max_tokens = 2048 } = req.body;

    // --- Build Gemini body ---
    const contents = (messages || []).map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: typeof m.content === 'string' ? m.content : '' }],
    }));
    const geminiBody = { contents, generationConfig: { maxOutputTokens: max_tokens } };
    if (system) geminiBody.systemInstruction = { parts: [{ text: system }] };

    // --- 1. Try Gemini keys ---
    for (let i = 0; i < geminiKeys.length; i++) {
      const id = `gemini:${i}`;
      if (!isReady(id)) continue;
      const result = await callGemini(geminiKeys[i], geminiBody);
      if (result.ok) {
        trackUsage('gemini'); console.log(`[chat] ✓ Gemini key${i + 1}`);
        return res.status(200).json({ content: [{ type: 'text', text: result.text }] });
      }
      if (result.status === 429) setCooldown(id, 60000);
    }

    // --- 2. Try Groq keys ---
    for (let i = 0; i < groqKeys.length; i++) {
      const id = `groq:${i}`;
      if (!isReady(id)) continue;
      const result = await callGroq(groqKeys[i], system, messages, max_tokens);
      if (result.ok) {
        trackUsage('groq'); console.log(`[chat] ✓ Groq key${i + 1}`);
        return res.status(200).json({ content: [{ type: 'text', text: result.text }] });
      }
      if (result.status === 429) setCooldown(id, 60000);
    }

    // --- 3. Try OpenRouter ---
    if (openrouterKey && isReady('openrouter:0')) {
      const result = await callOpenRouter(openrouterKey, system, messages, max_tokens);
      if (result.ok) {
        trackUsage('openrouter'); console.log('[chat] ✓ OpenRouter');
        return res.status(200).json({ content: [{ type: 'text', text: result.text }] });
      }
      if (result.status === 429) setCooldown('openrouter:0', 60000);
    }

    // --- 4. Try Anthropic ---
    if (anthropicKey && isReady('anthropic:0')) {
      const result = await callAnthropic(anthropicKey, system, messages, max_tokens);
      if (result.ok) {
        trackUsage('anthropic'); console.log('[chat] ✓ Anthropic');
        return res.status(200).json({ content: [{ type: 'text', text: result.text }] });
      }
      if (result.status === 429) setCooldown('anthropic:0', 60000);
    }

    console.log('[chat] ✗ All providers exhausted');
    return res.status(429).json({ error: 'AI is busy. Wait a moment and try again.' });
  } catch (err) {
    console.error('API proxy error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}
