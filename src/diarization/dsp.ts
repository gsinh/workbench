/**
 * Signal processing for speaker diarization.
 *
 * Plain TypeScript over Float32Array: no React, no Web Audio, no model. Every
 * stage here is the classical speech pipeline written out rather than imported,
 * because the point of the experiment is to make the machinery visible.
 *
 * Framing → window → FFT → mel filterbank → log → DCT. That sequence is an
 * MFCC, and it has been the front end of speaker recognition since long before
 * neural embeddings; a modern x-vector network still consumes exactly this.
 */

/* ------------------------------------------------------------------ */
/* FFT                                                                 */
/* ------------------------------------------------------------------ */

/**
 * In-place iterative radix-2 Cooley-Tukey FFT.
 *
 * `re` and `im` must be the same power-of-two length. Decimation-in-time, so
 * the input is bit-reversed first and the butterflies then run in order.
 */
export function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length;

  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len;
    const wRe = Math.cos(angle);
    const wIm = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < len / 2; k += 1) {
        const aRe = re[i + k];
        const aIm = im[i + k];
        const bRe = re[i + k + len / 2] * curRe - im[i + k + len / 2] * curIm;
        const bIm = re[i + k + len / 2] * curIm + im[i + k + len / 2] * curRe;
        re[i + k] = aRe + bRe;
        im[i + k] = aIm + bIm;
        re[i + k + len / 2] = aRe - bRe;
        im[i + k + len / 2] = aIm - bIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* Mel filterbank                                                      */
/* ------------------------------------------------------------------ */

const hzToMel = (hz: number) => 2595 * Math.log10(1 + hz / 700);
const melToHz = (mel: number) => 700 * (10 ** (mel / 2595) - 1);

/**
 * Triangular mel filters over the positive half of the spectrum.
 *
 * Mel spacing is the whole reason this works: it spends resolution where the
 * ear does, which is where the formants that distinguish two voices live.
 */
export function melFilterbank(
  count: number,
  fftSize: number,
  sampleRate: number,
  lowHz = 80,
  highHz = Math.min(8000, sampleRate / 2),
): Float32Array[] {
  const bins = fftSize / 2 + 1;
  const lowMel = hzToMel(lowHz);
  const highMel = hzToMel(highHz);
  const points = Array.from({ length: count + 2 }, (_, i) =>
    Math.floor(((fftSize + 1) * melToHz(lowMel + ((highMel - lowMel) * i) / (count + 1))) / sampleRate),
  );

  return Array.from({ length: count }, (_, m) => {
    const filter = new Float32Array(bins);
    const [left, centre, right] = [points[m], points[m + 1], points[m + 2]];
    for (let k = left; k < centre; k += 1) {
      if (k >= 0 && k < bins && centre > left) filter[k] = (k - left) / (centre - left);
    }
    for (let k = centre; k < right; k += 1) {
      if (k >= 0 && k < bins && right > centre) filter[k] = (right - k) / (right - centre);
    }
    return filter;
  });
}

/* ------------------------------------------------------------------ */
/* Framing and MFCC                                                    */
/* ------------------------------------------------------------------ */

export type FrameConfig = {
  sampleRate: number;
  /** Analysis window, in seconds. 25ms is the speech convention. */
  windowSeconds: number;
  /** Step between windows. 10ms, so frames overlap. */
  hopSeconds: number;
  /** Cepstral coefficients kept, excluding C0. */
  coefficients: number;
  melFilters: number;
};

export const DEFAULT_FRAMES: Omit<FrameConfig, "sampleRate"> = {
  windowSeconds: 0.025,
  hopSeconds: 0.01,
  coefficients: 13,
  melFilters: 26,
};

export type Frames = {
  /** One MFCC vector per frame. */
  mfcc: Float32Array[];
  /** Frame energy in dB, for the voice activity decision. */
  energyDb: Float32Array;
  hopSeconds: number;
  windowSeconds: number;
};

const nextPowerOfTwo = (n: number) => 2 ** Math.ceil(Math.log2(n));

/** Precomputed Hamming window. */
function hamming(size: number): Float32Array {
  const w = new Float32Array(size);
  for (let i = 0; i < size; i += 1) w[i] = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (size - 1));
  return w;
}

/**
 * MFCCs and per-frame energy for a mono signal.
 *
 * C0 is deliberately discarded. It is the overall log energy of the frame,
 * which tracks how loudly and how close to the microphone someone is speaking
 * — exactly the thing that must not decide who is talking, or leaning in
 * would make a person their own second speaker.
 */
export function analyseFrames(signal: Float32Array, config: FrameConfig): Frames {
  const { sampleRate, windowSeconds, hopSeconds, coefficients, melFilters } = config;
  const windowSize = Math.round(windowSeconds * sampleRate);
  const hopSize = Math.round(hopSeconds * sampleRate);
  const fftSize = nextPowerOfTwo(windowSize);
  const bins = fftSize / 2 + 1;

  const window = hamming(windowSize);
  const filters = melFilterbank(melFilters, fftSize, sampleRate);
  const frameCount = Math.max(0, Math.floor((signal.length - windowSize) / hopSize) + 1);

  const mfcc: Float32Array[] = [];
  const energyDb = new Float32Array(frameCount);

  const re = new Float32Array(fftSize);
  const im = new Float32Array(fftSize);
  const power = new Float32Array(bins);
  const logEnergies = new Float32Array(melFilters);

  for (let f = 0; f < frameCount; f += 1) {
    const offset = f * hopSize;
    re.fill(0);
    im.fill(0);

    let sumSquares = 0;
    // Pre-emphasis lifts the high frequencies the glottal source rolls off,
    // which is where the formant detail lives.
    let previous = offset > 0 ? signal[offset - 1] : 0;
    for (let i = 0; i < windowSize; i += 1) {
      const sample = signal[offset + i];
      sumSquares += sample * sample;
      re[i] = (sample - 0.97 * previous) * window[i];
      previous = sample;
    }
    energyDb[f] = 10 * Math.log10(sumSquares / windowSize + 1e-12);

    fft(re, im);
    for (let k = 0; k < bins; k += 1) power[k] = (re[k] * re[k] + im[k] * im[k]) / fftSize;

    for (let m = 0; m < melFilters; m += 1) {
      const filter = filters[m];
      let sum = 0;
      for (let k = 0; k < bins; k += 1) sum += power[k] * filter[k];
      logEnergies[m] = Math.log(sum + 1e-10);
    }

    // DCT-II, keeping coefficients 1..N — index 0 is the discarded C0.
    const cepstrum = new Float32Array(coefficients);
    for (let c = 0; c < coefficients; c += 1) {
      let sum = 0;
      for (let m = 0; m < melFilters; m += 1) {
        sum += logEnergies[m] * Math.cos((Math.PI * (c + 1) * (m + 0.5)) / melFilters);
      }
      cepstrum[c] = sum;
    }
    mfcc.push(cepstrum);
  }

  return { mfcc, energyDb, hopSeconds, windowSeconds };
}

/**
 * Cepstral mean normalization.
 *
 * Subtracting the per-coefficient mean across the recording removes whatever
 * is constant about the channel — the microphone, the room, the codec — and
 * leaves what varies, which is the speakers. Without it the clustering tends
 * to discover the recording conditions instead.
 */
export function normalizeCepstra(frames: Float32Array[]): void {
  if (frames.length === 0) return;
  const dim = frames[0].length;
  const mean = new Float32Array(dim);
  for (const frame of frames) for (let i = 0; i < dim; i += 1) mean[i] += frame[i];
  for (let i = 0; i < dim; i += 1) mean[i] /= frames.length;
  for (const frame of frames) for (let i = 0; i < dim; i += 1) frame[i] -= mean[i];
}

/* ------------------------------------------------------------------ */
/* Voice activity                                                      */
/* ------------------------------------------------------------------ */

/**
 * Mark frames as speech by energy, relative to the recording's own floor.
 *
 * An absolute threshold cannot work across devices — a laptop microphone and a
 * headset sit tens of dB apart — so the floor is taken from the quietest
 * portion of this recording and the threshold set above it.
 */
export function voiceActivity(energyDb: Float32Array, marginDb = 12): boolean[] {
  if (energyDb.length === 0) return [];
  const sorted = Float32Array.from(energyDb).sort();
  const floor = sorted[Math.floor(sorted.length * 0.1)];
  const peak = sorted[Math.floor(sorted.length * 0.95)];
  // If the whole recording is flat there is nothing to separate.
  const threshold = peak - floor < 6 ? Infinity : floor + marginDb;
  return Array.from(energyDb, (db) => db > threshold);
}
