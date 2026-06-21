// All API calls go through /api/chat (the Vercel serverless function).
// The API key never touches the browser.
// Auto-retries on 429 (rate limit) up to 3 times with backoff.

export async function callAPI(msgs, system, { timeoutMs = 90000 } = {}) {
  const maxRetries = 3;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
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
        if (res.status === 429 && attempt < maxRetries) {
          await new Promise((r) => setTimeout(r, (attempt + 1) * 5000));
          continue;
        }
        console.error('API error:', res.status, err);
        if (res.status === 429) return '⚠️ AI is rate-limited (too many requests). Wait 30 seconds and try again.';
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
}
