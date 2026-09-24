/**
 * A voice agent that decides with a System One model, laid out in time.
 *
 * Pure functions, no React. The decisions themselves are recorded Laya
 * outputs (decisions.json, written by scripts/record-decisions.mjs); this
 * file turns them, plus the word timings of the voiced calls, into a call:
 * when the agent decides the caller has finished, which reply it plays, and
 * how that compares with an agent that only listens for silence.
 *
 * The comparison build is the latency budget's "Cloud, streaming" preset, so
 * the two experiments argue from the same numbers.
 */

import { PRESETS, budget } from "../voice-latency/model";

/* ------------------------------------------------------------------ */
/* The recorded file                                                   */
/* ------------------------------------------------------------------ */

export type NoulRecord = { p: number };
export type ChoiceRecord = { choice: string; probs: Record<string, number>; confidence: number };
export type ScoreRecord = { score: number; probs: Record<string, number>; confidence: number };

export type Step = {
  /** Words heard so far. */
  words: number;
  text: string;
  /** Wall-clock milliseconds this decision took when recorded. */
  ms: number;
  answers: {
    turn_complete: NoulRecord;
    intent: ChoiceRecord;
    frustration: ScoreRecord;
    reply: ChoiceRecord;
  };
};

export type Question = {
  type: "choice" | "score" | "noul";
  instructions: string;
  criteria?: Record<string, string> | string[] | { true?: string; false?: string };
};

export type Decisions = {
  model: string;
  package: string;
  revision: string | null;
  recordedAt: string;
  machine: { platform: string; arch: string; cpu: string; cores: number; node: string };
  latencyMs: { median: number; p90: number; min: number; max: number; calls: number };
  questions: Record<"turn_complete" | "intent" | "frustration" | "reply", Question>;
  scenarios: { id: string; steps: Step[] }[];
};

export type ScenarioSpec = {
  id: string;
  title: string;
  agent: string;
  caller: string;
  pauseAfterWord?: number;
  pauseMs?: number;
};

export type Timings = {
  rate: number;
  scenarios: Record<
    string,
    {
      agentClip: string;
      agentMs: number;
      parts: { words: number; ms: number; wordEnds: number[] }[];
    }
  >;
  /** Duration of each reply clip, by reply id. */
  replies: Record<string, number>;
};

/* ------------------------------------------------------------------ */
/* Policy                                                              */
/* ------------------------------------------------------------------ */

/** P(finished) at or above which the agent treats a silence as the end. */
export const DONE_THRESHOLD = 0.5;
/** Silence the agent waits when it believes the caller has finished. */
export const SHORT_WAIT_MS = 200;
/** Silence it waits when it believes they have not. */
export const LONG_WAIT_MS = 1000;
/** Below this, the best reply is not trusted and the call goes to the LLM. */
export const REPLY_CONFIDENT = 0.5;
/** Gap between the agent's question and the caller starting to answer. */
const TURN_GAP_MS = 500;

/**
 * The rest of the pipeline after the turn is called over, from the latency
 * budget's streaming preset. A System One agent still needs the network and
 * streaming ASR to have the words at all, but no generation and no synthesis:
 * its replies are written, and voiced, in advance.
 */
const streaming = budget(PRESETS.find((p) => p.id === "streaming")!.params);
export const SILENCE_ENDPOINT_MS = streaming.endpoint;
export const LLM_AFTER_TURN_MS =
  streaming.uplink + streaming.asr + streaming.ttft + streaming.chunk + streaming.tts + streaming.downlink;
export const SYSTEM_ONE_OVERHEAD_MS = streaming.uplink + streaming.asr + streaming.downlink;

/* ------------------------------------------------------------------ */
/* The call in time                                                    */
/* ------------------------------------------------------------------ */

export type Word = { index: number; text: string; start: number; end: number };

export type Response = {
  /** Words the caller had said when the agent took the turn. */
  afterWord: number;
  /** When the agent decided the turn was over. */
  decidedAt: number;
  /** When its reply starts playing. */
  speaksAt: number;
  /** The reply it plays (the LLM path plays a stand-in, and says so). */
  reply: string;
  replyConfidence: number;
  /** It answered before the caller had finished. */
  cutIn: boolean;
  /** The reply was not confident enough and went to the LLM. */
  handedOff: boolean;
};

export type CallTimeline = {
  agentEnd: number;
  words: Word[];
  callerEnd: number;
  systemOne: Response;
  /** The silence-only LLM build, for comparison. */
  silenceOnly: { afterWord: number; speaksAt: number; cutIn: boolean };
  /** End of the last sound either agent makes. */
  length: number;
};

/** Absolute start and end of every caller word, from the voiced clips. */
export function wordsInTime(spec: ScenarioSpec, timing: Timings["scenarios"][string]): Word[] {
  const texts = spec.caller.split(/\s+/).filter(Boolean);
  const words: Word[] = [];
  let partStart = timing.agentMs + TURN_GAP_MS;
  let index = 0;
  timing.parts.forEach((part, p) => {
    if (p > 0) partStart += spec.pauseMs ?? 0;
    let previous = 0;
    for (const end of part.wordEnds) {
      words.push({ index, text: texts[index] ?? "", start: partStart + previous, end: partStart + end });
      previous = end;
      index += 1;
    }
    partStart += part.ms;
  });
  return words;
}

export function planCall(
  spec: ScenarioSpec,
  timing: Timings["scenarios"][string],
  steps: Step[],
  decisionMs: number,
  replyMs: Record<string, number>,
): CallTimeline {
  const words = wordsInTime(spec, timing);
  const callerEnd = words[words.length - 1].end;

  // System One: after each word, wait a short silence if the model thinks the
  // caller has finished and a long one if not; take the turn if the silence
  // runs out before the next word starts.
  let systemOne: Response | null = null;
  for (let k = 0; k < words.length; k += 1) {
    const step = steps[k];
    if (!step) break;
    const done = step.answers.turn_complete.p >= DONE_THRESHOLD;
    const wait = Math.max(done ? SHORT_WAIT_MS : LONG_WAIT_MS, decisionMs);
    const nextStart = words[k + 1]?.start ?? Infinity;
    if (words[k].end + wait <= nextStart) {
      const reply = step.answers.reply;
      const replyConfidence = reply.probs[reply.choice] ?? 0;
      const handedOff = replyConfidence < REPLY_CONFIDENT;
      const decidedAt = words[k].end + wait;
      systemOne = {
        afterWord: k + 1,
        decidedAt,
        speaksAt: decidedAt + SYSTEM_ONE_OVERHEAD_MS + (handedOff ? LLM_AFTER_TURN_MS - SYSTEM_ONE_OVERHEAD_MS : 0),
        reply: handedOff ? "ask_more" : reply.choice,
        replyConfidence,
        cutIn: k < words.length - 1,
        handedOff,
      };
      break;
    }
  }
  // Every call ends, so the loop always finds a turn; this only guards data
  // with fewer steps than words.
  systemOne ??= {
    afterWord: words.length,
    decidedAt: callerEnd + LONG_WAIT_MS,
    speaksAt: callerEnd + LONG_WAIT_MS + SYSTEM_ONE_OVERHEAD_MS,
    reply: "ask_more",
    replyConfidence: 0,
    cutIn: false,
    handedOff: false,
  };

  // Silence only: the first gap of at least the endpoint ends the turn.
  let silenceWord = words.length;
  for (let k = 0; k < words.length - 1; k += 1) {
    if (words[k + 1].start - words[k].end >= SILENCE_ENDPOINT_MS) {
      silenceWord = k + 1;
      break;
    }
  }
  const silenceOnly = {
    afterWord: silenceWord,
    speaksAt: words[silenceWord - 1].end + SILENCE_ENDPOINT_MS + LLM_AFTER_TURN_MS,
    cutIn: silenceWord < words.length,
  };

  const replyEnd = systemOne.speaksAt + (replyMs[systemOne.reply] ?? 0);
  return {
    agentEnd: timing.agentMs,
    words,
    callerEnd,
    systemOne,
    silenceOnly,
    length: Math.max(callerEnd, replyEnd, silenceOnly.speaksAt + 300),
  };
}

/** Words heard by time `t`: the step whose answers are on screen. */
export function wordsHeardAt(words: Word[], t: number): number {
  let n = 0;
  for (const w of words) if (w.end <= t) n += 1;
  return n;
}

/** Runs of the same answer to a choice question, word by word (1-based, inclusive). */
export function runsOf(
  steps: Step[],
  question: "intent" | "reply",
): { choice: string; from: number; to: number }[] {
  const runs: { choice: string; from: number; to: number }[] = [];
  steps.forEach((step, i) => {
    const choice = step.answers[question].choice;
    const last = runs[runs.length - 1];
    if (last && last.choice === choice) last.to = i + 1;
    else runs.push({ choice, from: i + 1, to: i + 1 });
  });
  return runs;
}
