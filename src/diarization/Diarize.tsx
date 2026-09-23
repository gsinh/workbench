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
import { DEFAULT_FRAMES, analyseFrames } from "./dsp";
import {
  type Diarization,
  type DiarizeOptions,
  type Merge,
  DEFAULT_OPTIONS,
  diarize,
  groupsAfter,
  project,
} from "./cluster";
import { type Turn, scoreAgainstTruth, syntheticConversation } from "./synth";
import { type MicCapture, isSilent, playSignal, resample, startMicCapture } from "../shared/audio";
import {
  Tour,
  TourButton,
  type TourStep,
  clearTourHash,
  tourFromHash,
  tourSpotlight,
} from "../shared/Tour";

/** How long each merge stays on screen when the clustering is replayed. */
const MERGE_MS = 800;
import { seriesVar, vizVars } from "../shared/palette";

/** Analysis rate. Speech features are conventionally computed at 16 kHz. */
const RATE = 16000;
/** Beyond this the scatter's colours stop being separable in every direction. */
const MAX_SPEAKERS = 3;

const speakerName = (i: number) => `Speaker ${i + 1}`;

type Source = { label: string; signal: Float32Array; truth?: Turn[] };

export default function Diarize() {
  const [source, setSource] = useState<Source | null>(null);
  const [options, setOptions] = useState<DiarizeOptions>(DEFAULT_OPTIONS);
  const [result, setResult] = useState<Diarization | null>(null);
  const [points, setPoints] = useState<{ x: number; y: number }[]>([]);
  const [busy, setBusy] = useState(false);
  // Seconds captured while recording, or null when not.
  const [recording, setRecording] = useState<number | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const capture = useRef<MicCapture | null>(null);

  // Playback, with a playhead on the timeline; dots appear as it passes them.
  const [playhead, setPlayhead] = useState<number | null>(null);
  const stopPlay = useRef<(() => void) | null>(null);

  // The clustering replayed one merge at a time: the number of merges shown,
  // or null for the finished result.
  const [mergeStep, setMergeStep] = useState<number | null>(null);
  const replayTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  // Guided tour: the step, and what the reader has done during each one.
  const [tourIndex, setTourIndex] = useState<number | null>(null);
  const tourRef = useRef<number | null>(null);
  tourRef.current = tourIndex;
  const [did, setDid] = useState<Record<string, boolean>>({});
  const mark = (what: string) => {
    const at = tourRef.current;
    if (at !== null) setDid((prev) => ({ ...prev, [`${at}:${what}`]: true }));
  };
  const root = useRef<HTMLDivElement>(null);

  const stopReplay = () => {
    if (replayTimer.current) clearInterval(replayTimer.current);
    replayTimer.current = null;
    setMergeStep(null);
  };

  const run = useCallback((next: Source, opts: DiarizeOptions) => {
    stopReplay();
    stopPlay.current?.();
    setBusy(true);
    // Yield a frame so the button state paints before the FFTs start.
    setTimeout(() => {
      const frames = analyseFrames(next.signal, { sampleRate: RATE, ...DEFAULT_FRAMES });
      const diarization = diarize(frames, opts, next.signal.length / RATE);
      setResult(diarization);
      setPoints(project(diarization.segments.map((s) => s.embedding)));
      setBusy(false);
    }, 0);
  }, []);

  const loadSynthetic = useCallback(() => {
    const { signal, truth } = syntheticConversation(RATE);
    const next: Source = { label: "Synthetic conversation", signal, truth };
    setSource(next);
    setNote(null);
    run(next, options);
  }, [options, run]);

  // Something to look at on arrival, with no permission prompt.
  useEffect(() => {
    loadSynthetic();
    // Intentionally once: re-running on every option change is the job of the
    // controls below, which re-analyse the signal already loaded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stopRecording = useCallback(async () => {
    const held = capture.current;
    if (!held) return;
    capture.current = null;
    setRecording(null);
    const signal = await held.stop();
    if (signal.length === 0) {
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
    const next: Source = { label: "Your recording", signal };
    setSource(next);
    run(next, options);
  }, [options, run]);

  // Not async until after startMicCapture: the audio context has to be created
  // inside the click, before anything is awaited.
  const toggleRecording = useCallback(() => {
    if (capture.current) {
      void stopRecording();
      return;
    }
    const held = startMicCapture(RATE, (seconds) => {
      if (capture.current === held) setRecording(seconds);
    });
    capture.current = held;
    setRecording(0);
    setNote("Waiting for the microphone…");
    held.ready.then(
      () => {
        if (capture.current === held) {
          setNote("Recording. Have two people speak in turn, then press Stop.");
        }
      },
      (error: Error) => {
        if (capture.current !== held) return;
        capture.current = null;
        setRecording(null);
        setNote(`${error.message} The synthetic sample needs no permission.`);
      },
    );
  }, [stopRecording]);

  useEffect(() => {
    return () => {
      capture.current?.cancel();
      capture.current = null;
      stopPlay.current?.();
      if (replayTimer.current) clearInterval(replayTimer.current);
    };
  }, []);

  const togglePlay = () => {
    if (stopPlay.current) {
      stopPlay.current();
      return;
    }
    if (!source) return;
    stopPlay.current = playSignal(
      source.signal,
      RATE,
      (seconds) => {
        setPlayhead(seconds);
        if (seconds === null) {
          stopPlay.current = null;
          mark("played");
        }
      },
      setNote,
    );
  };

  /** Replay the merges from every segment on its own to the final groups. */
  const replayClustering = () => {
    if (!result) return;
    if (replayTimer.current) clearInterval(replayTimer.current);
    const total = result.history.length;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches || total === 0) {
      setMergeStep(null);
      mark("replayed");
      return;
    }
    let step = 0;
    setMergeStep(0);
    replayTimer.current = setInterval(() => {
      step += 1;
      if (step > total) {
        if (replayTimer.current) clearInterval(replayTimer.current);
        replayTimer.current = null;
        setMergeStep(null);
        mark("replayed");
      } else {
        setMergeStep(step);
      }
    }, MERGE_MS);
  };

  async function loadFile(file: File) {
    setNote(null);
    const ctx = new AudioContext();
    try {
      const decoded = await ctx.decodeAudioData(await file.arrayBuffer());
      const mono = decoded.getChannelData(0);
      const next: Source = {
        label: file.name,
        signal: resample(Float32Array.from(mono), decoded.sampleRate, RATE),
      };
      setSource(next);
      run(next, options);
    } catch {
      setNote("That file could not be decoded as audio.");
    } finally {
      void ctx.close();
    }
  }

  function update(patch: Partial<DiarizeOptions>) {
    const next = { ...options, ...patch };
    setOptions(next);
    if (source) run(source, next);
  }

  const score = source?.truth && result ? scoreAgainstTruth(source.truth, result.segments) : null;
  const totalSeconds = result?.totalSeconds ?? 0;
  const replaying = mergeStep !== null;
  const history = result?.history ?? [];
  const groups =
    replaying && result ? groupsAfter(result.segments.length, history, mergeStep) : null;
  const groupCount = groups ? new Set(groups).size : 0;
  const latest = replaying && mergeStep > 0 ? history[mergeStep - 1] : null;

  const steps: TourStep[] = [
    {
      target: "verdict",
      say: "This works out who spoke when, with no trained model: just the sound's spectrum and some arithmetic. The sample is a synthetic conversation with a known script, so the answer can be scored.",
    },
    {
      target: "timeline",
      say: "Play the conversation. Each stretch of speech becomes one dot below: a fingerprint of how that stretch sounds.",
      showLabel: "Play it",
      show: () => {
        if (!stopPlay.current) togglePlay();
      },
      done: !!did["1:played"],
      after: `${result?.segments.length ?? 0} stretches of speech, ${result?.segments.length ?? 0} dots. Dots close together sound alike; the two voices land in different corners.`,
    },
    {
      target: "scatter",
      say: "Now the grouping. It joins the two most alike groups, again and again, until two are left.",
      showLabel: "Watch it",
      show: replayClustering,
      done: !!did["2:replayed"],
      after: score
        ? `${history.length} merges, and the two groups left are the two speakers: ${score.correct} of ${score.total} turns match the script.`
        : `${history.length} merges, and the groups left are the speakers.`,
    },
    {
      target: "speakers",
      say: "Tell it there are three speakers instead of two.",
      showLabel: "Set it to 3",
      show: () => update({ speakers: 3 }),
      done: options.speakers === 3 && !busy,
      after: score
        ? `It finds three, because it was asked for three: one real voice is split in two, and the score drops to ${score.correct} of ${score.total}. Clustering always returns as many groups as you ask for.`
        : "It finds three, because it was asked for three. Clustering always returns as many groups as you ask for.",
    },
    {
      target: "speakers",
      say: "Or let it decide: Auto keeps merging until the closest pair is further apart than a threshold.",
      showLabel: "Set it to Auto",
      show: () => update({ speakers: "auto" }),
      done: options.speakers === "auto" && !busy,
      after: `Auto found ${result?.speakerCount ?? 0}. Telling it the count is the single biggest accuracy win, and usually you do know it.`,
    },
    {
      target: "inputs",
      say: "Try it on two real voices: record a short back-and-forth.",
      showLabel: recording !== null ? "■ Stop and analyse" : "● Record",
      show: toggleRecording,
      done: source?.label === "Your recording" && !busy,
      after: "Two speakers is the default; set Speakers to match whoever was talking. Everything here is yours to change.",
    },
  ];

  const startTour = () => {
    setDid({});
    if (options.speakers !== 2) update({ speakers: 2 });
    setTourIndex(0);
  };
  const closeTour = () => {
    setTourIndex(null);
    clearTourHash();
  };
  useEffect(() => {
    const at = tourFromHash();
    if (at !== null) setTourIndex(Math.max(0, Math.min(5, at)));
  }, []);

  return (
    <Box
      ref={root}
      css={{ ...vizVars, ...tourSpotlight(tourIndex !== null ? steps[tourIndex].target : null) }}
    >
      {/* Verdict */}
      <Flex align="baseline" gap="3" wrap="wrap" data-tour="verdict">
        <Text
          fontSize={{ base: "4xl", sm: "5xl" }}
          fontWeight="bold"
          lineHeight="1"
          color="colorPalette.fg"
        >
          {result ? result.speakerCount : 0}
        </Text>
        <Box>
          <Text fontSize="xs" fontWeight="bold">
            {result?.speakerCount === 1 ? "speaker" : "speakers"} found
          </Text>
          <Text fontSize="2xs" color="fg.muted">
            {result ? `${result.segments.length} segments over ${totalSeconds.toFixed(1)}s` : "—"}
          </Text>
        </Box>
        {score && (
          <Badge
            size="sm"
            variant="subtle"
            colorPalette={score.correct === score.total ? "green" : "orange"}
            ms="auto"
          >
            {score.correct}/{score.total} turns match the known script
          </Badge>
        )}
        {tourIndex === null && (
          <Box ms={score ? undefined : "auto"}>
            <TourButton id="diarization" onStart={startTour} />
          </Box>
        )}
      </Flex>

      <Box mt="5" ps="3" borderStartWidth="2px" borderColor="colorPalette.solid">
        <Text fontSize="2xs" color="fg.muted" lineHeight="tall">
          Who spoke when, worked out with no model and no network: frames,
          MFCCs, statistics pooling, then clustering. The{" "}
          <Text as="span" color="fg">
            synthetic conversation
          </Text>{" "}
          below has a known script, so the badge above is a real score rather
          than a claim — and it is scored the same way whichever input you use.
        </Text>
      </Box>

      {/* Inputs */}
      <Wrap gap="2" mt="5" align="center" data-tour="inputs">
        <Button size="2xs" variant="outline" onClick={loadSynthetic} loading={busy}>
          Synthetic conversation
        </Button>
        <Button
          size="2xs"
          variant={recording !== null ? "solid" : "outline"}
          colorPalette={recording !== null ? "red" : undefined}
          onClick={toggleRecording}
        >
          {recording !== null
            ? `■ Stop and analyse · ${recording.toFixed(1)}s`
            : "● Record two voices"}
        </Button>
        {/* The label is the button: clicking it opens the picker, so no
            click handler has to reach for a hidden input by ref. */}
        <Button size="2xs" variant="outline" asChild>
          <label>
            Upload audio
            <input
              type="file"
              accept="audio/*"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void loadFile(file);
              }}
            />
          </label>
        </Button>
        {source && (
          <Text fontSize="2xs" color="fg.muted">
            {source.label}
          </Text>
        )}
      </Wrap>
      {note && (
        <Text fontSize="2xs" color="fg.muted" mt="2">
          {note}
        </Text>
      )}

      {/* Timeline */}
      {result && result.segments.length > 0 && (
        <Box mt="6" data-tour="timeline">
          <Flex justify="space-between" align="center" mb="2" gap="3">
            <Text fontSize="2xs" color="fg.muted">
              Who spoke when
            </Text>
            <Button size="2xs" variant={playhead === null ? "outline" : "solid"} onClick={togglePlay}>
              {playhead === null ? "▶ Play" : "■ Stop"}
            </Button>
          </Flex>
          <Box position="relative" h="7" bg="bg.subtle" rounded="l2" overflow="hidden">
            {result.segments.map((segment) => (
              <Box
                key={`${segment.from}-${segment.to}`}
                position="absolute"
                top="0"
                bottom="0"
                insetStart={`${(segment.startSeconds / totalSeconds) * 100}%`}
                width={`max(2px, calc(${((segment.endSeconds - segment.startSeconds) / totalSeconds) * 100}% - 2px))`}
                // Grey while the clustering replays, filling with each
                // speaker's colour once it has finished deciding.
                bg={replaying ? "fg.muted" : seriesVar(segment.speaker)}
                opacity={replaying ? 0.35 : 1}
                transition="background 400ms ease, opacity 400ms ease"
                _motionReduce={{ transition: "none" }}
                title={`${speakerName(segment.speaker)} · ${segment.startSeconds.toFixed(1)}–${segment.endSeconds.toFixed(1)}s`}
              />
            ))}
            {playhead !== null && totalSeconds > 0 && (
              <Box
                position="absolute"
                top="0"
                bottom="0"
                insetStart={`${Math.min(100, (playhead / totalSeconds) * 100)}%`}
                w="2px"
                bg="fg"
              />
            )}
          </Box>

          {/* The known script, drawn underneath for comparison. */}
          {source?.truth && (
            <>
              <Box position="relative" h="2.5" mt="1" rounded="l1" overflow="hidden">
                {source.truth.map((turn) => (
                  <Box
                    key={turn.startSeconds}
                    position="absolute"
                    top="0"
                    bottom="0"
                    insetStart={`${(turn.startSeconds / totalSeconds) * 100}%`}
                    width={`max(2px, calc(${((turn.endSeconds - turn.startSeconds) / totalSeconds) * 100}% - 2px))`}
                    bg={seriesVar(turn.speaker)}
                    opacity="0.35"
                  />
                ))}
              </Box>
              <Text fontSize="9px" color="fg.muted" mt="1">
                Faded strip: the script the sample was generated from.
              </Text>
            </>
          )}

          <Wrap columnGap="4" rowGap="1.5" mt="3">
            {result.talkTime.map((seconds, i) => (
              <HStack key={i} gap="1.5">
                <Box boxSize="2.5" rounded="2px" bg={seriesVar(i)} flexShrink="0" />
                <Text fontSize="2xs" color="fg.muted">
                  {speakerName(i)}
                </Text>
                <Text fontSize="2xs" fontVariantNumeric="tabular-nums">
                  {seconds.toFixed(1)}s
                </Text>
              </HStack>
            ))}
          </Wrap>
        </Box>
      )}

      {/* Embedding scatter */}
      {result && points.length > 1 && (
        <Box mt="6" data-tour="scatter">
          <Flex justify="space-between" align="center" mb="2" gap="3">
            <Text fontSize="2xs" color="fg.muted">
              Segment embeddings, projected to two dimensions
            </Text>
            <Button
              size="2xs"
              variant={replaying ? "solid" : "outline"}
              onClick={replaying ? stopReplay : replayClustering}
              disabled={history.length === 0}
            >
              {replaying ? "■ Stop" : "▶ Replay the grouping"}
            </Button>
          </Flex>
          <Scatter
            points={points}
            speakers={result.segments.map((s) => s.speaker)}
            visible={result.segments.map((s) => playhead === null || s.startSeconds <= playhead)}
            history={history}
            step={mergeStep}
          />
          <Text fontSize="2xs" mt="2" minH="4" aria-live="polite" color={replaying ? "fg" : "fg.muted"}>
            {replaying
              ? latest
                ? `Merge ${mergeStep} of ${history.length}: joined the two most alike groups (${latest.distance < 0.005 ? "almost identical" : `${latest.distance.toFixed(2)} apart`}). ${groupCount} group${groupCount === 1 ? "" : "s"} left.`
                : `${result.segments.length} segments, each its own group. Joining the closest pair…`
              : ""}
          </Text>
          <Text fontSize="9px" color="fg.muted" mt="2" lineHeight="short">
            Each dot is one segment, placed by its two strongest principal
            components. Clear separation here is the clustering being easy;
            overlap is where it starts guessing.
          </Text>
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
        <Box data-tour="speakers">
          <Text fontSize="2xs" color="fg.muted" mb="1.5">
            Speakers
          </Text>
          <Wrap gap="2">
            {([2, 3, "auto"] as const).map((value) => (
              <Button
                key={String(value)}
                size="2xs"
                variant={options.speakers === value ? "solid" : "outline"}
                onClick={() => update({ speakers: value })}
              >
                {value === "auto" ? "Auto" : value}
              </Button>
            ))}
          </Wrap>
          <Text fontSize="9px" color="fg.muted" mt="1.5" lineHeight="short">
            Auto stops merging once the nearest pair is further apart than the
            threshold. Telling it the count is the single biggest accuracy win
            available, and usually you do know.
          </Text>
        </Box>

        <Box>
          <Flex justify="space-between" align="baseline" gap="2">
            <Text fontSize="2xs" color="fg.muted">
              Merge threshold
            </Text>
            <Text fontSize="2xs" fontWeight="bold" fontVariantNumeric="tabular-nums">
              {options.threshold.toFixed(2)}
            </Text>
          </Flex>
          <Box
            asChild
            w="full"
            mt="2"
            opacity={options.speakers === "auto" ? 1 : 0.45}
          >
            <input
              type="range"
              min={0.05}
              max={0.9}
              step={0.05}
              value={options.threshold}
              disabled={options.speakers !== "auto"}
              aria-label="Merge threshold"
              onChange={(event) => update({ threshold: Number(event.target.value) })}
            />
          </Box>
          <Text fontSize="9px" color="fg.muted" mt="1.5" lineHeight="short">
            Cosine distance. Only used in Auto.
          </Text>
        </Box>
      </Box>

      <Text fontSize="9px" color="fg.muted" mt="5" lineHeight="short">
        Audio never leaves the page — there is nowhere for it to go. Nothing is
        uploaded and no model is downloaded.
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

/**
 * Scatter of segment embeddings, coloured by cluster.
 *
 * During a replay the dots stay neutral and each merge so far is drawn as a
 * line between the two groups' centres, the newest one highlighted — the
 * dendrogram, laid over the space it was built in. Colour arrives only with
 * the final answer.
 */
function Scatter({
  points,
  speakers,
  visible,
  history,
  step,
}: {
  points: { x: number; y: number }[];
  speakers: number[];
  /** Dots not yet reached by the playhead are faded out. */
  visible: boolean[];
  history: Merge[];
  /** Merges shown so far, or null for the finished clustering. */
  step: number | null;
}) {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const pad = 0.12;
  const spanX = Math.max(1e-6, Math.max(...xs) - Math.min(...xs));
  const spanY = Math.max(1e-6, Math.max(...ys) - Math.min(...ys));
  const minX = Math.min(...xs) - spanX * pad;
  const minY = Math.min(...ys) - spanY * pad;
  const width = spanX * (1 + pad * 2);
  const height = spanY * (1 + pad * 2);

  // Positions in percent of the box, shared by the dots and the lines.
  const at = points.map((p) => ({
    x: ((p.x - minX) / width) * 100,
    y: (1 - (p.y - minY) / height) * 100,
  }));
  const centre = (members: number[]) => ({
    x: members.reduce((sum, i) => sum + at[i].x, 0) / members.length,
    y: members.reduce((sum, i) => sum + at[i].y, 0) / members.length,
  });
  const lines =
    step === null
      ? []
      : history.slice(0, step).map((merge, i) => ({
          from: centre(merge.a),
          to: centre(merge.b),
          latest: i === step - 1,
        }));

  return (
    <Box
      position="relative"
      h="40"
      borderWidth="1px"
      borderColor="border"
      rounded="l2"
      bg="bg.subtle"
    >
      <svg
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        aria-hidden
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", overflow: "visible" }}
      >
        {lines.map((line, i) => (
          <line
            key={i}
            x1={line.from.x}
            y1={line.from.y}
            x2={line.to.x}
            y2={line.to.y}
            stroke={
              line.latest
                ? "var(--chakra-colors-color-palette-solid)"
                : "var(--chakra-colors-fg-muted)"
            }
            strokeWidth={line.latest ? 2.5 : 1.5}
            strokeOpacity={line.latest ? 1 : 0.5}
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>
      {points.map((_, i) => (
        <Box
          key={i}
          position="absolute"
          insetStart={`${at[i].x}%`}
          top={`${at[i].y}%`}
          transform={`translate(-50%, -50%) scale(${visible[i] ? 1 : 0.5})`}
          opacity={visible[i] ? 1 : 0.15}
          transition="opacity 250ms ease, transform 250ms ease, background 400ms ease"
          _motionReduce={{ transition: "none" }}
          boxSize="3"
          rounded="full"
          bg={step === null ? seriesVar(speakers[i] ?? 0) : "fg.muted"}
          // A ring in the surface colour keeps overlapping dots legible.
          outline="2px solid"
          outlineColor="bg.subtle"
          title={`Segment ${i + 1} · Speaker ${(speakers[i] ?? 0) + 1}`}
        />
      ))}
    </Box>
  );
}

export { MAX_SPEAKERS };
