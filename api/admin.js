// Vercel serverless function — returns all reps' sessions for the admin dashboard.
// Protected by: (1) a verified Supabase session whose email is on the ADMIN_EMAIL
// allowlist, and (2) a PIN as a second factor (constant-time compare).
// Calls a Supabase RPC (get_all_sessions) that bypasses RLS, so this gate matters.

import { createClient } from '@supabase/supabase-js';
import crypto from 'node:crypto';

function safeEqual(a, b) {
  const ba = Buffer.from(String(a ?? ''));
  const bb = Buffer.from(String(b ?? ''));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const adminPin = process.env.ADMIN_PIN;
  if (!adminPin) {
    return res.status(500).json({ error: 'ADMIN_PIN not configured on server' });
  }

  const supabaseUrl = process.env.VITE_SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseServiceKey) {
    return res.status(500).json({ error: 'Supabase service credentials not configured' });
  }

  const adminEmails = (process.env.ADMIN_EMAIL || '')
    .split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);

  try {
    const { pin } = req.body || {};
    const serviceClient = createClient(supabaseUrl, supabaseServiceKey);

    // 1. Identity gate: require a valid logged-in Supabase session whose email is
    //    on the allowlist. (Skipped only if ADMIN_EMAIL is unset, to avoid lockout.)
    if (adminEmails.length) {
      const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
      if (!token) {
        return res.status(403).json({ error: 'Not authorized' });
      }
      const { data: userData, error: authErr } = await serviceClient.auth.getUser(token);
      const email = userData?.user?.email?.toLowerCase();
      if (authErr || !email || !adminEmails.includes(email)) {
        return res.status(403).json({ error: 'Not authorized' });
      }
    }

    // 2. Second factor: the PIN (constant-time compare).
    if (!safeEqual(pin, adminPin)) {
      return res.status(403).json({ error: 'Wrong PIN' });
    }

    const { data, error } = await serviceClient.rpc('get_all_sessions');
    if (error) {
      console.error('Admin RPC error:', error);
      return res.status(500).json({ error: 'Failed to fetch sessions', detail: error.message });
    }
    console.log(`[admin] get_all_sessions returned ${(data || []).length} rows`);
    const uniqueUsers = new Set((data || []).map((s) => s.user_id)).size;
    console.log(`[admin] unique user_ids: ${uniqueUsers}`);

    // Also return the account list (sign-ins) so the admin can see who has an
    // account and when they last logged in — including people who haven't practiced.
    let users = [];
    try {
      const { data: list } = await serviceClient.auth.admin.listUsers({ perPage: 1000 });
      users = (list?.users || []).map((u) => ({
        id: u.id,
        email: u.email,
        name: u.user_metadata?.display_name || u.user_metadata?.name || '',
        createdAt: u.created_at,
        lastSignIn: u.last_sign_in_at || null,
        confirmed: !!u.email_confirmed_at,
      }));
    } catch (e) {
      console.error('Admin listUsers error:', e);
    }

    return res.status(200).json({ sessions: data, users });
  } catch (err) {
    console.error('Admin API error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}
