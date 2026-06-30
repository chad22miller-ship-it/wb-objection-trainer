-- ONE-TIME FIX — run this in Supabase > SQL Editor > New Query, then click RUN.
--
-- Why: the sessions/settings tables had Row Level Security policies but were
-- missing table-level GRANTs to the "authenticated" role. Result: every logged-in
-- user got "permission denied for table" (Postgres error 42501), so practice
-- sessions and voice calibration never saved to the database — they fell back to
-- each rep's browser localStorage, and the admin dashboard showed 0 sessions.
-- (This typically surfaces after a project moves to the new sb_publishable_ keys.)
--
-- Safe to run more than once.

GRANT SELECT, INSERT, UPDATE, DELETE ON public.sessions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.settings TO authenticated;

-- Optional sanity check — should list the privileges above for "authenticated":
-- SELECT grantee, privilege_type, table_name
-- FROM information_schema.role_table_grants
-- WHERE table_name IN ('sessions','settings') AND grantee = 'authenticated';
