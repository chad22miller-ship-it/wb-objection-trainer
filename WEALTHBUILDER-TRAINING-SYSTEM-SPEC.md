# Wealthbuilder Training System — Build Spec

> A clean rebuild of the WB Objection Trainer. This document captures every
> optimization we found reviewing the current app, so the new system is built
> right from day one instead of inheriting the old app's debt.
>
> **Source of truth:** two review passes on the current codebase
> (architecture pass + 8-lens deep sweep, 46 findings verified against real code).
> Two of the most urgent fixes were already patched on the *live* app (see below);
> everything else lives here as a requirement for the new build.

---

## 0. Already patched on the CURRENT app (not this rebuild)

These two were bleeding right now, so they were fixed on the existing app first:

1. **Chat endpoints now require a signed-in Supabase user.** `/api/chat` and
   `/api/chat-stream` verify the caller's access token (`verifyAuth` in
   `api/_shared.js`) and return 403 without one. Closes the denial-of-wallet /
   open-proxy hole. Client (`src/lib/api.js`) attaches the token automatically.
2. **iPhone/no-voice text fallback in Prospect mode.** The roleplay bottom bar
   renders a text composer when `!SPEECH_REC_SUPPORTED || IS_IOS`, so iOS reps
   can keep training by typing instead of hitting a voice-only dead end.

The new system must carry both behaviors forward (they're baked into the
requirements below: auth-gated server, universal text fallback).

---

## 1. Target architecture

| Concern | Current (old app) | New system |
|---|---|---|
| Structure | one 2,610-line `App.jsx` god component | route-level pages + feature components + custom hooks |
| Routing | `useState('home' \| 'chat' \| …)` | real router (React Router / TanStack) — every view has a URL |
| Styling | ~400 inline JS style objects | Tailwind or CSS Modules + design tokens; hover/media/dark-mode in CSS |
| State | ~55 `useState` + ~40 `useRef` in one scope | scoped per feature; a small store only where shared |
| Voice engine | recognition/synthesis/tone tangled into UI | `useVoice()` / voice-engine module, testable in isolation |
| Prompts | giant strings in `constants.js` shipped to client | **server-side**, selected by a mode enum |
| Errors | ad-hoc `setApiError` strings | React error boundaries per route + Suspense |
| Types/lint | none | ESLint + react-hooks + Prettier + `@ts-check`/TS |
| Tests | none | Vitest (speech/store/api) + Playwright (critical flows) |

**Recommended stack:** React 18 + Vite + TypeScript, React Router, Tailwind,
TanStack Query for server state, Supabase, Vercel. Keep the dependency count low.

**Port as-is (this is the product's IP — don't rewrite):**
- All system prompts (roleplay, drill, Raja, recap, redempter, debrief, hints)
- Multi-provider failover (Groq/Gemini round-robin + cooldown)
- Voice algorithms: pitch detection, tone classification, calibration, echo
  detection (`isLikelyEcho`), score parsing
- Supabase auth + RLS model

---

## 2. Security requirements

- **S1 — Auth on all AI endpoints.** Every AI route verifies a Supabase session
  server-side. No unauthenticated path to a provider key. *(Prototyped in the
  live patch; make it native here.)*
- **S2 — Server owns the system prompt.** The client sends a **mode id +
  parameters** (difficulty, prospect index, booking), never a raw `system`
  string. Kills the open-proxy abuse and stops shipping 10KB prompts to the
  browser. *(fixes: "open LLM proxy")*
- **S3 — Per-user / per-IP rate limiting.** Sliding-window limit (Vercel KV /
  Upstash) before any provider call, so one account can't drain the fleet.
- **S4 — Admin fails closed.** If the admin identity allowlist is unconfigured,
  **deny** (don't fall through to PIN-only). Add per-IP throttling + lockout on
  wrong PIN; require a long, high-entropy secret — or drop the PIN and rely on
  the email allowlist. *(fixes: "admin gate fail-open")*

---

## 3. AI cost / token requirements

- **C1 — Stable cacheable prefix.** Keep the system prompt byte-identical for a
  whole session. Move per-turn dynamics (voice-tone tag, Raja stage nudge) to
  the **tail of the latest user message**, not into `system`. Restores Gemini
  implicit prefix caching. *(fixes: "per-turn suffixes bust the cache")*
- **C2 — Pin a session to one provider key** (hash session id → key index) so
  implicit caches actually land in the same project.
- **C3 — Right-size history per mode.** Voice/drill turns need far less than 70
  messages of context (head 6 + last ~20 is plenty). Reserve full history for
  the one-shot debrief. *(fixes: "every turn re-uploads ~10-13KB + 70 msgs")*
- **C4 — Cap every seeded transcript.** Seeds and the "Watch Raja" demo must cap
  the prior transcript (head+tail, like `analyzeSession`'s 12k slice) or distill
  it to a ~500-char fact sheet. One Watch-Raja click today can burn 100k+
  tokens. *(fixes: "Watch-Raja token bomb")*

---

## 4. Data / persistence requirements

- **D1 — Structured session schema.** Real columns: `mode`, `difficulty`,
  `scores`, `duration`, `prospect_name`, `started_at`, plus the transcript. Lets
  the admin dashboard and analytics run in SQL instead of parsing JSON blobs.
- **D2 — One-query history.** Load the History list with a single
  `select(id,data,updated_at).order(updated_at desc).limit(N)` — not `list()`
  then N sequential `get()`s. Bulk-delete with one `.like('id','sess_%')`.
  *(fixes: "History N+1 fetch")*
- **D3 — Debounced saves off the reply path.** Don't full-blob upsert the whole
  transcript every turn (O(n²), and it currently blocks the spoken reply in text
  mode). Checkpoint on a debounce + guaranteed save on call-end/debrief;
  fire-and-forget with retry. Consider a `session_messages` child table.
  *(fixes: "full transcript rewritten every turn")*
- **D4 — Surface save failures.** A localStorage quota failure must not silently
  drop a turn (today it's a bare `console.warn`).
- **D5 — Soft delete + confirm.** Deleting a session needs a confirm and/or undo
  (today one mis-tap is permanent). *(see U3)*

---

## 5. Performance requirements

- **P1 — Isolate the live caption.** The interim speech transcript must not
  re-render the whole app per syllable. Write it to a DOM node via ref, or a
  memoized caption child that owns its own state. *(fixes: "interim transcript
  re-renders the tree")*
- **P2 — Scoped timer.** The session timer and calibration seconds live in tiny
  `<TimerBadge>` children, not top-level state that ticks the whole tree each
  second. *(fixes: "1s timer re-renders everything")*
- **P3 — Memoized message list + isolated composer.** A `React.memo`'d
  `<MessageList>` and a composer that owns its input, so typing doesn't
  re-render every bubble. Hoist per-role bubble styles to module scope.
  *(fixes: "every keystroke re-renders the transcript")*

---

## 6. Serverless / infra requirements

- **I1 — Shared cooldown + round-robin state.** Move key cooldowns and the RR
  counter to a shared store (Vercel KV / Upstash / small Supabase table) so
  scaled-out instances don't each re-hammer rate-limited keys or all start at
  key 0. *(fixes: "per-instance cooldown map")*
- **I2 — Real health signal.** `/api/stats` must read the shared cooldown store,
  not a per-lambda Map it never writes (today it's structurally always "ok" in
  prod — green during a real outage). Also drop the unconditional 30s poll from
  every tab; fetch on demand / only while a call is failing.
  *(fixes: "stats always ok")*
- **I3 — SSE inactivity watchdog.** Keep a watchdog armed *through* the stream:
  reset on each chunk, abort after ~15s of silence, fall through to the next
  provider when nothing was written. Prevents a stalled provider from hanging a
  live call for 90s and defeating failover. *(fixes: "SSE watchdog disarmed")*
- **I4 — One handler, no dev/prod drift.** Local dev should run the same handler
  code as prod (it does today via `dev-server.mjs` importing the handlers — keep
  that property).

---

## 7. UX / accessibility requirements

- **U1 — Universal text fallback.** Every conversational mode always offers a
  text composer, regardless of speech support. *(prototyped in the live patch)*
- **U2 — Keyboard + ARIA.** Interactive elements are real buttons with labels
  and focus states; modals trap focus and close on Escape. (Today many are
  `div`s with `onClick` and no ARIA.)
- **U3 — Safe destructive actions.** 44px minimum touch targets; delete requires
  a confirm/undo. *(fixes: "one-tap permanent delete")*
- **U4 — Contrast + responsive.** Meet WCAG AA on the palette; add tablet
  breakpoints (not just a single 600px mobile flip).
- **U5 — Installable PWA (stretch).** Manifest + service worker so reps can add
  it to their home screen and get offline-tolerant behavior. (Pairs with the
  saved-for-later ElevenLabs cloud-voice idea for iOS.)

---

## 8. Tooling / DX requirements

- **T1 — Static analysis.** ESLint + eslint-plugin-react-hooks + Prettier from
  day one; `lint` script; TypeScript (or `// @ts-check` + checkJs) to catch the
  null-access class that already shipped a prod crash. *(fixes: "no lint/types")*
- **T2 — CI gate.** Lint + typecheck + build must pass before deploy
  (`.github/workflows` or Vercel `buildCommand`).
- **T3 — Env validation at boot.** Fail fast at deploy with a clear message when
  a required env var (provider keys, Supabase) is missing — not at first request.
- **T4 — Tests.** Vitest unit coverage for `speech`, `store`, `api` failover,
  echo detection, score parsing; Playwright for login → roleplay → debrief and
  login → drill → grade.

---

## 9. Build priority (suggested order)

1. **Foundation:** repo scaffold, TS + lint + CI, router, design tokens, auth
   shell, error boundaries. (S1, T1, T2, U2)
2. **Server-side prompts + failover + shared cooldown/stats + SSE watchdog.**
   (S2, S3, I1, I2, I3)
3. **Data layer:** structured schema, one-query history, debounced saves.
   (D1–D5)
4. **Conversation UI:** memoized message list, isolated composer/caption/timer,
   universal text fallback. (P1–P3, U1, U3)
5. **Voice engine hook** + calibration/tone/echo ported over.
6. **Cost tuning:** stable prefix, per-mode history sizing, transcript caps.
   (C1–C4)
7. **Modes:** roleplay, drill, Raja + watch, redempter, debrief, history/patterns,
   admin — each as its own routed feature.
8. **Polish:** PWA, contrast/responsive, analytics. (U4, U5)

---

*Findings reference: 10 architecture-level items (first review) + 10 deep-sweep
items with 3 honorable mentions (second review), 46 of 48 candidates verified
against the real code.*
