// BACKUP — original Anthropic version of /api/chat.
// To restore: rename this file to chat.js (and rename the Gemini chat.js to chat-gemini.js).
// Vercel serverless function — keeps the Anthropic API key on the server side.
// The browser calls /api/chat, this function forwards to Anthropic with the key.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured on server' });
  }

  try {
    const { system, messages, max_tokens = 1000 } = req.body;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
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
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({ error: data.error?.message || 'Anthropic API error' });
    }

    return res.status(200).json(data);
  } catch (err) {
    console.error('API proxy error:', err);
    return res.status(500).json({ error: 'Server error calling Anthropic' });
  }
}
