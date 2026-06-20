// Vercel serverless function — calls Google Gemini and returns a response
// shaped like Anthropic's so the frontend (src/lib/api.js) needs no changes.
// The API key never touches the browser.
//
// To switch back to Anthropic Claude: see api/chat-anthropic.js for the original.

const GEMINI_MODEL = 'gemini-2.5-flash';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'GEMINI_API_KEY not configured on server' });
  }

  try {
    const { system, messages, max_tokens = 2048 } = req.body;

    const contents = (messages || []).map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: typeof m.content === 'string' ? m.content : '' }],
    }));

    const body = {
      contents,
      generationConfig: {
        maxOutputTokens: max_tokens,
        // gemini-2.5-flash is a "thinking" model — without this, thinking tokens
        // eat the maxOutputTokens budget and long replies (debrief, drill grading,
        // pattern analysis) come back truncated or empty. 0 disables thinking.
        thinkingConfig: { thinkingBudget: 0 },
      },
    };
    if (system) {
      body.systemInstruction = { parts: [{ text: system }] };
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 50000);
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    clearTimeout(timer);

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({ error: data.error?.message || 'Gemini API error' });
    }

    const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';

    return res.status(200).json({
      content: [{ type: 'text', text }],
    });
  } catch (err) {
    console.error('API proxy error:', err);
    if (err.name === 'AbortError') {
      return res.status(504).json({ error: 'Gemini took too long. Try again.' });
    }
    return res.status(500).json({ error: 'Server error calling Gemini' });
  }
}
