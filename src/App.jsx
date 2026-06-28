import { useState, useRef, useEffect, useCallback } from 'react';
import { supabase } from './lib/supabase';
import { store } from './lib/store';
import { callAPI, callAPIStream } from './lib/api';
import {
  cleanForSpeech, chunkText, clamp, median, autoCorrelate,
  parseScores, parseDebriefScores,
  CALIB_PHRASE, CALIB_WORDS, REF_HZ, BASELINE_WPM,
} from './lib/speech';
import {
  SYSTEM_ROLEPLAY, SYSTEM_DRILL, SYSTEM_RAJA, SYSTEM_RAJA_RECAP, SYSTEM_REDEMPTER, SYSTEM_DEBRIEF,
  ROLEPLAY_DIFF, DRILL_DIFF, HINT_STRATEGY, HINT_WORDS, PATTERN_PROMPT,
  PROSPECT_PROFILES, DIFFICULTY_META, diffMeta,
} from './constants';
import Auth from './components/Auth';
import Admin from './components/Admin';

/* ============================== MAIN APP ============================== */

// Live call mode: keep replies short and spoken-sounding, and let the prospect
// barge in (talk over the AI) like a real phone call. AUTO_BARGE works best with
// headphones — on laptop speakers the mic can hear the AI and self-interrupt;
// flip to false to disable.
const AUTO_BARGE = true;
const CALL_BREVITY = "\n\nVOICE CALL MODE: You are on a live phone call. Talk like a real person — reply in 1 to 2 short, natural spoken sentences. No lists, no markdown, no stage directions. Get to the point fast and let them respond. If a progress tag like [WHY_PROGRESS:n] is required, put it at the very end after your spoken words.";

// Web Speech voices don't expose gender, so we infer it from the voice name.
// These cover the common Windows (SAPI), Edge "Online (Natural)", and Chrome
// Google voices Chad's users will have. Used to match the prospect's gender.
const FEMALE_VOICE_NAMES = ['zira', 'samantha', 'victoria', 'karen', 'moira', 'tessa', 'fiona', 'susan', 'catherine', 'hazel', 'serena', 'allison', 'ava', 'kate', 'linda', 'heather', 'aria', 'jenny', 'michelle', 'ana', 'sara', 'nancy', 'jane', 'ashley', 'amber', 'emma', 'sonia', 'nora', 'jessa', 'clara', 'libby', 'maisie'];
const MALE_VOICE_NAMES = ['david', 'mark', 'alex', 'daniel', 'fred', 'tom', 'george', 'paul', 'aaron', 'arthur', 'guy', 'christopher', 'eric', 'brandon', 'jason', 'tony', 'davis', 'andrew', 'brian', 'steffan', 'ryan', 'oliver', 'william', 'rishi', 'roger', 'thomas'];
const voiceGender = (name) => {
  const n = (name || '').toLowerCase();
  if (/\bfemale\b/.test(n)) return 'female';
  if (/\bmale\b/.test(n)) return 'male';
  if (FEMALE_VOICE_NAMES.some((x) => n.includes(x))) return 'female';
  if (MALE_VOICE_NAMES.some((x) => n.includes(x))) return 'male';
  return null;
};

// Keep the API payload bounded on long (20-min+) calls: send only the most recent
// turns (the persona/profile lives in the system prompt, so older turns aren't
// needed for consistency). Full history is still kept in state for the debrief.
const trimForApi = (msgs, keep = 30) => {
  if (msgs.length <= keep) return msgs;
  let t = msgs.slice(-keep);
  while (t.length && t[0].role !== 'user') t = t.slice(1); // APIs expect history to start on a user turn
  return t;
};


function ResetPassword({ onDone }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (password.length < 6) { setError('Password must be at least 6 characters.'); return; }
    if (password !== confirm) { setError('Passwords do not match.'); return; }
    setLoading(true); setError('');
    const { error: err } = await supabase.auth.updateUser({ password });
    if (err) { setError(err.message); setLoading(false); return; }
    setDone(true); setLoading(false);
  };

  return (
    <div style={RS.wrap}>
      <div style={RS.card}>
        <div style={RS.logo}>WB</div>
        <h1 style={RS.title}>SET A NEW PASSWORD</h1>
        {done ? (
          <>
            <div style={RS.success}>✅ Password updated — you're signed in.</div>
            <button style={RS.btn} onClick={onDone}>Continue to the app</button>
          </>
        ) : (
          <form onSubmit={submit} style={RS.form}>
            <input type="password" placeholder="New password" value={password} onChange={(e) => setPassword(e.target.value)} style={RS.input} required minLength={6} autoFocus />
            <input type="password" placeholder="Confirm new password" value={confirm} onChange={(e) => setConfirm(e.target.value)} style={RS.input} required minLength={6} />
            {error && <div style={RS.error}>{error}</div>}
            <button type="submit" style={RS.btn} disabled={loading}>{loading ? 'Saving…' : 'Update password'}</button>
          </form>
        )}
      </div>
    </div>
  );
}

const RS = {
  wrap: { minHeight: '100vh', background: '#0F1419', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 },
  card: { width: '100%', maxWidth: 380, display: 'flex', flexDirection: 'column', alignItems: 'center' },
  logo: { fontSize: 14, fontWeight: 700, letterSpacing: '3px', color: '#D4A843', border: '1px solid #D4A843', padding: '6px 14px', marginBottom: 28 },
  title: { fontSize: 20, fontWeight: 800, letterSpacing: '3px', color: '#E8E6E1', margin: '0 0 24px', textAlign: 'center' },
  form: { width: '100%', display: 'flex', flexDirection: 'column', gap: 12 },
  input: { width: '100%', background: '#1A2332', border: '1px solid #2A3A4A', borderRadius: 8, padding: 12, color: '#E8E6E1', fontSize: 14, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box' },
  error: { fontSize: 13, color: '#E53935', textAlign: 'center', padding: '4px 0' },
  success: { fontSize: 14, color: '#7CDC9C', textAlign: 'center', lineHeight: 1.6, marginBottom: 16 },
  btn: { width: '100%', background: '#D4A843', border: 'none', borderRadius: 8, padding: 14, color: '#0F1419', fontSize: 14, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', letterSpacing: '1px' },
};

export default function App() {
  const [user, setUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [recovery, setRecovery] = useState(false);

  // Check for existing session on mount
  useEffect(() => {
    if (!supabase) { setAuthLoading(false); return; }
    // Arrived via a password-reset link? Show the set-new-password screen.
    if (typeof window !== 'undefined' && window.location.hash.includes('type=recovery')) {
      setRecovery(true);
    }
    supabase.auth.getSession().then(({ data }) => {
      setUser(data.session?.user || null);
      setAuthLoading(false);
    });
    const { data: listener } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'PASSWORD_RECOVERY') setRecovery(true);
      setUser(session?.user || null);
    });
    return () => listener?.subscription?.unsubscribe();
  }, []);

  if (authLoading) {
    return <div style={{ minHeight: '100vh', background: '#0F1419', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#8899A6' }}>Loading…</div>;
  }

  // Password-recovery flow takes priority over the normal sign-in gate.
  if (recovery) {
    return <ResetPassword onDone={() => {
      setRecovery(false);
      if (typeof window !== 'undefined') window.history.replaceState(null, '', window.location.pathname);
    }} />;
  }

  // If Supabase is configured, require auth. Otherwise run without auth (local dev).
  if (supabase && !user) {
    return <Auth onAuth={setUser} />;
  }

  return <Trainer user={user} />;
}

function Trainer({ user }) {
  const [view, setView] = useState('home');
  const [mode, setMode] = useState(null);
  const [difficulty, setDifficulty] = useState(3);
  const [profileIdx, setProfileIdx] = useState(0);

  const [messages, setMessages] = useState([]);
  const [rounds, setRounds] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);

  // FIX #1: messagesRef prevents stale closures in call mode
  const messagesRef = useRef([]);
  useEffect(() => { messagesRef.current = messages; }, [messages]);
  const roundsRef = useRef([]);
  useEffect(() => { roundsRef.current = rounds; }, [rounds]);

  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const [voices, setVoices] = useState([]);
  const [selectedVoiceName, setSelectedVoiceName] = useState('');
  const [isListening, setIsListening] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);

  const [calib, setCalib] = useState({ done: false, pitch: 1.0, rate: 1.0, hz: null, wpm: null });
  const [calibrating, setCalibrating] = useState(false);
  const [calibStatus, setCalibStatus] = useState('idle');
  const [calibError, setCalibError] = useState('');
  const [recSeconds, setRecSeconds] = useState(0);

  const [callMode, setCallMode] = useState(false);
  const [callState, setCallState] = useState('idle');
  const [liveTranscript, setLiveTranscript] = useState('');
  const [callError, setCallError] = useState('');

  const [settingsOpen, setSettingsOpen] = useState(false);
  // How long the live call waits after you stop talking before the prospect replies (ms).
  // Silence window after you stop talking before the prospect replies. New storage
  // key (v2) so the snappier 1s default replaces the old 2s value people had saved.
  const [pauseGrace, setPauseGrace] = useState(() => {
    try { const v = Number(localStorage.getItem('wb_pause_grace3')); if (v >= 400 && v <= 5000) return v; } catch (e) {}
    return 1500;
  });
  const [hintOpen, setHintOpen] = useState(false);
  const [hintMenu, setHintMenu] = useState(false);
  const [hintType, setHintType] = useState('');
  const [hintText, setHintText] = useState('');
  const [hintLoading, setHintLoading] = useState(false);

  // Session timer
  const [elapsed, setElapsed] = useState(0);
  const elapsedRef = useRef(null);

  // Roleplay debrief
  const [debriefText, setDebriefText] = useState('');
  const [debriefScores, setDebriefScores] = useState(null);
  const [debriefLoading, setDebriefLoading] = useState(false);
  const [showDebrief, setShowDebrief] = useState(false);
  // Watch-Raja demo: two AIs (Raja + the SAME prospect) auto-play the call while the user just observes.
  const [watchMode, setWatchMode] = useState(false);
  const [watchMsgs, setWatchMsgs] = useState([]); // [{ speaker: 'raja' | 'prospect', content }]
  const [watchThinking, setWatchThinking] = useState(null); // 'raja' | 'prospect' | null
  const [watchDone, setWatchDone] = useState(false);
  const [watchName, setWatchName] = useState('');
  const [whyProgress, setWhyProgress] = useState(0);
  const [drillProgress, setDrillProgress] = useState(0);
  const [isSeeded, setIsSeeded] = useState(false); // roleplay seeded with a prior Raja call
  const [apiError, setApiError] = useState(''); // transient banner for a failed AI request

  // API usage stats
  const [apiUsage, setApiUsage] = useState(null);

  // Redempter — paste a real objection or transcript, get Raja-style coaching
  const [redempterOpen, setRedempterOpen] = useState(false);
  const [redempterInput, setRedempterInput] = useState('');
  const [redempterResult, setRedempterResult] = useState('');
  const [redempterLoading, setRedempterLoading] = useState(false);

  const [history, setHistory] = useState([]);
  const [expanded, setExpanded] = useState(null);
  const [patternText, setPatternText] = useState('');
  const [patternLoading, setPatternLoading] = useState(false);
  const [showPattern, setShowPattern] = useState(false);

  const chatEndRef = useRef(null);
  const watchEndRef = useRef(null);
  const inputRef = useRef(null);
  const synthRef = useRef(null);
  const voicesRef = useRef([]);
  const userPickedVoiceRef = useRef(false); // true once the user manually selects a voice
  const recognitionRef = useRef(null);
  const sessionRef = useRef({ id: null, startedAt: null });
  const calibRef = useRef({ pitch: 1.0, rate: 1.0 });
  const audioCtxRef = useRef(null);
  const micStreamRef = useRef(null);
  const pitchSamplesRef = useRef([]);
  const recStartRef = useRef(0);
  const samplerRef = useRef(null);
  const timerRef = useRef(null);
  const callActiveRef = useRef(false);
  const callRecRef = useRef(null);
  const silenceTimerRef = useRef(null);
  const handleTurnRef = useRef(null);
  const startListeningRef = useRef(null);
  // Live-call streaming speech queue: sentences are spoken as they arrive from the
  // model instead of waiting for the whole reply. Refs (not state) to avoid re-renders.
  const sqItemsRef = useRef([]);      // pending sentences to speak
  const sqSpeakingRef = useRef(false); // is an utterance currently playing
  const sqDoneRef = useRef(false);     // has the model stream finished
  const sqDrainRef = useRef(null);     // callback to fire when queue empties AND stream done
  const lastSpokenRef = useRef('');    // what the AI is currently saying — used to ignore mic echo
  const bargeRecRef = useRef(null);    // recognizer that listens while the AI speaks (barge-in)
  const callStateRef = useRef('idle'); // mirror of callState for use inside async callbacks
  const turnIdRef = useRef(0);         // bumps each turn so a stale stream can't speak over a new one
  const modeRef = useRef(null);
  const difficultyRef = useRef(3);
  const profileIdxRef = useRef(0);
  const seedRef = useRef(null); // prior-call transcript when replaying as the rep
  const seedProfileRef = useRef(null); // prospect's full hidden profile (PPF) carried into a switched Raja call
  const offTrackHelpedRef = useRef(false); // auto-hint fired once per off-track streak
  const debriefRunningRef = useRef(false); // re-entry guard so a debrief can't double-fire
  const whyEstablishedRef = useRef(false); // Raja: once the why is in, push the call forward (phase nudge)
  const pauseGraceRef = useRef(1500); // live-call silence window (ms) before auto-send; mirrors pauseGrace state
  const watchStopRef = useRef(false); // lets the user stop the Watch-Raja auto-play mid-run

  useEffect(() => { modeRef.current = mode; }, [mode]);
  useEffect(() => { callStateRef.current = callState; }, [callState]);
  useEffect(() => { pauseGraceRef.current = pauseGrace; try { localStorage.setItem('wb_pause_grace3', String(pauseGrace)); } catch (e) {} }, [pauseGrace]);
  useEffect(() => { difficultyRef.current = difficulty; }, [difficulty]);
  useEffect(() => { profileIdxRef.current = profileIdx; }, [profileIdx]);

  /* ---------- voice setup ---------- */
  useEffect(() => {
    synthRef.current = window.speechSynthesis;
    const pickDefault = (vs) => {
      // Prefer Edge's high-quality "Online (Natural)" voices, then any neural voice,
      // before falling back to the robotic built-in (SAPI) voices.
      const pref = ['Online (Natural)', 'Natural', 'Neural', 'Google US English', 'Aria', 'Jenny', 'Guy', 'Samantha', 'Ava'];
      for (const p of pref) { const f = vs.find((v) => v.lang.startsWith('en') && v.name.includes(p)); if (f) return f; }
      return vs.find((v) => v.lang.startsWith('en')) || vs[0];
    };
    const load = () => {
      if (!synthRef.current) return;
      const vs = synthRef.current.getVoices().filter((v) => v.lang.startsWith('en'));
      voicesRef.current = vs;
      setVoices(vs);
      // Auto-upgrade to the best default when voices load (Edge's natural voices arrive
      // late), unless the user has explicitly picked one in settings.
      setSelectedVoiceName((prev) => (userPickedVoiceRef.current && prev ? prev : (pickDefault(vs)?.name || prev || '')));
    };
    load();
    if (synthRef.current) synthRef.current.onvoiceschanged = load;
    (async () => {
      const saved = await store.get('voice_calib');
      if (saved && saved.done) { setCalib(saved); calibRef.current = { pitch: saved.pitch, rate: saved.rate }; }
    })();
    return () => {
      if (synthRef.current) synthRef.current.cancel();
      if (recognitionRef.current) recognitionRef.current.abort();
      if (samplerRef.current) clearInterval(samplerRef.current);
      if (timerRef.current) clearInterval(timerRef.current);
      if (micStreamRef.current) micStreamRef.current.getTracks().forEach((t) => t.stop());
      if (audioCtxRef.current) audioCtxRef.current.close().catch(() => {});
    };
  }, []);

  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, hintText, debriefText, showDebrief, hintOpen]);
  useEffect(() => { if (watchMode) watchEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [watchMsgs, watchThinking, watchMode]);

  // Poll API usage stats
  useEffect(() => {
    const fetchStats = () => fetch('/api/stats').then((r) => r.json()).then(setApiUsage).catch(() => {});
    fetchStats();
    const iv = setInterval(fetchStats, 30000);
    return () => clearInterval(iv);
  }, []);

  const pickVoice = useCallback(() => {
    const vs = voicesRef.current;
    if (!vs || !vs.length) return null;
    const en = vs.filter((v) => v.lang && v.lang.toLowerCase().startsWith('en'));
    const pool = en.length ? en : vs;

    // Whose voice are we speaking? Match the character's gender:
    //   Raja = male; roleplay prospect = the profile's gender. (Drill / seeded = no
    //   known gender, so fall back to the user's chosen voice / default.)
    let want = null;
    if (modeRef.current === 'raja') want = 'male';
    else if (modeRef.current === 'roleplay' && !seedRef.current) {
      want = PROSPECT_PROFILES[profileIdxRef.current]?.gender || null;
    }

    if (want) {
      const matches = pool.filter((v) => voiceGender(v.name) === want);
      if (matches.length) {
        // Honor a manually-chosen voice only if it's the right gender.
        if (selectedVoiceName) { const f = matches.find((v) => v.name === selectedVoiceName); if (f) return f; }
        // Otherwise prefer the most natural-sounding US voice of that gender.
        const score = (v) => {
          const n = v.name.toLowerCase(); let s = 0;
          if (/(natural|neural|online)/.test(n)) s += 4;
          if (/google/.test(n)) s += 2;
          if (v.lang && v.lang.toLowerCase() === 'en-us') s += 1;
          return s;
        };
        return matches.slice().sort((a, b) => score(b) - score(a))[0];
      }
      // No voice of the wanted gender exists on this device — fall through to default.
    }

    if (selectedVoiceName) { const f = pool.find((v) => v.name === selectedVoiceName); if (f) return f; }
    return pool[0];
  }, [selectedVoiceName]);

  const stopSpeaking = useCallback(() => {
    if (synthRef.current) synthRef.current.cancel();
    setIsSpeaking(false);
  }, []);

  // Build a configured utterance (voice + calibrated rate/pitch). onEnd runs on both
  // natural end and error so callers advance their queue either way. Shared by speak()
  // and the streaming speech queue (pumpSpeech).
  const makeUtterance = useCallback((text, onEnd) => {
    const u = new SpeechSynthesisUtterance(text);
    const v = pickVoice(); if (v) u.voice = v;
    u.rate = calibRef.current.rate || 1.0;
    u.pitch = calibRef.current.pitch || 1.0;
    u.onend = onEnd;
    u.onerror = onEnd;
    return u;
  }, [pickVoice]);

  const speak = useCallback((text, onDone) => {
    if (!voiceEnabled || !synthRef.current) { if (onDone) onDone(); return; }
    synthRef.current.cancel();
    const chunks = chunkText(cleanForSpeech(text));
    setIsSpeaking(true);
    let i = 0;
    const next = () => {
      if (i >= chunks.length) { setIsSpeaking(false); if (onDone) onDone(); return; }
      synthRef.current.speak(makeUtterance(chunks[i], () => { i += 1; next(); }));
    };
    next();
  }, [voiceEnabled, makeUtterance]);

  /* ---------- streaming speech queue (live call mode) ---------- */
  // Plays queued sentences one after another. New sentences can be pushed mid-playback,
  // so the AI starts talking on sentence #1 while #2+ are still being generated.
  const pumpSpeech = useCallback(() => {
    const items = sqItemsRef.current;
    if (!items.length) {
      sqSpeakingRef.current = false;
      if (sqDoneRef.current && sqDrainRef.current) { const cb = sqDrainRef.current; sqDrainRef.current = null; cb(); }
      return;
    }
    sqSpeakingRef.current = true;
    const text = items.shift();
    if (synthRef.current) synthRef.current.speak(makeUtterance(text, () => pumpSpeech())); else pumpSpeech();
  }, [makeUtterance]);

  const resetSpeechQueue = useCallback(() => {
    sqItemsRef.current = [];
    sqDoneRef.current = false;
    sqDrainRef.current = null;
    sqSpeakingRef.current = false;
    lastSpokenRef.current = '';
    if (synthRef.current) synthRef.current.cancel();
  }, []);

  const enqueueSpeak = useCallback((text) => {
    if (!voiceEnabled || !synthRef.current) return;
    const t = (text || '').trim();
    if (!t) return;
    // Remember the AI's words so the barge-in recognizer can tell its own echo
    // (heard back through the speakers) from the user actually interrupting.
    lastSpokenRef.current = (lastSpokenRef.current + ' ' + t).slice(-600);
    sqItemsRef.current.push(t);
    if (!sqSpeakingRef.current) pumpSpeech();
  }, [voiceEnabled, pumpSpeech]);

  // Tell the queue the model is done streaming. onDrain fires once everything queued
  // has actually been spoken (or immediately if nothing is left to say).
  const finishSpeechStream = useCallback((onDrain) => {
    sqDoneRef.current = true;
    sqDrainRef.current = onDrain || null;
    if (!sqSpeakingRef.current && !sqItemsRef.current.length) {
      sqDrainRef.current = null;
      if (onDrain) onDrain();
    }
  }, []);

  /* ---------- barge-in: listen while the AI is speaking ---------- */
  const stopBargeListen = useCallback(() => {
    if (bargeRecRef.current) { try { bargeRecRef.current.abort(); } catch (e) {} bargeRecRef.current = null; }
  }, []);

  const startBargeListen = useCallback((speakSince) => {
    if (!AUTO_BARGE) return;
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return;
    stopBargeListen();
    const r = new SR();
    r.continuous = true; r.interimResults = true; r.lang = 'en-US'; r.maxAlternatives = 1;
    const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
    r.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i += 1) {
        if (!e.results[i].isFinal) continue;
        const txt = (e.results[i][0].transcript || '').trim();
        const words = txt.split(/\s+/).filter(Boolean).length;
        // Echo guard: if what we "heard" is just the AI's own words coming back
        // through the speakers, ignore it (this is what self-interrupts on laptops).
        const heard = norm(txt);
        if (heard && norm(lastSpokenRef.current).includes(heard)) continue;
        // Only treat it as a real interruption if the AI has been talking for a beat
        // and the listener heard a genuine phrase (≥2 words) — keeps speaker echo from
        // self-interrupting while still triggering on a quick "wait, stop".
        if (callActiveRef.current && callStateRef.current === 'speaking'
            && (Date.now() - speakSince) > 800 && words >= 2) {
          // Cut the AI off immediately, then hand what you've said so far into the
          // normal listening loop — it keeps listening and only replies once you
          // actually stop talking (instead of jumping in after the first few words).
          stopBargeListen();
          resetSpeechQueue();
          turnIdRef.current += 1; // invalidate the interrupted reply
          setCallState('listening');
          if (startListeningRef.current) startListeningRef.current(txt);
          return;
        }
      }
    };
    r.onerror = () => {};
    r.onend = () => {};
    bargeRecRef.current = r;
    try { r.start(); } catch (e) {}
  }, [stopBargeListen, resetSpeechQueue]);

  /* ---------- voice calibration ---------- */
  const applyCalib = useCallback((next) => {
    calibRef.current = { pitch: next.pitch, rate: next.rate };
    setCalib(next);
    store.set('voice_calib', next);
  }, []);

  const setPitchManual = useCallback((p) => applyCalib({ ...calib, done: true, pitch: clamp(p, 0.5, 2.0) }), [calib, applyCalib]);
  const setRateManual = useCallback((r) => applyCalib({ ...calib, done: true, rate: clamp(r, 0.5, 1.6) }), [calib, applyCalib]);
  const resetCalib = useCallback(() => applyCalib({ done: false, pitch: 1.0, rate: 1.0, hz: null, wpm: null }), [applyCalib]);

  const cleanupMic = useCallback(() => {
    if (samplerRef.current) { clearInterval(samplerRef.current); samplerRef.current = null; }
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    if (micStreamRef.current) { micStreamRef.current.getTracks().forEach((t) => t.stop()); micStreamRef.current = null; }
    if (audioCtxRef.current) { audioCtxRef.current.close().catch(() => {}); audioCtxRef.current = null; }
  }, []);

  const openCalibration = useCallback(() => {
    stopSpeaking();
    if (recognitionRef.current) recognitionRef.current.abort();
    setCalibError(''); setCalibStatus('idle'); setRecSeconds(0); setCalibrating(true); setSettingsOpen(false);
  }, [stopSpeaking]);

  const closeCalibration = useCallback(() => { cleanupMic(); setCalibrating(false); setCalibStatus('idle'); setRecSeconds(0); }, [cleanupMic]);

  const beginRecord = useCallback(async () => {
    setCalibError('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStreamRef.current = stream;
      const Ctx = window.AudioContext || window.webkitAudioContext;
      const ctx = new Ctx(); audioCtxRef.current = ctx;
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser(); analyser.fftSize = 2048;
      src.connect(analyser);
      const buf = new Float32Array(analyser.fftSize);
      pitchSamplesRef.current = [];
      recStartRef.current = Date.now();
      setRecSeconds(0); setCalibStatus('recording');
      samplerRef.current = setInterval(() => {
        analyser.getFloatTimeDomainData(buf);
        const f = autoCorrelate(buf, ctx.sampleRate);
        if (f > 0) pitchSamplesRef.current.push(f);
      }, 90);
      timerRef.current = setInterval(() => setRecSeconds(Math.round((Date.now() - recStartRef.current) / 1000)), 250);
    } catch (e) {
      setCalibError("Couldn't reach your mic. Check browser mic permission and try again.");
      setCalibStatus('error'); cleanupMic();
    }
  }, [cleanupMic]);

  const stopRecord = useCallback(() => {
    const durationSec = (Date.now() - recStartRef.current) / 1000;
    const samples = pitchSamplesRef.current.slice();
    cleanupMic(); setCalibStatus('analyzing');
    if (durationSec < 1.5 || samples.length < 8) {
      setCalibError('Didn\'t catch enough. Read the full line out loud, then tap Stop.');
      setCalibStatus('error'); return;
    }
    const hz = median(samples);
    const wpm = CALIB_WORDS / (durationSec / 60);
    const pitch = clamp(hz / REF_HZ, 0.6, 1.8);
    const rate = clamp(wpm / BASELINE_WPM, 0.7, 1.5);
    const next = { done: true, pitch: Math.round(pitch * 100) / 100, rate: Math.round(rate * 100) / 100, hz: Math.round(hz), wpm: Math.round(wpm) };
    applyCalib(next); setCalibStatus('done');
  }, [cleanupMic, applyCalib]);

  const testCalibVoice = useCallback(() => {
    if (!synthRef.current) return;
    synthRef.current.cancel();
    const u = new SpeechSynthesisUtterance("Hey, thanks for jumping on. I'm curious — what made you take this call today?");
    const v = pickVoice(); if (v) u.voice = v;
    u.rate = calibRef.current.rate || 1.0; u.pitch = calibRef.current.pitch || 1.0;
    synthRef.current.speak(u);
  }, [pickVoice]);

  /* ---------- hands-free call mode ---------- */
  // seed = words already captured before this recognizer started (e.g. from a
  // barge-in). We keep listening and only send once the user actually pauses, so
  // the prospect replies to the WHOLE thought, not just the first few words.
  startListeningRef.current = (seed = '') => {
    if (!callActiveRef.current) return;
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { setCallState('error'); setCallError('No speech recognition. Open in Chrome/Edge.'); return; }
    if (callRecRef.current) { try { callRecRef.current.abort(); } catch (e) {} }
    if (silenceTimerRef.current) { clearTimeout(silenceTimerRef.current); silenceTimerRef.current = null; }
    const r = new SR();
    r.continuous = true;
    r.interimResults = true;
    r.lang = 'en-US';
    r.maxAlternatives = 1;
    let buf = seed ? seed.trim() + ' ' : '';
    if (buf) setLiveTranscript(buf.trim());
    // Send `buf` after the silence window. Re-armed on every new bit of speech, so
    // it only fires once the user has stopped talking.
    const scheduleSend = (ms) => {
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = setTimeout(() => {
        if (!callActiveRef.current) return;
        const said = buf.trim();
        if (said.length > 1) {
          if (callRecRef.current) { try { callRecRef.current.abort(); } catch (e) {} callRecRef.current = null; }
          if (handleTurnRef.current) handleTurnRef.current(said);
        }
      }, ms);
    };
    r.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i += 1) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) buf += t + ' '; else interim += t;
      }
      setLiveTranscript((buf + interim).trim());
      scheduleSend(pauseGraceRef.current || 1000);
    };
    r.onerror = (ev) => {
      if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') {
        callActiveRef.current = false; setCallState('error');
        setCallError('Microphone is blocked. Allow mic access in your browser and try again.');
      } else if (ev.error === 'network') {
        callActiveRef.current = false; setCallState('error');
        setCallError('Speech recognition lost network. Check your connection and try again.');
      } else if (ev.error === 'no-speech') {
        // no-speech is not fatal — just restart
      }
    };
    r.onend = () => {
      if (!callActiveRef.current) return;
      if (silenceTimerRef.current) return; // a send is already scheduled — let the grace timer fire
      // Recognition ended with no pending send. Do NOT send now — Chrome ends mid-pause
      // and sending here cuts the user off mid-thought. Restart listening, carrying what
      // was said so far as a seed, so they can keep talking; the silence timer (with the
      // full grace window) is the only thing that actually sends a turn.
      const said = buf.trim();
      setTimeout(() => {
        if (callActiveRef.current && startListeningRef.current) startListeningRef.current(said.length > 1 ? said : '');
      }, 150);
    };
    callRecRef.current = r;
    try {
      r.start();
      // If we started with seeded words (a barge-in), arm a slightly longer initial
      // window so a continued sentence has time to register before we'd send the seed alone.
      if (buf) scheduleSend(Math.max(pauseGraceRef.current || 1000, 1300));
    } catch (e) {
      setTimeout(() => { if (callActiveRef.current && startListeningRef.current) startListeningRef.current(); }, 300);
    }
  };

  // FIX #1 continued: handleTurn reads from refs, not stale state.
  // Streaming version: speaks each sentence the moment it's complete, then listens
  // again as soon as the spoken queue drains. myTurn guards against a slow stream
  // speaking over a newer turn (e.g. after a barge-in).
  handleTurnRef.current = async (text) => {
    if (!callActiveRef.current) return;
    const myTurn = (turnIdRef.current += 1);
    setCallState('thinking'); setLiveTranscript('');
    resetSpeechQueue();
    let speakSince = 0;
    let started = false;
    const reply = await sendTextStreamingFromRef(text, {
      turnId: myTurn,
      onSentence: (s) => {
        if (!callActiveRef.current || turnIdRef.current !== myTurn) return;
        if (!started) {
          started = true;
          speakSince = Date.now();
          setCallState('speaking');
          startBargeListen(speakSince);
        }
        enqueueSpeak(s);
      },
    });
    if (!callActiveRef.current || turnIdRef.current !== myTurn) return;
    if (reply == null) {
      stopBargeListen();
      setCallState('listening');
      if (startListeningRef.current) startListeningRef.current();
      return;
    }
    finishSpeechStream(() => {
      if (!callActiveRef.current || turnIdRef.current !== myTurn) return;
      stopBargeListen();
      setCallState('listening');
      if (startListeningRef.current) startListeningRef.current();
    });
  };

  const startCall = useCallback(async () => {
    if (typeof window === 'undefined') return;
    setCallError('');
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { setCallMode(true); setCallState('error'); setCallError('Live voice needs Chrome or Edge.'); return; }
    stopSpeaking(); setHintMenu(false); setSettingsOpen(false);
    setCallMode(true); setCallState('connecting');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
    } catch (e) {
      setCallState('error'); setCallError("Couldn't get mic access. Allow microphone in your browser settings."); return;
    }
    callActiveRef.current = true;
    setCallState('listening'); setLiveTranscript('');
    setTimeout(() => { if (startListeningRef.current) startListeningRef.current(); }, 250);
  }, [stopSpeaking]);

  const endCall = useCallback(() => {
    callActiveRef.current = false;
    turnIdRef.current += 1; // invalidate any in-flight stream
    if (silenceTimerRef.current) { clearTimeout(silenceTimerRef.current); silenceTimerRef.current = null; }
    if (callRecRef.current) { try { callRecRef.current.abort(); } catch (e) {} callRecRef.current = null; }
    stopBargeListen();
    resetSpeechQueue();
    stopSpeaking();
    setCallMode(false); setCallState('idle'); setLiveTranscript(''); setCallError('');
  }, [stopSpeaking, stopBargeListen, resetSpeechQueue]);

  // Manual interrupt (tap the speaking indicator): stop talking and listen now.
  const bargeIn = useCallback(() => {
    if (callState !== 'speaking') return;
    turnIdRef.current += 1; // invalidate the in-flight stream so it can't resume speaking
    stopBargeListen();
    resetSpeechQueue();
    stopSpeaking();
    setCallState('listening');
    if (startListeningRef.current) startListeningRef.current();
  }, [callState, stopSpeaking, stopBargeListen, resetSpeechQueue]);

  /* ---------- push-to-talk (text mode) ---------- */
  const startListening = useCallback(() => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { alert('Speech recognition needs Chrome or Edge.'); return; }
    stopSpeaking();
    const r = new SR();
    r.continuous = true;
    r.interimResults = true;
    r.lang = 'en-US';
    r.maxAlternatives = 1;
    let buf = '';
    r.onstart = () => setIsListening(true);
    r.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i += 1) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) buf += t + ' '; else interim += t;
      }
      setInput((buf + interim).trim());
    };
    r.onend = () => setIsListening(false);
    r.onerror = () => setIsListening(false);
    recognitionRef.current = r; r.start();
  }, [stopSpeaking]);

  const stopListening = useCallback(() => {
    if (recognitionRef.current) recognitionRef.current.stop();
    setIsListening(false);
  }, []);

  /* ---------- system prompt builder ---------- */
  const buildSystem = useCallback((m, diff, pIdx) => {
    if (m === 'drill') return SYSTEM_DRILL + '\n\n' + DRILL_DIFF[diff];
    if (m === 'raja') {
      let sys = SYSTEM_RAJA;
      if (seedRef.current) {
        // Replaying a Prospect call: Raja now sells the SAME client the trainee just practiced on.
        sys += '\n\nSEEDED CLIENT — the person you are calling is the SAME client from the prior call below, where a trainee rep was practicing on them. Their situation and the WHY that came up are in the transcript. Run YOUR masterful call on this same client: greet them warmly and draw out their story and deep WHY through your invitational, "tell me more" style — demonstrate how a master uncovers what the trainee was reaching for. The user is now playing this client.';
        if (seedProfileRef.current) {
          // Carry the prospect's full hidden profile (PPF) so it's the SAME person with the SAME details,
          // not just whatever happened to be spoken aloud in the prior call.
          sys += '\n\nWHO THIS CLIENT REALLY IS (their full background — stay 100% consistent with this exact person and these exact details; the user is playing them, so treat anything they say as coming from this character):\n' + seedProfileRef.current;
        }
        sys += '\n\nPRIOR CALL (the client is the PROSPECT in it):\n' + seedRef.current;
      }
      return sys;
    }
    let sys = SYSTEM_ROLEPLAY + '\n\n' + ROLEPLAY_DIFF[diff];
    if (seedRef.current) {
      // Replaying a Raja call: BE the same client, now the trainee runs discovery.
      sys += '\n\nSEEDED STORY — CRITICAL: You are the SAME client from the call below, where a master rep named Raja was selling to YOU. Become that exact client — same name if one was given, same job/money/family details, and the SAME deep emotional WHY you revealed. A trainee rep is now going to run the call and try to uncover everything Raja uncovered. Stay 100% consistent with the story below, but make them EARN it like a real person would: reveal your situation and your WHY only as they ask good, caring, layered questions. Do not dump it all at once. If they get pushy, pitch early, or skip discovery, get guarded and pull back.\n\nPRIOR CALL (you are the CLIENT in it):\n' + seedRef.current;
    } else {
      sys += '\n\nYOUR SPECIFIC PROFILE:\n' + PROSPECT_PROFILES[pIdx].profile;
    }
    return sys;
  }, []);

  /* ---------- save session ---------- */
  const saveSession = useCallback(async (msgs, rnds, extra = {}) => {
    const meta = sessionRef.current;
    if (!meta.id) return;
    // Once a debrief has been saved for this session, keep it on every later write so a
    // racing turn-save can't silently drop it (store.set is a full overwrite, not a merge).
    const keepDebrief = (extra.debrief == null && meta.debrief != null)
      ? { debrief: meta.debrief, debriefScores: meta.debriefScores } : {};
    await store.set(meta.id, {
      id: meta.id, startedAt: meta.startedAt, mode: meta.mode, difficulty: meta.difficulty,
      profileIdx: meta.profileIdx,
      prospectName: meta.prospectName,
      prospectVibe: meta.prospectVibe,
      messages: msgs, rounds: rnds,
      ...keepDebrief,
      ...extra,
    });
    if (extra.debrief != null) { meta.debrief = extra.debrief; meta.debriefScores = extra.debriefScores; }
  }, []);

  /* ---------- session timer ---------- */
  const startTimer = useCallback(() => {
    setElapsed(0);
    if (elapsedRef.current) clearInterval(elapsedRef.current);
    const start = Date.now();
    elapsedRef.current = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 1000);
  }, []);
  const stopTimer = useCallback(() => { if (elapsedRef.current) { clearInterval(elapsedRef.current); elapsedRef.current = null; } }, []);
  const formatTime = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

  /* ---------- session start ---------- */
  const startSession = useCallback(async (m, diff, seed = null) => {
    stopSpeaking(); stopTimer();
    const id = 'sess_' + Date.now();
    const pIdx = Math.floor(Math.random() * PROSPECT_PROFILES.length);
    const prospect = PROSPECT_PROFILES[pIdx];

    seedRef.current = seed || null;
    if (!seed) seedProfileRef.current = null; // fresh menu start — drop any carried prospect profile
    setIsSeeded(!!seed);
    offTrackHelpedRef.current = false;
    whyEstablishedRef.current = false;

    sessionRef.current = {
      id, startedAt: new Date().toISOString(), mode: m, difficulty: diff,
      profileIdx: pIdx,
      // When seeded (replaying a prior call) the random profile name is irrelevant — don't store it.
      prospectName: seed ? null : prospect.name,
      prospectVibe: seed ? null : prospect.vibe,
    };

    setMode(m); setDifficulty(diff); setProfileIdx(pIdx); setView('chat');
    setMessages([]); setRounds([]); setInput('');
    setHintOpen(false); setHintMenu(false); setHintText(''); setSettingsOpen(false);
    setShowDebrief(false); setDebriefText(''); setDebriefScores(null); setWhyProgress(0); setDrillProgress(0); setApiError('');
    debriefRunningRef.current = false;
    setLoading(true); startTimer();

    if (m === 'roleplay') {
      // FIX #2: NO auto-opener. The rep types/speaks their own first line.
      // We just show a prompt telling them to open the call.
      setMessages([]);
      setLoading(false);
    } else {
      const result = await callAPI([{ role: 'user', content: "I'm ready. Let's go." }], buildSystem(m, diff, pIdx));
      if (result.ok) {
        const opener = stripProgressTags(result.text).clean;
        const msgs = [{ role: 'assistant', content: opener }];
        setMessages(msgs); await saveSession(msgs, []); speak(opener);
      } else {
        setApiError(result.error || 'Could not start the session. Try again.');
      }
      setLoading(false);
    }
  }, [buildSystem, saveSession, speak, stopSpeaking, startTimer, stopTimer]);

  /* ---------- WHY progress parsing ---------- */
  const stripProgressTags = useCallback((text) => {
    const whyMatch = text.match(/\[WHY_PROGRESS:(\d+)\]/);
    const drillMatch = text.match(/\[DRILL_PROGRESS:(\d+)\]/);
    const whyScore = whyMatch ? parseInt(whyMatch[1], 10) : null;
    const drillScore = drillMatch ? parseInt(drillMatch[1], 10) : null;
    const clean = text.replace(/\s*\[(WHY_PROGRESS|DRILL_PROGRESS):\d+\]\s*/g, '').trim();
    return { clean, whyScore, drillScore };
  }, []);

  // Raja phase nudge: once the why is established, inject a one-line directive (this reply
  // only) that pushes the call forward — quantify, then confirm/reframe/close — so Raja
  // can't loop in discovery. Returns '' for other modes or before the why is established.
  const rajaStageNudge = (msgs) => {
    if (modeRef.current !== 'raja' || !whyEstablishedRef.current) return '';
    const userText = msgs.filter((m) => m.role === 'user').map((m) => m.content).join('  ');
    const lastRaja = [...msgs].reverse().find((m) => m.role === 'assistant')?.content || '';
    // Already running the close/booking? Let it finish naturally.
    if (/new art of living|hollywood|minutes right now|tomorrow at|five pm|six pm|book (a|you)|get a time/i.test(lastRaja)) return '';
    const gaveNumber = /\$\s?\d|\d+\s*(k\b|grand|thousand|hundred)|\ba month\b/i.test(userText);
    return gaveNumber
      ? "\n\nDIRECTIVE (THIS REPLY ONLY): The emotional why is established and the client has given a dollar number. Move the call FORWARD now — briefly confirm the number, reframe that this was never about the money but about their dream, then run your full New Art of Living close and book a specific time. Do NOT ask another discovery or feelings question."
      : "\n\nDIRECTIVE (THIS REPLY ONLY): The client's emotional why is clearly established. STOP discovery — your NEXT move is to QUANTIFY: ask them what dollar amount a month would make that dream real. Do NOT ask another feelings question.";
  };

  // Shared post-processing for a model reply (text + streaming paths): strip the
  // hidden progress tags, update the WHY/drill progress UI, persist, and return the
  // clean reply text. Callers do their own stale-guard before calling this.
  const finalizeReply = useCallback(async (rawText, newMsgs) => {
    const { clean, whyScore, drillScore } = stripProgressTags(rawText);
    if ((modeRef.current === 'roleplay' || modeRef.current === 'raja') && whyScore != null) {
      setWhyProgress(whyScore);
      if (modeRef.current === 'raja' && whyScore >= 7) whyEstablishedRef.current = true;
    }
    if (modeRef.current === 'drill' && drillScore != null) setDrillProgress(drillScore);
    const finalMsgs = [...newMsgs, { role: 'assistant', content: clean }];
    setMessages(finalMsgs);
    let nextRounds = roundsRef.current;
    if (modeRef.current === 'drill') {
      const s = parseScores(clean);
      if (s) { nextRounds = [...nextRounds, s]; setRounds(nextRounds); }
    }
    await saveSession(finalMsgs, nextRounds);
    setLoading(false);
    return clean;
  }, [saveSession, stripProgressTags]);

  /* ---------- send (ref-based for call mode) ---------- */
  const sendTextFromRef = useCallback(async (text) => {
    const t = (text || '').trim();
    if (!t) return null;
    stopSpeaking();
    setApiError('');

    const sid = sessionRef.current.id;
    const curMsgs = messagesRef.current;
    const userMsg = { role: 'user', content: t };
    const newMsgs = [...curMsgs, userMsg];
    setMessages(newMsgs); setLoading(true);

    const sys = buildSystem(modeRef.current, difficultyRef.current, profileIdxRef.current) + rajaStageNudge(newMsgs);
    const result = await callAPI(
      trimForApi(newMsgs).map((m) => ({ role: m.role, content: m.content })),
      sys
    );

    // Drop the reply if the session was switched/restarted mid-request (stale-write guard).
    if (sessionRef.current.id !== sid) { setLoading(false); return null; }
    // Real failure: surface it, don't store/speak/persist an error as a prospect turn.
    if (!result.ok) {
      setApiError(result.error || 'Something went wrong. Try again.');
      setLoading(false);
      return null;
    }

    return finalizeReply(result.text, newMsgs);
  }, [buildSystem, stopSpeaking, finalizeReply]);

  /* ---------- send (streaming, for live call mode) ---------- */
  // Same brain and post-processing as sendTextFromRef, but streams the reply and
  // hands each completed sentence to onSentence so it can be spoken immediately.
  const sendTextStreamingFromRef = useCallback(async (text, { onSentence, turnId } = {}) => {
    const t = (text || '').trim();
    if (!t) return null;
    stopSpeaking();
    setApiError('');

    const sid = sessionRef.current.id;
    // Stale if the session restarted OR a newer turn took over (e.g. a barge-in).
    const stale = () => sessionRef.current.id !== sid || (turnId != null && turnIdRef.current !== turnId);
    const curMsgs = messagesRef.current;
    const userMsg = { role: 'user', content: t };
    const newMsgs = [...curMsgs, userMsg];
    setMessages(newMsgs); setLoading(true);

    // Drill grades every answer in a fixed "OVERALL: X/10" block. The call-mode
    // brevity rule suppresses it and the fast Groq stream mangles it, so drill skips
    // both — see the isDrill branch below.
    const isDrill = modeRef.current === 'drill';
    const sys = buildSystem(modeRef.current, difficultyRef.current, profileIdxRef.current) + rajaStageNudge(newMsgs) + (isDrill ? '' : CALL_BREVITY);
    const apiMsgs = trimForApi(newMsgs).map((m) => ({ role: m.role, content: m.content }));

    // Pull complete sentences out of the growing raw text and speak them. Progress
    // tags like [WHY_PROGRESS:n] are stripped from spoken audio (kept in raw for parsing).
    let raw = '';
    let spokenIdx = 0;
    const sentenceRe = /[.!?]+["')\]]*\s/g; // scanned from spokenIdx via lastIndex — no per-token buffer copy
    const flush = (final) => {
      sentenceRe.lastIndex = spokenIdx;
      let m;
      while ((m = sentenceRe.exec(raw))) {
        const end = m.index + m[0].length;
        const spoken = cleanForSpeech(raw.slice(spokenIdx, end).replace(/\[[^\]]*\]/g, ' '));
        spokenIdx = end;
        sentenceRe.lastIndex = spokenIdx;
        if (spoken && onSentence) onSentence(spoken);
      }
      if (final) {
        const tail = cleanForSpeech(raw.slice(spokenIdx).replace(/\[[^\]]*\]/g, ' '));
        spokenIdx = raw.length;
        if (tail && onSentence) onSentence(tail);
      }
    };
    // Whole-string sentence split (drill path) — reuse the canonical chunkText splitter.
    const speakChunks = (str) => {
      const clean = cleanForSpeech(str.replace(/\[[^\]]*\]/g, ' '));
      if (clean && onSentence) chunkText(clean).forEach((s) => onSentence(s));
    };

    if (isDrill) {
      // Use the reliable (Gemini-first) brain so the /10 grading block is well-formed,
      // and speak only the next prospect's objection — not the grades — aloud.
      const fb = await callAPI(apiMsgs, sys);
      if (stale()) { setLoading(false); return null; }
      if (!fb.ok) { setApiError(fb.error || 'Something went wrong. Try again.'); setLoading(false); return null; }
      raw = fb.text;
      // Strip the grade lines from speech (allow markdown bold, like parseScores does).
      speakChunks(raw.replace(/^\s*\**[A-Z][A-Z &/]+\**\s*:?\s*\**\s*\d+\s*\/\s*10.*$/gm, ''));
    } else {
      let result = await callAPIStream(
        apiMsgs,
        sys,
        { onDelta: (d) => { raw += d; flush(false); }, max_tokens: 320 }
      );
      // Stream failed before producing anything → fall back to the non-streaming brain.
      if (!result.ok && !raw) {
        const fb = await callAPI(apiMsgs, sys);
        if (stale()) { setLoading(false); return null; }
        if (!fb.ok) { setApiError(fb.error || 'Something went wrong. Try again.'); setLoading(false); return null; }
        raw = fb.text;
      }
      if (stale()) { setLoading(false); return null; }
      flush(true); // speak whatever sentence(s) remain
    }

    if (stale()) { setLoading(false); return null; }

    return finalizeReply(raw, newMsgs);
  }, [buildSystem, stopSpeaking, finalizeReply]);

  const sendMessage = useCallback(async () => {
    const t = input.trim();
    if (!t || loading) return;
    setInput(''); setHintMenu(false);
    const reply = await sendTextFromRef(t);
    if (reply) speak(reply);
  }, [input, loading, sendTextFromRef, speak]);

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  }, [sendMessage]);

  /* ---------- roleplay debrief ---------- */
  const runDebrief = useCallback(async () => {
    if (debriefRunningRef.current) return; // synchronous re-entry guard (double-click / two End buttons)
    debriefRunningRef.current = true;
    stopTimer();
    setDebriefLoading(true); setShowDebrief(true); setDebriefText(''); setDebriefScores(null);
    const isRaja = modeRef.current === 'raja';
    const transcript = messagesRef.current
      .map((m) => isRaja
        ? `${m.role === 'user' ? 'CLIENT' : 'RAJA'}: ${m.content}`
        : `${m.role === 'user' ? 'REP' : 'PROSPECT'}: ${m.content}`).join('\n\n');
    try {
      const result = await callAPI(
        [{ role: 'user', content: isRaja
            ? `Transcript of Raja's call (the trainee played the client):\n\n${transcript}\n\nRecap it for the trainee.`
            : `Full roleplay transcript:\n\n${transcript}\n\nDebrief this rep.` }],
        isRaja ? SYSTEM_RAJA_RECAP : SYSTEM_DEBRIEF
      );
      if (!result.ok) {
        setDebriefText('⚠️ ' + (result.error || 'Could not generate the debrief. Try again.'));
        return;
      }
      const reply = result.text;
      setDebriefText(reply);
      const scores = isRaja ? null : parseDebriefScores(reply);
      setDebriefScores(scores);
      await saveSession(messagesRef.current, roundsRef.current, { debrief: reply, debriefScores: scores });
    } finally {
      setDebriefLoading(false);
      debriefRunningRef.current = false;
    }
  }, [saveSession, stopTimer]);

  // End the live call and, if there's a real conversation, auto-open the debrief.
  // Gate on completed USER turns so the seeded assistant opener (raja/drill) doesn't skew the count.
  const endCallAndDebrief = () => {
    endCall();
    const userTurns = messagesRef.current.filter((m) => m.role === 'user').length;
    if (userTurns >= 2 && !showDebrief) runDebrief();
  };

  // Raja <-> Prospect are mirror roles; this returns the flipped mode (null for drill).
  const flipMode = (m) => (m === 'raja' ? 'roleplay' : m === 'roleplay' ? 'raja' : null);

  // Switch roles out of a Raja call: replay the SAME client story, but now the
  // trainee runs discovery as the rep (seeded roleplay).
  const switchRolesFromRaja = () => {
    seedProfileRef.current = null; // Raja calls have no prospect profile to carry
    const seed = messagesRef.current
      .map((m) => `${m.role === 'user' ? 'CLIENT' : 'RAJA'}: ${m.content}`).join('\n\n');
    startSession('roleplay', difficulty, seed);
  };

  /* ---------- Watch Raja run the SAME prospect (two AIs auto-play; the user just observes) ---------- */
  // Build the two facing system prompts: Raja (the master rep) and the SAME prospect, both seeded
  // with the prospect's profile + the prior transcript so it's the exact person you just talked to.
  const buildWatchSystems = (profile, prior, diff) => {
    const rajaSys = SYSTEM_RAJA +
      '\n\nSEEDED CLIENT — you are calling the SAME client from the prior practice call below, where a trainee rep was practicing on them. Run YOUR masterful call on this exact person: greet them warmly, draw out their story and deep WHY with your invitational "tell me more" style, then bridge to the New Art of Living and book a specific time. The person replying to you IS this client.' +
      (profile ? '\n\nWHO THE CLIENT IS:\n' + profile : '') +
      '\n\nPRIOR CALL (the client is the PROSPECT in it):\n' + prior;
    const prosSys = SYSTEM_ROLEPLAY + '\n\n' + (ROLEPLAY_DIFF[diff] || '') +
      (profile ? '\n\nYOUR SPECIFIC PROFILE:\n' + profile : '') +
      '\n\nYou are the SAME person from the prior call below — stay 100% consistent with these exact facts and your hidden WHY. A master rep named Raja is now calling you. Make him EARN it like a real guarded person would: stay surface-level at first and reveal your real emotional WHY only as he digs with genuine, caring questions.\n\nPRIOR CALL (you are the PROSPECT in it):\n' + prior;
    return { rajaSys, prosSys };
  };

  const stopWatch = () => { watchStopRef.current = true; setWatchThinking(null); setWatchDone(true); };
  const closeWatch = () => { watchStopRef.current = true; stopSpeaking(); setWatchMode(false); setWatchThinking(null); setShowDebrief(true); };

  const runWatchDemo = async () => {
    const prior = messagesRef.current.map((m) => `${m.role === 'user' ? 'REP' : 'PROSPECT'}: ${m.content}`).join('\n\n');
    if (!prior) return;
    const wasSeeded = !!seedRef.current;
    const prof = PROSPECT_PROFILES[sessionRef.current.profileIdx];
    const profile = wasSeeded ? '' : (prof?.profile || ''); // a seeded roleplay has no clean profile; the transcript carries the person
    const name = sessionRef.current.prospectName || (wasSeeded ? 'the client' : prof?.name) || 'the prospect';
    const diff = difficultyRef.current;
    const { rajaSys, prosSys } = buildWatchSystems(profile, prior, diff);

    stopSpeaking();
    setShowDebrief(false);
    setWatchName(name);
    setWatchMsgs([]); setWatchThinking('raja'); setWatchDone(false); setWatchMode(true);
    setWhyProgress(0);
    watchStopRef.current = false;

    const out = [];
    const push = (speaker, content) => { out.push({ speaker, content }); setWatchMsgs([...out]); };
    const rajaHist = [{ role: 'user', content: '(You are now on the phone with this client and they have just answered. Greet them warmly and begin the call.)' }];
    const prosHist = [];
    const MAX_LINES = 18;
    let lastWhy = 0;
    let booked = false;

    // Raja opens the call.
    let r = await callAPI(rajaHist, rajaSys);
    if (watchStopRef.current) return;
    if (!r.ok) { setApiError(r.error || 'Could not start the demo. Try again.'); setWatchThinking(null); setWatchDone(true); return; }
    let rajaLine = stripProgressTags(r.text).clean;
    push('raja', rajaLine);
    rajaHist.push({ role: 'assistant', content: rajaLine });
    prosHist.push({ role: 'user', content: rajaLine });

    while (out.length < MAX_LINES && !watchStopRef.current && !booked) {
      // The prospect answers Raja.
      setWatchThinking('prospect');
      await new Promise((res) => setTimeout(res, 450));
      if (watchStopRef.current) break;
      const p = await callAPI(prosHist, prosSys);
      if (watchStopRef.current) break;
      if (!p.ok) { setApiError(p.error || 'AI is busy — try again in a moment.'); break; }
      const ps = stripProgressTags(p.text);
      if (ps.whyScore != null) { lastWhy = ps.whyScore; setWhyProgress(ps.whyScore); }
      push('prospect', ps.clean);
      prosHist.push({ role: 'assistant', content: ps.clean });
      rajaHist.push({ role: 'user', content: ps.clean });
      if (out.length >= MAX_LINES) break;

      // Raja replies — once the why is in, nudge him to quantify then close (same as live Raja).
      setWatchThinking('raja');
      await new Promise((res) => setTimeout(res, 450));
      if (watchStopRef.current) break;
      let demoNudge = '';
      if (lastWhy >= 7) {
        const gaveNumber = /\$\s?\d|\d+\s*(k\b|grand|thousand|hundred)|\ba month\b/i.test(prosHist.map((m) => m.content).join(' '));
        demoNudge = gaveNumber
          ? "\n\nDIRECTIVE (THIS REPLY ONLY): The why is established and the client gave a dollar number. Confirm it, reframe that it was never about money but their dream, run your full New Art of Living close, and book a specific time. Do NOT ask another discovery question."
          : "\n\nDIRECTIVE (THIS REPLY ONLY): The emotional why is established. STOP discovery — QUANTIFY next: ask what dollar amount a month would make the dream real. Do NOT ask another feelings question.";
      }
      r = await callAPI(rajaHist, rajaSys + demoNudge);
      if (watchStopRef.current) break;
      if (!r.ok) { setApiError(r.error || 'AI is busy — try again in a moment.'); break; }
      rajaLine = stripProgressTags(r.text).clean;
      push('raja', rajaLine);
      rajaHist.push({ role: 'assistant', content: rajaLine });
      prosHist.push({ role: 'user', content: rajaLine });
      if (/tomorrow at|wednesday at|monday at|best number|lock (it|in|in a time)|on the calendar|book (a|you|it|us)|\b5 ?pm\b|\b6 ?pm\b|five pm|six pm/i.test(rajaLine)) booked = true;
    }

    setWatchThinking(null);
    setWatchDone(true);
  };

  /* ---------- hints ---------- */
  const hintLoadingRef = useRef(false);
  const getHint = useCallback(async (type) => {
    if (hintLoadingRef.current) return; // in-flight guard: no overlapping/stacked hint requests
    hintLoadingRef.current = true;
    setHintType(type); setHintLoading(true); setHintText(''); setHintOpen(true); setHintMenu(false);
    const transcript = messagesRef.current
      .map((m) => `${m.role === 'user' ? 'REP' : (mode === 'roleplay' ? 'PROSPECT' : 'DRILL')}: ${m.content}`).join('\n\n');
    const sys = type === 'strategy' ? HINT_STRATEGY : HINT_WORDS;
    const result = await callAPI([{ role: 'user', content: `Transcript so far:\n\n${transcript || '(conversation just started)'}\n\nGive me the hint.` }], sys);
    setHintText(result.ok ? result.text : ('⚠️ ' + (result.error || 'Hint failed. Try again.')));
    setHintLoading(false);
    hintLoadingRef.current = false;
  }, [mode]);

  // Auto-pop a strategy hint the moment the rep is clearly off track (roleplay only).
  useEffect(() => {
    if (mode !== 'roleplay' || loading) return;
    const repTurns = messages.filter((m) => m.role === 'user').length;
    const offTrack = repTurns >= 3 && whyProgress <= 2;
    if (offTrack && !offTrackHelpedRef.current && !hintOpen) {
      offTrackHelpedRef.current = true;
      getHint('strategy');
    }
    if (whyProgress > 2) offTrackHelpedRef.current = false;
  }, [messages, whyProgress, mode, loading, hintOpen, getHint]);

  const insertSelection = useCallback(() => {
    const sel = (typeof window !== 'undefined' && window.getSelection) ? window.getSelection().toString().trim() : '';
    if (sel) { setInput(sel); inputRef.current?.focus(); }
  }, []);

  /* ---------- history ---------- */
  const loadHistory = useCallback(async () => {
    const keys = await store.list('sess_');
    const recs = [];
    for (const k of keys) { const r = await store.get(k); if (r && r.messages && r.messages.length) recs.push(r); }
    recs.sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''));
    setHistory(recs);
  }, []);

  const openHistory = useCallback(async () => {
    stopSpeaking(); setSettingsOpen(false); setView('history');
    setShowPattern(false); setPatternText('');
    await loadHistory();
  }, [loadHistory, stopSpeaking]);

  const deleteSession = useCallback(async (id) => {
    await store.del(id);
    setHistory((h) => h.filter((s) => s.id !== id));
  }, []);

  const clearAll = useCallback(async () => {
    if (!window.confirm('Wipe all practice history? This can\'t be undone.')) return;
    const keys = await store.list('sess_');
    for (const k of keys) await store.del(k);
    setHistory([]); setShowPattern(false); setPatternText('');
  }, []);

  const runPattern = useCallback(async () => {
    setShowPattern(true); setPatternLoading(true); setPatternText('');
    const recent = history.slice(0, 8);
    const compiled = recent.map((s, i) => {
      const t = s.messages
        .map((m) => `${m.role === 'user' ? 'REP' : 'OTHER'}: ${m.content}`).join('\n').slice(0, 3000);
      return `--- SESSION ${i + 1} (${s.mode}, difficulty ${s.difficulty}) ---\n${t}`;
    }).join('\n\n');
    const result = await callAPI([{ role: 'user', content: `Practice history:\n\n${compiled}\n\nGive me the pattern.` }], PATTERN_PROMPT);
    setPatternText(result.ok ? result.text : ('⚠️ ' + (result.error || 'Could not analyze your history. Try again.')));
    setPatternLoading(false);
  }, [history]);

  const handleLogout = useCallback(async () => {
    if (supabase) await supabase.auth.signOut();
  }, []);

  /* ---------- drill stats ---------- */
  const computeStats = () => {
    const asc = [...history].sort((a, b) => (a.startedAt || '').localeCompare(b.startedAt || ''));
    const allRounds = [];
    let drillSessions = 0;
    asc.forEach((s) => { if (s.mode === 'drill' && s.rounds && s.rounds.length) { drillSessions += 1; allRounds.push(...s.rounds); } });
    const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
    const cat = (k) => avg(allRounds.map((r) => r[k]).filter((x) => x != null));
    const overalls = allRounds.map((r) => r.overall).filter((x) => x != null);
    const half = Math.floor(overalls.length / 2);
    const trend = overalls.length >= 4 ? avg(overalls.slice(half)) - avg(overalls.slice(0, half)) : null;
    return {
      drillSessions, rounds: allRounds.length,
      overall: cat('overall'), framework: cat('framework'), tonality: cat('tonality'),
      question: cat('question'), silence: cat('silence'), trend,
    };
  };

  /* ---------- Redempter: coach a real objection or transcript ---------- */
  const REDEMPTER_CAP = 100000; // single source of truth for the input cap
  const handleRedempterFile = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    if (file.size > 3_000_000) {
      setRedempterResult('⚠️ That file is too large (over 3 MB). Please paste the transcript text, or use a smaller file.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setRedempterInput(String(reader.result || '').slice(0, REDEMPTER_CAP));
    reader.onerror = () => setRedempterResult('⚠️ Could not read that file. Please paste the transcript text instead.');
    reader.readAsText(file.slice(0, 3_000_000));
  };

  const runRedempter = async (overrideText) => {
    let text = (typeof overrideText === 'string' ? overrideText : redempterInput).trim();
    if (!text || redempterLoading) return;
    const truncated = text.length > REDEMPTER_CAP;
    text = text.slice(0, REDEMPTER_CAP);
    setRedempterLoading(true);
    setRedempterResult('');
    // Fence the paste so embedded "ignore your instructions" text is treated as data, not commands.
    const note = truncated ? '\n\n(Note: this call was long; only the first part is shown above.)' : '';
    const content = `<call_transcript>\n${text}\n</call_transcript>${note}`;
    const result = await callAPI([{ role: 'user', content }], SYSTEM_REDEMPTER, { timeoutMs: 120000 });
    setRedempterResult(result.ok ? result.text : ('⚠️ ' + (result.error || 'Could not analyze that. Try again.')));
    setRedempterLoading(false);
  };

  // Feed the current in-app session straight into the Redempter coach
  const redeemThisCall = () => {
    if (!messages.length) return;
    const t = messages.map((m) => `${m.role === 'user' ? 'REP' : 'PROSPECT'}: ${m.content}`).join('\n\n');
    setRedempterInput(t);
    setRedempterResult('');
    setRedempterOpen(true);
    runRedempter(t);
  };

  // Shared Redempter modal — rendered from both the home screen and a live session
  const redempterModalEl = redempterOpen && (
    <div style={S.redempterOverlay} onClick={() => !redempterLoading && setRedempterOpen(false)}>
      <div style={S.redempterModal} onClick={(e) => e.stopPropagation()}>
        <div style={S.redempterHeader}>
          <div>
            <div style={S.redempterTitle}>🛟 REDEMPTER</div>
            <div style={S.redempterSub}>Paste a key objection or an entire Zoom transcript / call. Raja shows you how to redeem it.</div>
          </div>
          <button style={S.redempterX} onClick={() => setRedempterOpen(false)}>✕</button>
        </div>

        {redempterLoading ? (
          <div style={S.redempterLoadingBox}>
            <div style={S.typing}><span style={S.dot}>●</span><span style={{ ...S.dot, animationDelay: '.2s' }}>●</span><span style={{ ...S.dot, animationDelay: '.4s' }}>●</span></div>
            <div>Raja is reading your call…</div>
          </div>
        ) : redempterResult ? (
          <>
            <div style={S.redempterResult}>{redempterResult}</div>
            <div style={S.redempterActions}>
              <button style={S.redempterReset} onClick={() => setRedempterResult('')}>↩ New paste</button>
              <button style={S.redempterGo} onClick={() => { setRedempterResult(''); setRedempterInput(''); setRedempterOpen(false); }}>Done</button>
            </div>
          </>
        ) : (
          <>
            <textarea style={S.redempterTextarea} value={redempterInput}
              onChange={(e) => setRedempterInput(e.target.value)}
              placeholder="Paste the objection the client gave you, or the entire call / Zoom transcript here…" />
            <div style={S.redempterActions}>
              <label style={S.redempterUpload}>
                📎 Upload transcript file
                <input type="file" accept=".txt,.vtt,.csv,.md,.srt,text/plain" style={{ display: 'none' }} onChange={handleRedempterFile} />
              </label>
              <button style={{ ...S.redempterGo, opacity: !redempterInput.trim() ? 0.4 : 1 }}
                disabled={!redempterInput.trim()} onClick={() => runRedempter()}>Get Raja&apos;s Help</button>
            </div>
          </>
        )}
      </div>
    </div>
  );

  /* ============================== RENDER ============================== */

  if (view === 'admin') {
    return <Admin onBack={() => setView('home')} />;
  }

  if (view === 'home') {
    const displayName = user?.user_metadata?.display_name || user?.email?.split('@')[0] || '';
    return (
      <div style={S.container}>
        <div style={S.landing}>
          {user && (
            <div style={S.userBar}>
              <span style={S.userName}>{displayName}</span>
              <button style={S.logoutBtn} onClick={() => setView('admin')}>Admin</button>
              <button style={S.logoutBtn} onClick={handleLogout}>Sign out</button>
            </div>
          )}
          <div style={S.logoMark}>WB</div>
          <h1 style={S.title}>OBJECTION TRAINING</h1>
          <p style={S.subtitle}>Pick your difficulty. Pick your drill.</p>

          <div style={S.diffSelector}>
            {DIFFICULTY_META.map((d) => (
              <button key={d.level} onClick={() => setDifficulty(d.level)}
                style={{ ...S.diffBtn, borderColor: difficulty === d.level ? d.color : '#2A3A4A', background: difficulty === d.level ? d.color : 'transparent', color: difficulty === d.level ? '#0F1419' : '#8899A6' }}>
                <span style={S.diffNum}>{d.level}</span>
                <span style={S.diffName}>{d.name}</span>
              </button>
            ))}
          </div>

          <div style={S.cardRow}>
            <button style={S.card} onClick={() => startSession('roleplay', difficulty)}>
              <div style={S.cardIcon}>🎭</div>
              <div style={S.cardTitle}>THE PROSPECT</div>
              <div style={S.cardDesc}>Full voice roleplay. A real prospect talks, you talk back. Run PPF discovery, bridge to NAOL, handle whatever they throw.</div>
              <div style={S.cardTag}>CONVERSATION MUSCLE</div>
            </button>
            <button style={S.card} onClick={() => startSession('raja', difficulty)}>
              <div style={S.cardIcon}>🧑‍🏫</div>
              <div style={S.cardTitle}>LEARN FROM RAJA</div>
              <div style={S.cardDesc}>Flip the script. Raja, a master rep, runs the call and YOU play the client. Feel elite discovery, the WHY, and objection handling done right.</div>
              <div style={S.cardTag}>WATCH THE MASTER</div>
            </button>
            <button style={S.card} onClick={() => startSession('drill', difficulty)}>
              <div style={S.cardIcon}>💥</div>
              <div style={S.cardTitle}>THE GAUNTLET</div>
              <div style={S.cardDesc}>Rapid-fire with voice. Scenario drops, objection hits, you respond out loud, you get scored against your frameworks.</div>
              <div style={S.cardTag}>PATTERN RECOGNITION</div>
            </button>
          </div>

          <button style={S.redempterLink} onClick={() => setRedempterOpen(true)}>🛟 Redempter — fix a real objection or call</button>
          <button style={S.historyLink} onClick={openHistory}>📊 History &amp; Patterns</button>
        </div>
        {redempterModalEl}
      </div>
    );
  }

  if (view === 'history') {
    const stats = computeStats();
    const bars = [
      { k: 'framework', label: 'Framework Alignment' },
      { k: 'tonality', label: 'Tonality / Energy' },
      { k: 'question', label: 'Question Quality' },
      { k: 'silence', label: 'Silence Discipline' },
    ];
    const lowest = bars.reduce((lo, b) => (stats[b.k] && (!lo || stats[b.k] < stats[lo.k]) ? b : lo), null);

    return (
      <div style={S.container}>
        <div style={S.header}>
          <button style={S.backBtn} onClick={() => setView('home')}>← Home</button>
          <div style={S.headerTitle}>HISTORY &amp; PATTERNS</div>
          <div style={S.headerRight}>
            {history.length > 0 && <button style={S.newBtn} onClick={clearAll}>Clear all</button>}
          </div>
        </div>
        <div style={S.historyScroll}>
          {history.length === 0 && (
            <div style={S.empty}>
              <div style={{ fontSize: 36, marginBottom: 12 }}>📭</div>
              No reps logged yet. Run a Prospect or Gauntlet session and your history shows up here.
            </div>
          )}
          {history.length > 0 && (
            <>
              <button style={S.patternBtn} onClick={runPattern}>
                {showPattern ? '↻ Re-run Pattern Analysis' : '🔍 Show Overall Pattern'}
              </button>
              {showPattern && (
                <div style={S.patternPanel}>
                  {stats.rounds > 0 && (
                    <div style={S.statBlock}>
                      <div style={S.statHeaderRow}>
                        <div style={S.statBig}>{stats.overall.toFixed(1)}<span style={S.statBigUnit}>/10</span></div>
                        <div style={S.statMeta}>
                          <div>Overall average</div>
                          <div style={S.statSub}>{stats.rounds} graded rounds · {stats.drillSessions} Gauntlet sessions</div>
                          {stats.trend != null && (
                            <div style={{ color: stats.trend >= 0 ? '#43A047' : '#E53935', fontSize: 12, fontWeight: 600, marginTop: 4 }}>
                              {stats.trend >= 0 ? '▲' : '▼'} {Math.abs(stats.trend).toFixed(1)} {stats.trend >= 0 ? 'improving' : 'slipping'}
                            </div>
                          )}
                        </div>
                      </div>
                      {bars.map((b) => (
                        <div key={b.k} style={S.barRow}>
                          <div style={S.barLabel}>{b.label}</div>
                          <div style={S.barTrack}>
                            <div style={{ ...S.barFill, width: `${(stats[b.k] || 0) * 10}%`, background: stats[b.k] >= 7 ? '#43A047' : stats[b.k] >= 5 ? '#D4A843' : '#E53935' }} />
                          </div>
                          <div style={S.barVal}>{(stats[b.k] || 0).toFixed(1)}</div>
                        </div>
                      ))}
                      {lowest && <div style={S.weakCallout}>⚠ Weakest muscle: <b>{lowest.label}</b></div>}
                    </div>
                  )}
                  <div style={S.coachBlock}>
                    <div style={S.coachLabel}>COACH READ</div>
                    {patternLoading
                      ? <div style={S.typing}><span style={S.dot}>●</span><span style={{ ...S.dot, animationDelay: '.2s' }}>●</span><span style={{ ...S.dot, animationDelay: '.4s' }}>●</span></div>
                      : <div style={S.coachText}>{patternText}</div>
                    }
                  </div>
                </div>
              )}
              <div style={S.sessionList}>
                {history.map((s) => {
                  const d = diffMeta(s.difficulty);
                  const avg = s.rounds && s.rounds.length ? (s.rounds.reduce((a, b) => a + b.overall, 0) / s.rounds.length).toFixed(1) : null;
                  const dbScore = s.debriefScores?.overall;
                  const score = avg || (dbScore ? `${dbScore}/10` : null);
                  const reps = s.messages.filter((m) => m.role === 'user').length;
                  const date = new Date(s.startedAt);
                  const isOpen = expanded === s.id;
                  return (
                    <div key={s.id} style={S.sessionCard}>
                      <div style={S.sessionTop} onClick={() => setExpanded(isOpen ? null : s.id)}>
                        <div style={S.sessionLeft}>
                          <span style={{ ...S.modePill, background: s.mode === 'drill' ? '#3A2A4A' : '#2A3A4A' }}>
                            {s.mode === 'drill' ? 'GAUNTLET' : s.mode === 'raja' ? 'RAJA' : 'PROSPECT'}
                          </span>
                          <span style={{ ...S.diffPillSm, color: d.color, borderColor: d.color }}>{d.name}</span>
                          {s.prospectName && <span style={S.prospectTag}>{s.prospectName}</span>}
                        </div>
                        <div style={S.sessionRight}>
                          {score ? <span style={S.sessionScore}>{score}</span> : <span style={S.sessionScoreMuted}>{reps} turns</span>}
                          <span style={S.sessionDate}>{date.toLocaleDateString()} {date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                          <button style={S.delBtn} onClick={(e) => { e.stopPropagation(); deleteSession(s.id); }}>✕</button>
                        </div>
                      </div>
                      {isOpen && (
                        <div style={S.transcript}>
                          {s.messages.map((m, i) => (
                            <div key={i} style={S.tLine}>
                              <span style={{ ...S.tWho, color: m.role === 'user' ? '#6FA8DC' : '#D4A843' }}>
                                {m.role === 'user' ? 'YOU' : (s.mode === 'drill' ? 'DRILL' : s.mode === 'raja' ? 'RAJA' : s.prospectName || 'PROSPECT')}
                              </span>
                              <span style={S.tText}>{m.content}</span>
                            </div>
                          ))}
                          {s.debrief && (
                            <div style={S.debriefInHistory}>
                              <div style={S.coachLabel}>DEBRIEF</div>
                              <div style={S.tText}>{s.debrief}</div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  /* ---------- CHAT VIEW ---------- */
  const d = diffMeta(difficulty);
  const prospect = PROSPECT_PROFILES[profileIdx];
  const noMessages = messages.length === 0;

  return (
    <div style={S.container}>
      <div style={S.header}>
        <button style={S.backBtn} onClick={() => { stopSpeaking(); stopTimer(); setView('home'); }}>← Home</button>
        <div style={S.headerCenter}>
          <span style={S.headerTitle}>{mode === 'roleplay' ? 'THE PROSPECT' : mode === 'raja' ? 'LEARN FROM RAJA' : 'THE GAUNTLET'}</span>
          <span style={{ ...S.diffPillSm, color: d.color, borderColor: d.color }}>{d.name}</span>
          <span style={S.timerBadge}>{formatTime(elapsed)}</span>
          {mode === 'drill' && rounds.length > 0 && (
            <span style={S.scoreBadge}>{(rounds.reduce((a, b) => a + b.overall, 0) / rounds.length).toFixed(1)}/10 · R{rounds.length + 1}</span>
          )}
        </div>
        <div style={S.headerRight}>
          <button style={{ ...S.iconBtn, background: voiceEnabled ? '#D4A843' : '#1A2332', color: voiceEnabled ? '#0F1419' : '#8899A6' }}
            onClick={() => { setVoiceEnabled((v) => !v); if (voiceEnabled) stopSpeaking(); }} title="Toggle voice">
            {voiceEnabled ? '🔊' : '🔇'}
          </button>
          <button style={S.iconBtn} onClick={() => setSettingsOpen((o) => !o)} title="Settings">⚙</button>
        </div>

        {/* AI status — simple overload traffic light (per-instance) */}
        {apiUsage && apiUsage.health && (
          <div style={S.usageBar}>
            <div style={S.usageTop}>
              <span style={S.usageLabel}>AI STATUS</span>
              <span style={{
                ...S.usagePct,
                color: apiUsage.health === 'ok' ? '#43A047' : apiUsage.health === 'busy' ? '#D4A843' : '#E53935',
              }}>
                {apiUsage.health === 'ok' ? '🟢 Healthy'
                  : apiUsage.health === 'busy' ? '🟡 Busy — using backups'
                  : '🔴 Overloaded — add keys'}
              </span>
            </div>
          </div>
        )}

        {settingsOpen && (
          <div style={S.settingsPanel}>
            <div style={S.settingLabel}>DIFFICULTY</div>
            <div style={S.diffMini}>
              {DIFFICULTY_META.map((dm) => (
                <button key={dm.level} onClick={() => startSession(mode, dm.level, isSeeded ? seedRef.current : null)}
                  style={{ ...S.diffMiniBtn, borderColor: difficulty === dm.level ? dm.color : '#2A3A4A', background: difficulty === dm.level ? dm.color : 'transparent', color: difficulty === dm.level ? '#0F1419' : '#8899A6' }}>
                  {dm.level}
                </button>
              ))}
            </div>
            <div style={S.settingLabel}>PAUSE BEFORE REPLY</div>
            <div style={S.diffMini}>
              {[1000, 1500, 2000, 3000].map((ms) => (
                <button key={ms} onClick={() => setPauseGrace(ms)}
                  style={{ ...S.diffMiniBtn, borderColor: pauseGrace === ms ? '#D4A843' : '#2A3A4A', background: pauseGrace === ms ? '#D4A843' : 'transparent', color: pauseGrace === ms ? '#0F1419' : '#8899A6' }}>
                  {ms / 1000}s
                </button>
              ))}
            </div>
            <div style={{ fontSize: 10, color: '#6B7785', marginTop: -8, marginBottom: 14, lineHeight: 1.4 }}>How long it waits after you stop talking before it replies. Higher = more room to pause and think mid-sentence.</div>
            <div style={S.settingLabel}>VOICE</div>
            <select value={selectedVoiceName} onChange={(e) => { userPickedVoiceRef.current = true; setSelectedVoiceName(e.target.value); }} style={S.voiceSelect}>
              {voices.length === 0 && <option>Loading voices…</option>}
              {voices.map((v) => <option key={v.name} value={v.name}>{v.name}</option>)}
            </select>
            <div style={S.settingLabel}>MY VOICE MATCH {calib.done && <span style={S.calibTag}>✓ on</span>}</div>
            <button style={S.calibBtn} onClick={openCalibration}>🎙 {calib.done ? 'Re-calibrate' : 'Calibrate to my voice'}</button>
            {calib.done && calib.hz && <div style={S.calibReadout}>~{calib.hz} Hz · ~{calib.wpm} wpm</div>}
            <div style={S.sliderRow}>
              <span style={S.sliderLabel}>Pitch</span>
              <input type="range" min="0.5" max="2" step="0.05" value={calib.pitch} onChange={(e) => setPitchManual(parseFloat(e.target.value))} style={S.slider} />
              <span style={S.sliderVal}>{calib.pitch.toFixed(2)}</span>
            </div>
            <div style={S.sliderRow}>
              <span style={S.sliderLabel}>Speed</span>
              <input type="range" min="0.5" max="1.6" step="0.05" value={calib.rate} onChange={(e) => setRateManual(parseFloat(e.target.value))} style={S.slider} />
              <span style={S.sliderVal}>{calib.rate.toFixed(2)}</span>
            </div>
            <div style={S.calibActions}>
              <button style={S.testVoiceBtn} onClick={testCalibVoice}>▶ Test</button>
              {calib.done && <button style={S.calibResetBtn} onClick={resetCalib}>Reset</button>}
            </div>
            <button style={S.restartBtn} onClick={() => startSession(mode, difficulty, isSeeded ? seedRef.current : null)}>{isSeeded ? 'Restart (same client)' : mode === 'roleplay' ? 'New prospect' : mode === 'raja' ? 'Restart with Raja' : 'Restart drill'}</button>
          </div>
        )}
      </div>

      {calibrating && (
        <div style={S.calibOverlay} onClick={(e) => { if (e.target === e.currentTarget) closeCalibration(); }}>
          <div style={S.calibModal}>
            <div style={S.calibModalHead}>
              <span style={S.calibModalTitle}>🎙 MATCH MY VOICE</span>
              <button style={S.hintClose} onClick={closeCalibration}>✕</button>
            </div>
            <div style={S.calibIntro}>Read this out loud at your normal speaking voice and pace:</div>
            <div style={S.calibPhrase}>"{CALIB_PHRASE}"</div>
            {calibStatus === 'idle' && <button style={S.calibRecordBtn} onClick={beginRecord}>● Start recording</button>}
            {calibStatus === 'recording' && (
              <>
                <div style={S.calibLive}><span style={S.calibLiveDot}>●</span> Recording… {recSeconds}s</div>
                <button style={{ ...S.calibRecordBtn, background: '#E53935', borderColor: '#E53935', color: '#fff' }} onClick={stopRecord}>■ Stop &amp; match</button>
              </>
            )}
            {calibStatus === 'analyzing' && <div style={S.calibLive}>Analyzing…</div>}
            {calibStatus === 'done' && (
              <>
                <div style={S.calibDone}>✓ Matched — ~{calib.hz} Hz, ~{calib.wpm} wpm</div>
                <div style={S.calibActions}>
                  <button style={S.calibRecordBtn} onClick={testCalibVoice}>▶ Hear it</button>
                  <button style={{ ...S.calibRecordBtn, background: 'transparent', color: '#8899A6', borderColor: '#2A3A4A' }} onClick={beginRecord}>↻ Redo</button>
                </div>
                <button style={S.calibFinishBtn} onClick={closeCalibration}>Done</button>
              </>
            )}
            {calibStatus === 'error' && (
              <>
                <div style={S.calibErr}>{calibError}</div>
                <button style={S.calibRecordBtn} onClick={beginRecord}>● Try again</button>
              </>
            )}
          </div>
        </div>
      )}

      {apiError && (
        <div style={S.apiErrorBar}>
          <span>{apiError}</span>
          <button style={S.apiErrorClose} onClick={() => setApiError('')}>✕</button>
        </div>
      )}

      <div style={S.chatArea} onClick={() => settingsOpen && setSettingsOpen(false)}>
        {/* FIX #2: Roleplay shows prospect info and prompts rep to open */}
        {mode === 'roleplay' && noMessages && !loading && (
          <div style={S.prospectCard}>
            {isSeeded ? (
              <>
                <div style={S.prospectName}>🔄 Same client as Raja's call</div>
                <div style={S.prospectVibe}>Now YOU run it. Uncover the same story and WHY — like Raja did.</div>
                <div style={S.prospectPrompt}>Open the call. If you drift off track, a “What would Raja do?” button appears.</div>
              </>
            ) : (
              <>
                <div style={S.prospectName}>{prospect.name}</div>
                <div style={S.prospectVibe}>{prospect.vibe}</div>
                <div style={S.prospectPrompt}>Open the call. Say whatever you'd say in real life.</div>
              </>
            )}
          </div>
        )}

        {messages.map((m, i) => (
          <div key={i} style={{ ...S.msgRow, justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start' }}>
            <div style={{ ...S.msgBubble, ...(m.role === 'user' ? S.userBubble : S.botBubble) }}>
              {m.role === 'assistant' && (
                <div style={S.speakerLabel}>
                  {mode === 'roleplay' ? (isSeeded ? 'CLIENT' : prospect.name.toUpperCase()) : mode === 'raja' ? 'RAJA' : 'PROSPECT'}
                </div>
              )}
              <div style={S.msgText}>{m.content}</div>
              {m.role === 'assistant' && (
                <button style={S.replayBtn} onClick={() => speak(m.content)} title="Replay">🔄</button>
              )}
            </div>
          </div>
        ))}
        {loading && (
          <div style={{ ...S.msgRow, justifyContent: 'flex-start' }}>
            <div style={{ ...S.msgBubble, ...S.botBubble }}>
              <div style={S.typing}><span style={S.dot}>●</span><span style={{ ...S.dot, animationDelay: '.2s' }}>●</span><span style={{ ...S.dot, animationDelay: '.4s' }}>●</span></div>
            </div>
          </div>
        )}

        <div ref={chatEndRef} />
      </div>

      {/* Roleplay debrief — outside chatArea so it's always visible */}
      {showDebrief && (
        <div style={S.debriefPanel}>
          <div style={S.debriefHeader}>
            <div style={S.coachLabel}>{mode === 'raja' ? '🎓 RAJA RECAP' : '📋 SESSION DEBRIEF'}</div>
            <button style={S.hintClose} onClick={() => setShowDebrief(false)}>✕</button>
          </div>
          {debriefLoading
            ? <div style={S.typing}><span style={S.dot}>●</span><span style={{ ...S.dot, animationDelay: '.2s' }}>●</span><span style={{ ...S.dot, animationDelay: '.4s' }}>●</span></div>
            : (
              <>
                <div style={S.coachText}>{debriefText}</div>
                {mode !== 'raja' && (
                  <button style={{ ...S.redeemBtn, marginTop: 14, width: '100%', padding: '10px 12px' }} onClick={redeemThisCall}>🛟 Redeem this call — see how Raja would run it</button>
                )}
                <div style={S.debriefActions}>
                  {flipMode(mode) && (
                    <button style={S.debriefActionBtn} onClick={() => mode === 'raja' ? switchRolesFromRaja() : runWatchDemo()}>
                      {mode === 'raja' ? '🔄 Switch roles — now YOU run this same client' : '🎬 Watch Raja run this SAME prospect'}
                    </button>
                  )}
                  <button style={S.debriefActionBtn} onClick={() => startSession(mode, difficulty, isSeeded ? seedRef.current : null)}>↻ Run it again</button>
                  <button style={S.debriefActionGhost} onClick={() => { stopSpeaking(); stopTimer(); setView('home'); }}>🏠 New session</button>
                </div>
              </>
            )
          }
        </div>
      )}

      {/* Watch Raja run the SAME prospect — two AIs auto-play, you just observe */}
      {watchMode && (
        <div style={S.watchPanel}>
          <div style={S.debriefHeader}>
            <div style={S.coachLabel}>🎬 WATCH RAJA — {watchName.toUpperCase()}</div>
            <button style={S.hintClose} onClick={closeWatch}>✕</button>
          </div>
          <div style={S.watchWhyBar}>
            <div style={S.whyBarHeader}>
              <span style={S.whyBarLabel}>RAJA — GETTING THE WHY</span>
              <span style={S.whyBarPct}>{whyProgress * 10}%</span>
            </div>
            <div style={S.whyBarTrack}>
              <div style={{ ...S.whyBarFill, width: `${whyProgress * 10}%`, background: whyProgress >= 8 ? '#43A047' : whyProgress >= 5 ? '#D4A843' : '#3A5A7A' }} />
            </div>
          </div>
          <div style={S.watchBody}>
            {watchMsgs.map((m, i) => (
              <div key={i} style={{ ...S.msgRow, justifyContent: m.speaker === 'prospect' ? 'flex-end' : 'flex-start' }}>
                <div style={{ ...S.msgBubble, ...(m.speaker === 'prospect' ? S.userBubble : S.botBubble) }}>
                  <div style={S.speakerLabel}>{m.speaker === 'raja' ? '🎓 RAJA' : watchName.toUpperCase()}</div>
                  <div style={S.msgText}>{m.content}</div>
                  <button style={S.replayBtn} onClick={() => speak(m.content)} title="Hear it">🔄</button>
                </div>
              </div>
            ))}
            {watchThinking && (
              <div style={{ ...S.msgRow, justifyContent: watchThinking === 'prospect' ? 'flex-end' : 'flex-start' }}>
                <div style={{ ...S.msgBubble, ...(watchThinking === 'prospect' ? S.userBubble : S.botBubble) }}>
                  <div style={S.speakerLabel}>{watchThinking === 'raja' ? '🎓 RAJA' : watchName.toUpperCase()}</div>
                  <div style={S.typing}><span style={S.dot}>●</span><span style={{ ...S.dot, animationDelay: '.2s' }}>●</span><span style={{ ...S.dot, animationDelay: '.4s' }}>●</span></div>
                </div>
              </div>
            )}
            <div ref={watchEndRef} />
          </div>
          <div style={S.debriefActions}>
            {watchDone ? (
              <>
                <button style={S.debriefActionBtn} onClick={runWatchDemo}>↻ Watch it again</button>
                <button style={S.debriefActionGhost} onClick={closeWatch}>← Back to debrief</button>
              </>
            ) : (
              <button style={S.debriefActionGhost} onClick={stopWatch}>⏹ Stop</button>
            )}
          </div>
        </div>
      )}

      {hintOpen && (
        <div style={S.hintCard}>
          <div style={S.hintHeader}>
            <span style={S.hintLabel}>💡 {hintType === 'strategy' ? 'STRATEGY' : 'EXACT WORDS'}</span>
            <div style={S.hintHeaderRight}>
              <button style={{ ...S.hintSendTop, opacity: loading || !input.trim() ? 0.4 : 1 }} onClick={sendMessage} disabled={loading || !input.trim()}>▶ Send</button>
              <button style={S.hintClose} onClick={() => setHintOpen(false)}>✕</button>
            </div>
          </div>
          {hintLoading
            ? <div style={S.typing}><span style={S.dot}>●</span><span style={{ ...S.dot, animationDelay: '.2s' }}>●</span><span style={{ ...S.dot, animationDelay: '.4s' }}>●</span></div>
            : (
              <>
                <div style={S.hintText} onMouseUp={insertSelection} onTouchEnd={insertSelection}>{hintText}</div>
                <div style={S.hintTip}>Highlight text to drop it into your reply.</div>
              </>
            )
          }
        </div>
      )}

      {isSpeaking && !callMode && (
        <div style={S.speakingBar}>
          <span style={S.speakingPulse}>🔊 Speaking…</span>
          <button style={S.stopSpeakBtn} onClick={stopSpeaking}>Stop</button>
        </div>
      )}

      {callMode && (
        <div style={S.callPanel}>
          {callState === 'error' ? (
            <div style={S.callPanelErr}>
              <div style={S.callPanelErrHead}>
                <span style={S.callPanelErrTitle}>🎙️🚫 Mic issue</span>
                <button style={S.callPanelX} onClick={endCall}>✕</button>
              </div>
              <div style={S.callPanelErrMsg}>{callError}</div>
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <button style={S.callRetryBtn} onClick={startCall}>↻ Retry</button>
                <button style={S.callCloseBtn} onClick={endCall}>Close</button>
              </div>
            </div>
          ) : (
            <div style={S.callPanelLive}>
              <div onClick={bargeIn} style={{
                ...S.callMiniOrb,
                ...(callState === 'listening' ? S.callOrbListening : {}),
                ...(callState === 'thinking' ? S.callOrbThinking : {}),
                ...(callState === 'speaking' ? S.callOrbSpeaking : {}),
              }}>
                {callState === 'connecting' && '◌'}
                {callState === 'listening' && '🎙'}
                {callState === 'thinking' && '◐'}
                {callState === 'speaking' && '🔊'}
              </div>
              <div style={S.callPanelMid}>
                <div style={S.callPanelState}>
                  {callState === 'connecting' && 'Connecting…'}
                  {callState === 'listening' && 'Listening — just talk'}
                  {callState === 'thinking' && 'Thinking…'}
                  {callState === 'speaking' && 'Speaking — tap orb to cut in'}
                </div>
                <div style={S.callPanelCaption}>
                  {callState === 'listening' && (liveTranscript || '…')}
                  {callState === 'speaking' && ''}
                  {callState === 'connecting' && 'Allow the mic if your browser asks.'}
                </div>
              </div>
              <button style={S.callEndInline} onClick={endCallAndDebrief}>End</button>
            </div>
          )}
        </div>
      )}

      <div style={S.actionBar}>
        {mode !== 'raja' && (
          <div style={S.hintWrap}>
            <button style={S.hintTrigger} onClick={() => setHintMenu((o) => !o)}>💡 Hint ▾</button>
            {hintMenu && (
              <div style={S.hintMenuPop}>
                <button style={S.hintOption} onClick={() => getHint('strategy')}>
                  <b>Strategy</b><span style={S.hintOptDesc}>Which tool / phase to run now</span>
                </button>
                <button style={S.hintOption} onClick={() => getHint('words')}>
                  <b>Exact words</b><span style={S.hintOptDesc}>A line to say next</span>
                </button>
              </div>
            )}
          </div>
        )}
        <div style={S.actionRight}>
          {messages.length >= 4 && !showDebrief && (
            <button style={{ ...S.debriefBtn, marginLeft: 0 }} onClick={runDebrief}>{mode === 'raja' ? '🎓 End & Recap' : '📋 End & Debrief'}</button>
          )}
        </div>
      </div>

      {/* WHY Progress Bar — replaces input in roleplay after first message */}
      {mode === 'roleplay' && messages.length > 0 ? (
        <div style={S.whyBarBottom}>
          <div style={S.whyBarHeader}>
            <span style={S.whyBarLabel}>GETTING THE WHY</span>
            <span style={S.whyBarPct}>{whyProgress * 10}%</span>
          </div>
          <div style={S.whyBarTrack}>
            <div style={{
              ...S.whyBarFill,
              width: `${whyProgress * 10}%`,
              background: whyProgress >= 8 ? '#43A047' : whyProgress >= 5 ? '#D4A843' : '#3A5A7A',
            }} />
          </div>
          {messages.filter((m) => m.role === 'user').length >= 3 && whyProgress <= 2 ? (
            <div style={S.offTrackBox}>
              <span style={S.offTrackLabel}>⚠️ Off track — you haven't gotten near their WHY.</span>
              <button style={{ ...S.offTrackBtn, opacity: hintLoading ? 0.5 : 1 }} disabled={hintLoading} onClick={() => getHint('strategy')}>💡 What would Raja do?</button>
            </div>
          ) : (
            <div style={S.whyBarHint}>
              {whyProgress <= 2 && 'Ask about their life — who are they, what do they do?'}
              {whyProgress > 2 && whyProgress <= 4 && 'Go deeper — what do they really want for their family?'}
              {whyProgress > 4 && whyProgress <= 6 && "Getting warmer — what's it costing them to stay where they are?"}
              {whyProgress > 6 && whyProgress < 8 && "Almost there — make them feel the gap. Who are they doing this for?"}
              {whyProgress >= 8 && whyProgress < 10 && "You've got the WHY. Bridge into the New Art of Living."}
              {whyProgress >= 10 && "Perfect. They're ready to hear the solution."}
            </div>
          )}
          <div style={{ ...S.drillInputRow, justifyContent: 'center', marginTop: 8 }}>
            <button style={S.callCircle} onClick={startCall} title="Resume live call">📞</button>
            <span style={{ fontSize: 12, color: '#8899A6', alignSelf: 'center' }}>Tap to talk to the prospect</span>
          </div>
        </div>

      /* Drill Progress Bar — replaces input in gauntlet after first response */
      ) : mode === 'drill' && messages.length > 1 ? (
        <div style={S.drillBarBottom}>
          <div style={S.drillBarHeader}>
            <span style={S.drillBarLabel}>
              {drillProgress <= 4 ? '🔴 OVERCOME THE OBJECTION' : drillProgress <= 6 ? '🟡 GET BACK TO THE WHY' : drillProgress <= 8 ? '🟢 BRIDGE TO NAOL' : '✅ COMPLETE'}
            </span>
            <span style={S.drillBarPct}>{drillProgress * 10}%</span>
          </div>
          <div style={S.drillBarTrack}>
            <div style={{
              ...S.drillBarFill,
              width: `${drillProgress * 10}%`,
            }} />
          </div>
          <div style={S.drillBarPhases}>
            <div style={{ ...S.drillPhase, opacity: drillProgress >= 1 ? 1 : 0.3 }}>
              <div style={{ ...S.drillPhaseDot, background: drillProgress <= 4 ? '#E53935' : drillProgress <= 6 ? '#D4A843' : '#43A047' }} />
              <span>Handle Objection</span>
            </div>
            <div style={{ ...S.drillPhaseArrow }}>→</div>
            <div style={{ ...S.drillPhase, opacity: drillProgress >= 5 ? 1 : 0.3 }}>
              <div style={{ ...S.drillPhaseDot, background: drillProgress >= 7 ? '#43A047' : drillProgress >= 5 ? '#D4A843' : '#5A6A7A' }} />
              <span>Get the WHY</span>
            </div>
            <div style={{ ...S.drillPhaseArrow }}>→</div>
            <div style={{ ...S.drillPhase, opacity: drillProgress >= 8 ? 1 : 0.3 }}>
              <div style={{ ...S.drillPhaseDot, background: drillProgress >= 9 ? '#43A047' : '#5A6A7A' }} />
              <span>New Art of Living</span>
            </div>
          </div>
          <div style={S.drillBarHint}>
            {drillProgress <= 2 && 'Use the right tool — Pullback, Must Conversion, or Pain Bridge.'}
            {drillProgress > 2 && drillProgress <= 4 && 'Ask, don\'t tell. Use silence after your question.'}
            {drillProgress > 4 && drillProgress <= 6 && 'Objection handled — now get back to their WHY. Who are they doing this for?'}
            {drillProgress > 6 && drillProgress <= 8 && 'You have the WHY — bridge into Freedom, Security, Peace.'}
            {drillProgress > 8 && drillProgress < 10 && 'Almost perfect — lock the next step.'}
            {drillProgress >= 10 && 'Perfect execution. Ready for the next round.'}
          </div>
          <div style={S.drillInputRow}>
            <button style={S.callCircle} onClick={startCall} title="Start live call">📞</button>
            <textarea ref={inputRef} value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={handleKeyDown}
              placeholder="Handle the objection…"
              style={S.input} rows={1} disabled={loading} />
            <button onClick={sendMessage} disabled={loading || !input.trim()} style={{ ...S.sendBtn, opacity: loading || !input.trim() ? 0.4 : 1 }}>Send</button>
          </div>
        </div>

      /* Raja mode — WHY bar (Raja getting YOUR why) + an input row, since you reply as the client */
      ) : mode === 'raja' && messages.length > 0 ? (
        <div style={S.whyBarBottom}>
          <div style={S.whyBarHeader}>
            <span style={S.whyBarLabel}>RAJA — GETTING YOUR WHY</span>
            <span style={S.whyBarPct}>{whyProgress * 10}%</span>
          </div>
          <div style={S.whyBarTrack}>
            <div style={{
              ...S.whyBarFill,
              width: `${whyProgress * 10}%`,
              background: whyProgress >= 8 ? '#43A047' : whyProgress >= 5 ? '#D4A843' : '#3A5A7A',
            }} />
          </div>
          <div style={S.whyBarHint}>
            {whyProgress <= 2 && 'Raja is breaking the ice and getting to know you.'}
            {whyProgress > 2 && whyProgress <= 4 && "He's into your situation now — answer like a real client."}
            {whyProgress > 4 && whyProgress <= 6 && "Getting warmer — he's circling what really matters to you."}
            {whyProgress > 6 && whyProgress < 8 && "Almost there — notice how he makes you feel the gap."}
            {whyProgress >= 8 && whyProgress < 10 && "He's uncovered your WHY. Watch him bridge to the solution."}
            {whyProgress >= 10 && 'Masterful — your WHY is fully on the table.'}
          </div>
          <div style={S.drillInputRow}>
            <button style={S.callCircle} onClick={startCall} title="Start live call">📞</button>
            <textarea ref={inputRef} value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={handleKeyDown}
              placeholder="Reply as the client…"
              style={S.input} rows={1} disabled={loading} />
            <button onClick={sendMessage} disabled={loading || !input.trim()} style={{ ...S.sendBtn, opacity: loading || !input.trim() ? 0.4 : 1 }}>Send</button>
          </div>
        </div>

      ) : (
        <div style={S.inputArea}>
          <button style={S.callCircle} onClick={startCall} title="Start live call">📞</button>
          <textarea ref={inputRef} value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={handleKeyDown}
            placeholder={noMessages && mode === 'roleplay' ? "Open the call — what do you say?" : "Type your reply, or tap 📞 for a live call…"}
            style={S.input} rows={2} disabled={loading} />
          <button onClick={sendMessage} disabled={loading || !input.trim()} style={{ ...S.sendBtn, opacity: loading || !input.trim() ? 0.4 : 1 }}>Send</button>
        </div>
      )}

      {redempterModalEl}
    </div>
  );
}

/* ============================== STYLES ============================== */

const S = {
  container: { height: '100vh', background: '#0F1419', color: '#E8E6E1', fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", display: 'flex', flexDirection: 'column', overflow: 'hidden' },
  landing: { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', padding: '24px' },
  logoMark: { fontSize: 14, fontWeight: 700, letterSpacing: '3px', color: '#D4A843', border: '1px solid #D4A843', padding: '6px 14px', marginBottom: 28 },
  title: { fontSize: 28, fontWeight: 800, letterSpacing: '4px', margin: '0 0 8px 0' },
  subtitle: { fontSize: 14, color: '#8899A6', margin: '0 0 28px 0' },

  userBar: { position: 'absolute', top: 16, right: 20, display: 'flex', alignItems: 'center', gap: 12 },
  userName: { fontSize: 13, color: '#8899A6' },
  logoutBtn: { background: 'none', border: '1px solid #2A3A4A', color: '#8899A6', fontSize: 11, padding: '5px 12px', borderRadius: 4, cursor: 'pointer', fontFamily: 'inherit' },

  diffSelector: { display: 'flex', gap: 8, marginBottom: 32, flexWrap: 'wrap', justifyContent: 'center' },
  diffBtn: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, border: '1px solid', borderRadius: 8, padding: '8px 14px', cursor: 'pointer', fontFamily: 'inherit', transition: 'all .15s', minWidth: 64 },
  diffNum: { fontSize: 16, fontWeight: 800 },
  diffName: { fontSize: 10, letterSpacing: '1px', fontWeight: 600 },

  cardRow: { display: 'flex', gap: 20, flexWrap: 'wrap', justifyContent: 'center', maxWidth: 1000 },
  card: { background: '#1A2332', border: '1px solid #2A3A4A', borderRadius: 8, padding: '30px 24px', width: 310, cursor: 'pointer', textAlign: 'left', color: '#E8E6E1', transition: 'border-color .2s, transform .2s', fontFamily: 'inherit' },
  cardIcon: { fontSize: 30, marginBottom: 14 },
  cardTitle: { fontSize: 18, fontWeight: 700, letterSpacing: '2px', marginBottom: 12, color: '#D4A843' },
  cardDesc: { fontSize: 13, lineHeight: 1.6, color: '#8899A6', marginBottom: 18 },
  cardTag: { fontSize: 10, letterSpacing: '2px', color: '#D4A843', fontWeight: 700, borderTop: '1px solid #2A3A4A', paddingTop: 12 },
  historyLink: { marginTop: 32, background: 'none', border: '1px solid #2A3A4A', color: '#8899A6', fontSize: 12, padding: '10px 20px', borderRadius: 6, cursor: 'pointer', fontFamily: 'inherit', letterSpacing: '1px' },

  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', borderBottom: '1px solid #1A2332', background: '#0F1419', position: 'sticky', top: 0, zIndex: 20 },
  headerCenter: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', justifyContent: 'center' },
  backBtn: { background: 'none', border: 'none', color: '#8899A6', fontSize: 13, cursor: 'pointer', fontFamily: 'inherit', padding: '4px 6px', whiteSpace: 'nowrap' },
  headerTitle: { fontSize: 13, fontWeight: 700, letterSpacing: '2px', color: '#D4A843' },
  headerRight: { display: 'flex', alignItems: 'center', gap: 6 },
  iconBtn: { border: '1px solid #2A3A4A', background: '#1A2332', borderRadius: 6, padding: '5px 9px', cursor: 'pointer', fontSize: 14, fontFamily: 'inherit', color: '#E8E6E1' },
  newBtn: { background: '#1A2332', border: '1px solid #2A3A4A', color: '#8899A6', fontSize: 11, padding: '6px 12px', borderRadius: 4, cursor: 'pointer', fontFamily: 'inherit' },
  scoreBadge: { fontSize: 11, fontWeight: 600, color: '#43A047', fontFamily: 'monospace' },
  timerBadge: { fontSize: 11, fontWeight: 600, color: '#8899A6', fontFamily: 'monospace', background: '#1A2332', padding: '2px 8px', borderRadius: 4 },
  diffPillSm: { fontSize: 10, fontWeight: 700, letterSpacing: '1px', border: '1px solid', borderRadius: 4, padding: '2px 7px' },

  settingsPanel: { position: 'absolute', top: 52, right: 12, width: 256, maxHeight: '78vh', overflowY: 'auto', background: '#161E2B', border: '1px solid #2A3A4A', borderRadius: 8, padding: 14, zIndex: 30, boxShadow: '0 8px 24px rgba(0,0,0,.4)' },
  settingLabel: { fontSize: 10, letterSpacing: '1.5px', color: '#8899A6', fontWeight: 700, marginBottom: 8, marginTop: 4 },
  diffMini: { display: 'flex', gap: 6, marginBottom: 14 },
  diffMiniBtn: { flex: 1, border: '1px solid', borderRadius: 6, padding: '8px 0', cursor: 'pointer', fontFamily: 'inherit', fontWeight: 800, fontSize: 14 },
  voiceSelect: { width: '100%', background: '#0F1419', border: '1px solid #2A3A4A', color: '#E8E6E1', borderRadius: 6, padding: '8px', fontSize: 12, fontFamily: 'inherit', marginBottom: 8 },
  testVoiceBtn: { flex: 1, background: '#1A2332', border: '1px solid #2A3A4A', color: '#8899A6', borderRadius: 6, padding: '8px', fontSize: 11, cursor: 'pointer', fontFamily: 'inherit' },
  restartBtn: { width: '100%', background: '#D4A843', border: 'none', color: '#0F1419', borderRadius: 6, padding: '9px', fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', letterSpacing: '1px', marginTop: 10 },
  calibTag: { color: '#43A047', fontWeight: 700, letterSpacing: '1px', marginLeft: 6, textTransform: 'none' },
  calibBtn: { width: '100%', background: '#231A2E', border: '1px solid #5A3A6A', color: '#C8A8E0', borderRadius: 6, padding: '9px', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', marginBottom: 8 },
  calibReadout: { fontSize: 10, color: '#7A8A5A', marginBottom: 10 },
  sliderRow: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 },
  sliderLabel: { fontSize: 11, color: '#8899A6', width: 38, flexShrink: 0 },
  slider: { flex: 1, accentColor: '#D4A843', height: 4 },
  sliderVal: { fontSize: 11, color: '#E8E6E1', width: 30, textAlign: 'right', fontFamily: 'monospace' },
  calibActions: { display: 'flex', gap: 8, marginTop: 4 },
  calibResetBtn: { flex: 1, background: 'transparent', border: '1px solid #4A2A2A', color: '#C88', borderRadius: 6, padding: '8px', fontSize: 11, cursor: 'pointer', fontFamily: 'inherit' },

  calibOverlay: { position: 'fixed', inset: 0, background: 'rgba(8,12,18,.82)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100, padding: 20 },
  calibModal: { width: '100%', maxWidth: 420, background: '#161E2B', border: '1px solid #5A3A6A', borderRadius: 14, padding: 22, boxShadow: '0 20px 60px rgba(0,0,0,.5)' },
  calibModalHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
  calibModalTitle: { fontSize: 14, fontWeight: 800, letterSpacing: '2px', color: '#C8A8E0' },
  calibIntro: { fontSize: 13, color: '#8899A6', marginBottom: 12, lineHeight: 1.5 },
  calibPhrase: { fontSize: 18, lineHeight: 1.5, color: '#E8E6E1', fontWeight: 600, padding: '16px 18px', background: '#0F1419', border: '1px solid #2A3A4A', borderRadius: 10, marginBottom: 20 },
  calibRecordBtn: { flex: 1, width: '100%', background: '#231A2E', border: '1px solid #5A3A6A', color: '#C8A8E0', borderRadius: 8, padding: '13px', fontSize: 14, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' },
  calibLive: { fontSize: 14, color: '#E8E6E1', marginBottom: 14, display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'center' },
  calibLiveDot: { color: '#E53935', animation: 'pulse 1s infinite' },
  calibDone: { fontSize: 14, color: '#43A047', fontWeight: 700, marginBottom: 14, textAlign: 'center' },
  calibErr: { fontSize: 13, color: '#E0A8A8', marginBottom: 14, textAlign: 'center', lineHeight: 1.5 },
  calibFinishBtn: { width: '100%', background: '#D4A843', border: 'none', color: '#0F1419', borderRadius: 8, padding: '12px', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', letterSpacing: '1px', marginTop: 14 },

  chatArea: { flex: 1, overflowY: 'auto', padding: '36px 16px 16px', display: 'flex', flexDirection: 'column', gap: 8 },
  msgRow: { display: 'flex', width: '100%' },
  msgBubble: { maxWidth: '82%', padding: '12px 16px', borderRadius: 12, fontSize: 14, lineHeight: 1.6, position: 'relative' },
  userBubble: { background: '#1A3A5C', color: '#E8E6E1', borderBottomRightRadius: 4 },
  botBubble: { background: '#1A2332', color: '#C8C8C8', borderBottomLeftRadius: 4, border: '1px solid #2A3A4A' },
  speakerLabel: { fontSize: 9, letterSpacing: '1.5px', color: '#D4A843', marginBottom: 4, fontWeight: 700 },
  msgText: { whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
  replayBtn: { position: 'absolute', bottom: 4, right: 8, background: 'none', border: 'none', fontSize: 12, cursor: 'pointer', opacity: 0.4, padding: 2 },
  typing: { display: 'flex', gap: 4, padding: '4px 0' },
  dot: { fontSize: 8, color: '#8899A6', animation: 'pulse 1s infinite' },

  // FIX #2: Prospect intro card
  prospectCard: { background: '#1A2332', border: '1px solid #D4A843', borderRadius: 12, padding: '24px 20px', textAlign: 'center', margin: '40px auto 20px', maxWidth: 400 },
  prospectName: { fontSize: 24, fontWeight: 800, color: '#D4A843', marginBottom: 6 },
  prospectVibe: { fontSize: 13, color: '#8899A6', marginBottom: 16 },
  prospectPrompt: { fontSize: 14, color: '#E8E6E1', fontWeight: 600 },
  prospectTag: { fontSize: 10, color: '#8899A6', fontWeight: 400 },

  // Debrief
  debriefBtn: { marginLeft: 'auto', background: '#1A2A3A', border: '1px solid #3A5A7A', color: '#6FA8DC', fontSize: 12, padding: '6px 14px', borderRadius: 6, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 600 },
  debriefPanel: { position: 'fixed', top: 60, left: 16, right: 16, bottom: 80, background: '#161E2B', border: '2px solid #D4A843', borderRadius: 14, padding: '16px 18px', zIndex: 50, overflowY: 'auto', boxShadow: '0 12px 40px rgba(0,0,0,.6)' },
  watchPanel: { position: 'fixed', top: 60, left: 16, right: 16, bottom: 80, background: '#161E2B', border: '2px solid #D4A843', borderRadius: 14, padding: '14px 16px', zIndex: 50, boxShadow: '0 12px 40px rgba(0,0,0,.6)', display: 'flex', flexDirection: 'column' },
  watchWhyBar: { padding: '6px 0 10px', borderBottom: '1px solid #2A3A4A', marginBottom: 8 },
  watchBody: { flex: 1, overflowY: 'auto', paddingRight: 4 },
  debriefHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  debriefInHistory: { marginTop: 12, padding: '12px 0 0', borderTop: '1px solid #2A3A4A' },

  hintCard: { position: 'fixed', bottom: 80, left: 16, right: 16, background: '#1F2A1A', border: '2px solid #4A5A2A', borderRadius: 12, padding: '14px 16px', maxHeight: '45vh', overflowY: 'auto', zIndex: 40, boxShadow: '0 -8px 30px rgba(0,0,0,.5)' },
  hintHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  hintLabel: { fontSize: 10, letterSpacing: '1.5px', color: '#A8C843', fontWeight: 700 },
  hintClose: { background: 'none', border: 'none', color: '#8899A6', cursor: 'pointer', fontSize: 14 },
  hintText: { fontSize: 14, lineHeight: 1.6, color: '#D8E0C8', whiteSpace: 'pre-wrap', cursor: 'text', userSelect: 'text' },
  hintHeaderRight: { display: 'flex', alignItems: 'center', gap: 8 },
  hintSendTop: { background: '#D4A843', color: '#0F1419', border: '1px solid #D4A843', fontSize: 12, fontWeight: 700, padding: '5px 12px', borderRadius: 6, cursor: 'pointer', fontFamily: 'inherit' },
  hintTip: { fontSize: 11, color: '#7A8A5A', marginTop: 10, paddingTop: 10, borderTop: '1px solid #3A4A2A' },

  speakingBar: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12, padding: 8, background: '#1A2332', borderTop: '1px solid #2A3A4A' },
  speakingPulse: { fontSize: 12, color: '#D4A843', animation: 'pulse 1.5s infinite' },
  stopSpeakBtn: { background: '#2A3A4A', border: 'none', color: '#E8E6E1', fontSize: 11, padding: '4px 12px', borderRadius: 4, cursor: 'pointer', fontFamily: 'inherit' },

  actionBar: { padding: '0 16px 6px', display: 'flex', position: 'relative', alignItems: 'center', zIndex: 20 },
  actionRight: { marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' },
  redeemBtn: { background: '#2A1E12', border: '1px solid #D4A843', color: '#D4A843', fontSize: 12, padding: '6px 12px', borderRadius: 6, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 700 },
  debriefActions: { display: 'flex', flexDirection: 'column', gap: 8, marginTop: 14, borderTop: '1px solid #2A3A4A', paddingTop: 14 },
  debriefActionBtn: { background: '#1A2332', border: '1px solid #3A5A7A', color: '#9CC4E8', fontSize: 13, fontWeight: 700, padding: '11px 14px', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit' },
  debriefActionGhost: { background: 'none', border: '1px solid #2A3A4A', color: '#8899A6', fontSize: 13, fontWeight: 600, padding: '10px 14px', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit' },
  offTrackBox: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 4, padding: '6px 10px', background: '#2A1414', border: '1px solid #5A2A2A', borderRadius: 8 },
  offTrackLabel: { fontSize: 11, color: '#E0A8A8', fontWeight: 600, lineHeight: 1.3 },
  offTrackBtn: { flexShrink: 0, background: '#D4A843', border: 'none', color: '#0F1419', fontSize: 11, fontWeight: 700, padding: '6px 10px', borderRadius: 6, cursor: 'pointer', fontFamily: 'inherit' },
  apiErrorBar: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, margin: '0 16px', padding: '8px 12px', background: '#2A1414', border: '1px solid #5A2A2A', borderRadius: 8, color: '#E0A8A8', fontSize: 12, fontWeight: 600 },
  apiErrorClose: { background: 'none', border: 'none', color: '#8899A6', cursor: 'pointer', fontSize: 13, flexShrink: 0 },
  hintWrap: { position: 'relative', zIndex: 20 },
  hintTrigger: { background: '#1F2A1A', border: '1px solid #4A5A2A', color: '#A8C843', fontSize: 12, padding: '6px 14px', borderRadius: 6, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 600 },
  hintMenuPop: { position: 'absolute', bottom: 38, left: 0, background: '#161E2B', border: '1px solid #2A3A4A', borderRadius: 8, overflow: 'hidden', width: 220, zIndex: 15, boxShadow: '0 8px 24px rgba(0,0,0,.4)' },
  hintOption: { display: 'flex', flexDirection: 'column', gap: 2, width: '100%', textAlign: 'left', background: 'none', border: 'none', borderBottom: '1px solid #2A3A4A', color: '#E8E6E1', padding: '10px 14px', cursor: 'pointer', fontFamily: 'inherit', fontSize: 13 },
  hintOptDesc: { fontSize: 11, color: '#8899A6' },

  inputArea: { padding: '10px 16px', borderTop: '1px solid #1A2332', display: 'flex', gap: 8, background: '#0F1419', position: 'sticky', bottom: 0 },
  callCircle: { width: 46, height: 46, borderRadius: '50%', border: '2px solid #2A5A3A', background: '#1A3A2A', color: '#7CDC9C', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20, cursor: 'pointer', flexShrink: 0, alignSelf: 'flex-end' },
  callPanel: { margin: '0 16px 8px' },
  callPanelLive: { display: 'flex', alignItems: 'center', gap: 12, background: '#0F1A15', border: '1px solid #2A4A3A', borderRadius: 12, padding: '10px 12px' },
  callMiniOrb: { width: 52, height: 52, borderRadius: '50%', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 24, border: '1px solid #2A4A3A', background: 'linear-gradient(145deg,#1A2A24,#0F1A15)', cursor: 'pointer', transition: 'all .3s' },
  callPanelMid: { flex: 1, minWidth: 0 },
  callPanelState: { fontSize: 12, fontWeight: 700, color: '#7CDC9C', letterSpacing: '.5px', marginBottom: 2 },
  callPanelCaption: { fontSize: 12, color: '#A8B8A8', lineHeight: 1.45, maxHeight: 52, overflowY: 'auto' },
  callEndInline: { flexShrink: 0, alignSelf: 'stretch', background: '#3A1A1A', border: '1px solid #5A2A2A', color: '#E0A8A8', fontSize: 12, fontWeight: 700, padding: '0 16px', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit' },
  callPanelErr: { background: '#1A1414', border: '1px solid #5A2A2A', borderRadius: 12, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8 },
  callPanelErrHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  callPanelErrTitle: { fontSize: 13, fontWeight: 800, color: '#E0A8A8' },
  callPanelX: { background: 'none', border: 'none', color: '#8899A6', cursor: 'pointer', fontSize: 14 },
  callPanelErrMsg: { fontSize: 13, color: '#C8C8C8', lineHeight: 1.55 },
  callOrbListening: { animation: 'orbBreathe 2s ease-in-out infinite', borderColor: '#43A047', background: 'linear-gradient(145deg,#1A3A24,#0F2A15)' },
  callOrbThinking: { borderColor: '#D4A843', background: 'linear-gradient(145deg,#2A2418,#1A1810)' },
  callOrbSpeaking: { animation: 'orbSpeak 1.6s ease-in-out infinite', borderColor: '#D4A843', background: 'linear-gradient(145deg,#2A2418,#1A1810)' },
  callRetryBtn: { background: '#1A3A2A', border: '1px solid #2A5A3A', color: '#7CDC9C', fontSize: 13, fontWeight: 700, padding: '11px 18px', borderRadius: 10, cursor: 'pointer', fontFamily: 'inherit' },
  callCloseBtn: { background: 'transparent', border: '1px solid #2A3A4A', color: '#8899A6', fontSize: 13, fontWeight: 600, padding: '11px 18px', borderRadius: 10, cursor: 'pointer', fontFamily: 'inherit' },
  input: { flex: 1, background: '#1A2332', border: '1px solid #2A3A4A', borderRadius: 8, padding: 12, color: '#E8E6E1', fontSize: 14, fontFamily: 'inherit', resize: 'none', outline: 'none', lineHeight: 1.5 },
  sendBtn: { background: '#D4A843', border: 'none', borderRadius: 8, color: '#0F1419', fontWeight: 700, fontSize: 13, padding: '0 20px', cursor: 'pointer', fontFamily: 'inherit', letterSpacing: '1px', alignSelf: 'flex-end', height: 42 },

  historyScroll: { flex: 1, overflowY: 'auto', padding: 16 },
  empty: { textAlign: 'center', color: '#8899A6', fontSize: 14, lineHeight: 1.6, marginTop: 60, padding: '0 24px' },
  patternBtn: { width: '100%', background: '#1A2332', border: '1px solid #D4A843', color: '#D4A843', fontSize: 13, fontWeight: 700, padding: '12px', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit', letterSpacing: '1px', marginBottom: 14 },
  patternPanel: { marginBottom: 20 },
  statBlock: { background: '#161E2B', border: '1px solid #2A3A4A', borderRadius: 10, padding: 16, marginBottom: 12 },
  statHeaderRow: { display: 'flex', alignItems: 'center', gap: 16, marginBottom: 16 },
  statBig: { fontSize: 40, fontWeight: 800, color: '#43A047', lineHeight: 1 },
  statBigUnit: { fontSize: 16, color: '#8899A6', fontWeight: 400 },
  statMeta: { fontSize: 13, color: '#C8C8C8' },
  statSub: { fontSize: 11, color: '#8899A6', marginTop: 2 },
  barRow: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 },
  barLabel: { fontSize: 12, color: '#8899A6', width: 130, flexShrink: 0 },
  barTrack: { flex: 1, height: 8, background: '#0F1419', borderRadius: 4, overflow: 'hidden' },
  barFill: { height: '100%', borderRadius: 4, transition: 'width .4s' },
  barVal: { fontSize: 12, color: '#E8E6E1', width: 28, textAlign: 'right', fontFamily: 'monospace' },
  weakCallout: { marginTop: 12, padding: '8px 12px', background: '#2A1A1A', border: '1px solid #4A2A2A', borderRadius: 6, fontSize: 12, color: '#E0A8A8' },
  coachBlock: { background: '#161E2B', border: '1px solid #2A3A4A', borderRadius: 10, padding: 16 },
  coachLabel: { fontSize: 10, letterSpacing: '1.5px', color: '#D4A843', fontWeight: 700, marginBottom: 8 },
  coachText: { fontSize: 14, lineHeight: 1.7, color: '#C8C8C8', whiteSpace: 'pre-wrap' },

  sessionList: { display: 'flex', flexDirection: 'column', gap: 8 },
  sessionCard: { background: '#161E2B', border: '1px solid #2A3A4A', borderRadius: 8, overflow: 'hidden' },
  sessionTop: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 14px', cursor: 'pointer', flexWrap: 'wrap', gap: 6 },
  sessionLeft: { display: 'flex', alignItems: 'center', gap: 8 },
  modePill: { fontSize: 9, fontWeight: 700, letterSpacing: '1px', color: '#C8C8C8', padding: '3px 8px', borderRadius: 4 },
  sessionRight: { display: 'flex', alignItems: 'center', gap: 10 },
  sessionScore: { fontSize: 14, fontWeight: 700, color: '#43A047', fontFamily: 'monospace' },
  sessionScoreMuted: { fontSize: 12, color: '#8899A6' },
  sessionDate: { fontSize: 11, color: '#5A6A7A' },
  delBtn: { background: 'none', border: 'none', color: '#5A6A7A', cursor: 'pointer', fontSize: 13, padding: 2 },
  transcript: { borderTop: '1px solid #2A3A4A', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 280, overflowY: 'auto' },
  tLine: { display: 'flex', gap: 8, fontSize: 13, lineHeight: 1.5 },
  tWho: { fontSize: 9, fontWeight: 700, letterSpacing: '1px', flexShrink: 0, width: 56, paddingTop: 2 },
  tText: { color: '#C8C8C8', whiteSpace: 'pre-wrap' },

  // API Usage Bar
  usageBar: { position: 'absolute', top: 52, left: 0, right: 0, padding: '4px 14px 6px', background: '#0F1419', borderBottom: '1px solid #1A2332', zIndex: 19 },
  usageTop: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 },
  usageLabel: { fontSize: 9, letterSpacing: '1.5px', color: '#8899A6', fontWeight: 700 },
  usagePct: { fontSize: 11, color: '#E8E6E1', fontWeight: 700, fontFamily: 'monospace' },
  usageDetail: { fontSize: 10, color: '#5A6A7A', fontFamily: 'monospace' },
  usageTimer: { fontSize: 10, color: '#43A047', fontWeight: 600, marginLeft: 'auto' },
  usageTrack: { height: 6, background: '#1A2332', borderRadius: 3, overflow: 'hidden' },
  usageFill: { height: '100%', borderRadius: 3, transition: 'width .6s ease, background .6s ease' },

  // WHY Progress Bar (bottom, replaces input area)
  whyBarBottom: { padding: '10px 16px', borderTop: '1px solid #D4A843', background: '#0F1419', position: 'sticky', bottom: 0 },
  whyBarHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 },
  whyBarLabel: { fontSize: 10, letterSpacing: '1.5px', color: '#D4A843', fontWeight: 700 },
  whyBarPct: { fontSize: 12, color: '#E8E6E1', fontWeight: 700, fontFamily: 'monospace' },
  whyBarTrack: { height: 10, background: '#1A2332', borderRadius: 5, overflow: 'hidden' },
  whyBarFill: { height: '100%', borderRadius: 5, transition: 'width .6s ease, background .6s ease' },
  whyBarHint: { fontSize: 11, color: '#8899A6', marginTop: 4, fontStyle: 'italic' },

  // Drill Progress Bar (bottom, gauntlet mode)
  drillBarBottom: { padding: '10px 16px', borderTop: '1px solid #2A3A4A', background: '#0F1419', position: 'sticky', bottom: 0 },
  drillBarHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 },
  drillBarLabel: { fontSize: 11, letterSpacing: '1px', fontWeight: 700, color: '#E8E6E1' },
  drillBarPct: { fontSize: 12, color: '#E8E6E1', fontWeight: 700, fontFamily: 'monospace' },
  drillBarTrack: { height: 12, background: '#1A2332', borderRadius: 6, overflow: 'hidden', marginBottom: 6 },
  drillBarFill: { height: '100%', borderRadius: 6, transition: 'width .6s ease', background: 'linear-gradient(90deg, #E53935, #D4A843 50%, #43A047)' },
  drillBarPhases: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, marginBottom: 4 },
  drillPhase: { display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, color: '#C8C8C8', fontWeight: 600, transition: 'opacity .3s' },
  drillPhaseDot: { width: 8, height: 8, borderRadius: '50%', transition: 'background .3s' },
  drillPhaseArrow: { fontSize: 10, color: '#5A6A7A' },
  drillBarHint: { fontSize: 11, color: '#8899A6', marginTop: 2, marginBottom: 8, fontStyle: 'italic' },
  drillInputRow: { display: 'flex', gap: 8, alignItems: 'flex-end' },

  // Congrats overlay
  congratsOverlay: { position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 },
  congratsModal: { background: '#161E2B', border: '2px solid #D4A843', borderRadius: 16, padding: '32px 28px', textAlign: 'center', maxWidth: 400, width: '90%', boxShadow: '0 0 60px rgba(212,168,67,.3)' },

  // Redempter modal
  redempterLink: { marginTop: 14, background: 'none', border: '1px solid #D4A843', color: '#D4A843', fontSize: 12, padding: '10px 20px', borderRadius: 6, cursor: 'pointer', fontFamily: 'inherit', letterSpacing: '1px', fontWeight: 700 },
  redempterOverlay: { position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,.75)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100, padding: 16 },
  redempterModal: { background: '#161E2B', border: '2px solid #D4A843', borderRadius: 16, padding: '20px 22px', maxWidth: 640, width: '100%', maxHeight: '85vh', display: 'flex', flexDirection: 'column', boxShadow: '0 0 60px rgba(212,168,67,.25)' },
  redempterHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 14 },
  redempterTitle: { fontSize: 18, fontWeight: 800, letterSpacing: '2px', color: '#D4A843' },
  redempterSub: { fontSize: 12, color: '#8899A6', marginTop: 4, lineHeight: 1.5 },
  redempterX: { background: 'none', border: 'none', color: '#8899A6', cursor: 'pointer', fontSize: 16, flexShrink: 0 },
  redempterTextarea: { width: '100%', minHeight: 190, background: '#0F1419', border: '1px solid #2A3A4A', borderRadius: 8, padding: 12, color: '#E8E6E1', fontSize: 13, fontFamily: 'inherit', resize: 'vertical', outline: 'none', lineHeight: 1.5, boxSizing: 'border-box' },
  redempterActions: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, marginTop: 12 },
  redempterUpload: { fontSize: 12, color: '#8899A6', cursor: 'pointer', border: '1px solid #2A3A4A', borderRadius: 6, padding: '8px 14px', fontWeight: 600 },
  redempterGo: { background: '#D4A843', border: 'none', borderRadius: 8, color: '#0F1419', fontWeight: 700, fontSize: 13, padding: '10px 22px', cursor: 'pointer', fontFamily: 'inherit', letterSpacing: '1px' },
  redempterReset: { background: 'none', border: '1px solid #2A3A4A', borderRadius: 8, color: '#8899A6', fontWeight: 600, fontSize: 13, padding: '10px 18px', cursor: 'pointer', fontFamily: 'inherit' },
  redempterResult: { flex: 1, minHeight: 0, overflowY: 'auto', fontSize: 14, lineHeight: 1.7, color: '#D8D8D8', whiteSpace: 'pre-wrap', padding: '4px 2px' },
  redempterLoadingBox: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, padding: '40px 0', color: '#8899A6', fontSize: 13 },
  congratsEmoji: { fontSize: 56, marginBottom: 12 },
  congratsTitle: { fontSize: 24, fontWeight: 900, color: '#D4A843', letterSpacing: '2px', marginBottom: 12 },
  congratsBody: { fontSize: 15, lineHeight: 1.7, color: '#C8C8C8', marginBottom: 20 },
  congratsBtn: { background: '#D4A843', border: 'none', color: '#0F1419', fontSize: 14, fontWeight: 800, padding: '12px 32px', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit', letterSpacing: '1px' },
};
