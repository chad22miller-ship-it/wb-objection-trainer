// All API calls go through /api/chat (the Vercel serverless function).
// The API key never touches the browser.
// Returns a structured result so callers can distinguish a real reply from a
// failure: { ok: true, text } on success, { ok: false, error, status } on failure.
// Auto-retries on 429 and transient 5xx up to 3 times with backoff.

export async function callAPI(msgs, system, { timeoutMs = 90000 } = {}) {
  const maxRetries = 3;
  let lastError = 'Connection error. Try again.';

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
          messages: (msgs || []).map((m) => ({ role: m.role, content: m.content })),
        }),
      });

      clearTimeout(timer);

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        // 429 (busy) and transient 5xx (incl. the empty-reply 502 guard) are retryable.
        if ((res.status === 429 || res.status >= 500) && attempt < maxRetries) {
          await new Promise((r) => setTimeout(r, (attempt + 1) * 3000));
          continue;
        }
        console.error('API error:', res.status, err);
        const error = res.status === 429 ? '⚠️ AI is busy right now. Wait a moment and try again.'
          : res.status === 401 ? '⚠️ AI key problem — ask your team lead to check the API keys.'
          : res.status === 408 ? 'AI timed out. Try again.'
          : (err.error || 'Connection error. Try again.');
        return { ok: false, error, status: res.status };
      }

      const data = await res.json();
      const text = data.content?.find((b) => b.type === 'text')?.text || '';
      if (!text) {
        // Treat an empty success body like a transient miss so we don't surface a blank turn.
        if (attempt < maxRetries) { await new Promise((r) => setTimeout(r, (attempt + 1) * 3000)); continue; }
        return { ok: false, error: 'AI gave an empty reply. Try again.', status: 502 };
      }
      return { ok: true, text };
    } catch (err) {
      clearTimeout(timer);
      lastError = err.name === 'AbortError' ? 'Request timed out. Try again.' : 'Connection error. Try again.';
      console.error('API fetch error:', err);
      return { ok: false, error: lastError, status: 0 };
    }
  }
  return { ok: false, error: lastError, status: 0 };
}
