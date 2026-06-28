// Shared helpers for the chat endpoints (api/chat.js and api/chat-stream.js).
// Underscore-prefixed so Vercel never treats it as its own serverless route.

export const GEMINI_MODEL = 'gemini-2.5-flash';
export const GROQ_MODEL = 'llama-3.3-70b-versatile';
export const OPENROUTER_MODEL = 'meta-llama/llama-3.3-70b-instruct:free';

// Comma-separated env keys → trimmed list.
export const parseKeys = (name) =>
  (process.env[name] || '').split(',').map((k) => k.trim()).filter(Boolean);

// Per-instance rate-limit cooldown. Each serverless function imports its own copy
// of this module (and its own Map) — the code is shared, the state stays isolated.
const cooldowns = new Map();
export const isReady = (id) => Date.now() >= (cooldowns.get(id) || 0);
export const setCooldown = (id, ms) => cooldowns.set(id, Date.now() + ms);
export const coolingCount = (prefix, n) => {
  const now = Date.now();
  let c = 0;
  for (let i = 0; i < n; i += 1) if ((cooldowns.get(`${prefix}:${i}`) || 0) > now) c += 1;
  return c;
};

// Validate the shared chat request body. Returns { error, status } on failure, or
// { system, messages, max_tokens } on success. Endpoints pass their own token
// default/ceiling (chat: 2048/4096, chat-stream: 512/1024).
export const validateChatBody = (body, { defaultMax, maxCeil }) => {
  const { system } = body;
  const messages = body.messages;
  if (!Array.isArray(messages)) return { error: 'messages must be an array', status: 400 };
  if (messages.length > 80) return { error: 'too many messages', status: 400 };
  if (system != null && typeof system !== 'string') return { error: 'system must be a string', status: 400 };
  const approxSize = (system ? system.length : 0) +
    messages.reduce((n, m) => n + (typeof m?.content === 'string' ? m.content.length : 0), 0);
  if (approxSize > 200000) return { error: 'request too large', status: 413 };
  const max_tokens = Math.min(Math.max(Number(body.max_tokens) || defaultMax, 1), maxCeil);
  return { system, messages, max_tokens };
};

// Gemini generateContent body (thinking disabled). Used by both endpoints.
export const buildGeminiBody = (messages, system, max_tokens) => {
  const contents = messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: typeof m.content === 'string' ? m.content : '' }],
  }));
  const body = {
    contents,
    generationConfig: { maxOutputTokens: max_tokens, thinkingConfig: { thinkingBudget: 0 } },
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  return body;
};

// OpenAI-style message array (Groq / OpenRouter), prepending the system turn.
export const toOpenAIMessages = (system, messages) => {
  const msgs = [];
  if (system) msgs.push({ role: 'system', content: system });
  msgs.push(...(messages || []).map((m) => ({ role: m.role, content: m.content })));
  return msgs;
};
