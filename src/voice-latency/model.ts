/**
 * The latency model behind the voice-agent budget demo.
 *
 * Pure functions, no React, no browser APIs — so the arithmetic can be read,
 * argued with and unit-tested on its own. Everything is milliseconds.
 *
 * The clock starts at the last sample of the user's speech and stops when the
 * first sample of the agent's reply reaches their ear. That is the number a
 * caller actually feels, and it is deliberately *not* "model latency": most of
 * it is spent somewhere other than the model.
 */

export type StageId =
  | "endpoint"
  | "uplink"
  | "asr"
  | "ttft"
  | "chunk"
  | "tts"
  | "downlink";

export type Stage = {
  id: StageId;
  /** Legend and table label. */
  label: string;
  /** Short form, for the inline label inside a wide enough segment. */
  short: string;
  /** Why this stage costs what it costs. Shown in the tooltip. */
  note: string;
};

/**
 * Declaration order is render order: these are the seven segments of the
 * critical path, left to right, and each one's index picks its colour slot.
 *
 * Seven distinct hues rather than six with the network reused at both ends —
 * the reused-hue version puts green next to orange where the bar wraps, and
 * that pair fails colour-vision separation (ΔE 3.2 protan against this
 * surface). Network appearing twice is instead made visible by the labels.
 */
export const STAGES: Stage[] = [
  {
    id: "endpoint",
    label: "Endpointing",
    short: "endpoint",
    note: "Silence the VAD must hear before it will call the turn finished. Pure waiting, and usually the single largest line in the budget.",
  },
  {
    id: "uplink",
    label: "Uplink",
    short: "up",
    note: "Half the round trip, carrying the tail of the utterance to whichever component runs first. Zero when nothing leaves the device.",
  },
  {
    id: "asr",
    label: "ASR finalize",
    short: "ASR",
    note: "Turning the last partial hypothesis into a final transcript. Small when ASR streams alongside the speech, proportional to utterance length when it does not.",
  },
  {
    id: "ttft",
    label: "LLM first token",
    short: "TTFT",
    note: "Prefill plus queueing, before a single token comes back. Grows with prompt length, not with reply length.",
  },
  {
    id: "chunk",
    label: "First speakable chunk",
    short: "chunk",
    note: "Tokens are not speech. TTS needs enough text to pronounce, so generation has to run for a few tokens before synthesis can start.",
  },
  {
    id: "tts",
    label: "TTS first audio",
    short: "TTS",
    note: "From text handed to the synthesiser to its first audio chunk. Independent of how long the reply is.",
  },
  {
    id: "downlink",
    label: "Downlink + playout",
    short: "down",
    note: "The other half of the round trip, plus the jitter buffer the client fills before it will start playing. The buffer buys smoothness and charges latency.",
  },
];

export type AsrMode = "streaming" | "batch";
export type TtsTrigger = "sentence" | "clause" | "word";

/**
 * Tokens that have to exist before the synthesiser is given anything to say.
 * A sentence-buffered pipeline waits for terminal punctuation; a clause-level
 * one flushes on commas and conjunctions; the most aggressive speaks the first
 * word and keeps up from there.
 */
export const TRIGGER_TOKENS: Record<TtsTrigger, number> = {
  sentence: 18,
  clause: 7,
  word: 3,
};

export const TRIGGER_LABEL: Record<TtsTrigger, string> = {
  sentence: "Full sentence",
  clause: "Clause",
  word: "First word",
};

export type Params = {
  /** VAD silence hangover before end-of-turn is declared. */
  endpointMs: number;
  /** Client to server and back. 0 means everything runs on the device. */
  rttMs: number;
  asrMode: AsrMode;
  /** Streaming ASR: time to promote the last partial to a final. */
  asrFinalMs: number;
  /** Batch ASR: how long the user spoke for. */
  utteranceSec: number;
  /** Batch ASR: real-time factor. 0.2 means 5x faster than real time. */
  asrRtf: number;
  ttftMs: number;
  tokensPerSec: number;
  ttsTrigger: TtsTrigger;
  ttsFirstAudioMs: number;
  /** Client-side jitter/playout buffer filled before playback starts. */
  playoutMs: number;
};

export type Budget = Record<StageId, number>;

/** The critical path, stage by stage. */
export function budget(p: Params): Budget {
  const half = p.rttMs / 2;

  // Streaming ASR has already transcribed nearly all of the utterance by the
  // time it ends, so only the final hypothesis is left. Batch ASR has done
  // nothing yet, so it pays for the whole utterance — which is why a long
  // question is slower to answer than a short one only in this mode.
  const asr =
    p.asrMode === "streaming"
      ? p.asrFinalMs
      : p.utteranceSec * 1000 * p.asrRtf;

  return {
    endpoint: p.endpointMs,
    uplink: half,
    asr,
    ttft: p.ttftMs,
    chunk: (TRIGGER_TOKENS[p.ttsTrigger] / p.tokensPerSec) * 1000,
    tts: p.ttsFirstAudioMs,
    downlink: half + p.playoutMs,
  };
}

export function total(b: Budget): number {
  return STAGES.reduce((sum, stage) => sum + b[stage.id], 0);
}

/** The stage with the largest share, which is the thing worth fixing first. */
export function dominant(b: Budget): Stage {
  return STAGES.reduce((worst, stage) => (b[stage.id] > b[worst.id] ? stage : worst));
}

/**
 * A turn-taking reference point, from conversation-analysis work on human
 * speech: gaps between speakers cluster around 200ms, and a listener starts
 * reading a pause as hesitation somewhere past 500–800ms. Only the upper mark
 * is drawn — at the axis scales this chart reaches, a 200ms line sits on top
 * of the y-axis and its caption collides with this one.
 *
 * It is a marker, not a target the model enforces.
 */
export const THRESHOLDS = [{ at: 800, label: "reads as a pause" }];

export type Preset = {
  id: string;
  name: string;
  note: string;
  params: Params;
};

/**
 * Four builds of the same assistant, in the order people usually travel
 * through them.
 */
export const PRESETS: Preset[] = [
  {
    id: "batch",
    name: "Cloud, batch",
    note: "The first thing anyone builds: wait for silence, upload the clip, transcribe it, prompt the model, synthesise the whole reply.",
    params: {
      endpointMs: 700,
      rttMs: 80,
      asrMode: "batch",
      asrFinalMs: 120,
      utteranceSec: 6,
      asrRtf: 0.12,
      ttftMs: 900,
      tokensPerSec: 40,
      ttsTrigger: "sentence",
      ttsFirstAudioMs: 350,
      playoutMs: 160,
    },
  },
  {
    id: "streaming",
    name: "Cloud, streaming",
    note: "Same components, pipelined. ASR runs during the speech and TTS starts on the first clause instead of the first full stop.",
    params: {
      endpointMs: 500,
      rttMs: 60,
      asrMode: "streaming",
      asrFinalMs: 120,
      utteranceSec: 6,
      asrRtf: 0.12,
      ttftMs: 480,
      tokensPerSec: 60,
      ttsTrigger: "clause",
      ttsFirstAudioMs: 180,
      playoutMs: 120,
    },
  },
  {
    id: "realtime",
    name: "Speech-to-speech",
    note: "One model, audio in and audio out, server-side VAD. The transcript stage disappears rather than getting faster.",
    params: {
      endpointMs: 400,
      rttMs: 50,
      asrMode: "streaming",
      asrFinalMs: 40,
      utteranceSec: 6,
      asrRtf: 0.12,
      ttftMs: 320,
      tokensPerSec: 90,
      ttsTrigger: "word",
      ttsFirstAudioMs: 90,
      playoutMs: 80,
    },
  },
  {
    id: "ondevice",
    name: "On-device",
    note: "Nothing leaves the handset. The network legs go to zero and every model gets slower — a trade, not a win.",
    params: {
      endpointMs: 450,
      rttMs: 0,
      asrMode: "streaming",
      asrFinalMs: 200,
      utteranceSec: 6,
      asrRtf: 0.12,
      ttftMs: 600,
      tokensPerSec: 25,
      ttsTrigger: "clause",
      ttsFirstAudioMs: 250,
      playoutMs: 40,
    },
  },
];

export const DEFAULT_PARAMS: Params = PRESETS[1].params;

/* ------------------------------------------------------------------ */
/* Barge-in                                                            */
/* ------------------------------------------------------------------ */

export type BargeStageId = "detect" | "decide" | "drain";

export const BARGE_STAGES: { id: BargeStageId; label: string; note: string }[] = [
  {
    id: "detect",
    label: "Onset detect",
    note: "Consecutive frames of speech energy before the VAD will believe it. Lower is twitchier: a cough cuts the agent off.",
  },
  {
    id: "decide",
    label: "Cancel round trip",
    note: "Only paid when the VAD runs on the server: the interruption has to reach it and the stop has to come back.",
  },
  {
    id: "drain",
    label: "Playout drain",
    note: "Audio already queued in the sink keeps playing after the stop is issued. Flushing the buffer is what makes an interruption feel instant.",
  },
];

/**
 * Past roughly this much talk-over, an interruption stops reading as latency
 * and starts reading as the agent ignoring the user — a far less forgiving
 * budget than the response one.
 */
export const BARGE_THRESHOLD = 300;

export type BargeParams = {
  onsetMs: number;
  vadAt: "client" | "server";
  /** Audio already buffered ahead of the speaker. */
  playoutMs: number;
  /** Whether the client can drop buffered audio instead of letting it finish. */
  flushable: boolean;
};

/** Residual flush cost even when the buffer can be dropped. */
const FLUSH_MS = 20;

export function bargeIn(p: BargeParams, rttMs: number): Record<BargeStageId, number> {
  return {
    detect: p.onsetMs,
    decide: p.vadAt === "server" ? rttMs : 0,
    drain: p.flushable ? FLUSH_MS : p.playoutMs,
  };
}

export function bargeTotal(b: Record<BargeStageId, number>): number {
  return b.detect + b.decide + b.drain;
}

export const DEFAULT_BARGE: BargeParams = {
  onsetMs: 120,
  vadAt: "server",
  playoutMs: 120,
  flushable: false,
};

/* ------------------------------------------------------------------ */
/* Formatting and scales                                               */
/* ------------------------------------------------------------------ */

export function ms(value: number): string {
  return value >= 1000
    ? `${(value / 1000).toFixed(2)} s`
    : `${Math.round(value)} ms`;
}

/**
 * Fit an axis to the data with ticks a reader can do arithmetic with.
 *
 * Rounding the maximum up on its own is not enough: 3427 rounds to 3500, and
 * four even ticks across that lands on 875, 1750, 2625. Choosing the step
 * first and the maximum from it keeps every label a round number.
 */
const TICK_STEPS = [25, 50, 100, 200, 250, 500, 1000, 2000, 5000];
const MAX_TICKS = 7;

export function axis(maxValue: number): { max: number; step: number } {
  const step =
    TICK_STEPS.find((candidate) => Math.ceil(maxValue / candidate) <= MAX_TICKS) ??
    TICK_STEPS[TICK_STEPS.length - 1];
  return { max: Math.max(step, Math.ceil(maxValue / step) * step), step };
}

export function ticks(max: number, step: number): number[] {
  return Array.from({ length: Math.round(max / step) + 1 }, (_, i) => i * step);
}
