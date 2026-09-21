"use client";

import { Box, Button, HStack, SimpleGrid, Text } from "@chakra-ui/react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Params } from "./model";
import { ms } from "./model";

/**
 * The parts of the budget that can be measured rather than guessed.
 *
 * Three of the seven stages are local to the device and need no key, no server
 * and no model download: the capture and sink latencies the audio stack
 * reports, the time this browser's speech synthesiser takes to produce its
 * first audio, and the behaviour of a real VAD on a real microphone. The
 * remaining four — uplink, ASR, the model and the downlink — depend on
 * infrastructure a static page has no access to, and stay as sliders.
 */

type DeviceInfo = {
  sampleRate: number;
  /** Capture-side buffering the audio stack admits to, in ms. */
  baseMs: number;
  /** Sink-side buffering ahead of the speaker, in ms. Not reported everywhere. */
  outputMs: number | null;
};

type Phase = "idle" | "running" | "done" | "unsupported" | "denied";

/** Speech is anything above this, relative to full scale. */
const SPEECH_DB = -45;

function rmsDb(buffer: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < buffer.length; i += 1) sum += buffer[i] * buffer[i];
  const rms = Math.sqrt(sum / buffer.length);
  return 20 * Math.log10(rms + 1e-9);
}

export function Measure({
  endpointMs,
  onApply,
}: {
  endpointMs: number;
  onApply: (patch: Partial<Params>) => void;
}) {
  const [device, setDevice] = useState<DeviceInfo | null>(null);
  const [ttsPhase, setTtsPhase] = useState<Phase>("idle");
  const [ttsMs, setTtsMs] = useState<number | null>(null);

  const [micPhase, setMicPhase] = useState<Phase>("idle");
  const [level, setLevel] = useState(-90);
  const [speaking, setSpeaking] = useState(false);
  const [hangover, setHangover] = useState(0);
  const [lastTurn, setLastTurn] = useState<number | null>(null);

  const graph = useRef<{
    ctx: AudioContext;
    stream: MediaStream;
    raf: number;
    alive: boolean;
  } | null>(null);
  // Read inside the animation frame, so changing the slider mid-run retunes the
  // live VAD without tearing down the audio graph.
  const endpointRef = useRef(endpointMs);
  useEffect(() => {
    endpointRef.current = endpointMs;
  }, [endpointMs]);

  const stopMic = useCallback(() => {
    const g = graph.current;
    if (!g) return;
    g.alive = false;
    cancelAnimationFrame(g.raf);
    g.stream.getTracks().forEach((t) => t.stop());
    void g.ctx.close();
    graph.current = null;
    setMicPhase("idle");
    setSpeaking(false);
    setHangover(0);
    setLevel(-90);
  }, []);

  // Release the microphone and silence any queued speech when the demo is
  // unmounted — navigating away mid-measurement should not leave the recording
  // indicator lit.
  useEffect(() => {
    return () => {
      stopMic();
      if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
    };
  }, [stopMic]);

  const probeDevice = useCallback(() => {
    const Ctor = window.AudioContext ?? window.webkitAudioContext;
    if (!Ctor) {
      setDevice(null);
      return;
    }
    const ctx = new Ctor();
    setDevice({
      sampleRate: ctx.sampleRate,
      baseMs: (ctx.baseLatency ?? 0) * 1000,
      outputMs:
        typeof ctx.outputLatency === "number" ? ctx.outputLatency * 1000 : null,
    });
    void ctx.close();
  }, []);

  const probeTts = useCallback(() => {
    if (typeof speechSynthesis === "undefined") {
      setTtsPhase("unsupported");
      return;
    }
    speechSynthesis.cancel();
    setTtsPhase("running");
    const utterance = new SpeechSynthesisUtterance(
      "Measuring how long this device takes to start speaking.",
    );
    const t0 = performance.now();
    utterance.onstart = () => {
      setTtsMs(performance.now() - t0);
      setTtsPhase("done");
    };
    utterance.onerror = () => setTtsPhase("unsupported");
    speechSynthesis.speak(utterance);
  }, []);

  const startMic = useCallback(async () => {
    if (graph.current) {
      stopMic();
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setMicPhase("unsupported");
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setMicPhase("denied");
      return;
    }

    const ctx = new (window.AudioContext ?? window.webkitAudioContext)();
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    const buffer = new Float32Array(analyser.fftSize);

    let speechStart: number | null = null;
    let silenceStart: number | null = null;

    const tick = () => {
      analyser.getFloatTimeDomainData(buffer);
      const db = rmsDb(buffer);
      const now = performance.now();
      setLevel(db);

      if (db > SPEECH_DB) {
        if (speechStart === null) speechStart = now;
        silenceStart = null;
        setSpeaking(true);
        setHangover(0);
      } else if (speechStart !== null) {
        if (silenceStart === null) silenceStart = now;
        const held = now - silenceStart;
        setHangover(held);
        // The hangover elapsing is the endpoint: the same decision the model's
        // first stage charges for, made here against a real microphone.
        if (held >= endpointRef.current) {
          setLastTurn(silenceStart - speechStart);
          speechStart = null;
          silenceStart = null;
          setSpeaking(false);
          setHangover(0);
        }
      }

      const g = graph.current;
      if (g?.alive) g.raf = requestAnimationFrame(tick);
    };

    // The handle is installed before the first frame is scheduled: `tick`
    // re-arms itself through it, so it has to exist by the time it runs.
    graph.current = { ctx, stream, raf: 0, alive: true };
    graph.current.raf = requestAnimationFrame(tick);
    setMicPhase("running");
  }, [stopMic]);

  const meter = Math.max(0, Math.min(1, (level + 70) / 55));

  return (
    <Box mt="6" pt="5" borderTopWidth="1px" borderColor="border">
      <Text fontSize="xs" fontWeight="bold">
        Measure on this device
      </Text>
      <Text fontSize="2xs" color="fg.muted" mt="1" lineHeight="short">
        Three of the seven stages are local, so they can be measured here
        instead of estimated. The other four need infrastructure this page does
        not have, and stay as sliders.
      </Text>

      <SimpleGrid columns={{ base: 1, sm: 3 }} gap="3" mt="4">
        {/* Audio stack */}
        <Box borderWidth="1px" borderColor="border" rounded="l2" p="3">
          <Text fontSize="2xs" fontWeight="bold">
            Audio stack
          </Text>
          {device ? (
            <Box mt="2" fontSize="2xs" color="fg.muted">
              <Text fontVariantNumeric="tabular-nums">
                capture {device.baseMs.toFixed(1)} ms
              </Text>
              <Text fontVariantNumeric="tabular-nums">
                sink{" "}
                {device.outputMs === null
                  ? "not reported"
                  : `${device.outputMs.toFixed(1)} ms`}
              </Text>
              <Text fontVariantNumeric="tabular-nums">
                {(device.sampleRate / 1000).toFixed(1)} kHz
              </Text>
            </Box>
          ) : (
            <Text fontSize="2xs" color="fg.muted" mt="2" lineHeight="short">
              What the browser admits to buffering either side of your speakers.
            </Text>
          )}
          <HStack mt="3" gap="2">
            <Button size="2xs" variant="outline" onClick={probeDevice}>
              {device ? "Re-read" : "Read"}
            </Button>
            {device?.outputMs != null && (
              <Button
                size="2xs"
                variant="ghost"
                onClick={() =>
                  onApply({ playoutMs: Math.round(device.outputMs as number) })
                }
              >
                Use as playout
              </Button>
            )}
          </HStack>
        </Box>

        {/* TTS */}
        <Box borderWidth="1px" borderColor="border" rounded="l2" p="3">
          <Text fontSize="2xs" fontWeight="bold">
            TTS first audio
          </Text>
          {ttsPhase === "unsupported" ? (
            <Text fontSize="2xs" color="fg.muted" mt="2">
              No speech synthesis in this browser.
            </Text>
          ) : ttsMs !== null ? (
            <Text
              mt="2"
              fontSize="lg"
              fontWeight="bold"
              color="colorPalette.fg"
              lineHeight="1"
            >
              {ms(ttsMs)}
            </Text>
          ) : (
            <Text fontSize="2xs" color="fg.muted" mt="2" lineHeight="short">
              From asking this browser to speak to the first audio leaving it.
              Turn your volume up.
            </Text>
          )}
          <HStack mt="3" gap="2">
            <Button
              size="2xs"
              variant="outline"
              loading={ttsPhase === "running"}
              onClick={probeTts}
            >
              {ttsMs === null ? "Speak" : "Again"}
            </Button>
            {ttsMs !== null && (
              <Button
                size="2xs"
                variant="ghost"
                onClick={() => onApply({ ttsFirstAudioMs: Math.round(ttsMs) })}
              >
                Use in budget
              </Button>
            )}
          </HStack>
        </Box>

        {/* VAD */}
        <Box borderWidth="1px" borderColor="border" rounded="l2" p="3">
          <Text fontSize="2xs" fontWeight="bold">
            Live endpointing
          </Text>
          {micPhase === "denied" ? (
            <Text fontSize="2xs" color="fg.muted" mt="2" lineHeight="short">
              Microphone access was declined. Nothing else here needs it.
            </Text>
          ) : micPhase === "unsupported" ? (
            <Text fontSize="2xs" color="fg.muted" mt="2">
              No microphone API in this browser.
            </Text>
          ) : micPhase === "running" ? (
            <Box mt="2">
              <Box h="1.5" bg="bg.subtle" rounded="full" overflow="hidden">
                <Box
                  h="full"
                  w={`${meter * 100}%`}
                  bg={speaking ? "colorPalette.solid" : "border"}
                  transition="width 60ms linear"
                />
              </Box>
              <Text fontSize="2xs" color="fg.muted" mt="2" fontVariantNumeric="tabular-nums">
                {speaking
                  ? "speech"
                  : hangover > 0
                    ? `silence ${Math.round(hangover)} / ${endpointMs} ms`
                    : "waiting"}
              </Text>
              {lastTurn !== null && (
                <Text fontSize="2xs" color="fg.muted" fontVariantNumeric="tabular-nums">
                  last turn {ms(lastTurn)}
                </Text>
              )}
            </Box>
          ) : (
            <Text fontSize="2xs" color="fg.muted" mt="2" lineHeight="short">
              Runs the endpointing slider against your actual microphone. Audio
              never leaves the page.
            </Text>
          )}
          <HStack mt="3" gap="2">
            <Button
              size="2xs"
              variant={micPhase === "running" ? "solid" : "outline"}
              onClick={() => void startMic()}
            >
              {micPhase === "running" ? "Stop" : "Start mic"}
            </Button>
          </HStack>
        </Box>
      </SimpleGrid>
    </Box>
  );
}

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}
