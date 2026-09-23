"use client";

import {
  Box,
  Button,
  Flex,
  HStack,
  SimpleGrid,
  Text,
  Wrap,
} from "@chakra-ui/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BudgetChart,
  BudgetTable,
  Legend,
  type Row,
} from "./Budget";
import { CallPlayer, type CallPlayerHandle, type CallResult } from "./CallPlayer";
import { Choice, Knob } from "./Controls";
import { Measure } from "./Measure";
import {
  type AsrMode,
  type BargeParams,
  type Params,
  type TtsTrigger,
  BARGE_STAGES,
  BARGE_THRESHOLD,
  DEFAULT_BARGE,
  DEFAULT_PARAMS,
  PRESETS,
  TRIGGER_LABEL,
  bargeIn,
  bargeTotal,
  budget,
  dominant,
  ms,
  axis,
  total,
} from "./model";
import { seriesVar, vizVars } from "./palette";
import {
  Tour,
  TourButton,
  type TourStep,
  clearTourHash,
  tourFromHash,
  tourSpotlight,
} from "../shared/Tour";
import { useTween } from "../shared/useTween";

export type VoiceLatencyProps = {
  /**
   * Directory serving the voice clips in src/voice-latency/assets, with a
   * trailing slash. Without it the demo works as before, minus the call
   * player and the guided tour, which is built around hearing the calls.
   */
  clipsUrl?: string;
};

/**
 * An interactive budget for the latency a caller actually feels.
 *
 * The premise is that "voice agent latency" is almost never one number from
 * one model: it is seven of them in series, and the largest is usually the
 * silence you make the user sit through before you will admit they have
 * finished talking. The chart puts a configuration next to four reference
 * builds on a shared axis, so the cost of each architectural choice is a
 * length rather than an assertion.
 */
export default function VoiceLatency({ clipsUrl }: VoiceLatencyProps = {}) {
  const [params, setParams] = useState<Params>(DEFAULT_PARAMS);
  const [barge, setBarge] = useState<BargeParams>(DEFAULT_BARGE);
  // Collapsed on arrival: interruptions are a second question, and the page
  // should answer the first one before asking it. The headline number stays
  // visible so the reader knows there is something behind the button.
  const [showBarge, setShowBarge] = useState(false);
  const [showTable, setShowTable] = useState(false);

  // Guided tour: the current step, or null when exploring freely.
  const [tourIndex, setTourIndex] = useState<number | null>(null);
  const tourRef = useRef<number | null>(null);
  tourRef.current = tourIndex;
  // Calls heard during each tour step, so the narration can respond to them.
  const [heard, setHeard] = useState<Record<number, CallResult>>({});
  const root = useRef<HTMLDivElement>(null);
  const call = useRef<CallPlayerHandle>(null);

  const patch = (next: Partial<Params>) =>
    setParams((prev) => ({ ...prev, ...next }));

  const mine = useMemo(() => budget(params), [params]);
  const rows: Row[] = useMemo(
    () => [
      { id: "mine", name: "Your configuration", budget: mine, own: true },
      ...PRESETS.map((preset) => ({
        id: preset.id,
        name: preset.name,
        budget: budget(preset.params),
      })),
    ],
    [mine],
  );

  const scale = useMemo(
    () => axis(Math.max(...rows.map((row) => total(row.budget))) * 1.02),
    [rows],
  );

  const sum = total(mine);
  const shownSum = useTween(sum);
  const worst = dominant(mine);
  const share = Math.round((mine[worst.id] / sum) * 100);

  // The playout buffer is one number that shows up in both budgets: it is
  // latency on the way in and dead air on the way out.
  const bargeBudget = bargeIn(
    { ...barge, playoutMs: params.playoutMs },
    params.rttMs,
  );
  const bargeSum = bargeTotal(bargeBudget);
  const bargeMax = axis(Math.max(bargeSum, 400)).max;

  const onPlayed = useCallback((result: CallResult) => {
    const at = tourRef.current;
    if (at !== null) setHeard((prev) => ({ ...prev, [at]: result }));
  }, []);

  /** Slide the endpoint slider to a value, so "Show me" is visibly a drag. */
  const slideEndpoint = (target: number) => {
    const from = params.endpointMs;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      patch({ endpointMs: target });
      return;
    }
    const started = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - started) / 800);
      const eased = 1 - (1 - t) ** 3;
      patch({ endpointMs: Math.round((from + (target - from) * eased) / 10) * 10 });
      if (t < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };

  /** Switch to a reference build and play a call through it. */
  const hearPreset = (id: string) => {
    const preset = PRESETS.find((p) => p.id === id);
    if (!preset) return;
    setParams(preset.params);
    call.current?.play({ scenario: "question", budget: budget(preset.params) });
  };

  const pauseStep = 4;
  const steps: TourStep[] = [
    {
      target: "headline",
      say: "This is the gap a caller feels: from their last word to the agent's first. Seven costs add up to it, and only one of them is the model thinking. Let's hear it.",
    },
    {
      target: "call",
      say: "First, the build most teams start with: wait for silence, upload, transcribe, think, then speak.",
      showLabel: "Play it",
      show: () => hearPreset("batch"),
      done: !!heard[1],
      after: "Over three seconds of dead air. On a phone call that sounds like the line has dropped.",
    },
    {
      target: "call",
      say: "The same parts, streamed: transcription runs while the caller talks, and speech starts on the first clause.",
      showLabel: "Play it",
      show: () => hearPreset("streaming"),
      done: !!heard[2],
      after: "About half the wait. The biggest piece left is endpointing: the agent waiting to be sure the caller has finished.",
    },
    {
      target: "endpoint",
      say: "So make the agent less patient. Drag Endpointing down to 200 ms.",
      showLabel: "Drag it for me",
      show: () => slideEndpoint(200),
      done: params.endpointMs <= 250,
      after: "A snappier agent, on paper. Now hear it with a caller who pauses.",
    },
    {
      target: "call",
      say: "This caller reads out an account number and takes a breath halfway through.",
      showLabel: "Play it",
      show: () => call.current?.play({ scenario: "pause", budget: mine }),
      done: !!heard[pauseStep],
      after: heard[pauseStep]?.cutIn
        ? "The agent took the breath for the end of the turn and answered half a number. That is why endpointing cannot just be shortened: the fix is a detector that knows when a sentence is finished, not just when it is quiet."
        : "With this endpoint the agent waited out the breath. Drag Endpointing below 700 ms and play it again to hear it jump in.",
    },
    {
      target: "call",
      say: "Speech-to-speech drops the transcript stage altogether: one model, audio in and audio out.",
      showLabel: "Play it",
      show: () => hearPreset("realtime"),
      done: !!heard[5],
      after: "About a second. Faster — and endpointing is still the biggest line.",
    },
    {
      target: "barge",
      say: "The other half of a conversation: when the caller interrupts, how long does the agent keep talking?",
      showLabel: "Show the breakdown",
      show: () => setShowBarge(true),
      done: showBarge,
      after: "The playout buffer that smooths the agent's speech is the same audio still playing after the caller starts. That is the whole tour. Everything here is yours to change.",
    },
  ];

  const startTour = (at = 0) => {
    setHeard({});
    call.current?.preload();
    setTourIndex(Math.max(0, Math.min(steps.length - 1, at)));
  };
  const closeTour = () => {
    setTourIndex(null);
    clearTourHash();
  };

  // A #tour-N link opens the tour at that step.
  useEffect(() => {
    if (!clipsUrl) return;
    const at = tourFromHash();
    if (at !== null) setTourIndex(Math.max(0, Math.min(6, at)));
  }, [clipsUrl]);

  return (
    <Box
      ref={root}
      css={{ ...vizVars, ...tourSpotlight(tourIndex !== null ? steps[tourIndex].target : null) }}
    >
      {/* Hero figure: the one number the whole page is about. */}
      <Flex align="baseline" gap="3" wrap="wrap" data-tour="headline">
        <Text
          fontSize={{ base: "4xl", sm: "5xl" }}
          fontWeight="bold"
          lineHeight="1"
          color="colorPalette.fg"
        >
          {ms(shownSum)}
        </Text>
        <Box>
          <Text fontSize="xs" fontWeight="bold">
            Response latency
          </Text>
          <Text fontSize="2xs" color="fg.muted">
            last word in to first word out
          </Text>
        </Box>
        {clipsUrl && tourIndex === null && (
          <Box ms="auto">
            <TourButton id="voice-latency" onStart={() => startTour()} />
          </Box>
        )}
      </Flex>
      <Text fontSize="2xs" color="fg.muted" mt="2">
        Biggest line: <Text as="span" color="fg">{worst.label}</Text>, {share}%
        of the budget.
      </Text>

      {/* Orientation. The component carries this itself rather than leaving it
          to the host page: read standalone, the chart gives no clue what the
          bars are or which one the reader is allowed to change. */}
      <Box mt="5" ps="3" borderStartWidth="2px" borderColor="colorPalette.solid">
        <Text fontSize="2xs" color="fg.muted" lineHeight="tall">
          Every bar is one voice pipeline, cut into the seven costs that sit
          between the user&rsquo;s last word and the agent&rsquo;s first.{" "}
          <Text as="span" color="fg">
            The top bar is yours to change
          </Text>
          ; the four under it are fixed reference builds on the same axis.
          Hover or tab to any segment for what it is and why it costs what it
          does.
        </Text>
        <Text fontSize="2xs" color="fg.muted" mt="2" lineHeight="tall">
          Start by dragging{" "}
          <Text as="span" color="fg">
            Endpointing
          </Text>
          . It is pure waiting &mdash; no compute, nothing you can buy your way
          out of &mdash; and on most builds it is the largest line in the
          budget.
        </Text>
      </Box>

      {/* Presets */}
      <Wrap gap="2" mt="5" data-tour="presets">
        {PRESETS.map((preset) => (
          <Button
            key={preset.id}
            size="2xs"
            variant="outline"
            onClick={() => setParams(preset.params)}
          >
            {preset.name}
          </Button>
        ))}
        <Button
          size="2xs"
          variant="ghost"
          onClick={() => setParams(DEFAULT_PARAMS)}
        >
          Reset
        </Button>
      </Wrap>

      <Box data-tour="chart">
        <BudgetChart rows={rows} max={scale.max} step={scale.step} />
        <Legend budget={mine} />
      </Box>

      {clipsUrl && (
        <Box data-tour="call" mt="6" pt="5" borderTopWidth="1px" borderColor="border">
          <CallPlayer ref={call} budget={mine} clipsUrl={clipsUrl} onPlayed={onPlayed} />
        </Box>
      )}

      <HStack mt="3" gap="2">
        <Button
          size="2xs"
          variant="ghost"
          onClick={() => setShowTable((v) => !v)}
          aria-expanded={showTable}
        >
          {showTable ? "Hide table" : "Table view"}
        </Button>
      </HStack>
      {showTable && <BudgetTable rows={rows} />}

      {/* Controls */}
      <SimpleGrid
        columns={{ base: 1, sm: 2, md: 3 }}
        gap="4"
        mt="6"
        pt="5"
        borderTopWidth="1px"
        borderColor="border"
      >
        <Box data-tour="endpoint">
          <Knob
            label="Endpointing"
            value={params.endpointMs}
            onChange={(endpointMs) => patch({ endpointMs })}
            min={100}
            max={1200}
            step={10}
            hint="Silence before the turn is called finished."
          />
        </Box>
        <Knob
          label="Network round trip"
          value={params.rttMs}
          onChange={(rttMs) => patch({ rttMs })}
          min={0}
          max={300}
          step={5}
          hint="0 means nothing leaves the device."
        />
        <Choice<AsrMode>
          label="ASR"
          value={params.asrMode}
          onChange={(asrMode) => patch({ asrMode })}
          options={[
            { value: "streaming", label: "Streaming" },
            { value: "batch", label: "Batch" },
          ]}
          hint="Batch pays for the whole utterance after it ends."
        />
        <Knob
          label={params.asrMode === "streaming" ? "ASR finalize" : "Utterance length"}
          value={
            params.asrMode === "streaming" ? params.asrFinalMs : params.utteranceSec
          }
          onChange={(value) =>
            params.asrMode === "streaming"
              ? patch({ asrFinalMs: value })
              : patch({ utteranceSec: value })
          }
          min={params.asrMode === "streaming" ? 20 : 1}
          max={params.asrMode === "streaming" ? 400 : 20}
          step={params.asrMode === "streaming" ? 5 : 1}
          unit={params.asrMode === "streaming" ? "ms" : "s"}
          hint={
            params.asrMode === "streaming"
              ? "Promoting the last partial to a final."
              : `Transcribed at ${Math.round(1 / params.asrRtf)}x real time.`
          }
        />
        <Knob
          label="LLM first token"
          value={params.ttftMs}
          onChange={(ttftMs) => patch({ ttftMs })}
          min={80}
          max={2000}
          step={10}
          hint="Prefill and queueing, before any output."
        />
        <Knob
          label="Generation speed"
          value={params.tokensPerSec}
          onChange={(tokensPerSec) => patch({ tokensPerSec })}
          min={5}
          max={200}
          step={5}
          unit="tok/s"
          hint="Only the first few tokens are on the critical path."
        />
        <Choice<TtsTrigger>
          label="TTS starts on"
          value={params.ttsTrigger}
          onChange={(ttsTrigger) => patch({ ttsTrigger })}
          options={(Object.keys(TRIGGER_LABEL) as TtsTrigger[]).map((value) => ({
            value,
            label: TRIGGER_LABEL[value],
          }))}
          hint="How much text the synthesiser insists on first."
        />
        <Knob
          label="TTS first audio"
          value={params.ttsFirstAudioMs}
          onChange={(ttsFirstAudioMs) => patch({ ttsFirstAudioMs })}
          min={30}
          max={800}
          step={10}
          hint="Text in to first audio chunk out."
        />
        <Knob
          label="Playout buffer"
          value={params.playoutMs}
          onChange={(playoutMs) => patch({ playoutMs })}
          min={0}
          max={400}
          step={10}
          hint="Smoothness on the way in, dead air on the way out."
        />
      </SimpleGrid>

      {/* Barge-in */}
      <Box mt="6" pt="5" borderTopWidth="1px" borderColor="border" data-tour="barge">
        <Flex justify="space-between" align="baseline" gap="4" wrap="wrap">
          <Box>
            <Text fontSize="xs" fontWeight="bold">
              Barge-in
            </Text>
            <Text fontSize="2xs" color="fg.muted" mt="1" maxW="md" lineHeight="short">
              The other latency nobody budgets for: how long the agent keeps
              talking after the user starts. The playout buffer above is the
              same number, working against you in the opposite direction.
            </Text>
          </Box>
          <Text
            fontSize="2xl"
            fontWeight="bold"
            lineHeight="1"
            color={bargeSum > BARGE_THRESHOLD ? "orange.fg" : "colorPalette.fg"}
          >
            {ms(bargeSum)}
          </Text>
        </Flex>
        <Button
          size="2xs"
          variant="outline"
          mt="3"
          onClick={() => setShowBarge((open) => !open)}
          aria-expanded={showBarge}
        >
          {showBarge ? "Hide the breakdown" : "Show the breakdown"}
        </Button>

        {showBarge && (
          <>

            {/* Three segments on their own axis, in the first three colour slots
                — the only trio that clears colour-vision separation on every pair
                in both modes, which matters here because the middle segment
                collapses to zero whenever the VAD runs on the device. The tie back
                to the playout buffer above is carried by the label, not the fill. */}
            {/* Caption strip, so the marker below is labelled without writing on
                the bar. */}
            <Box position="relative" h="4" mt="4" aria-hidden>
              <Text
                position="absolute"
                insetStart={`${(BARGE_THRESHOLD / bargeMax) * 100}%`}
                ms="1"
                fontSize="9px"
                color="fg.muted"
                whiteSpace="nowrap"
              >
                starts to feel rude
              </Text>
            </Box>

            <Box position="relative" h="18px">
              {(() => {
                const values = BARGE_STAGES.map((stage) => bargeBudget[stage.id]);
                return BARGE_STAGES.map((stage, i) => {
                  const value = values[i];
                  const start = values.slice(0, i).reduce((a, b) => a + b, 0);
                  if (value <= 0) return null;
                  return (
                    <Box
                      key={stage.id}
                      position="absolute"
                      top="0"
                      bottom="0"
                      insetStart={`${(start / bargeMax) * 100}%`}
                      width={`max(1px, calc(${(value / bargeMax) * 100}% - 2px))`}
                      bg={seriesVar(i)}
                      borderEndRadius={
                        start + value >= bargeSum - 0.01 ? "4px" : "0"
                      }
                      title={`${stage.label}: ${ms(value)}`}
                    />
                  );
                });
              })()}
              {/* Drawn over the segments for the same reason as the response
                  chart's marker: behind them it vanishes on exactly the
                  configurations worth flagging. */}
              <Box
                position="absolute"
                top="0"
                bottom="0"
                insetStart={`${(BARGE_THRESHOLD / bargeMax) * 100}%`}
                borderStartWidth="1px"
                borderStyle="dashed"
                borderColor="fg"
                opacity="0.55"
                pointerEvents="none"
                aria-hidden
              />
            </Box>
            <Wrap columnGap="4" rowGap="1.5" mt="2">
              {BARGE_STAGES.map((stage, i) => (
                <HStack key={stage.id} gap="1.5">
                  <Box
                    boxSize="2.5"
                    rounded="2px"
                    bg={seriesVar(i)}
                    flexShrink="0"
                  />
                  <Text fontSize="2xs" color="fg.muted">
                    {stage.label}
                  </Text>
                  <Text fontSize="2xs" fontVariantNumeric="tabular-nums">
                    {ms(bargeBudget[stage.id])}
                  </Text>
                </HStack>
              ))}
            </Wrap>

            <SimpleGrid columns={{ base: 1, sm: 2, md: 3 }} gap="4" mt="4">
              <Knob
                label="Onset detect"
                value={barge.onsetMs}
                onChange={(onsetMs) => setBarge((b) => ({ ...b, onsetMs }))}
                min={20}
                max={400}
                step={10}
                hint="Lower is twitchier: a cough cuts the agent off."
              />
              <Choice<BargeParams["vadAt"]>
                label="VAD runs"
                value={barge.vadAt}
                onChange={(vadAt) => setBarge((b) => ({ ...b, vadAt }))}
                options={[
                  { value: "client", label: "On device" },
                  { value: "server", label: "On server" },
                ]}
                hint="Server-side VAD pays a round trip to cancel."
              />
              <Choice<"yes" | "no">
                label="Playout buffer"
                value={barge.flushable ? "yes" : "no"}
                onChange={(v) => setBarge((b) => ({ ...b, flushable: v === "yes" }))}
                options={[
                  { value: "no", label: "Plays out" },
                  { value: "yes", label: "Flushable" },
                ]}
                hint="Dropping queued audio is what makes a cut-off feel instant."
              />
            </SimpleGrid>
          </>
        )}
      </Box>

      <Box data-tour="measure">
        <Measure endpointMs={params.endpointMs} onApply={patch} />
      </Box>

      <Text fontSize="9px" color="fg.muted" mt="5" lineHeight="short">
        Defaults are plausible starting points for each architecture, not
        measurements of any particular vendor. The three stages under &ldquo;measure
        on this device&rdquo; are real numbers from your machine; the rest are yours
        to set.
      </Text>

      {tourIndex !== null && (
        <Tour
          steps={steps}
          index={tourIndex}
          onIndex={setTourIndex}
          onClose={closeTour}
          root={root.current}
        />
      )}
    </Box>
  );
}
