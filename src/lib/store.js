import { supabase } from './supabase';

// Storage layer: tries Supabase first, falls back to localStorage.
// Supabase table: "sessions" with columns: id (text PK), user_id (uuid FK), data (jsonb), updated_at
// Supabase table: "settings" with columns: id (text PK), user_id (uuid FK), data (jsonb)

async function getUserId() {
  if (!supabase) return null;
  // getSession() returns the cached local token — no network round-trip.
  // getUser() makes a server request every time, which can time out and silently drop the save to localStorage.
  const { data } = await supabase.auth.getSession();
  return data?.session?.user?.id || null;
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
  const { data } = await supabase.auth.getSession();
  const userId = data?.session?.user?.id;
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
