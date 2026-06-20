import { supabase } from './supabase';

// Storage layer: tries Supabase first, falls back to localStorage.
// Supabase table: "sessions" with columns: id (text PK), user_id (uuid FK), data (jsonb), created_at
// Supabase table: "settings" with columns: id (text PK), user_id (uuid FK), data (jsonb)

async function getUserId() {
  if (!supabase) return null;
  const { data } = await supabase.auth.getUser();
  return data?.user?.id || null;
}

export const store = {
  async set(key, val) {
    // Try Supabase
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
    // Fallback: localStorage
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
    // Fallback
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
    // Fallback
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
