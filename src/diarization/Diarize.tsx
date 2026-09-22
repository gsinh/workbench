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
  DEFAULT_OPTIONS,
  diarize,
  project,
} from "./cluster";
import { type Turn, scoreAgainstTruth, syntheticConversation } from "./synth";
import { seriesVar, vizVars } from "../shared/palette";

/** Analysis rate. Speech features are conventionally computed at 16 kHz. */
const RATE = 16000;
/** Beyond this the scatter's colours stop being separable in every direction. */
const MAX_SPEAKERS = 3;

const speakerName = (i: number) => `Speaker ${i + 1}`;

/** Average an arbitrary-rate buffer down to the analysis rate. */
function resample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return input;
  const ratio = from / to;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i += 1) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let k = start; k < end; k += 1) sum += input[k];
    out[i] = sum / Math.max(1, end - start);
  }
  return out;
}

type Source = { label: string; signal: Float32Array; truth?: Turn[] };

export default function Diarize() {
  const [source, setSource] = useState<Source | null>(null);
  const [options, setOptions] = useState<DiarizeOptions>(DEFAULT_OPTIONS);
  const [result, setResult] = useState<Diarization | null>(null);
  const [points, setPoints] = useState<{ x: number; y: number }[]>([]);
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const capture = useRef<{ ctx: AudioContext; stream: MediaStream; chunks: Float32Array[] } | null>(
    null,
  );

  const run = useCallback((next: Source, opts: DiarizeOptions) => {
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
    held.stream.getTracks().forEach((t) => t.stop());
    await held.ctx.close();
    capture.current = null;
    setRecording(false);

    const total = held.chunks.reduce((n, c) => n + c.length, 0);
    if (total === 0) return;
    const joined = new Float32Array(total);
    let at = 0;
    for (const chunk of held.chunks) {
      joined.set(chunk, at);
      at += chunk.length;
    }
    const next: Source = { label: "Your microphone", signal: joined };
    setSource(next);
    run(next, options);
  }, [options, run]);

  const startRecording = useCallback(async () => {
    if (capture.current) {
      void stopRecording();
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setNote("This browser has no microphone API.");
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setNote("Microphone access was declined. The synthetic sample needs no permission.");
      return;
    }
    const ctx = new AudioContext({ sampleRate: RATE });
    const sourceNode = ctx.createMediaStreamSource(stream);
    // ScriptProcessor rather than an AudioWorklet: a worklet needs a separate
    // module URL, which a source-only package cannot ship without forcing a
    // bundler configuration on whoever installs it.
    const processor = ctx.createScriptProcessor(4096, 1, 1);
    const chunks: Float32Array[] = [];
    processor.onaudioprocess = (event) => {
      chunks.push(Float32Array.from(event.inputBuffer.getChannelData(0)));
    };
    sourceNode.connect(processor);
    // Routed to a silent gain node: without a path to the destination the
    // graph does not pull, but connecting it directly would echo the room.
    const mute = ctx.createGain();
    mute.gain.value = 0;
    processor.connect(mute);
    mute.connect(ctx.destination);

    capture.current = { ctx, stream, chunks };
    setRecording(true);
    setNote("Recording. Have two people speak in turn, then stop.");
  }, [stopRecording]);

  useEffect(() => {
    return () => {
      const held = capture.current;
      if (held) {
        held.stream.getTracks().forEach((t) => t.stop());
        void held.ctx.close();
        capture.current = null;
      }
    };
  }, []);

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

  return (
    <Box css={vizVars}>
      {/* Verdict */}
      <Flex align="baseline" gap="3" wrap="wrap">
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
      <Wrap gap="2" mt="5" align="center">
        <Button size="2xs" variant="outline" onClick={loadSynthetic} loading={busy}>
          Synthetic conversation
        </Button>
        <Button
          size="2xs"
          variant={recording ? "solid" : "outline"}
          onClick={() => void startRecording()}
        >
          {recording ? "Stop and analyse" : "Record two voices"}
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
        <Box mt="6">
          <Text fontSize="2xs" color="fg.muted" mb="2">
            Who spoke when
          </Text>
          <Box position="relative" h="7" bg="bg.subtle" rounded="l2" overflow="hidden">
            {result.segments.map((segment) => (
              <Box
                key={`${segment.from}-${segment.to}`}
                position="absolute"
                top="0"
                bottom="0"
                insetStart={`${(segment.startSeconds / totalSeconds) * 100}%`}
                width={`max(2px, calc(${((segment.endSeconds - segment.startSeconds) / totalSeconds) * 100}% - 2px))`}
                bg={seriesVar(segment.speaker)}
                title={`${speakerName(segment.speaker)} · ${segment.startSeconds.toFixed(1)}–${segment.endSeconds.toFixed(1)}s`}
              />
            ))}
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
        <Box mt="6">
          <Text fontSize="2xs" color="fg.muted" mb="2">
            Segment embeddings, projected to two dimensions
          </Text>
          <Scatter points={points} speakers={result.segments.map((s) => s.speaker)} />
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
        <Box>
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
    </Box>
  );
}

/** Scatter of segment embeddings, coloured by cluster. */
function Scatter({
  points,
  speakers,
}: {
  points: { x: number; y: number }[];
  speakers: number[];
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

  return (
    <Box
      position="relative"
      h="40"
      borderWidth="1px"
      borderColor="border"
      rounded="l2"
      bg="bg.subtle"
    >
      {points.map((point, i) => (
        <Box
          key={i}
          position="absolute"
          insetStart={`${((point.x - minX) / width) * 100}%`}
          top={`${(1 - (point.y - minY) / height) * 100}%`}
          transform="translate(-50%, -50%)"
          boxSize="3"
          rounded="full"
          bg={seriesVar(speakers[i] ?? 0)}
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
