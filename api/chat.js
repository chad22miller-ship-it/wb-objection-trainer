// Vercel serverless function — calls Google Gemini with automatic retry,
// multi-key rotation, and optional Anthropic fallback.
// Supports multiple Gemini keys via comma-separated GEMINI_API_KEY env var.

const GEMINI_MODEL = 'gemini-2.5-flash';

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
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    clearTimeout(timer);
    return { ok: false, status: err.name === 'AbortError' ? 408 : 500, data: { error: { message: err.message } } };
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
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    clearTimeout(timer);
    return { ok: false, status: 500, data: { error: { message: err.message } } };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Round-robin counter — persists across requests in the same serverless instance
let keyIndex = 0;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const geminiKeys = (process.env.GEMINI_API_KEY || '').split(',').map((k) => k.trim()).filter(Boolean);
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  if (!geminiKeys.length && !anthropicKey) {
    return res.status(500).json({ error: 'No API keys configured' });
  }

  try {
    const { system, messages, max_tokens = 2048 } = req.body;

    const contents = (messages || []).map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: typeof m.content === 'string' ? m.content : '' }],
    }));

    const geminiBody = {
      contents,
      generationConfig: {
        maxOutputTokens: max_tokens,
        thinkingConfig: { thinkingBudget: 0 },
      },
    };
    if (system) {
      geminiBody.systemInstruction = { parts: [{ text: system }] };
    }

    // Try each Gemini key, rotating start position
    if (geminiKeys.length) {
      const startIdx = keyIndex;
      for (let i = 0; i < geminiKeys.length; i++) {
        const idx = (startIdx + i) % geminiKeys.length;
        const key = geminiKeys[idx];

        // Try this key with one retry after a delay
        for (let attempt = 0; attempt < 2; attempt++) {
          const result = await callGemini(key, geminiBody);

          if (result.ok) {
            keyIndex = (idx + 1) % geminiKeys.length;
            const text = result.data.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
            return res.status(200).json({ content: [{ type: 'text', text }] });
          }

          if (result.status === 429 && attempt === 0) {
            await sleep(3000);
            continue;
          }
          break;
        }
      }
      // All keys exhausted — try one more time with a longer wait
      await sleep(10000);
      const lastKey = geminiKeys[keyIndex % geminiKeys.length];
      const lastTry = await callGemini(lastKey, geminiBody);
      if (lastTry.ok) {
        keyIndex = (keyIndex + 1) % geminiKeys.length;
        const text = lastTry.data.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
        return res.status(200).json({ content: [{ type: 'text', text }] });
      }
    }

    // Fallback to Anthropic
    if (anthropicKey) {
      const result = await callAnthropic(anthropicKey, system, messages, max_tokens);
      if (result.ok) return res.status(200).json(result.data);
      return res.status(result.status).json({ error: result.data.error?.message || 'Anthropic API error' });
    }

    return res.status(429).json({ error: 'AI is busy. Wait a moment and try again.' });
  } catch (err) {
    console.error('API proxy error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}
