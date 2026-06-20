-- Run this in Supabase > SQL Editor > New Query
-- Creates a function that the admin API endpoint calls to fetch ALL sessions.
-- This bypasses RLS safely because it runs with SECURITY DEFINER (service-role level).

CREATE OR REPLACE FUNCTION get_all_sessions()
RETURNS TABLE (
  id TEXT,
  user_id UUID,
  user_email TEXT,
  user_name TEXT,
  data JSONB,
  updated_at TIMESTAMPTZ
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    s.id,
    s.user_id,
    u.email AS user_email,
    COALESCE(u.raw_user_meta_data->>'display_name', split_part(u.email, '@', 1)) AS user_name,
    s.data,
    s.updated_at
  FROM sessions s
  JOIN auth.users u ON u.id = s.user_id
  ORDER BY s.updated_at DESC;
$$;
