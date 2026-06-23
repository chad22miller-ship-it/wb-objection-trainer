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
      return res.status(500).json({ error: 'Failed to fetch sessions' });
    }

    return res.status(200).json({ sessions: data });
  } catch (err) {
    console.error('Admin API error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}
