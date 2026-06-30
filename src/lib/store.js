import { supabase } from './supabase';

// Storage layer: tries Supabase first, falls back to localStorage.
// Supabase table: "sessions" with columns: id (text PK), user_id (uuid FK), data (jsonb), updated_at
// Supabase table: "settings" with columns: id (text PK), user_id (uuid FK), data (jsonb)

async function getUserId() {
  if (!supabase) return null;
  // getSession() returns the cached local token — no network round-trip.
  // getUser() makes a server request every time, which can time out and silently drop the save to localStorage.
  const { data } = await supabase.auth.getSession();
  const session = data?.session;
  if (!session) return null;
  // CRITICAL: the cached token expires (~1h). If we write with an expired token the
  // DB rejects it ("JWT expired") and the save silently falls back to localStorage —
  // which is why sessions stopped showing up server-side. If the token is expired or
  // within 2 min of it, force a refresh before using it for a write.
  const expMs = (session.expires_at || 0) * 1000;
  if (expMs && expMs - Date.now() < 120000) {
    try {
      const { data: refreshed } = await supabase.auth.refreshSession();
      return refreshed?.session?.user?.id || session.user?.id || null;
    } catch (e) {
      return session.user?.id || null;
    }
  }
  return session.user?.id || null;
}

export const store = {
  async set(key, val) {
    const userId = await getUserId();
    if (supabase && userId) {
      const table = key.startsWith('sess_') ? 'sessions' : 'settings';
      const { error } = await supabase.from(table).upsert({
        id: key,
        user_id: userId,
        data: val,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'id' });
      if (!error) return;
      console.warn('Supabase write failed, using localStorage:', error.message);
    }
    try {
      localStorage.setItem(key, JSON.stringify(val));
    } catch (e) {
      console.warn('localStorage write failed:', e);
    }
  },

  async get(key) {
    const userId = await getUserId();
    if (supabase && userId) {
      const table = key.startsWith('sess_') ? 'sessions' : 'settings';
      const { data, error } = await supabase.from(table).select('data').eq('id', key).eq('user_id', userId).single();
      if (!error && data) return data.data;
    }
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  },

  async list(prefix) {
    const userId = await getUserId();
    if (supabase && userId) {
      const table = prefix.startsWith('sess_') ? 'sessions' : 'settings';
      const { data, error } = await supabase.from(table)
        .select('id')
        .eq('user_id', userId)
        .like('id', `${prefix}%`);
      if (!error && data) return data.map((r) => r.id);
    }
    try {
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(prefix)) keys.push(k);
      }
      return keys;
    } catch (e) { return []; }
  },

  async del(key) {
    const userId = await getUserId();
    if (supabase && userId) {
      const table = key.startsWith('sess_') ? 'sessions' : 'settings';
      await supabase.from(table).delete().eq('id', key).eq('user_id', userId);
    }
    try { localStorage.removeItem(key); } catch (e) {}
  },
};

// On login: push any sessions sitting in localStorage up to Supabase so the
// admin can see them. Runs silently — failures are ignored.
export async function migrateLocalSessionsToSupabase() {
  if (!supabase) return;
  // Use the same fresh-token guard as writes — a stale token here would 401 the
  // whole migration and leave the sessions stranded in localStorage.
  const userId = await getUserId();
  if (!userId) return;

  const keys = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith('sess_')) keys.push(k);
    }
  } catch (e) { return; }

  if (keys.length === 0) return;
  console.log(`[store] migrating ${keys.length} localStorage session(s) to Supabase`);

  for (const key of keys) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const val = JSON.parse(raw);
      const { error } = await supabase.from('sessions').upsert({
        id: key,
        user_id: userId,
        data: val,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'id' });
      if (!error) {
        localStorage.removeItem(key);
        console.log(`[store] migrated ${key}`);
      }
    } catch (e) { /* skip */ }
  }
}
