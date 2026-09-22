/**
 * The energy detector, for comparison.
 *
 * This is the same approach the latency-budget and diarization experiments
 * use: frame energy in dB, with a threshold set above the recording's own
 * noise floor rather than at an absolute level, because a headset and a laptop
 * microphone sit tens of dB apart.
 *
 * It is not a straw man — it is what most hand-rolled VADs are, it costs
 * nothing, and on clean speech it does a respectable job. What it cannot do is
 * tell speech from any other loud thing, because loudness is all it measures.
 */

import { FRAME } from "./silero";

/** Frame energy in dB relative to full scale. */
export function frameEnergyDb(signal: Float32Array): Float32Array {
  const count = Math.floor(signal.length / FRAME);
  const out = new Float32Array(count);
  for (let i = 0; i < count; i += 1) {
    let sum = 0;
    for (let k = i * FRAME; k < (i + 1) * FRAME; k += 1) sum += signal[k] * signal[k];
    out[i] = 10 * Math.log10(sum / FRAME + 1e-12);
  }
  return out;
}

/** The floor this recording sits on: its 10th-percentile frame energy. */
export function noiseFloorDb(energyDb: Float32Array): number {
  if (energyDb.length === 0) return -120;
  const sorted = Float32Array.from(energyDb).sort();
  return sorted[Math.floor(sorted.length * 0.1)];
}

/** Speech decisions, one per frame, at `marginDb` above the floor. */
export function energyVad(energyDb: Float32Array, marginDb = 12): boolean[] {
  const floor = noiseFloorDb(energyDb);
  return Array.from(energyDb, (db) => db > floor + marginDb);
}
