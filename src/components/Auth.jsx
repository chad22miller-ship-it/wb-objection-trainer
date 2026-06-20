import { useState } from 'react';
import { supabase } from '../lib/supabase';

export default function Auth({ onAuth }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [isSignup, setIsSignup] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(''); setLoading(true);

    if (isSignup) {
      const { data, error: err } = await supabase.auth.signUp({
        email,
        password,
        options: { data: { display_name: name } },
      });
      if (err) { setError(err.message); setLoading(false); return; }
      if (data.user) onAuth(data.user);
    } else {
      const { data, error: err } = await supabase.auth.signInWithPassword({ email, password });
      if (err) { setError(err.message); setLoading(false); return; }
      if (data.user) onAuth(data.user);
    }
    setLoading(false);
  };

  return (
    <div style={S.wrap}>
      <div style={S.card}>
        <div style={S.logo}>WB</div>
        <h1 style={S.title}>OBJECTION TRAINING</h1>
        <p style={S.sub}>{isSignup ? 'Create your account' : 'Sign in to train'}</p>

        <form onSubmit={handleSubmit} style={S.form}>
          {isSignup && (
            <input type="text" placeholder="Your name" value={name}
              onChange={(e) => setName(e.target.value)} style={S.input} required />
          )}
          <input type="email" placeholder="Email" value={email}
            onChange={(e) => setEmail(e.target.value)} style={S.input} required />
          <input type="password" placeholder="Password" value={password}
            onChange={(e) => setPassword(e.target.value)} style={S.input} required minLength={6} />

          {error && <div style={S.error}>{error}</div>}

          <button type="submit" style={S.btn} disabled={loading}>
            {loading ? 'Working…' : (isSignup ? 'Create account' : 'Sign in')}
          </button>
        </form>

        <button style={S.toggle} onClick={() => { setIsSignup(!isSignup); setError(''); }}>
          {isSignup ? 'Already have an account? Sign in' : "Don't have an account? Sign up"}
        </button>
      </div>
    </div>
  );
}

const S = {
  wrap: { minHeight: '100vh', background: '#0F1419', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 },
  card: { width: '100%', maxWidth: 380, display: 'flex', flexDirection: 'column', alignItems: 'center' },
  logo: { fontSize: 14, fontWeight: 700, letterSpacing: '3px', color: '#D4A843', border: '1px solid #D4A843', padding: '6px 14px', marginBottom: 28 },
  title: { fontSize: 24, fontWeight: 800, letterSpacing: '4px', color: '#E8E6E1', margin: '0 0 8px' },
  sub: { fontSize: 14, color: '#8899A6', margin: '0 0 28px' },
  form: { width: '100%', display: 'flex', flexDirection: 'column', gap: 12 },
  input: { width: '100%', background: '#1A2332', border: '1px solid #2A3A4A', borderRadius: 8, padding: 12, color: '#E8E6E1', fontSize: 14, fontFamily: 'inherit', outline: 'none' },
  error: { fontSize: 13, color: '#E53935', textAlign: 'center', padding: '4px 0' },
  btn: { width: '100%', background: '#D4A843', border: 'none', borderRadius: 8, padding: 14, color: '#0F1419', fontSize: 14, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', letterSpacing: '1px' },
  toggle: { marginTop: 20, background: 'none', border: 'none', color: '#8899A6', fontSize: 13, cursor: 'pointer', fontFamily: 'inherit' },
};
