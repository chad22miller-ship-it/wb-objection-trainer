import { useState } from 'react';
import { supabase } from '../lib/supabase';

export default function Auth({ onAuth }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [isSignup, setIsSignup] = useState(false);
  const [forgot, setForgot] = useState(false);
  const [resetSent, setResetSent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(''); setLoading(true);

    if (forgot) {
      const { error: err } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: window.location.origin,
      });
      if (err) { setError(err.message); setLoading(false); return; }
      setResetSent(true); setLoading(false);
      return;
    }

    if (isSignup) {
      const { data, error: err } = await supabase.auth.signUp({
        email,
        password,
        options: { data: { display_name: name } },
      });
      if (err) { setError(err.message); setLoading(false); return; }
      // Only proceed if a real SESSION was created. If email confirmation is on,
      // signUp returns a user but NO session — don't fake-login (that left users
      // stuck creating new accounts every visit).
      if (data.session) {
        onAuth(data.user);
      } else {
        setError('Account created — check your email to confirm it, then come back and Sign in.');
        setIsSignup(false);
      }
    } else {
      const { data, error: err } = await supabase.auth.signInWithPassword({ email, password });
      if (err) {
        setError(/not confirmed/i.test(err.message)
          ? 'Your email isn’t confirmed yet — check your inbox for the confirmation link, then sign in.'
          : err.message);
        setLoading(false);
        return;
      }
      if (data.session) onAuth(data.user);
    }
    setLoading(false);
  };

  return (
    <div style={S.wrap}>
      <div style={S.card}>
        <div style={S.logo}>WB</div>
        <h1 style={S.title}>OBJECTION TRAINING</h1>
        <p style={S.sub}>{forgot ? 'Reset your password' : isSignup ? 'Create your account' : 'Sign in to train'}</p>

        {forgot && resetSent ? (
          <>
            <div style={S.success}>📧 If an account exists for that email, a password reset link is on its way. Click it to set a new password.</div>
            <button style={S.toggle} onClick={() => { setForgot(false); setResetSent(false); setError(''); }}>← Back to sign in</button>
          </>
        ) : (
          <>
            <form onSubmit={handleSubmit} style={S.form}>
              {isSignup && !forgot && (
                <input type="text" placeholder="Your name" value={name}
                  onChange={(e) => setName(e.target.value)} style={S.input} required />
              )}
              <input type="email" placeholder="Email" value={email}
                onChange={(e) => setEmail(e.target.value)} style={S.input} required />
              {!forgot && (
                <input type="password" placeholder="Password" value={password}
                  onChange={(e) => setPassword(e.target.value)} style={S.input} required minLength={6} />
              )}

              {error && <div style={S.error}>{error}</div>}

              <button type="submit" style={S.btn} disabled={loading}>
                {loading ? 'Working…' : forgot ? 'Send reset link' : isSignup ? 'Create account' : 'Sign in'}
              </button>
            </form>

            {!isSignup && !forgot && (
              <button style={S.link} onClick={() => { setForgot(true); setError(''); }}>Forgot password?</button>
            )}

            <button style={S.toggle} onClick={() => {
              if (forgot) { setForgot(false); setError(''); }
              else { setIsSignup(!isSignup); setError(''); }
            }}>
              {forgot ? '← Back to sign in' : isSignup ? 'Already have an account? Sign in' : "Don't have an account? Sign up"}
            </button>
          </>
        )}
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
  success: { fontSize: 13, color: '#7CDC9C', textAlign: 'center', lineHeight: 1.6, padding: '8px 4px', background: '#14241A', border: '1px solid #2A4A3A', borderRadius: 8 },
  link: { marginTop: 14, background: 'none', border: 'none', color: '#6FA8DC', fontSize: 13, cursor: 'pointer', fontFamily: 'inherit' },
  btn: { width: '100%', background: '#D4A843', border: 'none', borderRadius: 8, padding: 14, color: '#0F1419', fontSize: 14, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', letterSpacing: '1px' },
  toggle: { marginTop: 20, background: 'none', border: 'none', color: '#8899A6', fontSize: 13, cursor: 'pointer', fontFamily: 'inherit' },
};
