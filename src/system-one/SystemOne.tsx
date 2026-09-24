"use client";

import { Box, Button, Flex, HStack, Text, Wrap } from "@chakra-ui/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { loadAudio, playSignal } from "../shared/audio";
import { seriesVar, vizVars } from "../shared/palette";
import {
  Tour,
  TourButton,
  type TourStep,
  clearTourHash,
  tourFromHash,
  tourSpotlight,
} from "../shared/Tour";
import {
  type CallTimeline,
  type Decisions,
  DONE_THRESHOLD,
  LLM_AFTER_TURN_MS,
  REPLY_CONFIDENT,
  type ScenarioSpec,
  SILENCE_ENDPOINT_MS,
  type Step,
  type Timings,
  planCall,
  runsOf,
  wordsHeardAt,
} from "./model";

export type SystemOneProps = {
  /**
   * Directory serving scenarios.json, decisions.json, timings.json and the
   * voice clips from src/system-one, with a trailing slash.
   */
  baseUrl: string;
};

type Loaded = { scenarios: ScenarioSpec[]; decisions: Decisions; timings: Timings };

const ms = (value: number) =>
  value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${Math.round(value)} ms`;
const pct = (p: number) => `${Math.round(p * 100)}%`;
/** A word as quoted in narration: no trailing punctuation. */
const bare = (word: string | undefined) => (word ?? "").replace(/[,.!?]+$/, "");
/** An option id as prose: tech_support -> tech support. */
const prose = (id: string) => id.replace(/_/g, " ");

/**
 * A voice agent that decides with a System One model instead of writing text.
 *
 * After every word the caller says, Laya answers four typed questions — has
 * the caller finished, what do they want, how frustrated are they, which
 * pre-written reply fits — and the agent acts on those answers. Everything
 * shown is a recorded Laya output; the page replays it in time with the
 * voiced call, so nothing is downloaded but the call itself.
 */
export default function SystemOne({ baseUrl }: SystemOneProps) {
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scenarioId, setScenarioId] = useState<string | null>(null);
  // Words heard, driving every panel. Moved by playback or the scrubber.
  const [heard, setHeard] = useState(0);
  const [cursor, setCursor] = useState<number | null>(null);
  const stopPlay = useRef<(() => void) | null>(null);
  const clipCache = useRef(new Map<string, Promise<Float32Array>>());

  const [tourIndex, setTourIndex] = useState<number | null>(null);
  const tourRef = useRef<number | null>(null);
  tourRef.current = tourIndex;
  const [played, setPlayed] = useState<Record<number, string>>({});
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all(
      ["scenarios.json", "decisions.json", "timings.json"].map((file) =>
        fetch(`${baseUrl}${file}`).then((r) => {
          if (!r.ok) throw new Error(`${file}: ${r.status}`);
          return r.json();
        }),
      ),
    )
      .then(([spec, decisions, timings]) => {
        if (cancelled) return;
        setData({ scenarios: spec.scenarios, decisions, timings });
        setScenarioId(spec.scenarios[0]?.id ?? null);
      })
      .catch(() => {
        if (!cancelled) {
          setError(
            "The recorded decisions are not available. Run scripts/record-decisions.mjs to produce decisions.json.",
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [baseUrl]);

  useEffect(() => () => stopPlay.current?.(), []);

  const scenario = data?.scenarios.find((s) => s.id === scenarioId) ?? null;
  const steps: Step[] = useMemo(
    () => data?.decisions.scenarios.find((s) => s.id === scenarioId)?.steps ?? [],
    [data, scenarioId],
  );
  const timing = scenario && data ? data.timings.scenarios[scenario.id] : null;
  const decisionMs = data?.decisions.latencyMs.median ?? 0;
  const plan: CallTimeline | null = useMemo(
    () =>
      scenario && timing && steps.length > 0 && data
        ? planCall(scenario, timing, steps, decisionMs, data.timings.replies)
        : null,
    [scenario, timing, steps, decisionMs, data],
  );
  const words = plan?.words ?? [];
  const current = heard > 0 ? steps[heard - 1] : null;

  const clip = useCallback(
    (name: string) => {
      const url = `${baseUrl}${name}.wav`;
      let promise = clipCache.current.get(url);
      if (!promise) {
        promise = loadAudio(url, data?.timings.rate ?? 16000);
        clipCache.current.set(url, promise);
      }
      return promise;
    },
    [baseUrl, data],
  );

  // Fetch the clips for the chosen call ahead of Play, so playback can start
  // inside the click.
  useEffect(() => {
    if (!scenario || !timing || !plan) return;
    void clip(timing.agentClip);
    timing.parts.forEach((_, i) => void clip(`${scenario.id}-caller-${i}`));
    void clip(`reply-${plan.systemOne.reply}`);
  }, [clip, plan, scenario, timing]);

  const choose = (id: string) => {
    stopPlay.current?.();
    setScenarioId(id);
    setHeard(0);
    setCursor(null);
  };

  /** Mix the call into one track and play it, moving the panels in time. */
  const play = async (id = scenarioId) => {
    if (stopPlay.current) {
      stopPlay.current();
      return;
    }
    if (!data || !id) return;
    const spec = data.scenarios.find((s) => s.id === id);
    const t = data.timings.scenarios[id];
    const recorded = data.decisions.scenarios.find((s) => s.id === id)?.steps ?? [];
    if (!spec || !t || recorded.length === 0) return;
    if (id !== scenarioId) choose(id);
    const call = planCall(spec, t, recorded, decisionMs, data.timings.replies);
    const rate = data.timings.rate;
    const [agent, reply, ...parts] = await Promise.all([
      clip(t.agentClip),
      clip(`reply-${call.systemOne.reply}`),
      ...t.parts.map((_, i) => clip(`${id}-caller-${i}`)),
    ]);
    const mix = new Float32Array(Math.ceil((call.length / 1000) * rate) + rate / 2);
    const place = (samples: Float32Array, atMs: number) => {
      const offset = Math.round((atMs / 1000) * rate);
      for (let i = 0; i < samples.length && offset + i < mix.length; i += 1) mix[offset + i] += samples[i];
    };
    place(agent, 0);
    // Each caller clip starts where its first word does.
    let firstWord = 0;
    t.parts.forEach((part, i) => {
      place(parts[i], call.words[firstWord].start);
      firstWord += part.words;
    });
    place(reply, call.systemOne.speaksAt);
    for (let i = 0; i < mix.length; i += 1) mix[i] = Math.max(-1, Math.min(1, mix[i]));

    setHeard(0);
    stopPlay.current = playSignal(mix, rate, (seconds) => {
      if (seconds === null) {
        stopPlay.current = null;
        setCursor(null);
        setHeard(call.systemOne.afterWord);
        const at = tourRef.current;
        if (at !== null) setPlayed((prev) => ({ ...prev, [at]: id }));
        return;
      }
      const t = seconds * 1000;
      setCursor(t);
      setHeard(Math.min(wordsHeardAt(call.words, t), call.systemOne.afterWord));
    });
  };

  if (error) {
    return (
      <Text fontSize="xs" color="fg.muted">
        {error}
      </Text>
    );
  }
  if (!data || !scenario || !plan) {
    return (
      <Text fontSize="xs" color="fg.muted">
        Loading the recorded decisions…
      </Text>
    );
  }

  const q = data.decisions.questions;
  const intentOptions = Object.keys(q.intent.criteria as Record<string, string>);
  const replyOptions = q.reply.criteria as Record<string, string>;
  const levels = q.frustration.criteria as string[];
  const doneSeries = steps.map((s) => s.answers.turn_complete.p);
  const { systemOne, silenceOnly } = plan;
  const gainMs = silenceOnly.speaksAt - systemOne.speaksAt;

  // ---- Tour, narrated from the recording ----
  const stepsOf = (id: string) => data.decisions.scenarios.find((s) => s.id === id)?.steps ?? [];
  const planOf = (id: string) => {
    const spec = data.scenarios.find((s) => s.id === id)!;
    return planCall(spec, data.timings.scenarios[id], stepsOf(id), decisionMs, data.timings.replies);
  };
  const numberSpec = data.scenarios.find((s) => s.id === "number");
  const numberSteps = stepsOf("number");
  const pauseAt = numberSpec?.pauseAfterWord ?? 0;
  const numberPlan = numberSpec ? planOf("number") : null;
  const intentRuns = runsOf(stepsOf("change-of-mind"), "intent");
  const changeWords = data.scenarios.find((s) => s.id === "change-of-mind")?.caller.split(/\s+/) ?? [];
  const frustratedSteps = stepsOf("frustrated");
  const frustratedEnd = frustratedSteps[frustratedSteps.length - 1];
  const unclearPlan = data.scenarios.some((s) => s.id === "unclear") ? planOf("unclear") : null;

  const tourSteps: TourStep[] = [
    {
      target: "headline",
      say: `A voice agent has to decide things while the caller is still talking. Here a System One model — Laya, open source — answers four questions after every word, in about ${ms(decisionMs)} each.`,
    },
    {
      target: "call",
      say: "A caller reads out an account number and takes a breath halfway through. Watch the “finished?” curve.",
      showLabel: "Play it",
      show: () => void play("number"),
      done: played[1] === "number",
      after: numberPlan
        ? `At the breath after “${bare(numberSteps[pauseAt - 1]?.text.split(" ").pop())}”, Laya put the chance they had finished at ${pct(numberSteps[pauseAt - 1]?.answers.turn_complete.p ?? 0)}; after the last digit, ${pct(numberSteps[numberSteps.length - 1]?.answers.turn_complete.p ?? 0)}. ${numberPlan.systemOne.cutIn ? "It still took the pause for the end of the turn." : "So it waited out the breath."} The silence-only agent ${numberPlan.silenceOnly.cutIn ? "cut in at the pause" : "waited too"}.`
        : "",
    },
    {
      target: "intent",
      say: "This caller changes their mind halfway through. Watch what the agent thinks they want.",
      showLabel: "Play it",
      show: () => void play("change-of-mind"),
      done: played[2] === "change-of-mind",
      after:
        intentRuns.length > 1
          ? intentRuns
              .map((r) => `“${prose(r.choice)}” from “${bare(changeWords[r.from - 1])}”`)
              .join(", then ")
              .replace(/^./, (c) => c.toUpperCase()) + ". The answer moves with the sentence, word by word."
          : `It held “${prose(intentRuns[0]?.choice ?? "")}” throughout.`,
    },
    {
      target: "frustration",
      say: "Third call about the same fault. Watch frustration, and which reply it picks.",
      showLabel: "Play it",
      show: () => void play("frustrated"),
      done: played[3] === "frustrated",
      after: frustratedEnd
        ? `By the end it scored frustration ${frustratedEnd.answers.frustration.score.toFixed(1)} of ${levels.length - 1} (“${levels[Math.round(frustratedEnd.answers.frustration.score)]}”) and picked “${replyOptions[frustratedEnd.answers.reply.choice]}”.`
        : "",
    },
    {
      target: "reply",
      say: "A vague opener. When the best reply is not a confident one, a System One agent should hand over rather than guess.",
      showLabel: "Play it",
      show: () => void play("unclear"),
      done: played[4] === "unclear",
      after: unclearPlan
        ? unclearPlan.systemOne.handedOff
          ? `Its best reply scored ${pct(unclearPlan.systemOne.replyConfidence)}, under the ${pct(REPLY_CONFIDENT)} bar, so the call went to the LLM — about ${ms(LLM_AFTER_TURN_MS)} of generating and speaking instead of playing a ready reply.`
          : `Its best reply scored ${pct(unclearPlan.systemOne.replyConfidence)}, over the ${pct(REPLY_CONFIDENT)} bar, so it answered directly.`
        : "",
    },
    {
      target: "provenance",
      say: `Every answer here is a real Laya output, recorded offline: ${data.decisions.latencyMs.calls} decisions, median ${ms(decisionMs)} each on ${data.decisions.machine.cpu}. Pick any call and step through it word by word.`,
    },
  ];
  const startTour = () => {
    setPlayed({});
    setTourIndex(0);
  };
  const closeTour = () => {
    setTourIndex(null);
    clearTourHash();
  };

  return (
    <Box
      ref={root}
      css={{ ...vizVars, ...tourSpotlight(tourIndex !== null ? tourSteps[tourIndex].target : null) }}
    >
      <DeepLink onOpen={(at) => setTourIndex(Math.min(tourSteps.length - 1, at))} />

      {/* Headline: how much sooner the agent speaks */}
      <Flex align="baseline" gap="3" wrap="wrap" data-tour="headline">
        <Text fontSize={{ base: "4xl", sm: "5xl" }} fontWeight="bold" lineHeight="1" color="colorPalette.fg">
          {ms(systemOne.speaksAt - plan.words[systemOne.afterWord - 1].end)}
        </Text>
        <Box>
          <Text fontSize="xs" fontWeight="bold">
            to reply, deciding with System One
          </Text>
          <Text fontSize="2xs" color="fg.muted">
            {silenceOnly.cutIn
              ? "the silence-only agent cut in mid-turn"
              : `${ms(silenceOnly.speaksAt - plan.words[silenceOnly.afterWord - 1].end)} for the silence-only LLM agent${gainMs > 0 ? ` · ${ms(gainMs)} sooner` : ""}`}
          </Text>
        </Box>
        {tourIndex === null && (
          <Box ms="auto">
            <TourButton id="system-one" onStart={startTour} />
          </Box>
        )}
      </Flex>

      <Box mt="5" ps="3" borderStartWidth="2px" borderColor="colorPalette.solid">
        <Text fontSize="2xs" color="fg.muted" lineHeight="tall">
          A System One model does not write text. Given the call so far and a
          few typed questions, it returns probabilities in one pass. So the
          agent can decide{" "}
          <Text as="span" color="fg">
            while the caller is still talking
          </Text>{" "}
          whether they have finished, what they want, and which reply to play —
          a reply written and voiced in advance, so nothing is generated.
        </Text>
      </Box>

      {/* Calls */}
      <Wrap gap="2" mt="5">
        {data.scenarios.map((s) => (
          <Button
            key={s.id}
            size="2xs"
            variant={s.id === scenarioId ? "solid" : "outline"}
            onClick={() => choose(s.id)}
          >
            {s.title}
          </Button>
        ))}
      </Wrap>

      {/* The call, word by word */}
      <Box data-tour="call" mt="5" p="4" borderWidth="1px" borderColor="border" rounded="l3">
        <Flex justify="space-between" align="center" gap="3" wrap="wrap">
          <Text fontSize="2xs" color="fg.muted">
            Agent: “{scenario.agent}”
          </Text>
          <Button size="2xs" onClick={() => void play()} minW="24">
            {cursor !== null ? "■ Stop" : "▶ Play the call"}
          </Button>
        </Flex>
        <Text fontSize="md" mt="3" lineHeight="tall">
          {words.map((w, i) => (
            <Text
              as="span"
              key={i}
              color={i < heard ? "fg" : "fg.subtle"}
              fontWeight={i === heard - 1 ? "bold" : "normal"}
              transition="color 120ms ease"
            >
              {w.text}{" "}
              {scenario.pauseAfterWord === i + 1 && (
                <Text as="span" fontSize="2xs" color="fg.muted">
                  (breath){" "}
                </Text>
              )}
            </Text>
          ))}
        </Text>
        <Box asChild w="full" mt="3">
          <input
            type="range"
            min={0}
            max={words.length}
            value={heard}
            aria-label="Words heard"
            onChange={(event) => {
              stopPlay.current?.();
              setHeard(Number(event.target.value));
            }}
          />
        </Box>
        <Text fontSize="9px" color="fg.muted">
          Drag to step through the call word by word, or play it.
        </Text>

        <TimelineLanes plan={plan} cursor={cursor} />
      </Box>

      {/* The four answers */}
      <Box display="grid" gap="4" mt="5" gridTemplateColumns={{ base: "1fr", md: "repeat(2, 1fr)" }}>
        <Panel tour="done" title={q.turn_complete.instructions}>
          <Flex align="baseline" gap="2">
            <Text fontSize="2xl" fontWeight="bold" lineHeight="1" fontVariantNumeric="tabular-nums">
              {current ? pct(current.answers.turn_complete.p) : "—"}
            </Text>
            <Text fontSize="2xs" color="fg.muted">
              chance they have finished
            </Text>
          </Flex>
          <Sparkline values={doneSeries} upTo={heard} threshold={DONE_THRESHOLD} pauseAfter={scenario.pauseAfterWord} />
        </Panel>

        <Panel tour="intent" title={q.intent.instructions}>
          <Bars
            options={intentOptions.map((id) => ({ id, label: id.replace("_", " ") }))}
            probs={current?.answers.intent.probs ?? null}
            chosen={current?.answers.intent.choice ?? null}
            slot={1}
          />
        </Panel>

        <Panel tour="frustration" title={q.frustration.instructions}>
          <Box position="relative" h="3" bg="bg.subtle" rounded="full" overflow="hidden" mt="1">
            <Box
              h="full"
              w={current ? `${(current.answers.frustration.score / (levels.length - 1)) * 100}%` : "0%"}
              bg={seriesVar(3)}
              transition="width 200ms ease"
              _motionReduce={{ transition: "none" }}
            />
          </Box>
          <Flex justify="space-between" mt="1.5">
            {levels.map((level) => (
              <Text key={level} fontSize="9px" color="fg.muted">
                {level}
              </Text>
            ))}
          </Flex>
        </Panel>

        <Panel tour="reply" title={q.reply.instructions}>
          <Bars
            options={Object.entries(replyOptions).map(([id, text]) => ({ id, label: text }))}
            probs={current?.answers.reply.probs ?? null}
            chosen={current?.answers.reply.choice ?? null}
            slot={2}
          />
          <Text fontSize="9px" color="fg.muted" mt="2">
            Below {pct(REPLY_CONFIDENT)} for the best reply, the agent hands the
            turn to an LLM instead.
          </Text>
        </Panel>
      </Box>

      {/* Provenance */}
      <Text data-tour="provenance" fontSize="9px" color="fg.muted" mt="5" lineHeight="short">
        Recorded answers, not live: {data.decisions.model}, {data.decisions.package}
        {data.decisions.revision ? ` (revision ${data.decisions.revision})` : ""}, run{" "}
        {data.decisions.latencyMs.calls} times on {data.decisions.machine.cpu} on{" "}
        {new Date(data.decisions.recordedAt).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}
        ; median {ms(decisionMs)} per decision. The comparison agent waits{" "}
        {ms(SILENCE_ENDPOINT_MS)} of silence and then runs the latency budget&rsquo;s
        streaming pipeline ({ms(LLM_AFTER_TURN_MS)}). Voices synthesised with
        Kokoro.
      </Text>

      {tourIndex !== null && (
        <Tour steps={tourSteps} index={tourIndex} onIndex={setTourIndex} onClose={closeTour} root={root.current} />
      )}
    </Box>
  );
}

/** Opens the tour from a #tour-N link, once. */
function DeepLink({ onOpen }: { onOpen: (at: number) => void }) {
  useEffect(() => {
    const at = tourFromHash();
    if (at !== null) onOpen(Math.max(0, at));
    // Once, on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

function Panel({ tour, title, children }: { tour: string; title: string; children: React.ReactNode }) {
  return (
    <Box data-tour={tour} p="3" borderWidth="1px" borderColor="border" rounded="l2">
      <Text fontSize="2xs" fontWeight="bold" mb="2" lineHeight="short">
        {title}
      </Text>
      {children}
    </Box>
  );
}

/** One bar per option, the chosen one in full colour. */
function Bars({
  options,
  probs,
  chosen,
  slot,
}: {
  options: { id: string; label: string }[];
  probs: Record<string, number> | null;
  chosen: string | null;
  slot: number;
}) {
  return (
    <Box>
      {options.map((option) => {
        const p = probs?.[option.id] ?? 0;
        const isChosen = option.id === chosen;
        return (
          <Box key={option.id} mb="1.5">
            <Flex justify="space-between" gap="2">
              <Text fontSize="2xs" color={isChosen ? "fg" : "fg.muted"} fontWeight={isChosen ? "bold" : "normal"} lineHeight="short">
                {option.label}
              </Text>
              <Text fontSize="2xs" fontVariantNumeric="tabular-nums" color="fg.muted">
                {probs ? pct(p) : ""}
              </Text>
            </Flex>
            <Box h="1.5" bg="bg.subtle" rounded="full" overflow="hidden" mt="0.5">
              <Box
                h="full"
                w={`${p * 100}%`}
                bg={seriesVar(slot)}
                opacity={isChosen ? 1 : 0.45}
                transition="width 200ms ease, opacity 200ms ease"
                _motionReduce={{ transition: "none" }}
              />
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}

/** P(finished) across the words heard, with the decision threshold drawn. */
function Sparkline({
  values,
  upTo,
  threshold,
  pauseAfter,
}: {
  values: number[];
  upTo: number;
  threshold: number;
  pauseAfter?: number;
}) {
  const n = Math.max(2, values.length);
  const x = (i: number) => (i / (n - 1)) * 100;
  const y = (p: number) => (1 - p) * 100;
  const shown = values.slice(0, upTo);
  return (
    <Box position="relative" h="16" mt="3">
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={{ width: "100%", height: "100%", overflow: "visible" }} aria-hidden>
        <line x1="0" x2="100" y1={y(threshold)} y2={y(threshold)} stroke="var(--chakra-colors-fg-muted)" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" strokeWidth="1" />
        {pauseAfter !== undefined && (
          <line x1={x(pauseAfter - 1)} x2={x(pauseAfter - 1)} y1="0" y2="100" stroke="var(--chakra-colors-fg-muted)" strokeOpacity="0.4" vectorEffect="non-scaling-stroke" strokeWidth="1" />
        )}
        {shown.length > 1 && (
          <polyline
            points={shown.map((p, i) => `${x(i)},${y(p)}`).join(" ")}
            fill="none"
            stroke={seriesVar(0)}
            strokeWidth="2"
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>
      {/* The latest point, outside the stretched SVG so it stays round. */}
      {shown.length > 0 && (
        <Box
          position="absolute"
          insetStart={`${x(shown.length - 1)}%`}
          top={`${y(shown[shown.length - 1])}%`}
          transform="translate(-50%, -50%)"
          boxSize="2"
          rounded="full"
          bg={seriesVar(0)}
        />
      )}
      <Text position="absolute" insetEnd="0" top={`calc(${y(threshold)}% - 14px)`} fontSize="9px" color="fg.muted">
        reply threshold
      </Text>
    </Box>
  );
}

/** Caller, System One agent and silence-only agent on one time axis. */
function TimelineLanes({ plan, cursor }: { plan: CallTimeline; cursor: number | null }) {
  const start = plan.agentEnd;
  const span = Math.max(1, plan.length - start);
  const at = (t: number) => `${Math.max(0, ((t - start) / span) * 100)}%`;
  const width = (a: number, b: number) => `max(2px, ${((b - a) / span) * 100}%)`;
  const { systemOne, silenceOnly } = plan;

  const lanes = [
    { label: "Caller", segments: plan.words.map((w) => ({ from: w.start, to: w.end, bg: "fg.muted", opacity: 0.55 })) },
    {
      label: "System One",
      segments: [
        { from: systemOne.decidedAt - 1, to: systemOne.speaksAt, bg: "border", opacity: 1 },
        { from: systemOne.speaksAt, to: plan.length, bg: systemOne.handedOff ? seriesVar(2) : "colorPalette.solid", opacity: 1 },
      ],
      note: systemOne.handedOff ? "handed to the LLM" : systemOne.cutIn ? "cut in" : undefined,
    },
    {
      label: "Silence only",
      segments: [{ from: silenceOnly.speaksAt, to: plan.length, bg: "fg.muted", opacity: 0.35 }],
      note: silenceOnly.cutIn ? "cut in" : undefined,
    },
  ];

  return (
    <Box mt="4" aria-hidden>
      {lanes.map((lane) => (
        <Flex key={lane.label} align="center" gap="2" mb="1.5">
          <Text fontSize="9px" color="fg.muted" w="16" flexShrink="0">
            {lane.label}
          </Text>
          <Box position="relative" h="14px" flex="1" bg="bg.subtle" rounded="l1">
            {lane.segments.map((s, i) => (
              <Box
                key={i}
                position="absolute"
                top="0"
                bottom="0"
                insetStart={at(s.from)}
                width={width(s.from, s.to)}
                bg={s.bg}
                opacity={s.opacity}
                rounded="2px"
              />
            ))}
            {cursor !== null && cursor >= start && (
              <Box position="absolute" top="-2px" bottom="-2px" insetStart={at(Math.min(cursor, plan.length))} w="2px" bg="fg" />
            )}
          </Box>
        </Flex>
      ))}
      {lanes.some((lane) => lane.note) && (
        <Text fontSize="9px" color="red.fg" mt="1">
          {lanes
            .filter((lane) => lane.note)
            .map((lane) => `${lane.label}: ${lane.note}`)
            .join(" · ")}
        </Text>
      )}
    </Box>
  );
}
