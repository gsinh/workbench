/**
 * A synthetic two-speaker conversation, generated in the browser.
 *
 * So the demo has something to run with no microphone and no upload, and
 * because a known ground truth is the only way to say whether the diarizer is
 * right rather than merely confident.
 *
 * Source-filter synthesis: a glottal pulse train at some fundamental, passed
 * through resonators standing in for the vocal tract. Crude — nobody will
 * mistake it for speech — but the two voices differ the way real ones do, in
 * pitch *and* in resonance, rather than being two tones that any method could
 * separate. That matters: a demo which only works on trivially different
 * inputs is a demo that proves nothing.
 */

export type Voice = {
  name: string;
  /** Fundamental frequency, in Hz. */
  f0: number;
  /** [centre Hz, bandwidth Hz, gain] per formant. */
  formants: [number, number, number][];
};

export const VOICES: Voice[] = [
  {
    name: "lower pitch, back vowel",
    f0: 112,
    formants: [
      [730, 90, 1],
      [1090, 110, 0.5],
      [2440, 160, 0.25],
    ],
  },
  {
    name: "higher pitch, front vowel",
    f0: 205,
    formants: [
      [390, 80, 1],
      [2300, 120, 0.6],
      [3010, 180, 0.3],
    ],
  },
];

export type Turn = { speaker: number; startSeconds: number; endSeconds: number };

/** Deterministic, so the sample is the same conversation every time. */
function rng(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff - 0.5;
  };
}

function utterance(seconds: number, voice: Voice, sampleRate: number, seed: number): Float32Array {
  const n = Math.round(seconds * sampleRate);
  const random = rng(seed);

  // Glottal source: impulse train with a little jitter, plus aspiration noise.
  const source = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i += 1) {
    phase += (voice.f0 * (1 + 0.02 * random())) / sampleRate;
    if (phase >= 1) {
      phase -= 1;
      source[i] = 1;
    }
    source[i] += 0.02 * random();
  }

  // One two-pole resonator per formant.
  const out = new Float32Array(n);
  for (const [freq, bandwidth, gain] of voice.formants) {
    const r = Math.exp((-Math.PI * bandwidth) / sampleRate);
    const c = -r * r;
    const b = 2 * r * Math.cos((2 * Math.PI * freq) / sampleRate);
    const a = 1 - b - c;
    let y1 = 0;
    let y2 = 0;
    for (let i = 0; i < n; i += 1) {
      const y = a * source[i] + b * y1 + c * y2;
      y2 = y1;
      y1 = y;
      out[i] += gain * y;
    }
  }

  // Fade the edges, so a turn boundary is not a click the VAD latches onto.
  const fade = Math.round(0.02 * sampleRate);
  for (let i = 0; i < fade && i < n; i += 1) {
    out[i] *= i / fade;
    out[n - 1 - i] *= i / fade;
  }

  let peak = 0;
  for (let i = 0; i < n; i += 1) peak = Math.max(peak, Math.abs(out[i]));
  if (peak > 0) for (let i = 0; i < n; i += 1) out[i] /= peak;
  return out;
}

const SCRIPT: { speaker: number; seconds: number }[] = [
  { speaker: 0, seconds: 1.8 },
  { speaker: 1, seconds: 1.5 },
  { speaker: 0, seconds: 1.2 },
  { speaker: 1, seconds: 2.0 },
  { speaker: 0, seconds: 1.4 },
];

const GAP_SECONDS = 0.5;

/** The sample conversation, with the turn list it was built from. */
export function syntheticConversation(sampleRate: number): {
  signal: Float32Array;
  truth: Turn[];
} {
  const gap = Math.round(GAP_SECONDS * sampleRate);
  const pieces: Float32Array[] = [];
  const truth: Turn[] = [];
  let seconds = 0;
  let seed = 7;

  for (const line of SCRIPT) {
    pieces.push(new Float32Array(gap));
    seconds += GAP_SECONDS;
    pieces.push(utterance(line.seconds, VOICES[line.speaker], sampleRate, seed));
    seed += 1;
    truth.push({
      speaker: line.speaker,
      startSeconds: seconds,
      endSeconds: seconds + line.seconds,
    });
    seconds += line.seconds;
  }
  pieces.push(new Float32Array(gap));

  const signal = new Float32Array(pieces.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const piece of pieces) {
    signal.set(piece, at);
    at += piece.length;
  }
  return { signal, truth };
}

/**
 * Score a diarization against a known turn list.
 *
 * Cluster numbers are arbitrary, so the mapping from true speaker to cluster
 * is learned from the first turn of each and then held: what is being measured
 * is consistency, not whether the labels happen to agree.
 */
export function scoreAgainstTruth(
  truth: Turn[],
  segments: { startSeconds: number; endSeconds: number; speaker: number }[],
): { correct: number; total: number } {
  const mapping = new Map<number, number>();
  let correct = 0;

  for (const turn of truth) {
    const votes = new Map<number, number>();
    for (const segment of segments) {
      const overlap =
        Math.min(segment.endSeconds, turn.endSeconds) -
        Math.max(segment.startSeconds, turn.startSeconds);
      if (overlap > 0) votes.set(segment.speaker, (votes.get(segment.speaker) ?? 0) + overlap);
    }
    const found = [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (found === undefined) continue;
    if (!mapping.has(turn.speaker)) mapping.set(turn.speaker, found);
    if (mapping.get(turn.speaker) === found) correct += 1;
  }

  // Two true speakers collapsing onto one cluster is consistent but wrong.
  const distinct = new Set(mapping.values()).size;
  const expected = new Set(truth.map((t) => t.speaker)).size;
  return { correct: distinct === expected ? correct : 0, total: truth.length };
}
