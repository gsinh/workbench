"use client";

import { Box, Button, Flex, HStack, Text } from "@chakra-ui/react";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { loadAudio, playSignal } from "../shared/audio";
import {
  CALL_RATE,
  CLIPS,
  type CallPlan,
  type ClipName,
  SCENARIO_LABEL,
  type Scenario,
  describeCall,
  mixCall,
  planCall,
} from "./call";
import { type Budget, STAGES, ms } from "./model";
import { seriesVar } from "./palette";

export type CallPlayerHandle = {
  /**
   * Play a call. Call it from inside a click handler: playback is started
   * synchronously when the clips are ready, which keeps the user gesture that
   * browsers — iOS Safari above all — insist on.
   */
  play: (options?: { scenario?: Scenario; budget?: Budget }) => void;
  /** Start fetching the clips now, ahead of the first Play. */
  preload: () => void;
};

export type CallResult = { scenario: Scenario; cutIn: boolean };

type Clips = Record<ClipName, Float32Array>;

/**
 * The budget as sound: a caller, the wait the budget describes, then the
 * agent. Hearing 3.4 s of dead air is a different experience from reading
 * "3.4 s", and it is the one the whole page is about.
 */
export const CallPlayer = forwardRef<
  CallPlayerHandle,
  {
    budget: Budget;
    /** Directory the clips are served from, with a trailing slash. */
    clipsUrl: string;
    /** Told when a call finishes playing, so a guide can react to it. */
    onPlayed?: (result: CallResult) => void;
  }
>(function CallPlayer({ budget, clipsUrl, onPlayed }, ref) {
  const [scenario, setScenario] = useState<Scenario>("question");
  const [clips, setClips] = useState<Clips | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Milliseconds into the call while playing, or null when stopped.
  const [cursor, setCursor] = useState<number | null>(null);
  // The plan being played, frozen at Play so moving a slider mid-call does not
  // redraw the timeline under the cursor.
  const [playing, setPlaying] = useState<{ plan: CallPlan; scenario: Scenario } | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const root = useRef<HTMLDivElement>(null);
  const loading = useRef<Promise<Clips> | null>(null);
  const stop = useRef<(() => void) | null>(null);

  const load = useCallback(() => {
    if (!loading.current) {
      loading.current = Promise.all(
        CLIPS.map((name) => loadAudio(`${clipsUrl}${name}.wav`, CALL_RATE)),
      ).then((decoded) => {
        const byName = Object.fromEntries(CLIPS.map((name, i) => [name, decoded[i]])) as Clips;
        setClips(byName);
        return byName;
      });
      loading.current.catch(() => {
        loading.current = null;
        setError("The voice clips could not be loaded.");
      });
    }
    return loading.current;
  }, [clipsUrl]);

  // Fetch when the player scrolls into view, so the first Play has the clips
  // in hand and can start inside the click.
  useEffect(() => {
    const el = root.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      void load();
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        void load();
        observer.disconnect();
      }
    }, { rootMargin: "200px" });
    observer.observe(el);
    return () => observer.disconnect();
  }, [load]);

  useEffect(() => () => stop.current?.(), []);

  const durations = (c: Clips) =>
    Object.fromEntries(CLIPS.map((name) => [name, (c[name].length / CALL_RATE) * 1000])) as Record<
      ClipName,
      number
    >;

  const start = useCallback(
    (c: Clips, which: Scenario, b: Budget) => {
      stop.current?.();
      const plan = planCall(b, which, durations(c));
      setPlaying({ plan, scenario: which });
      setResult(null);
      setError(null);
      stop.current = playSignal(
        mixCall(plan, c),
        CALL_RATE,
        (seconds) => {
          if (seconds === null) {
            stop.current = null;
            setCursor(null);
            setPlaying(null);
            setResult(describeCall(plan, which, b.endpoint));
            onPlayed?.({ scenario: which, cutIn: plan.cutIn });
          } else {
            setCursor(seconds * 1000);
          }
        },
        setError,
      );
    },
    [onPlayed],
  );

  const play = useCallback(
    (options?: { scenario?: Scenario; budget?: Budget }) => {
      const which = options?.scenario ?? scenario;
      const b = options?.budget ?? budget;
      if (options?.scenario) setScenario(options.scenario);
      if (clips) {
        start(clips, which, b);
        return;
      }
      // Not loaded yet: play once it is. Browsers that tie playback to the
      // click may refuse this one, and playSignal then says to press again.
      void load().then((c) => start(c, which, b));
    },
    [budget, clips, load, scenario, start],
  );

  useImperativeHandle(ref, () => ({ play, preload: () => void load() }), [play, load]);

  const toggle = () => {
    if (stop.current) {
      stop.current();
      return;
    }
    play();
  };

  const plan = playing?.plan ?? (clips ? planCall(budget, scenario, durations(clips)) : null);
  const length = plan?.length ?? 1;
  const pct = (value: number) => `${(value / length) * 100}%`;

  // What is happening under the cursor, in words.
  let now: string | null = null;
  if (plan && cursor !== null) {
    const here = plan.segments.filter((s) => cursor >= s.start && cursor < s.end);
    const agentSpeaking = here.find((s) => s.lane === "agent" && s.kind === "speech");
    const callerSpeaking = here.find((s) => s.lane === "caller");
    const stage = here.find((s) => s.kind === "stage");
    now =
      agentSpeaking && callerSpeaking
        ? "Both talking at once"
        : agentSpeaking
          ? "Agent speaking"
          : callerSpeaking
            ? stage
              ? `Caller speaking · agent already on ${stage.label.toLowerCase()}`
              : "Caller speaking"
            : stage
              ? `Silence · ${stage.label}`
              : "Silence";
  }

  return (
    <Box ref={root}>
      <Flex justify="space-between" align="baseline" gap="3" wrap="wrap">
        <Box>
          <Text fontSize="xs" fontWeight="bold">
            Hear it
          </Text>
          <Text fontSize="2xs" color="fg.muted" mt="1" lineHeight="short">
            A call through the top bar: the caller, the wait your budget adds up
            to, then the agent.
          </Text>
        </Box>
        <HStack gap="2" wrap="wrap">
          {(Object.keys(SCENARIO_LABEL) as Scenario[]).map((key) => (
            <Button
              key={key}
              size="2xs"
              variant={scenario === key ? "subtle" : "ghost"}
              aria-pressed={scenario === key}
              onClick={() => setScenario(key)}
              disabled={playing !== null}
            >
              {SCENARIO_LABEL[key]}
            </Button>
          ))}
          <Button size="2xs" onClick={toggle} minW="24">
            {playing ? "■ Stop" : "▶ Play a call"}
          </Button>
        </HStack>
      </Flex>

      {/* Timeline: two lanes on one time axis, so the gap is a length. */}
      <Box mt="3" aria-hidden>
        {plan ? (
          <Box position="relative">
            {(["caller", "agent"] as const).map((lane) => (
              <Flex key={lane} align="center" gap="2" mb="1.5">
                <Text fontSize="9px" color="fg.muted" w="10" flexShrink="0" textTransform="uppercase" letterSpacing="wide">
                  {lane}
                </Text>
                <Box position="relative" h="18px" flex="1" bg="bg.subtle" rounded="l1">
                  {plan.segments
                    .filter((s) => s.lane === lane)
                    .map((s) => (
                      <Box
                        key={`${s.kind}-${s.start}-${s.label}`}
                        position="absolute"
                        top={s.kind === "stage" ? "30%" : "0"}
                        bottom={s.kind === "stage" ? "30%" : "0"}
                        insetStart={pct(s.start)}
                        width={`max(1px, calc(${pct(s.end - s.start)} - 1px))`}
                        rounded="2px"
                        bg={
                          s.kind === "stage"
                            ? seriesVar(STAGES.findIndex((st) => st.id === s.stage))
                            : lane === "agent"
                              ? "colorPalette.solid"
                              : "fg.muted"
                        }
                        opacity={s.kind === "stage" ? 0.8 : lane === "caller" ? 0.55 : 1}
                        title={`${s.label}: ${ms(s.end - s.start)}`}
                        transition="width 200ms ease, inset-inline-start 200ms ease"
                        _motionReduce={{ transition: "none" }}
                      />
                    ))}
                </Box>
              </Flex>
            ))}
            {/* Both lanes, offset past the lane labels. */}
            <Box position="absolute" top="0" bottom="0" insetStart="calc(2.5rem + 0.5rem)" insetEnd="0" pointerEvents="none">
              {plan.overlap && (
                <Box
                  position="absolute"
                  top="-1"
                  bottom="-1"
                  insetStart={pct(plan.overlap.start)}
                  width={pct(plan.overlap.end - plan.overlap.start)}
                  borderWidth="1.5px"
                  borderColor="red.solid"
                  rounded="l1"
                />
              )}
              {cursor !== null && (
                <Box
                  position="absolute"
                  top="-1"
                  bottom="-1"
                  insetStart={pct(Math.min(cursor, length))}
                  w="2px"
                  bg="fg"
                />
              )}
            </Box>
          </Box>
        ) : (
          <Box h="10" bg="bg.subtle" rounded="l1" opacity="0.6" />
        )}
      </Box>

      <Text fontSize="2xs" mt="2" minH="4" color={cursor !== null ? "fg" : "fg.muted"} aria-live="polite">
        {error ??
          now ??
          result ??
          (plan
            ? plan.overlap
              ? "Red outline: the agent and the caller talking over each other."
              : `The agent answers ${ms(plan.agentStart - plan.turnEnd)} after the caller stops.`
            : "Loading the voices…")}
      </Text>
    </Box>
  );
});
