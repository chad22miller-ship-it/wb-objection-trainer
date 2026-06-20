// Vercel serverless function — returns all reps' sessions for the admin dashboard.
// Protected by a PIN code. Calls a Supabase RPC function (get_all_sessions) that bypasses RLS.

import { createClient } from '@supabase/supabase-js';

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

  try {
    const { pin } = req.body;
    if (!pin || pin !== adminPin) {
      return res.status(403).json({ error: 'Wrong PIN' });
    }

    const serviceClient = createClient(supabaseUrl, supabaseServiceKey);
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
