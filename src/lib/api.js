// All Anthropic API calls go through /api/chat (the Vercel serverless function).
// The API key never touches the browser.

export async function callAPI(msgs, system, { timeoutMs = 60000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        system,
        messages: msgs.map((m) => ({ role: m.role, content: m.content })),
      }),
    });

    clearTimeout(timer);

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      console.error('API error:', res.status, err);
      return 'Connection error. Try again.';
    }

    const data = await res.json();
    return data.content?.find((b) => b.type === 'text')?.text || '...';
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') return 'Request timed out. Try again.';
    console.error('API fetch error:', err);
    return 'Connection error. Try again.';
  }
}
