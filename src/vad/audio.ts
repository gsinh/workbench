/**
 * Getting audio into a Float32Array at the rate the detectors expect.
 *
 * Decoding goes through the browser's own `decodeAudioData`, which handles
 * WAV, MP3, and everything else the platform supports — so there is no format
 * parser here to go wrong on someone's file.
 */

import { SAMPLE_RATE } from "./silero";

/** Average a buffer down to the target rate. */
export function resample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return input;
  const ratio = from / to;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i += 1) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let k = start; k < end; k += 1) sum += input[k];
    out[i] = sum / Math.max(1, end - start);
  }
  return out;
}

async function decode(bytes: ArrayBuffer): Promise<Float32Array> {
  const ctx = new AudioContext();
  try {
    const buffer = await ctx.decodeAudioData(bytes);
    return resample(Float32Array.from(buffer.getChannelData(0)), buffer.sampleRate, SAMPLE_RATE);
  } finally {
    void ctx.close();
  }
}

export async function loadAudioFromUrl(url: string): Promise<Float32Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not fetch the audio: ${response.status}`);
  return decode(await response.arrayBuffer());
}

export async function loadAudioFromFile(file: File): Promise<Float32Array> {
  return decode(await file.arrayBuffer());
}

/**
 * Drop an impulsive non-speech burst into the quietest stretch.
 *
 * The point of the experiment made audible: a door, a keyboard, a chair. Loud,
 * broadband, and not speech — which an energy threshold has no way to know.
 */
export function injectBurst(
  signal: Float32Array,
  energyDb: Float32Array,
  frame: number,
  seconds = 0.15,
): { signal: Float32Array; atSeconds: number } {
  const out = Float32Array.from(signal);
  if (energyDb.length === 0) return { signal: out, atSeconds: 0 };

  // Quietest frame that has room for the burst.
  let quietest = 0;
  let quietestDb = Infinity;
  const needed = Math.round(seconds * SAMPLE_RATE);
  for (let i = 0; i < energyDb.length; i += 1) {
    if (i * frame + needed >= out.length) break;
    if (energyDb[i] < quietestDb) {
      quietestDb = energyDb[i];
      quietest = i;
    }
  }

  const at = quietest * frame;
  for (let i = 0; i < needed && at + i < out.length; i += 1) {
    // Exponential decay over white noise: broadband, loud, and nothing like
    // the harmonic structure of a voice. The time constant is ~110ms, so the
    // burst stays above a sensible energy threshold for most of its length —
    // a sharper decay is inaudible after two frames and makes the comparison
    // impossible to see.
    out[at + i] = Math.exp(-i / 1800) * (Math.random() * 2 - 1) * 0.8;
  }
  return { signal: out, atSeconds: at / SAMPLE_RATE };
}

/**
 * Play a signal back, reporting progress.
 *
 * The demo shows two detectors disagreeing about audio; without this there is
 * no way to judge which of them is right, or to hear the burst the buttons
 * talk about. `onProgress` drives the playhead, so what you hear and what the
 * lanes claim line up.
 *
 * Returns a stop function. Calling it, or reaching the end, releases the
 * context — a page that leaves AudioContexts open eventually stops being
 * allowed to make them.
 */
export function playSignal(
  signal: Float32Array,
  sampleRate: number,
  onProgress: (seconds: number | null) => void,
): () => void {
  const ctx = new AudioContext();
  const buffer = ctx.createBuffer(1, signal.length, sampleRate);
  // Copy into the channel directly rather than via copyToChannel, whose typing
  // rejects a Float32Array that might be backed by a SharedArrayBuffer.
  buffer.getChannelData(0).set(signal);

  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(ctx.destination);

  let frame = 0;
  let stopped = false;

  const finish = () => {
    if (stopped) return;
    stopped = true;
    cancelAnimationFrame(frame);
    try {
      source.stop();
    } catch {
      // Already ended; stop() on a finished source throws.
    }
    void ctx.close();
    onProgress(null);
  };

  source.onended = finish;

  const startedAt = ctx.currentTime;
  const tick = () => {
    if (stopped) return;
    onProgress(ctx.currentTime - startedAt);
    frame = requestAnimationFrame(tick);
  };

  source.start();
  frame = requestAnimationFrame(tick);
  return finish;
}
