-- Run this SQL in your Supabase project > SQL Editor > New Query

-- Sessions table (stores practice sessions)
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  data JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Settings table (stores voice calibration, preferences)
CREATE TABLE IF NOT EXISTS settings (
  id TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  data JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Row Level Security: each user only sees their own data
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users see own sessions" ON sessions
  FOR ALL USING (auth.uid() = user_id);

CREATE POLICY "Users see own settings" ON settings
  FOR ALL USING (auth.uid() = user_id);

-- Table-level privileges for logged-in users. RLS decides WHICH ROWS a user can
-- touch; these GRANTs decide whether the "authenticated" role may touch the table
-- at all. WITHOUT THESE, every logged-in request fails with
--   42501 "permission denied for table ..."
-- and the app silently falls back to localStorage (so the admin sees 0 sessions).
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sessions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.settings TO authenticated;

-- Indexes for fast lookups
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_settings_user ON settings(user_id);
