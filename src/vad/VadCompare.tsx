"use client";

import {
  Badge,
  Box,
  Button,
  Flex,
  HStack,
  Text,
  Wrap,
} from "@chakra-ui/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { FRAME, SAMPLE_RATE, SileroVad } from "./silero";
import { energyVad, frameEnergyDb, noiseFloorDb } from "./energy";
import { injectBurst, loadAudioFromFile, loadAudioFromUrl, playSignal } from "./audio";
import { type MicCapture, isSilent, startMicCapture } from "../shared/audio";
import { seriesVar, vizVars } from "../shared/palette";
import {
  Tour,
  TourButton,
  type TourStep,
  clearTourHash,
  tourFromHash,
  tourSpotlight,
} from "../shared/Tour";
import { useTween } from "../shared/useTween";

/** Frames the injected burst spans: 0.15 s at 32 ms a frame. */
const BURST_FRAMES = Math.ceil((0.15 * SAMPLE_RATE) / FRAME);

/**
 * What a reader actually pays, stated before they are asked to pay it.
 *
 * The model is 2.3 MB. The runtime that executes it is 13.6 MB of
 * WebAssembly, which compresses to roughly a third of that. Quoting only the
 * model would be the more flattering number and the wrong one — and the gap
 * is itself worth noticing about on-device inference in a browser.
 */
const DOWNLOAD_NOTE =
  "2.3 MB of model plus 13.6 MB of WebAssembly runtime — around 6 MB over the wire, fetched once.";

export type VadCompareProps = {
  /** Where the host serves silero_vad.onnx. */
  modelUrl: string;
  /** Where the host serves the sample clip. */
  sampleUrl: string;
  /**
   * Where the host serves onnxruntime's runtime files: a directory prefix, or
   * explicit URLs when a dev server will not serve the .mjs untouched.
   */
  wasmPaths?: string | { wasm?: string; mjs?: string };
};

type Analysis = {
  label: string;
  signal: Float32Array;
  energyDb: Float32Array;
  floorDb: number;
  /** One probability per frame, once the model has run. */
  probs: Float32Array | null;
  burstAt: number | null;
  /** Wall-clock milliseconds the model took over this signal. */
  inferenceMs: number | null;
};

export default function VadCompare({ modelUrl, sampleUrl, wasmPaths }: VadCompareProps) {
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [margin, setMargin] = useState(12);
  const [threshold, setThreshold] = useState(0.5);
  const [modelState, setModelState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Seconds captured and input level while recording, or null when not.
  const [recording, setRecording] = useState<{ seconds: number; rms: number } | null>(null);

  // Seconds elapsed while playing, or null when stopped. Drives the playhead.
  const [playhead, setPlayhead] = useState<number | null>(null);
  const stopPlayback = useRef<(() => void) | null>(null);

  const model = useRef<SileroVad | null>(null);
  const capture = useRef<MicCapture | null>(null);

  // The close-up's own playback: just the second around the burst.
  const [slamPlayhead, setSlamPlayhead] = useState<number | null>(null);
  const stopSlam = useRef<(() => void) | null>(null);

  // Guided tour: the current step, or null when exploring freely, and what
  // the reader has listened to during each step.
  const [tourIndex, setTourIndex] = useState<number | null>(null);
  const tourRef = useRef<number | null>(null);
  tourRef.current = tourIndex;
  const [listened, setListened] = useState<Record<number, boolean>>({});
  const markListened = () => {
    const at = tourRef.current;
    if (at !== null) setListened((prev) => ({ ...prev, [at]: true }));
  };
  const root = useRef<HTMLDivElement>(null);

  /** Run the model over a signal, if it is loaded. */
  const runModel = useCallback(async (signal: Float32Array) => {
    if (!model.current) return { probs: null, inferenceMs: null };
    const started = performance.now();
    const probs = await model.current.processAll(signal);
    return { probs, inferenceMs: performance.now() - started };
  }, []);

  const analyse = useCallback(
    async (label: string, signal: Float32Array, burstAt: number | null = null) => {
      stopPlayback.current?.();
      stopPlayback.current = null;
      stopSlam.current?.();
      stopSlam.current = null;
      setPlayhead(null);
      setBusy(true);
      const energyDb = frameEnergyDb(signal);
      const { probs, inferenceMs } = await runModel(signal);
      setAnalysis({
        label,
        signal,
        energyDb,
        floorDb: noiseFloorDb(energyDb),
        probs,
        burstAt,
        inferenceMs,
      });
      setBusy(false);
    },
    [runModel],
  );

  const loadSample = useCallback(async () => {
    setNote(null);
    setBusy(true);
    try {
      const signal = await loadAudioFromUrl(sampleUrl);
      await analyse("Sample clip", signal);
    } catch {
      setNote("The sample clip could not be loaded.");
      setBusy(false);
    }
  }, [analyse, sampleUrl]);

  useEffect(() => {
    void loadSample();
    // Once, on mount: the energy detector costs nothing, so there is something
    // to look at before anyone is asked to download a model.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadModel = useCallback(async () => {
    setModelState("loading");
    try {
      model.current = await SileroVad.load({ modelUrl, wasmPaths });
      setModelState("ready");
      if (analysis) await analyse(analysis.label, analysis.signal, analysis.burstAt);
    } catch (error) {
      setModelState("error");
      setNote(error instanceof Error ? error.message : "The model could not be loaded.");
    }
  }, [analyse, analysis, modelUrl, wasmPaths]);

  const addBurst = useCallback(async () => {
    if (!analysis) return;
    const { signal, atSeconds } = injectBurst(analysis.signal, analysis.energyDb, FRAME);
    await analyse(`${analysis.label} + noise burst`, signal, atSeconds);
  }, [analyse, analysis]);

  const stopRecording = useCallback(async () => {
    const held = capture.current;
    if (!held) return;
    capture.current = null;
    setRecording(null);
    const signal = await held.stop();
    if (signal.length < FRAME) {
      setNote(
        "Nothing came through from the microphone. Check which input the browser is using, then try again.",
      );
      return;
    }
    setNote(
      isSilent(signal)
        ? "The microphone delivered only silence — it may be muted, or the wrong input is selected."
        : null,
    );
    await analyse("Your recording", signal);
  }, [analyse]);

  // Not async until after startMicCapture: the audio context has to be created
  // inside the click, before anything is awaited.
  const toggleRecording = useCallback(() => {
    if (capture.current) {
      void stopRecording();
      return;
    }
    stopPlayback.current?.();
    stopPlayback.current = null;
    const held = startMicCapture(SAMPLE_RATE, (seconds, rms) => {
      if (capture.current === held) setRecording({ seconds, rms });
    });
    capture.current = held;
    setRecording({ seconds: 0, rms: 0 });
    setNote("Waiting for the microphone…");
    held.ready.then(
      () => {
        if (capture.current === held) {
          setNote("Recording. Say something, knock on the desk, then press Stop.");
        }
      },
      (error: Error) => {
        if (capture.current !== held) return;
        capture.current = null;
        setRecording(null);
        setNote(`${error.message} The sample clip needs no permission.`);
      },
    );
  }, [stopRecording]);

  useEffect(
    () => () => {
      capture.current?.cancel();
      stopPlayback.current?.();
    },
    [],
  );

  const togglePlayback = useCallback(() => {
    if (stopPlayback.current) {
      stopPlayback.current();
      stopPlayback.current = null;
      return;
    }
    if (!analysis) return;
    setNote(null);
    stopSlam.current?.();
    stopPlayback.current = playSignal(
      analysis.signal,
      SAMPLE_RATE,
      (seconds) => {
        setPlayhead(seconds);
        if (seconds === null) {
          stopPlayback.current = null;
          markListened();
        }
      },
      setNote,
    );
  }, [analysis]);

  async function loadFile(file: File) {
    setNote(null);
    setBusy(true);
    try {
      await analyse(file.name, await loadAudioFromFile(file));
    } catch {
      setNote("That file could not be decoded as audio.");
      setBusy(false);
    }
  }

  // Decisions, recomputed from the stored signals whenever a threshold moves —
  // no re-inference, which is why the sliders are instant.
  const energy = analysis ? energyVad(analysis.energyDb, margin) : [];
  const neural = analysis?.probs ? Array.from(analysis.probs, (p) => p > threshold) : null;
  const frames = energy.length;
  const disagreements = neural
    ? energy.reduce((n, e, i) => n + (e !== neural[i] ? 1 : 0), 0)
    : 0;
  const seconds = analysis ? analysis.signal.length / SAMPLE_RATE : 0;
  const disagreePct = neural ? (disagreements / Math.max(1, frames)) * 100 : 0;
  const shownPct = useTween(disagreePct);

  // The burst, in frames, and a window around it for the close-up.
  const burstFrame =
    analysis?.burstAt != null ? Math.round((analysis.burstAt * SAMPLE_RATE) / FRAME) : null;
  const burstRange =
    burstFrame !== null
      ? Array.from({ length: BURST_FRAMES }, (_, i) => burstFrame + i).filter((i) => i < frames)
      : [];
  const energyOnBurst = burstRange.filter((i) => energy[i]).length;
  const neuralOnBurst = neural ? burstRange.filter((i) => neural[i]).length : null;
  const closeFrom = burstFrame !== null ? Math.max(0, burstFrame - 12) : 0;
  const closeTo = burstFrame !== null ? Math.min(frames, burstFrame + 18) : 0;

  const playSlam = () => {
    if (stopSlam.current) {
      stopSlam.current();
      return;
    }
    if (!analysis || burstFrame === null) return;
    stopPlayback.current?.();
    stopSlam.current = playSignal(
      analysis.signal.subarray(closeFrom * FRAME, closeTo * FRAME),
      SAMPLE_RATE,
      (at) => {
        setSlamPlayhead(at);
        if (at === null) {
          stopSlam.current = null;
          markListened();
        }
      },
      setNote,
    );
  };

  // Speech the energy detector catches at the current margin against the
  // default 12 dB, burst frames excluded: the cost of tuning out the slam.
  const speechFramesAt = (m: number) =>
    analysis
      ? energyVad(analysis.energyDb, m).filter((on, i) => on && !burstRange.includes(i)).length
      : 0;
  const speechLostPct = analysis
    ? Math.round((1 - speechFramesAt(margin) / Math.max(1, speechFramesAt(12))) * 100)
    : 0;

  /** Slide the margin knob, so "Show me" is visibly a turn of the dial. */
  const slideMargin = (target: number) => {
    const from = margin;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      setMargin(target);
      return;
    }
    const started = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - started) / 900);
      setMargin(Math.round(from + (target - from) * (1 - (1 - t) ** 3)));
      if (t < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };

  const steps: TourStep[] = [
    {
      target: "verdict",
      say: "Two detectors are listening to the same clip. One goes by loudness; the other is a small neural network running in your browser. This tour finds where they disagree, and why it matters.",
    },
    {
      target: "lanes",
      say: "Listen first. The playhead shows which detector thinks someone is speaking at each moment.",
      showLabel: "Listen",
      show: () => {
        if (!stopPlayback.current) togglePlayback();
      },
      done: !!listened[1],
      after: "The loudness detector's lane (Energy detector) switches off in the short gaps between words. Every one of those gaps is a moment it believes the speaker has finished.",
    },
    {
      target: "inputs",
      say: "Now drop a door slam into a pause in the speech: loud, sudden, and nothing like a voice.",
      showLabel: "Add the slam",
      show: () => void addBurst(),
      done: burstFrame !== null,
      after: `The loudness detector calls it speech: ${energyOnBurst} of the slam's ${burstRange.length} frames. The close-up below shows it.`,
    },
    {
      target: "closeup",
      say: "Here is the slam up close. Play just that second.",
      showLabel: "Play the slam",
      show: playSlam,
      done: !!listened[3],
      after: "To a loudness detector, loud is loud. It has no way to know that a voice sounds different from a door.",
    },
    {
      target: "closeup",
      say: "Now ask the neural model. It is about 6 MB, downloaded once, and runs here in your browser.",
      showLabel: "Load the model",
      show: () => void loadModel(),
      done: modelState === "ready" && neuralOnBurst !== null,
      after:
        neuralOnBurst === 0
          ? "Silero did not fire on the slam at all. It learned what speech sounds like, not how loud it is."
          : `Silero fired on ${neuralOnBurst} of the slam's frames, against ${energyOnBurst} for loudness.`,
    },
    {
      target: "margin",
      say: "Can the loudness detector be tuned to ignore the slam? Its only setting is how far above the room noise to trigger. Turn it all the way up.",
      showLabel: "Turn it up for me",
      show: () => slideMargin(30),
      done: margin >= 28,
      after:
        energyOnBurst > 0
          ? `At ${margin} dB it still fires on ${energyOnBurst} of the slam's frames, and it now misses ${speechLostPct}% of the speech it caught at 12 dB. Loudness cannot tell a door from a voice, which is why voice agents use a model for this.`
          : `At ${margin} dB it finally ignores the slam, and misses ${speechLostPct}% of the speech it caught at 12 dB. Loudness cannot tell a door from a voice, which is why voice agents use a model for this.`,
    },
    {
      target: "inputs",
      say: "Try it on your own voice: record a sentence with a pause in it, then knock on the desk.",
      showLabel: recording ? "■ Stop and analyse" : "● Record",
      show: toggleRecording,
      done: analysis?.label === "Your recording",
      after: "Compare the lanes on your own recording. Everything here is yours to change.",
    },
  ];

  const startTour = () => {
    setListened({});
    setTourIndex(0);
  };
  const closeTour = () => {
    setTourIndex(null);
    clearTourHash();
  };

  // A #tour-N link opens the tour at that step.
  useEffect(() => {
    const at = tourFromHash();
    if (at !== null) setTourIndex(Math.max(0, Math.min(6, at)));
  }, []);

  return (
    <Box
      ref={root}
      css={{ ...vizVars, ...tourSpotlight(tourIndex !== null ? steps[tourIndex] : null) }}
    >
      {/* Verdict */}
      <Flex align="baseline" gap="3" wrap="wrap" data-tour="verdict">
        <Text
          fontSize={{ base: "4xl", sm: "5xl" }}
          fontWeight="bold"
          lineHeight="1"
          color={neural ? "colorPalette.fg" : "fg.muted"}
        >
          {neural ? `${Math.round(shownPct)}%` : "—"}
        </Text>
        <Box>
          <Text fontSize="xs" fontWeight="bold">
            of frames they disagree on
          </Text>
          <Text fontSize="2xs" color="fg.muted">
            {neural
              ? `${frames} frames over ${seconds.toFixed(1)}s`
              : `load the model to compare · ${frames} frames`}
          </Text>
        </Box>
        <HStack ms="auto" gap="2">
          {analysis?.inferenceMs != null && (
            <Badge size="sm" variant="subtle">
              {(seconds / (analysis.inferenceMs / 1000)).toFixed(0)}× real time
            </Badge>
          )}
          {tourIndex === null && <TourButton id="vad" onStart={startTour} />}
        </HStack>
      </Flex>

      <Box mt="5" ps="3" borderStartWidth="2px" borderColor="colorPalette.solid">
        <Text fontSize="2xs" color="fg.muted" lineHeight="tall">
          Two voice-activity detectors on the same audio. One measures loudness;
          the other is a neural model running in WebAssembly. They agree most of
          the time — the question is what happens where they do not.
        </Text>
        <Text fontSize="2xs" color="fg.muted" mt="2" lineHeight="tall">
          Press{" "}
          <Text as="span" color="fg">
            Listen
          </Text>{" "}
          to hear the clip while a playhead runs across the lanes. Then press{" "}
          <Text as="span" color="fg">
            Add a noise burst
          </Text>{" "}
          to drop a door-slam into the quietest part of the clip. Energy has no
          way to tell it from speech. That is the whole argument, and it is the
          reason endpointing — the largest line in the latency budget — cannot
          simply be tuned shorter.
        </Text>
      </Box>

      {/* Model gate */}
      {modelState !== "ready" && (
        <Flex
          mt="5"
          p="3"
          gap="3"
          align="center"
          wrap="wrap"
          borderWidth="1px"
          borderColor="border"
          rounded="l2"
        >
          <Button
            size="2xs"
            onClick={() => void loadModel()}
            loading={modelState === "loading"}
          >
            Load the model
          </Button>
          <Text fontSize="2xs" color="fg.muted">
            {DOWNLOAD_NOTE} Nothing is uploaded — the audio stays in the page.
          </Text>
        </Flex>
      )}

      {/* Inputs */}
      <Wrap gap="2" mt="5" align="center" data-tour="inputs">
        <Button
          size="2xs"
          variant="solid"
          onClick={togglePlayback}
          disabled={!analysis || recording !== null}
          minW="20"
        >
          {playhead === null ? "▶ Listen" : "■ Stop"}
        </Button>
        <Button size="2xs" variant="outline" onClick={() => void addBurst()} disabled={!analysis}>
          Add a noise burst
        </Button>
        <Button
          size="2xs"
          variant={recording ? "solid" : "outline"}
          colorPalette={recording ? "red" : undefined}
          onClick={toggleRecording}
        >
          {recording ? `■ Stop and analyse · ${recording.seconds.toFixed(1)}s` : "● Record"}
        </Button>
        <Button size="2xs" variant="outline" asChild>
          <label>
            Upload audio
            <input
              type="file"
              accept="audio/*"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0];
                // Cleared so choosing the same file again still fires.
                event.target.value = "";
                if (file) void loadFile(file);
              }}
            />
          </label>
        </Button>
        <Button size="2xs" variant="ghost" onClick={() => void loadSample()} loading={busy}>
          Reset to sample
        </Button>
      </Wrap>
      <Flex mt="2" gap="2" align="center" minH="4">
        {recording ? (
          <>
            <Box w="24" h="1.5" rounded="full" bg="bg.subtle" overflow="hidden" flexShrink="0">
              <Box
                h="full"
                bg="red.solid"
                width={`${Math.min(100, Math.max(0, (20 * Math.log10(recording.rms + 1e-9) + 60) / 50) * 100)}%`}
                transition="width 80ms linear"
              />
            </Box>
            <Text fontSize="2xs" color="fg.muted">
              input level
            </Text>
          </>
        ) : (
          analysis && (
            <Text fontSize="2xs" color="fg.muted">
              Now showing: {analysis.label} · {seconds.toFixed(1)}s
            </Text>
          )
        )}
      </Flex>
      {note && (
        <Text fontSize="2xs" color="fg.muted" mt="2">
          {note}
        </Text>
      )}

      {/* Lanes */}
      {analysis && frames > 0 && (
        <Box mt="6" data-tour="lanes">
          <Lane
            title="Frame energy"
            caption={`noise floor ${analysis.floorDb.toFixed(0)} dB, threshold ${(analysis.floorDb + margin).toFixed(0)} dB`}
          >
            <EnergyTrace energyDb={analysis.energyDb} floorDb={analysis.floorDb} margin={margin} />
          </Lane>

          <Lane title="Energy detector" caption={`${energy.filter(Boolean).length}/${frames} frames`}>
            <Decisions
              decisions={energy}
              slot={0}
              burstAt={analysis.burstAt}
              seconds={seconds}
              playhead={playhead}
            />
          </Lane>

          <Lane
            title="Silero (neural)"
            caption={
              neural ? `${neural.filter(Boolean).length}/${frames} frames` : "model not loaded"
            }
          >
            {neural ? (
              <Decisions
                decisions={neural}
                slot={1}
                burstAt={analysis.burstAt}
                seconds={seconds}
                playhead={playhead}
              />
            ) : (
              <Box h="5" rounded="l1" bg="bg.subtle" />
            )}
          </Lane>

          {neural && (
            <Lane title="Disagreement" caption={`${disagreements} frames`}>
              <Decisions
                decisions={energy.map((e, i) => e !== neural[i])}
                slot={6}
                burstAt={analysis.burstAt}
                seconds={seconds}
                playhead={playhead}
              />
            </Lane>
          )}

          <Wrap columnGap="4" rowGap="1.5" mt="3">
            {[
              { label: "Energy says speech", slot: 0 },
              { label: "Silero says speech", slot: 1 },
              { label: "They disagree", slot: 6 },
            ].map((item) => (
              <HStack key={item.label} gap="1.5">
                <Box boxSize="2.5" rounded="2px" bg={seriesVar(item.slot)} flexShrink="0" />
                <Text fontSize="2xs" color="fg.muted">
                  {item.label}
                </Text>
              </HStack>
            ))}
          </Wrap>
        </Box>
      )}

      {/* Close-up on the burst: the one second the argument is about, big
          enough to see frame by frame, with its own play button. */}
      {analysis && burstFrame !== null && closeTo > closeFrom && (
        <Box
          data-tour="closeup"
          mt="6"
          p="3"
          borderWidth="1px"
          borderColor="border"
          rounded="l2"
          animation="fade-in 300ms ease-out"
          _motionReduce={{ animation: "none" }}
        >
          <Flex justify="space-between" align="center" gap="3" wrap="wrap" mb="3">
            <Box>
              <Text fontSize="xs" fontWeight="bold">
                Close-up: the slam
              </Text>
              <Text fontSize="2xs" color="fg.muted">
                {((closeTo - closeFrom) * FRAME / SAMPLE_RATE).toFixed(1)}s around it, frame by frame
              </Text>
            </Box>
            <Button size="2xs" variant={slamPlayhead === null ? "outline" : "solid"} onClick={playSlam}>
              {slamPlayhead === null ? "▶ Play the slam" : "■ Stop"}
            </Button>
          </Flex>
          <Lane title="Frame energy" caption={`slam peaks ${Math.round(Math.max(...burstRange.map((i) => analysis.energyDb[i])) - analysis.floorDb)} dB above the room`}>
            <EnergyTrace
              energyDb={analysis.energyDb.slice(closeFrom, closeTo)}
              floorDb={analysis.floorDb}
              margin={margin}
            />
          </Lane>
          <Lane title="Energy detector" caption={`fires on ${energyOnBurst}/${burstRange.length} slam frames`}>
            <Decisions
              decisions={energy.slice(closeFrom, closeTo)}
              slot={0}
              burstAt={((burstFrame - closeFrom) * FRAME) / SAMPLE_RATE}
              seconds={((closeTo - closeFrom) * FRAME) / SAMPLE_RATE}
              playhead={slamPlayhead}
            />
          </Lane>
          <Lane
            title="Silero (neural)"
            caption={
              neural ? `fires on ${neuralOnBurst}/${burstRange.length} slam frames` : "model not loaded"
            }
          >
            {neural ? (
              <Decisions
                decisions={neural.slice(closeFrom, closeTo)}
                slot={1}
                burstAt={((burstFrame - closeFrom) * FRAME) / SAMPLE_RATE}
                seconds={((closeTo - closeFrom) * FRAME) / SAMPLE_RATE}
                playhead={slamPlayhead}
              />
            ) : (
              <Box h="5" rounded="l1" bg="bg.subtle" />
            )}
          </Lane>
        </Box>
      )}

      {/* Controls */}
      <Box
        mt="6"
        pt="5"
        borderTopWidth="1px"
        borderColor="border"
        display="grid"
        gap="4"
        gridTemplateColumns={{ base: "1fr", sm: "repeat(2, 1fr)" }}
      >
        <Box data-tour="margin">
          <Knob
            label="Energy margin above the floor"
            value={margin}
            unit="dB"
            min={3}
            max={30}
            step={1}
            onChange={setMargin}
            hint="Raise it to stop reacting to the room; raise it too far and quiet speech disappears."
          />
        </Box>
        <Knob
          label="Silero threshold"
          value={threshold}
          unit=""
          min={0.05}
          max={0.95}
          step={0.05}
          onChange={setThreshold}
          disabled={!neural}
          hint="The model reports a probability, not a verdict. This is where you choose to draw the line."
        />
      </Box>

      <Text fontSize="9px" color="fg.muted" mt="5" lineHeight="short">
        Silero VAD is MIT licensed and its weights are served from this site
        rather than a third-party CDN. The audio never leaves the page.
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

function Lane({
  title,
  caption,
  children,
}: {
  title: string;
  caption: string;
  children: React.ReactNode;
}) {
  return (
    <Box mb="3">
      <Flex justify="space-between" align="baseline" gap="3">
        <Text fontSize="2xs" color="fg.muted">
          {title}
        </Text>
        <Text fontSize="9px" color="fg.muted" fontVariantNumeric="tabular-nums">
          {caption}
        </Text>
      </Flex>
      <Box mt="1">{children}</Box>
    </Box>
  );
}

/** Per-frame decisions as a dense strip. */
function Decisions({
  decisions,
  slot,
  burstAt,
  seconds,
  playhead,
}: {
  decisions: boolean[];
  slot: number;
  burstAt: number | null;
  seconds: number;
  /** Seconds elapsed while playing, or null when stopped. */
  playhead?: number | null;
}) {
  return (
    <Box position="relative" h="5" bg="bg.subtle" rounded="l1" overflow="hidden">
      {/* One absolutely-positioned block per run of frames, rather than per
          frame — a 60-second clip is nearly two thousand frames, and that many
          nodes makes dragging a threshold slider visibly stutter. */}
      {runs(decisions).map((run) => (
        <Box
          key={run.from}
          position="absolute"
          top="0"
          bottom="0"
          insetStart={`${(run.from / decisions.length) * 100}%`}
          width={`${((run.to - run.from) / decisions.length) * 100}%`}
          bg={seriesVar(slot)}
        />
      ))}
      {burstAt != null && seconds > 0 && (
        <Box
          position="absolute"
          top="0"
          bottom="0"
          insetStart={`${(burstAt / seconds) * 100}%`}
          borderStartWidth="1px"
          borderStyle="dashed"
          borderColor="fg"
          opacity="0.65"
          title="Injected noise burst"
        />
      )}
      {/* Playhead. The point of the whole control: hearing the audio and
          watching which detector is firing at that instant are the only way
          to judge which of them is right. */}
      {playhead != null && seconds > 0 && (
        <Box
          position="absolute"
          top="0"
          bottom="0"
          insetStart={`${Math.min(100, (playhead / seconds) * 100)}%`}
          w="2px"
          bg="fg"
          opacity="0.8"
        />
      )}
    </Box>
  );
}

/** Contiguous true runs, so the strip is a handful of nodes rather than thousands. */
function runs(decisions: boolean[]): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  let start: number | null = null;
  decisions.forEach((value, i) => {
    if (value && start === null) start = i;
    if (!value && start !== null) {
      out.push({ from: start, to: i });
      start = null;
    }
  });
  if (start !== null) out.push({ from: start, to: decisions.length });
  return out;
}

/** Frame energy as a column trace, with the decision threshold drawn across. */
function EnergyTrace({
  energyDb,
  floorDb,
  margin,
}: {
  energyDb: Float32Array;
  floorDb: number;
  margin: number;
}) {
  const top = Math.max(...energyDb, floorDb + margin + 6);
  const bottom = floorDb - 6;
  const span = Math.max(1, top - bottom);
  const height = (db: number) => Math.max(0, Math.min(1, (db - bottom) / span));

  // Downsample to at most this many columns: past it the bars are sub-pixel
  // and the extra nodes only cost layout time.
  const columns = Math.min(240, energyDb.length);
  const step = energyDb.length / columns;

  return (
    <Box position="relative" h="12" bg="bg.subtle" rounded="l1" overflow="hidden">
      {Array.from({ length: columns }, (_, i) => {
        let peak = -Infinity;
        for (let k = Math.floor(i * step); k < Math.floor((i + 1) * step); k += 1) {
          peak = Math.max(peak, energyDb[k]);
        }
        return (
          <Box
            key={i}
            position="absolute"
            bottom="0"
            insetStart={`${(i / columns) * 100}%`}
            width={`${100 / columns}%`}
            height={`${height(peak) * 100}%`}
            bg="fg.muted"
            opacity="0.5"
          />
        );
      })}
      <Box
        position="absolute"
        insetStart="0"
        insetEnd="0"
        bottom={`${height(floorDb + margin) * 100}%`}
        // Slides as the margin moves, so turning the knob visibly raises the
        // bar that loudness has to clear.
        transition="bottom 200ms ease"
        _motionReduce={{ transition: "none" }}
        borderTopWidth="1px"
        borderStyle="dashed"
        borderColor={seriesVar(0)}
      />
    </Box>
  );
}

function Knob({
  label,
  value,
  unit,
  min,
  max,
  step,
  onChange,
  hint,
  disabled,
}: {
  label: string;
  value: number;
  unit: string;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  hint: string;
  disabled?: boolean;
}) {
  return (
    <Box opacity={disabled ? 0.45 : 1}>
      <Flex justify="space-between" align="baseline" gap="2">
        <Text fontSize="2xs" color="fg.muted">
          {label}
        </Text>
        <Text fontSize="2xs" fontWeight="bold" fontVariantNumeric="tabular-nums">
          {unit ? `${value} ${unit}` : value.toFixed(2)}
        </Text>
      </Flex>
      <Box asChild w="full" mt="2">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={disabled}
          aria-label={label}
          onChange={(event) => onChange(Number(event.target.value))}
        />
      </Box>
      <Text fontSize="9px" color="fg.muted" mt="1.5" lineHeight="short">
        {hint}
      </Text>
    </Box>
  );
}
