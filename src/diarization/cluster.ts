/**
 * Turning frames into "who spoke when".
 *
 * Still plain TypeScript. Three steps: cut the speech into short segments,
 * reduce each one to a fixed-length vector, then group the vectors.
 *
 * The embedding here is statistics pooling — the mean and standard deviation
 * of a segment's MFCCs. That is precisely what an x-vector network does to
 * collapse a variable-length utterance into a fixed vector; the difference is
 * that it first passes the frames through trained layers, and this does not.
 * So the shape of the pipeline is the real one, and only the representation is
 * weaker. The write-up is explicit about what that costs.
 */

import { type Frames, normalizeCepstra, voiceActivity } from "./dsp";

export type Segment = {
  startSeconds: number;
  endSeconds: number;
  /** Frame indices this segment covers. */
  from: number;
  to: number;
  embedding: Float32Array;
  /** Assigned after clustering. */
  speaker: number;
};

export type DiarizeOptions = {
  /** Shortest run of speech worth embedding, in seconds. */
  minSegmentSeconds: number;
  /** Silence needed to end a segment, in seconds. */
  splitSilenceSeconds: number;
  /** Fixed speaker count, or "auto" to cut the dendrogram by distance. */
  speakers: number | "auto";
  /** Merge threshold when speakers is "auto". Cosine distance. */
  threshold: number;
};

export const DEFAULT_OPTIONS: DiarizeOptions = {
  minSegmentSeconds: 0.6,
  splitSilenceSeconds: 0.35,
  speakers: 2,
  threshold: 0.35,
};

/* ------------------------------------------------------------------ */
/* Segmentation                                                        */
/* ------------------------------------------------------------------ */

/** Contiguous runs of speech, split wherever silence runs long enough. */
export function segmentSpeech(
  speech: boolean[],
  frames: Frames,
  options: DiarizeOptions,
): { from: number; to: number }[] {
  const gapFrames = Math.round(options.splitSilenceSeconds / frames.hopSeconds);
  const minFrames = Math.round(options.minSegmentSeconds / frames.hopSeconds);

  const runs: { from: number; to: number }[] = [];
  let start: number | null = null;
  let silence = 0;

  for (let i = 0; i < speech.length; i += 1) {
    if (speech[i]) {
      if (start === null) start = i;
      silence = 0;
    } else if (start !== null) {
      silence += 1;
      if (silence >= gapFrames) {
        const end = i - silence + 1;
        if (end - start >= minFrames) runs.push({ from: start, to: end });
        start = null;
        silence = 0;
      }
    }
  }
  if (start !== null && speech.length - start >= minFrames) {
    runs.push({ from: start, to: speech.length });
  }
  return runs;
}

/* ------------------------------------------------------------------ */
/* Embedding                                                           */
/* ------------------------------------------------------------------ */

/** Mean and standard deviation per coefficient, then L2-normalized. */
export function embedSegment(mfcc: Float32Array[], from: number, to: number): Float32Array {
  const dim = mfcc[0].length;
  const mean = new Float32Array(dim);
  const variance = new Float32Array(dim);
  const count = Math.max(1, to - from);

  for (let i = from; i < to; i += 1) {
    for (let d = 0; d < dim; d += 1) mean[d] += mfcc[i][d];
  }
  for (let d = 0; d < dim; d += 1) mean[d] /= count;

  for (let i = from; i < to; i += 1) {
    for (let d = 0; d < dim; d += 1) {
      const delta = mfcc[i][d] - mean[d];
      variance[d] += delta * delta;
    }
  }

  const embedding = new Float32Array(dim * 2);
  for (let d = 0; d < dim; d += 1) {
    embedding[d] = mean[d];
    embedding[dim + d] = Math.sqrt(variance[d] / count);
  }

  let norm = 0;
  for (let i = 0; i < embedding.length; i += 1) norm += embedding[i] * embedding[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < embedding.length; i += 1) embedding[i] /= norm;
  return embedding;
}

/** Cosine distance between two L2-normalized vectors. */
export function cosineDistance(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i += 1) dot += a[i] * b[i];
  return 1 - dot;
}

/* ------------------------------------------------------------------ */
/* Clustering                                                          */
/* ------------------------------------------------------------------ */

/**
 * Agglomerative clustering with average linkage.
 *
 * Every segment starts as its own cluster; the closest pair is merged
 * repeatedly until either the requested number of speakers remains or the
 * closest pair is further apart than the threshold. Average linkage rather
 * than single linkage, because single linkage chains — one ambiguous segment
 * between two voices drags both into one cluster.
 */
export function cluster(
  embeddings: Float32Array[],
  options: DiarizeOptions,
): { labels: number[]; merges: number[] } {
  const n = embeddings.length;
  if (n === 0) return { labels: [], merges: [] };

  const members: number[][] = embeddings.map((_, i) => [i]);
  const alive = new Set(members.map((_, i) => i));
  const merges: number[] = [];

  const distance = (a: number[], b: number[]) => {
    let sum = 0;
    for (const i of a) for (const j of b) sum += cosineDistance(embeddings[i], embeddings[j]);
    return sum / (a.length * b.length);
  };

  const target = options.speakers === "auto" ? 1 : Math.max(1, options.speakers);

  while (alive.size > target) {
    let best: [number, number] | null = null;
    let bestDistance = Infinity;
    const ids = [...alive];
    for (let x = 0; x < ids.length; x += 1) {
      for (let y = x + 1; y < ids.length; y += 1) {
        const d = distance(members[ids[x]], members[ids[y]]);
        if (d < bestDistance) {
          bestDistance = d;
          best = [ids[x], ids[y]];
        }
      }
    }
    if (!best) break;
    // In auto mode the threshold decides when to stop merging.
    if (options.speakers === "auto" && bestDistance > options.threshold) break;
    merges.push(bestDistance);
    const [keep, drop] = best;
    members[keep] = [...members[keep], ...members[drop]];
    alive.delete(drop);
  }

  // Number speakers by first appearance, so the same voice is "Speaker 1"
  // whichever order the clusters happened to merge in.
  const labels = new Array<number>(n).fill(0);
  const ordered = [...alive].sort((a, b) => Math.min(...members[a]) - Math.min(...members[b]));
  ordered.forEach((id, index) => {
    for (const member of members[id]) labels[member] = index;
  });
  return { labels, merges };
}

/* ------------------------------------------------------------------ */
/* Pipeline                                                            */
/* ------------------------------------------------------------------ */

export type Diarization = {
  segments: Segment[];
  speakerCount: number;
  speechSeconds: number;
  totalSeconds: number;
  /** Per-speaker talk time, in seconds. */
  talkTime: number[];
};

export function diarize(
  frames: Frames,
  options: DiarizeOptions,
  totalSeconds: number,
): Diarization {
  // Channel normalization first: it changes every vector that follows.
  normalizeCepstra(frames.mfcc);

  const speech = voiceActivity(frames.energyDb);
  const runs = segmentSpeech(speech, frames, options);

  const segments: Segment[] = runs.map((run) => ({
    startSeconds: run.from * frames.hopSeconds,
    endSeconds: run.to * frames.hopSeconds + frames.windowSeconds,
    from: run.from,
    to: run.to,
    embedding: embedSegment(frames.mfcc, run.from, run.to),
    speaker: 0,
  }));

  const { labels } = cluster(
    segments.map((s) => s.embedding),
    options,
  );
  segments.forEach((segment, i) => {
    segment.speaker = labels[i] ?? 0;
  });

  const speakerCount = segments.length > 0 ? Math.max(...labels) + 1 : 0;
  const talkTime = new Array<number>(Math.max(speakerCount, 0)).fill(0);
  for (const segment of segments) {
    talkTime[segment.speaker] += segment.endSeconds - segment.startSeconds;
  }

  return {
    segments,
    speakerCount,
    speechSeconds: speech.filter(Boolean).length * frames.hopSeconds,
    totalSeconds,
    talkTime,
  };
}

/**
 * Two-dimensional projection of the embeddings, for the scatter plot.
 *
 * Principal components by power iteration on the covariance matrix — enough
 * to show whether the clusters are actually separated, without pulling in a
 * linear-algebra dependency for two eigenvectors.
 */
export function project(embeddings: Float32Array[]): { x: number; y: number }[] {
  const n = embeddings.length;
  if (n === 0) return [];
  const dim = embeddings[0].length;

  const mean = new Float32Array(dim);
  for (const e of embeddings) for (let d = 0; d < dim; d += 1) mean[d] += e[d];
  for (let d = 0; d < dim; d += 1) mean[d] /= n;

  const centred = embeddings.map((e) => {
    const c = new Float32Array(dim);
    for (let d = 0; d < dim; d += 1) c[d] = e[d] - mean[d];
    return c;
  });

  const component = (exclude: Float32Array | null): Float32Array => {
    let v = new Float32Array(dim).map(() => Math.random() - 0.5);
    for (let iteration = 0; iteration < 80; iteration += 1) {
      const next = new Float32Array(dim);
      // next = Cv, with C the covariance, computed without materializing it.
      for (const c of centred) {
        let dot = 0;
        for (let d = 0; d < dim; d += 1) dot += c[d] * v[d];
        for (let d = 0; d < dim; d += 1) next[d] += c[d] * dot;
      }
      if (exclude) {
        let dot = 0;
        for (let d = 0; d < dim; d += 1) dot += next[d] * exclude[d];
        for (let d = 0; d < dim; d += 1) next[d] -= dot * exclude[d];
      }
      let norm = 0;
      for (let d = 0; d < dim; d += 1) norm += next[d] * next[d];
      norm = Math.sqrt(norm) || 1;
      for (let d = 0; d < dim; d += 1) next[d] /= norm;
      v = next;
    }
    return v;
  };

  const first = component(null);
  const second = component(first);

  return centred.map((c) => {
    let x = 0;
    let y = 0;
    for (let d = 0; d < dim; d += 1) {
      x += c[d] * first[d];
      y += c[d] * second[d];
    }
    return { x, y };
  });
}
