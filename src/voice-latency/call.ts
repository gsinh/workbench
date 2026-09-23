/**
 * A phone call laid out in time, so the budget can be heard rather than read.
 *
 * Pure functions again: the timeline is arithmetic on the same budget the
 * chart draws, and the mix is arithmetic on samples. Playback lives in
 * CallPlayer; nothing here touches the browser.
 */

import { type Budget, STAGES, type StageId, total } from "./model";

/** The recorded lines, by file name without extension. */
export const CLIPS = [
  "caller-question",
  "agent-answer",
  "caller-number-a",
  "caller-number-b",
  "agent-cutin",
  "agent-found",
] as const;
export type ClipName = (typeof CLIPS)[number];

/** Sample rate the clips are stored and mixed at. */
export const CALL_RATE = 16000;

export type Scenario = "question" | "pause";

export const SCENARIO_LABEL: Record<Scenario, string> = {
  question: "A simple question",
  pause: "Caller pauses mid-number",
};

/**
 * The breath a caller takes halfway through reading out a number. Long enough
 * that a short endpoint mistakes it for the end of the turn, short enough that
 * no person listening would.
 */
export const NUMBER_PAUSE_MS = 700;

export type Segment = {
  lane: "caller" | "agent";
  kind: "speech" | "stage";
  start: number;
  end: number;
  label: string;
  stage?: StageId;
  clip?: ClipName;
};

export type CallPlan = {
  segments: Segment[];
  /** When the agent starts speaking, from the caller's first word. */
  agentStart: number;
  /** When the agent decided the caller had finished. */
  turnEnd: number;
  /** End of the last sound. */
  length: number;
  /** The agent answered before the caller had finished. */
  cutIn: boolean;
  /** Stretch where both are speaking at once, if any. */
  overlap: { start: number; end: number } | null;
};

/**
 * Where everything happens, in milliseconds from the caller's first word.
 *
 * The stages run in series from the moment the agent decides the turn is
 * over, exactly as in the chart. In the pause scenario, that decision is made
 * at the pause if the endpoint is shorter than it — and the caller, who has
 * not finished, carries on regardless.
 */
export function planCall(
  b: Budget,
  scenario: Scenario,
  durationMs: Record<ClipName, number>,
): CallPlan {
  const segments: Segment[] = [];
  const speech = (lane: Segment["lane"], clip: ClipName, start: number, label: string) => {
    segments.push({ lane, kind: "speech", start, end: start + durationMs[clip], label, clip });
  };

  let turnEnd: number;
  let answer: ClipName;
  let cutIn = false;
  let callerEnd: number;

  if (scenario === "question") {
    speech("caller", "caller-question", 0, "Caller");
    turnEnd = durationMs["caller-question"];
    callerEnd = turnEnd;
    answer = "agent-answer";
  } else {
    const a = durationMs["caller-number-a"];
    speech("caller", "caller-number-a", 0, "Caller");
    speech("caller", "caller-number-b", a + NUMBER_PAUSE_MS, "Caller");
    callerEnd = a + NUMBER_PAUSE_MS + durationMs["caller-number-b"];
    cutIn = b.endpoint < NUMBER_PAUSE_MS;
    turnEnd = cutIn ? a : callerEnd;
    answer = cutIn ? "agent-cutin" : "agent-found";
  }

  // The endpoint silence is measured from the last sound, so the agent's
  // decision lands `endpoint` after the caller went quiet; the other six
  // stages follow it.
  let at = turnEnd;
  for (const stage of STAGES) {
    const value = b[stage.id];
    if (value > 0) {
      segments.push({ lane: "agent", kind: "stage", start: at, end: at + value, label: stage.label, stage: stage.id });
    }
    at += value;
  }
  const agentStart = turnEnd + total(b);
  speech("agent", answer, agentStart, "Agent");

  const agentEnd = agentStart + durationMs[answer];
  const overlapStart = Math.max(agentStart, cutIn ? durationMs["caller-number-a"] + NUMBER_PAUSE_MS : callerEnd);
  const overlapEnd = Math.min(agentEnd, callerEnd);
  const overlap =
    scenario === "pause" && cutIn && overlapEnd > overlapStart
      ? { start: overlapStart, end: overlapEnd }
      : null;

  return {
    segments,
    agentStart,
    turnEnd,
    length: Math.max(agentEnd, callerEnd),
    cutIn,
    overlap,
  };
}

/** Every spoken segment summed into one track, at CALL_RATE. */
export function mixCall(plan: CallPlan, clips: Record<ClipName, Float32Array>): Float32Array {
  const out = new Float32Array(Math.ceil((plan.length / 1000) * CALL_RATE) + 1);
  for (const segment of plan.segments) {
    if (segment.kind !== "speech" || !segment.clip) continue;
    const samples = clips[segment.clip];
    const offset = Math.round((segment.start / 1000) * CALL_RATE);
    for (let i = 0; i < samples.length && offset + i < out.length; i += 1) {
      out[offset + i] += samples[i];
    }
  }
  // Two voices at once can exceed full scale; clip rather than distort.
  for (let i = 0; i < out.length; i += 1) out[i] = Math.max(-1, Math.min(1, out[i]));
  return out;
}

/** What the reader should take from the call they just heard. */
export function describeCall(plan: CallPlan, scenario: Scenario, endpointMs: number): string {
  const seconds = (ms: number) => `${(ms / 1000).toFixed(2)} s`;
  const gap = plan.agentStart - plan.turnEnd;
  if (scenario === "question") {
    return `The agent started speaking ${seconds(gap)} after the caller stopped.`;
  }
  if (plan.cutIn) {
    return `A ${endpointMs} ms endpoint is shorter than the caller's ${NUMBER_PAUSE_MS} ms pause, so the agent took the half-read number as the whole turn.`;
  }
  return `The ${endpointMs} ms endpoint outlasted the caller's ${NUMBER_PAUSE_MS} ms pause, so the agent waited for the whole number, then answered ${seconds(gap)} later.`;
}
