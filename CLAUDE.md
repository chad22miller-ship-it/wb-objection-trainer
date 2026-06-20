# WB Objection Trainer — Claude Code Setup Guide

This is a sales roleplay training app for Wealth Builders reps. It uses Google Gemini AI, Supabase for auth/database, and deploys to Vercel.

## When a user says "start" or "set up" or "help me get this running"

Automate EVERYTHING. The user is NOT a developer. They should only have to do ONE thing: get a Gemini API key and paste it. You handle the rest silently.

### Step 1: Check Node.js (silent)

Run `node --version` and `npm --version`. If either is missing, tell the user:

> You need Node.js installed. Go to https://nodejs.org, download the LTS version, install it, then restart this terminal and say "done".

Do NOT move on until Node.js is confirmed working.

### Step 2: Install dependencies (silent)

Run `npm install` automatically. Don't ask, just do it. If it fails, troubleshoot.

### Step 3: Get a Gemini API key

Open the browser for them automatically by running: `start https://aistudio.google.com/apikey` (Windows) or `open https://aistudio.google.com/apikey` (Mac).

Then tell them:

> A page just opened in your browser. Click "Create API Key", then copy the key and paste it here.

That's it — one click, one paste. Don't question the format — Gemini keys can start with `AIza` or `AQ.` or other prefixes. Save whatever they paste.

### Step 4: Create .env (silent)

Create the `.env` file automatically using the Gemini key they just pasted plus the pre-configured Supabase credentials:

```
GEMINI_API_KEY=<whatever they pasted>
VITE_SUPABASE_URL=https://vhbdiaazslhezaugmrqd.supabase.co
VITE_SUPABASE_ANON_KEY=sb_publishable_-x9TwWqvgCztnABDnmRKpA_VwndPN6W
```

Do NOT include ADMIN_EMAIL, ADMIN_PIN, or SUPABASE_SERVICE_ROLE_KEY — those are only on the team leader's deployment.

### Step 5: Deploy to Vercel (silent)

Do this automatically — don't ask if they want to deploy. Everyone gets a live URL.

1. Run `npm install -g vercel` silently
2. Run `vercel login` — tell the user:
   > A browser window is about to open. Log in to Vercel (sign up free if you don't have one), then come back here and say "done".
3. Once logged in, run `vercel --yes` to deploy with defaults (the `--yes` flag skips all prompts)
4. Read the Gemini key from the `.env` file you just created, then set all three env vars automatically:
   ```
   echo "<their GEMINI_API_KEY from .env>" | vercel env add GEMINI_API_KEY production
   echo "https://vhbdiaazslhezaugmrqd.supabase.co" | vercel env add VITE_SUPABASE_URL production
   echo "sb_publishable_-x9TwWqvgCztnABDnmRKpA_VwndPN6W" | vercel env add VITE_SUPABASE_ANON_KEY production
   ```
5. Run `vercel --prod --yes` to redeploy with the env vars active
6. Capture the production URL from the output

Then tell the user:

> You're live! Your app is at: **<their Vercel URL>**
> Open it in Chrome or Edge, create an account, and start practicing.
>
> **Important:** Use Chrome or Edge — Safari and Firefox don't support the voice features.

### Step 6: Also start locally (silent)

After deploying, also start both local servers in the background so they can use the app right away:
1. `node dev-server.mjs` (API server on port 3001)
2. `npx vite` (frontend on port 5173)

Tell the user:

> Your app is also running locally at http://localhost:5173 if you want to use it right now.

### That's it

The entire setup should take under 3 minutes. The user pastes ONE key and logs into Vercel — everything else is automatic. Do NOT ask them to create a Supabase account, run SQL, configure anything, or make any decisions.

## Project structure

- `src/App.jsx` — Main React app (roleplay, drill, call mode, debrief)
- `src/components/Admin.jsx` — PIN-protected admin dashboard
- `src/lib/api.js` — Frontend API caller (60s timeout)
- `src/lib/store.js` — Supabase/localStorage persistence layer
- `src/lib/supabase.js` — Supabase client init
- `src/lib/speech.js` — Voice calibration, pitch detection, score parsing
- `src/constants.js` — System prompts, prospect profiles, difficulty levels
- `api/chat.js` — Serverless function: proxies to Gemini API
- `api/chat-anthropic.js` — Backup: original Anthropic Claude version
- `api/admin.js` — Serverless function: PIN-protected admin data endpoint
- `dev-server.mjs` — Local dev API server (port 3001)
- `supabase-setup.sql` — Database table setup (already run — do not ask users to run this)
- `supabase-admin.sql` — Admin function setup (already run — do not ask users to run this)

## Tech stack

- Frontend: React 18 + Vite
- AI: Google Gemini 2.5 Flash (free tier, thinking disabled)
- Auth/DB: Supabase (email/password, RLS)
- Hosting: Vercel (serverless functions + static)
- Speech: Browser Web Speech API (Chrome/Edge only)

## Common issues

- "Connection error" — The API server (port 3001) isn't running. Start it with `node dev-server.mjs`.
- Speech recognition not working — Must use Chrome or Edge. Safari/Firefox don't support Web Speech API.
- Gemini 429 errors — Free tier rate limit. Wait a minute and retry.
- Debrief truncated — Increase maxOutputTokens in api/chat.js.
