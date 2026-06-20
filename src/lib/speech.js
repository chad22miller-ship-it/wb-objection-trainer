/* ============================== TEXT CLEANING ============================== */

export const cleanForSpeech = (t) => t
  .replace(/\*\*/g, '').replace(/[*#_|>`]/g, '')
  .replace(/(\d+)\s*\/\s*10/g, '$1 out of 10')
  .replace(/\s+/g, ' ').trim();

export const chunkText = (t) => {
  const sentences = t.match(/[^.!?]+[.!?]+|\S.+$/g) || [t];
  const chunks = []; let cur = '';
  for (const s of sentences) {
    if ((cur + s).length > 220 && cur) { chunks.push(cur.trim()); cur = s; }
    else cur += s;
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks;
};

/* ============================== MATH HELPERS ============================== */

export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export const median = (arr) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/* ============================== PITCH DETECTION ============================== */

export const autoCorrelate = (buf, sampleRate) => {
  let SIZE = buf.length;
  let rms = 0;
  for (let i = 0; i < SIZE; i++) { const v = buf[i]; rms += v * v; }
  rms = Math.sqrt(rms / SIZE);
  if (rms < 0.01) return -1;
  let r1 = 0, r2 = SIZE - 1; const thres = 0.2;
  for (let i = 0; i < SIZE / 2; i++) { if (Math.abs(buf[i]) < thres) { r1 = i; break; } }
  for (let i = 1; i < SIZE / 2; i++) { if (Math.abs(buf[SIZE - i]) < thres) { r2 = SIZE - i; break; } }
  const b = buf.slice(r1, r2); SIZE = b.length;
  const c = new Array(SIZE).fill(0);
  for (let i = 0; i < SIZE; i++) for (let j = 0; j < SIZE - i; j++) c[i] += b[j] * b[j + i];
  let d = 0; while (d < SIZE - 1 && c[d] > c[d + 1]) d++;
  let maxval = -1, maxpos = -1;
  for (let i = d; i < SIZE; i++) { if (c[i] > maxval) { maxval = c[i]; maxpos = i; } }
  let T0 = maxpos;
  if (T0 <= 0) return -1;
  const x1 = c[T0 - 1] || 0, x2 = c[T0] || 0, x3 = c[T0 + 1] || 0;
  const a = (x1 + x3 - 2 * x2) / 2, bb = (x3 - x1) / 2;
  if (a) T0 = T0 - bb / (2 * a);
  const freq = sampleRate / T0;
  return (freq >= 70 && freq <= 400) ? freq : -1;
};

export const CALIB_PHRASE = "Freedom, security, and peace are what every family is really after.";
export const CALIB_WORDS = 11;
export const REF_HZ = 130;
export const BASELINE_WPM = 165;

/* ============================== SCORE PARSING (ROBUST) ============================== */

export const parseScores = (text) => {
  // More flexible matching — handles markdown bold, extra spaces, slight label variations
  const g = (labels) => {
    for (const label of labels) {
      // Try exact match, markdown bold, and colon variations
      const patterns = [
        new RegExp(`\\*?\\*?${label}\\*?\\*?[:\\s]*?(\\d+)\\s*/\\s*10`, 'i'),
        new RegExp(`${label}[^\\d]*?(\\d+)\\s*(?:\\/|out of)\\s*10`, 'i'),
      ];
      for (const p of patterns) {
        const m = text.match(p);
        if (m) return parseInt(m[1], 10);
      }
    }
    return null;
  };

  const overall = g(['OVERALL']);
  if (overall == null) return null;

  return {
    framework: g(['FRAMEWORK ALIGNMENT', 'FRAMEWORK']),
    tonality: g(['TONALITY.?ENERGY', 'TONALITY', 'TONE']),
    question: g(['QUESTION QUALITY', 'QUESTION']),
    silence: g(['SILENCE DISCIPLINE', 'SILENCE']),
    overall,
  };
};

// Parse debrief scores (roleplay mode)
export const parseDebriefScores = (text) => {
  const g = (labels) => {
    for (const label of labels) {
      const patterns = [
        new RegExp(`\\*?\\*?${label}\\*?\\*?[:\\s]*?(\\d+)\\s*/\\s*10`, 'i'),
        new RegExp(`${label}[^\\d]*?(\\d+)\\s*(?:\\/|out of)\\s*10`, 'i'),
      ];
      for (const p of patterns) {
        const m = text.match(p);
        if (m) return parseInt(m[1], 10);
      }
    }
    return null;
  };

  const overall = g(['OVERALL']);
  if (overall == null) return null;

  return {
    ppfDiscovery: g(['PPF DISCOVERY', 'PPF', 'DISCOVERY']),
    mustConversion: g(['MUST CONVERSION', 'MUST']),
    pullback: g(['PULLBACK EXECUTION', 'PULLBACK']),
    nextStep: g(['NEXT STEP LOCK', 'NEXT STEP']),
    tonality: g(['TONALITY.?ENERGY', 'TONALITY', 'TONE']),
    overall,
  };
};
