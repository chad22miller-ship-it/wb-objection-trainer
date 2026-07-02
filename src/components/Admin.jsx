import { useState, useCallback, useEffect, useRef } from 'react';
import { DIFFICULTY_META } from '../constants';
import { supabase } from '../lib/supabase';
import { mean as avg } from '../lib/speech';

const diffMeta = (n) => DIFFICULTY_META[n - 1] || DIFFICULTY_META[2];

export default function Admin({ onBack }) {
  const [pin, setPin] = useState('');
  const [unlocked, setUnlocked] = useState(false);
  const [sessions, setSessions] = useState([]);
  const [users, setUsers] = useState([]);
  const [tab, setTab] = useState('reps');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [expandedRep, setExpandedRep] = useState(null);
  const [expandedSession, setExpandedSession] = useState(null);
  const [apiStats, setApiStats] = useState(null);
  const [consoleErrors, setConsoleErrors] = useState([]);
  const errorsRef = useRef([]);

  const fetchData = useCallback(async (code) => {
    setLoading(true);
    setError('');
    try {
      let token = '';
      try {
        const { data } = await supabase.auth.getSession();
        token = data?.session?.access_token || '';
      } catch (e) { /* not signed in */ }
      const res = await fetch('/api/admin', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ pin: code }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        if (res.status === 403) {
          setUnlocked(false);
          setError('Wrong PIN');
        } else {
          setError(err.error || `Error ${res.status}`);
        }
        setLoading(false);
        return;
      }

      const data = await res.json();
      const rawSessions = data.sessions || [];
      setSessions(rawSessions);
      setUsers(data.users || []);
      if (rawSessions.length === 0) {
        console.warn('[admin] 0 sessions returned from DB — sessions may be in localStorage only (users not logged in when practicing)');
      } else {
        const uids = new Set(rawSessions.map((s) => s.user_id));
        console.log(`[admin] ${rawSessions.length} sessions from ${uids.size} unique users`);
      }
      setUnlocked(true);
    } catch (err) {
      setError('Failed to load data');
    }
    setLoading(false);
  }, []);

  // Capture console errors globally
  useEffect(() => {
    const origError = console.error.bind(console);
    const origWarn = console.warn.bind(console);
    const push = (level, args) => {
      const entry = { level, msg: args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' '), t: new Date().toLocaleTimeString() };
      errorsRef.current = [entry, ...errorsRef.current].slice(0, 50);
      setConsoleErrors([...errorsRef.current]);
    };
    console.error = (...a) => { push('error', a); origError(...a); };
    console.warn = (...a) => { push('warn', a); origWarn(...a); };
    const prevOnError = window.onerror;
    const prevOnRejection = window.onunhandledrejection;
    window.onerror = (msg, src, line, col, err) => push('error', [`${msg} (${src}:${line}:${col})`]);
    window.onunhandledrejection = (e) => push('error', ['Unhandled promise:', e.reason?.message || e.reason]);
    return () => {
      console.error = origError; console.warn = origWarn;
      // Restore the previous handlers — leaving ours installed after unmount would call
      // setState on a dead component and clobber any handler the rest of the app sets.
      window.onerror = prevOnError || null;
      window.onunhandledrejection = prevOnRejection || null;
    };
  }, []);

  // Poll /api/stats every 15s when debug tab is active
  const fetchStats = useCallback(async () => {
    try {
      const r = await fetch('/api/stats');
      if (r.ok) setApiStats(await r.json());
    } catch (e) { /* ignore */ }
  }, []);

  useEffect(() => {
    if (tab !== 'debug') return;
    fetchStats();
    const id = setInterval(fetchStats, 15000);
    return () => clearInterval(id);
  }, [tab, fetchStats]);

  const handlePinSubmit = (e) => {
    e.preventDefault();
    if (pin.trim()) fetchData(pin.trim());
  };

  // Build rep list from ALL registered users so every signed-up rep appears,
  // even those with 0 sessions in Supabase (e.g. sessions still in localStorage).
  // (avg is the shared `mean` helper.)

  // One pass over sessions: group them by owner AND collect any session-only owners not
  // in `users`. Grouping into a Map avoids an O(users*sessions) filter per rep below, and
  // the account merge keeps sessions visible even if listUsers() failed server-side.
  // Sessions carry user_email / user_name from the get_all_sessions RPC.
  const accounts = users.slice();
  const knownIds = new Set(users.map((u) => u.id));
  const sessionsByUser = new Map();
  sessions.forEach((s) => {
    if (!s.user_id) return;
    if (!sessionsByUser.has(s.user_id)) sessionsByUser.set(s.user_id, []);
    sessionsByUser.get(s.user_id).push(s);
    if (!knownIds.has(s.user_id)) {
      knownIds.add(s.user_id);
      accounts.push({ id: s.user_id, email: s.user_email || '', name: s.user_name || '' });
    }
  });

  const repList = accounts.map((u) => {
    const repSessions = sessionsByUser.get(u.id) || [];
    const allRounds = [];
    let roleplays = 0;
    let drills = 0;
    let lastActive = null;
    const debriefScores = [];

    repSessions.forEach((s) => {
      const d = s.data;
      if (!d) return;
      if (d.mode === 'drill') drills++;
      if (d.mode === 'roleplay') roleplays++;
      if (d.rounds) allRounds.push(...d.rounds);
      if (d.debriefScores?.overall) debriefScores.push(d.debriefScores.overall);
      const t = d.startedAt || s.updated_at;
      if (t && (!lastActive || t > lastActive)) lastActive = t;
    });

    const overalls = allRounds.map((r) => r.overall).filter((x) => x != null);
    const half = Math.floor(overalls.length / 2);
    const trend = overalls.length >= 4 ? avg(overalls.slice(half)) - avg(overalls.slice(0, half)) : null;

    return {
      id: u.id,
      email: u.email || '',
      name: u.name || (u.email ? u.email.split('@')[0] : 'rep'),
      sessions: repSessions,
      totalSessions: repSessions.length,
      roleplays,
      drills,
      rounds: allRounds.length,
      drillAvg: avg(overalls),
      debriefAvg: avg(debriefScores),
      framework: avg(allRounds.map((r) => r.framework).filter((x) => x != null)),
      tonality: avg(allRounds.map((r) => r.tonality).filter((x) => x != null)),
      question: avg(allRounds.map((r) => r.question).filter((x) => x != null)),
      silence: avg(allRounds.map((r) => r.silence).filter((x) => x != null)),
      gettingTheWhy: avg(allRounds.map((r) => r.gettingTheWhy).filter((x) => x != null)),
      trend,
      lastActive,
    };
  });

  // Sort: reps who have practiced recently first, then alphabetical for non-practitioners
  repList.sort((a, b) => {
    if (a.lastActive && b.lastActive) return b.lastActive.localeCompare(a.lastActive);
    if (a.lastActive) return -1;
    if (b.lastActive) return 1;
    return (a.name || '').localeCompare(b.name || '');
  });

  const practicedIds = new Set(sessions.map((s) => s.user_id));
  const signins = [...users].sort((a, b) => (b.lastSignIn || '').localeCompare(a.lastSignIn || ''));

  const practicedReps = repList.filter((r) => r.totalSessions > 0);
  const drillAvgs = practicedReps.map((r) => r.drillAvg).filter(Boolean);
  const teamAvg = drillAvgs.length ? drillAvgs.reduce((sum, v) => sum + v, 0) / drillAvgs.length : 0;
  const totalSessions = sessions.length;
  const activeLast7 = repList.filter((r) => {
    if (!r.lastActive) return false;
    return Date.now() - new Date(r.lastActive).getTime() < 7 * 86400000;
  }).length;

  if (!unlocked) {
    return (
      <div style={S.container}>
        <div style={S.header}>
          <button style={S.backBtn} onClick={onBack}>← Home</button>
          <div style={S.headerTitle}>ADMIN</div>
          <div />
        </div>
        <div style={S.center}>
          <div style={S.pinBox}>
            <div style={S.pinIcon}>🔒</div>
            <form onSubmit={handlePinSubmit} style={S.pinForm}>
              <input
                type="password"
                inputMode="numeric"
                placeholder="Enter PIN"
                value={pin}
                onChange={(e) => { setPin(e.target.value); setError(''); }}
                style={S.pinInput}
                autoFocus
              />
              <button type="submit" style={S.pinBtn} disabled={loading || !pin.trim()}>
                {loading ? '...' : 'Unlock'}
              </button>
            </form>
            {error && <div style={S.pinError}>{error}</div>}
          </div>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div style={S.container}>
        <div style={S.header}>
          <button style={S.backBtn} onClick={onBack}>← Home</button>
          <div style={S.headerTitle}>ADMIN DASHBOARD</div>
          <div />
        </div>
        <div style={S.center}>Loading...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div style={S.container}>
        <div style={S.header}>
          <button style={S.backBtn} onClick={onBack}>← Home</button>
          <div style={S.headerTitle}>ADMIN DASHBOARD</div>
          <div />
        </div>
        <div style={S.center}>
          <div style={S.errorBox}>{error}</div>
          <button style={S.retryBtn} onClick={() => fetchData(pin)}>Retry</button>
        </div>
      </div>
    );
  }

  return (
    <div style={S.container}>
      <div style={S.header}>
        <button style={S.backBtn} onClick={onBack}>← Home</button>
        <div style={S.headerTitle}>ADMIN DASHBOARD</div>
        <button style={S.refreshBtn} onClick={() => fetchData(pin)}>↻ Refresh</button>
      </div>

      <div style={S.scroll}>
        <div style={S.tabBar}>
          <button style={tab === 'reps' ? S.tabActive : S.tab} onClick={() => setTab('reps')}>📊 Practice ({repList.length})</button>
          <button style={tab === 'signins' ? S.tabActive : S.tab} onClick={() => setTab('signins')}>👤 Sign-ins ({users.length})</button>
          <button style={tab === 'debug' ? S.tabActive : S.tab} onClick={() => setTab('debug')}>🔧 Debug</button>
        </div>

        {tab === 'signins' && (
          <div style={S.signinList}>
            {signins.length === 0 && <div style={S.empty}>No accounts yet.</div>}
            {signins.map((u) => (
              <div key={u.id} style={S.signinRow}>
                <div style={S.signinLeft}>
                  <div style={S.signinName}>{u.name || '(no name)'}</div>
                  <div style={S.signinEmail}>{u.email}</div>
                </div>
                <div style={S.signinRight}>
                  <div style={S.signinMeta}>Last login: {u.lastSignIn ? new Date(u.lastSignIn).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'never'}</div>
                  <div style={S.signinSub}>
                    Joined {new Date(u.createdAt).toLocaleDateString()}
                    {!practicedIds.has(u.id) && <span style={S.signinFlag}> · hasn’t practiced</span>}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {tab === 'reps' && (<>
        {/* Team stats */}
        <div style={S.statsRow}>
          <div style={S.statCard}>
            <div style={S.statNum}>{repList.length}</div>
            <div style={S.statLabel}>Signed up</div>
          </div>
          <div style={S.statCard}>
            <div style={S.statNum}>{practicedReps.length}</div>
            <div style={S.statLabel}>Practiced</div>
          </div>
          <div style={S.statCard}>
            <div style={S.statNum}>{activeLast7}</div>
            <div style={S.statLabel}>Active (7d)</div>
          </div>
          <div style={S.statCard}>
            <div style={S.statNum}>{totalSessions}</div>
            <div style={S.statLabel}>Sessions</div>
          </div>
          <div style={S.statCard}>
            <div style={{ ...S.statNum, color: teamAvg >= 7 ? '#43A047' : teamAvg >= 5 ? '#D4A843' : '#E53935' }}>
              {teamAvg ? teamAvg.toFixed(1) : '—'}
            </div>
            <div style={S.statLabel}>Team avg</div>
          </div>
        </div>

        {/* Rep list */}
        {repList.length === 0 && (
          <div style={S.empty}>No reps have signed up yet. Share the app URL with your team.</div>
        )}

        {repList.map((rep) => {
          const isOpen = expandedRep === rep.id;
          const bars = [
            { k: 'gettingTheWhy', label: 'Getting the WHY' },
            { k: 'framework', label: 'Framework' },
            { k: 'tonality', label: 'Tonality' },
            { k: 'question', label: 'Questions' },
            { k: 'silence', label: 'Silence' },
          ];

          return (
            <div key={rep.id} style={S.repCard}>
              <div style={S.repTop} onClick={() => setExpandedRep(isOpen ? null : rep.id)}>
                <div style={S.repLeft}>
                  <div style={S.repName}>{rep.name}</div>
                  <div style={S.repEmail}>{rep.email}</div>
                </div>
                <div style={S.repRight}>
                  <div style={S.repStats}>
                    {rep.totalSessions === 0
                      ? <span style={{ ...S.repStat, color: '#5A6A7A', fontStyle: 'italic' }}>hasn't practiced yet</span>
                      : <>
                          <span style={S.repStat}>{rep.roleplays} prospect{rep.roleplays !== 1 ? 's' : ''}</span>
                          <span style={S.repStat}>{rep.drills} gauntlet{rep.drills !== 1 ? 's' : ''}</span>
                          <span style={S.repStat}>{rep.rounds} rounds</span>
                        </>
                    }
                  </div>
                  <div style={S.repScoreRow}>
                    {rep.drillAvg != null && (
                      <span style={{ ...S.repScore, color: rep.drillAvg >= 7 ? '#43A047' : rep.drillAvg >= 5 ? '#D4A843' : '#E53935' }}>
                        {rep.drillAvg.toFixed(1)}/10
                      </span>
                    )}
                    {rep.trend != null && (
                      <span style={{ fontSize: 11, color: rep.trend >= 0 ? '#43A047' : '#E53935', fontWeight: 600 }}>
                        {rep.trend >= 0 ? '▲' : '▼'}{Math.abs(rep.trend).toFixed(1)}
                      </span>
                    )}
                  </div>
                  {rep.lastActive && (
                    <div style={S.repDate}>
                      Last: {new Date(rep.lastActive).toLocaleDateString()}
                    </div>
                  )}
                </div>
                <span style={S.chevron}>{isOpen ? '▾' : '▸'}</span>
              </div>

              {isOpen && (
                <div style={S.repDetail}>
                  {rep.drillAvg != null && (
                    <div style={S.barsBlock}>
                      {bars.map((b) => (
                        <div key={b.k} style={S.barRow}>
                          <div style={S.barLabel}>{b.label}</div>
                          <div style={S.barTrack}>
                            <div style={{
                              ...S.barFill,
                              width: `${(rep[b.k] || 0) * 10}%`,
                              background: rep[b.k] >= 7 ? '#43A047' : rep[b.k] >= 5 ? '#D4A843' : '#E53935',
                            }} />
                          </div>
                          <div style={S.barVal}>{rep[b.k] != null ? rep[b.k].toFixed(1) : '—'}</div>
                        </div>
                      ))}
                    </div>
                  )}

                  <div style={S.sessionLabel}>SESSIONS ({rep.sessions.length})</div>
                  {rep.sessions.length === 0 && (
                    <div style={{ color: '#5A6A7A', fontSize: 12, fontStyle: 'italic', padding: '8px 0' }}>
                      No sessions recorded yet. Sessions sync here when the rep is logged in while practicing.
                    </div>
                  )}
                  {rep.sessions.map((s) => {
                    const d = s.data || {};
                    const dm = diffMeta(d.difficulty);
                    const avg = d.rounds?.length
                      ? (d.rounds.reduce((a, b) => a + b.overall, 0) / d.rounds.length).toFixed(1)
                      : null;
                    const dbScore = d.debriefScores?.overall;
                    const score = avg || (dbScore ? `${dbScore}/10` : null);
                    const turns = d.messages?.filter((m) => m.role === 'user').length || 0;
                    const date = new Date(d.startedAt || s.updated_at);
                    const isSessionOpen = expandedSession === s.id;

                    return (
                      <div key={s.id} style={S.sessionCard}>
                        <div style={S.sessionTop} onClick={() => setExpandedSession(isSessionOpen ? null : s.id)}>
                          <div style={S.sessionLeft}>
                            <span style={{ ...S.modePill, background: d.mode === 'drill' ? '#3A2A4A' : '#2A3A4A' }}>
                              {d.mode === 'drill' ? 'GAUNTLET' : 'PROSPECT'}
                            </span>
                            <span style={{ ...S.diffPill, color: dm.color, borderColor: dm.color }}>{dm.name}</span>
                            {d.prospectName && <span style={S.prospectTag}>{d.prospectName}</span>}
                          </div>
                          <div style={S.sessionRight}>
                            {score && <span style={S.sessionScore}>{score}</span>}
                            <span style={S.sessionTurns}>{turns} turns</span>
                            <span style={S.sessionDate}>
                              {date.toLocaleDateString()} {date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                            </span>
                          </div>
                        </div>

                        {isSessionOpen && d.messages && (
                          <div style={S.transcript}>
                            {d.messages.map((m, i) => (
                              <div key={i} style={S.tLine}>
                                <span style={{ ...S.tWho, color: m.role === 'user' ? '#6FA8DC' : '#D4A843' }}>
                                  {m.role === 'user' ? rep.name.toUpperCase() : (d.mode === 'drill' ? 'DRILL' : d.prospectName || 'PROSPECT')}
                                </span>
                                <span style={S.tText}>{m.content}</span>
                              </div>
                            ))}
                            {d.debrief && (
                              <div style={S.debriefBlock}>
                                <div style={S.debriefLabel}>DEBRIEF</div>
                                <div style={S.tText}>{d.debrief}</div>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
        </>)}

        {tab === 'debug' && (
          <div>
            {/* Database counts */}
            <div style={S.debugSection}>
              <div style={S.debugTitle}>DATABASE (Supabase sessions table)</div>
              <div style={S.debugRow}>
                <span style={S.debugLabel}>Sessions in DB</span>
                <span style={{ ...S.debugVal, color: sessions.length === 0 ? '#E53935' : '#43A047' }}>{sessions.length}</span>
              </div>
              <div style={S.debugRow}>
                <span style={S.debugLabel}>Unique reps in DB</span>
                <span style={S.debugVal}>{new Set(sessions.map((s) => s.user_id)).size}</span>
              </div>
              <div style={S.debugRow}>
                <span style={S.debugLabel}>Registered accounts</span>
                <span style={S.debugVal}>{users.length}</span>
              </div>
              {sessions.length === 0 && (
                <div style={{ color: '#D4A843', fontSize: 11, marginTop: 8, lineHeight: 1.6 }}>
                  ⚠️ Zero sessions in Supabase. Most likely cause: reps practiced while not logged in, so sessions saved to their browser's localStorage only — the admin can't see those. Tell reps to log in before practicing.
                </div>
              )}
            </div>
            {/* API Health */}
            <div style={S.debugSection}>
              <div style={S.debugTitle}>AI API STATUS <button style={S.debugRefresh} onClick={fetchStats}>↻</button></div>
              {!apiStats ? <div style={S.debugEmpty}>Loading...</div> : (
                <div>
                  <div style={{ ...S.debugHealth, background: apiStats.health === 'ok' ? '#1A3A2A' : apiStats.health === 'busy' ? '#3A2A10' : '#3A1A1A', borderColor: apiStats.health === 'ok' ? '#43A047' : apiStats.health === 'busy' ? '#D4A843' : '#E53935' }}>
                    <span style={{ color: apiStats.health === 'ok' ? '#43A047' : apiStats.health === 'busy' ? '#D4A843' : '#E53935', fontWeight: 700, fontSize: 13 }}>
                      {apiStats.health === 'ok' ? '● ALL SYSTEMS GO' : apiStats.health === 'busy' ? '● BUSY — SOME KEYS COOLING' : '● OVERLOADED — ALL KEYS DOWN'}
                    </span>
                    <span style={{ color: '#8899A6', fontSize: 11, marginLeft: 12 }}>instance up {apiStats.sinceMins}m</span>
                  </div>
                  <div style={S.debugRow}>
                    <span style={S.debugLabel}>Groq keys</span>
                    <span style={S.debugVal}>{apiStats.groq.total - apiStats.groq.cooling} ready / {apiStats.groq.total} total ({apiStats.groq.cooling} cooling)</span>
                  </div>
                  <div style={S.debugRow}>
                    <span style={S.debugLabel}>Gemini keys</span>
                    <span style={S.debugVal}>{apiStats.gemini.total - apiStats.gemini.cooling} ready / {apiStats.gemini.total} total ({apiStats.gemini.cooling} cooling)</span>
                  </div>
                  <div style={{ fontSize: 10, color: '#6B7785', marginTop: 6 }}>Auto-refreshes every 15s • Cooldown state is per serverless instance</div>
                </div>
              )}
            </div>

            {/* Console Errors */}
            <div style={S.debugSection}>
              <div style={S.debugTitle}>
                CONSOLE ERRORS / WARNINGS
                <button style={S.debugRefresh} onClick={() => { errorsRef.current = []; setConsoleErrors([]); }}>Clear</button>
              </div>
              {consoleErrors.length === 0
                ? <div style={S.debugEmpty}>No errors captured yet. Reproduce the issue and they'll appear here.</div>
                : consoleErrors.map((e, i) => (
                  <div key={i} style={{ ...S.debugErrRow, borderLeftColor: e.level === 'error' ? '#E53935' : '#D4A843' }}>
                    <span style={{ color: e.level === 'error' ? '#E53935' : '#D4A843', fontSize: 10, fontWeight: 700, minWidth: 36 }}>{e.level.toUpperCase()}</span>
                    <span style={{ color: '#8899A6', fontSize: 10, minWidth: 52 }}>{e.t}</span>
                    <span style={{ color: '#C8D6E5', fontSize: 11, wordBreak: 'break-all' }}>{e.msg}</span>
                  </div>
                ))
              }
            </div>

            {/* Quick links */}
            <div style={S.debugSection}>
              <div style={S.debugTitle}>QUICK DEBUG STEPS</div>
              <div style={{ color: '#8899A6', fontSize: 12, lineHeight: 1.8 }}>
                <div>1. Press <strong style={{ color: '#C8D6E5' }}>F12</strong> → Console tab — red errors show here automatically</div>
                <div>2. Press <strong style={{ color: '#C8D6E5' }}>F12</strong> → Network tab → filter by <strong style={{ color: '#C8D6E5' }}>/api/chat</strong> — check status codes</div>
                <div>3. A <strong style={{ color: '#E53935' }}>429</strong> means AI rate limited — wait 60s or add more keys</div>
                <div>4. A <strong style={{ color: '#E53935' }}>401</strong> means a key was deleted — remove it from .env</div>
                <div>5. Speech not working → must use Chrome or Edge, allow mic</div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const S = {
  container: { minHeight: '100vh', background: '#0F1419', color: '#E8E6E1', fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", display: 'flex', flexDirection: 'column' },
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', borderBottom: '1px solid #1A2332', background: '#0F1419', position: 'sticky', top: 0, zIndex: 20 },
  headerTitle: { fontSize: 13, fontWeight: 700, letterSpacing: '2px', color: '#D4A843' },
  backBtn: { background: 'none', border: 'none', color: '#8899A6', fontSize: 13, cursor: 'pointer', fontFamily: 'inherit', padding: '4px 6px' },
  refreshBtn: { background: '#1A2332', border: '1px solid #2A3A4A', color: '#8899A6', fontSize: 11, padding: '6px 12px', borderRadius: 4, cursor: 'pointer', fontFamily: 'inherit' },
  pinBox: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 },
  pinIcon: { fontSize: 40 },
  pinForm: { display: 'flex', gap: 8 },
  pinInput: { width: 140, background: '#1A2332', border: '1px solid #2A3A4A', borderRadius: 8, padding: '12px 16px', color: '#E8E6E1', fontSize: 20, fontFamily: 'inherit', textAlign: 'center', letterSpacing: 6, outline: 'none' },
  pinBtn: { background: '#D4A843', border: 'none', borderRadius: 8, color: '#0F1419', fontWeight: 700, fontSize: 13, padding: '0 20px', cursor: 'pointer', fontFamily: 'inherit' },
  pinError: { color: '#E53935', fontSize: 13 },
  center: { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flex: 1, gap: 12, color: '#8899A6', fontSize: 14 },
  errorBox: { color: '#E53935', fontSize: 14, padding: '12px 20px', background: '#1A1414', border: '1px solid #4A2A2A', borderRadius: 8 },
  retryBtn: { background: '#1A2332', border: '1px solid #2A3A4A', color: '#8899A6', fontSize: 12, padding: '8px 16px', borderRadius: 6, cursor: 'pointer', fontFamily: 'inherit' },
  scroll: { flex: 1, overflowY: 'auto', padding: 16 },

  debugSection: { background: '#161E2B', border: '1px solid #2A3A4A', borderRadius: 10, padding: 16, marginBottom: 14 },
  debugTitle: { fontSize: 11, fontWeight: 700, color: '#8899A6', letterSpacing: 1, marginBottom: 10, display: 'flex', alignItems: 'center', gap: 8 },
  debugRefresh: { background: '#1A2332', border: '1px solid #2A3A4A', color: '#8899A6', fontSize: 11, padding: '2px 8px', borderRadius: 4, cursor: 'pointer', fontFamily: 'inherit' },
  debugHealth: { border: '1px solid', borderRadius: 8, padding: '10px 14px', marginBottom: 10, display: 'flex', alignItems: 'center' },
  debugRow: { display: 'flex', justifyContent: 'space-between', padding: '5px 0', borderBottom: '1px solid #1A2332' },
  debugLabel: { color: '#8899A6', fontSize: 12 },
  debugVal: { color: '#C8D6E5', fontSize: 12, fontWeight: 600 },
  debugEmpty: { color: '#6B7785', fontSize: 12, fontStyle: 'italic' },
  debugErrRow: { display: 'flex', gap: 10, padding: '6px 0 6px 10px', borderLeft: '3px solid', borderBottom: '1px solid #1A2332', alignItems: 'flex-start' },
  tabBar: { display: 'flex', gap: 8, marginBottom: 16 },
  tab: { flex: 1, background: '#1A2332', border: '1px solid #2A3A4A', color: '#8899A6', fontSize: 12, fontWeight: 700, padding: '10px 12px', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit' },
  tabActive: { flex: 1, background: '#D4A843', border: '1px solid #D4A843', color: '#0F1419', fontSize: 12, fontWeight: 700, padding: '10px 12px', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit' },
  signinList: { display: 'flex', flexDirection: 'column', gap: 8 },
  signinRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, background: '#161E2B', border: '1px solid #2A3A4A', borderRadius: 8, padding: '12px 14px', flexWrap: 'wrap' },
  signinLeft: { minWidth: 0 },
  signinName: { fontSize: 15, fontWeight: 700, color: '#E8E6E1' },
  signinEmail: { fontSize: 11, color: '#5A6A7A', marginTop: 2 },
  signinRight: { textAlign: 'right' },
  signinMeta: { fontSize: 12, color: '#9CC4E8', fontWeight: 600 },
  signinSub: { fontSize: 10, color: '#5A6A7A', marginTop: 2 },
  signinFlag: { color: '#D4A843' },

  statsRow: { display: 'flex', gap: 10, marginBottom: 20, flexWrap: 'wrap' },
  statCard: { flex: 1, minWidth: 80, background: '#1A2332', border: '1px solid #2A3A4A', borderRadius: 8, padding: '14px 12px', textAlign: 'center' },
  statNum: { fontSize: 28, fontWeight: 800, color: '#D4A843', lineHeight: 1 },
  statLabel: { fontSize: 10, color: '#8899A6', letterSpacing: '1px', marginTop: 6, fontWeight: 600 },

  empty: { textAlign: 'center', color: '#8899A6', fontSize: 14, lineHeight: 1.6, marginTop: 40 },

  repCard: { background: '#161E2B', border: '1px solid #2A3A4A', borderRadius: 8, marginBottom: 10, overflow: 'hidden' },
  repTop: { display: 'flex', alignItems: 'center', padding: '14px 16px', cursor: 'pointer', gap: 12 },
  repLeft: { flex: 1, minWidth: 0 },
  repName: { fontSize: 16, fontWeight: 700, color: '#E8E6E1' },
  repEmail: { fontSize: 11, color: '#5A6A7A', marginTop: 2 },
  repRight: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 },
  repStats: { display: 'flex', gap: 10 },
  repStat: { fontSize: 11, color: '#8899A6' },
  repScoreRow: { display: 'flex', alignItems: 'center', gap: 6 },
  repScore: { fontSize: 16, fontWeight: 700, fontFamily: 'monospace' },
  repDate: { fontSize: 10, color: '#5A6A7A' },
  chevron: { color: '#5A6A7A', fontSize: 14 },

  repDetail: { borderTop: '1px solid #2A3A4A', padding: '12px 16px' },
  barsBlock: { marginBottom: 16 },
  barRow: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 },
  barLabel: { fontSize: 12, color: '#8899A6', width: 90, flexShrink: 0 },
  barTrack: { flex: 1, height: 8, background: '#0F1419', borderRadius: 4, overflow: 'hidden' },
  barFill: { height: '100%', borderRadius: 4, transition: 'width .4s' },
  barVal: { fontSize: 12, color: '#E8E6E1', width: 28, textAlign: 'right', fontFamily: 'monospace' },

  sessionLabel: { fontSize: 10, letterSpacing: '1.5px', color: '#8899A6', fontWeight: 700, marginBottom: 8 },
  sessionCard: { background: '#0F1419', border: '1px solid #1A2332', borderRadius: 6, marginBottom: 6, overflow: 'hidden' },
  sessionTop: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 12px', cursor: 'pointer', flexWrap: 'wrap', gap: 6 },
  sessionLeft: { display: 'flex', alignItems: 'center', gap: 8 },
  sessionRight: { display: 'flex', alignItems: 'center', gap: 10 },
  modePill: { fontSize: 9, fontWeight: 700, letterSpacing: '1px', color: '#C8C8C8', padding: '3px 8px', borderRadius: 4 },
  diffPill: { fontSize: 10, fontWeight: 700, letterSpacing: '1px', border: '1px solid', borderRadius: 4, padding: '2px 7px' },
  prospectTag: { fontSize: 10, color: '#8899A6' },
  sessionScore: { fontSize: 13, fontWeight: 700, color: '#43A047', fontFamily: 'monospace' },
  sessionTurns: { fontSize: 11, color: '#8899A6' },
  sessionDate: { fontSize: 11, color: '#5A6A7A' },

  transcript: { borderTop: '1px solid #1A2332', padding: '10px 12px', maxHeight: 300, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6 },
  tLine: { display: 'flex', gap: 8, fontSize: 12, lineHeight: 1.5 },
  tWho: { fontSize: 9, fontWeight: 700, letterSpacing: '1px', flexShrink: 0, width: 70, paddingTop: 2 },
  tText: { color: '#C8C8C8', whiteSpace: 'pre-wrap' },
  debriefBlock: { marginTop: 10, paddingTop: 10, borderTop: '1px solid #2A3A4A' },
  debriefLabel: { fontSize: 10, letterSpacing: '1.5px', color: '#D4A843', fontWeight: 700, marginBottom: 6 },
};
