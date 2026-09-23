/**
 * Microphone capture and playback that survive real browsers.
 *
 * Both are easy to write so that they work in a headless test and fail on a
 * phone. The rules that matter:
 *
 * - An AudioContext has to be created inside the click that asked for it.
 *   Create it after `await getUserMedia()` and the permission prompt has
 *   already used up the gesture: Safari hands back a suspended context, the
 *   graph never pulls, and the recording is silently empty.
 * - A context must not be forced to 16 kHz when a microphone is attached.
 *   Firefox refuses to connect a stream to a context at a different rate from
 *   the device. Capture at the device rate and resample afterwards.
 * - Web Audio output on iOS is muted by the ring/silent switch; a media
 *   element is not. Playback goes through an `<audio>` element for that
 *   reason alone.
 */

type AudioContextCtor = typeof AudioContext;

function audioContextCtor(): AudioContextCtor | null {
  if (typeof window === "undefined") return null;
  return (
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext ??
    null
  );
}

/** Average a buffer down to the target rate. */
export function resample(input: Float32Array, from: number, to: number): Float32Array {
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

export type MicCapture = {
  /** Resolves once audio is flowing; rejects with a sentence fit to show a reader. */
  ready: Promise<void>;
  /** Stop, release the microphone, and return what was heard at `rate`. */
  stop: () => Promise<Float32Array>;
  /** Stop and discard. Safe to call more than once. */
  cancel: () => void;
};

/**
 * Start recording from the default microphone.
 *
 * **Call this synchronously from the click handler** — before any `await` —
 * so the AudioContext is created while the gesture is still live.
 *
 * `onProgress` reports seconds captured and the latest block's RMS, so the
 * page can show that audio is actually arriving rather than asking the reader
 * to trust a red dot.
 */
export function startMicCapture(
  rate: number,
  onProgress?: (seconds: number, rms: number) => void,
): MicCapture {
  const Ctor = audioContextCtor();
  if (!Ctor || !navigator.mediaDevices?.getUserMedia) {
    const failed = Promise.reject(new Error("This browser has no microphone API."));
    return { ready: failed, stop: async () => new Float32Array(0), cancel: () => {} };
  }

  // Created and resumed inside the gesture. Deliberately no `sampleRate`
  // option: see the note at the top of the file.
  const ctx = new Ctor();
  void ctx.resume();

  const chunks: Float32Array[] = [];
  let captured = 0;
  let stream: MediaStream | null = null;
  let released = false;

  const release = () => {
    if (released) return;
    released = true;
    stream?.getTracks().forEach((t) => t.stop());
    void ctx.close();
  };

  const ready = (async () => {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        // The raw signal. Browser noise suppression exists to remove exactly
        // the knocks and clicks these experiments want you to hear, and gain
        // control flattens the loudness differences they measure.
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
    } catch (error) {
      release();
      const name = error instanceof DOMException ? error.name : "";
      throw new Error(
        name === "NotAllowedError"
          ? "Microphone access was declined."
          : name === "NotFoundError"
            ? "No microphone was found."
            : "The microphone could not be opened.",
      );
    }
    if (released) {
      stream.getTracks().forEach((t) => t.stop());
      throw new Error("Recording was cancelled.");
    }

    // A second attempt in case the prompt suspended it; bounded, because a
    // resume the browser will not grant never settles.
    await Promise.race([ctx.resume(), new Promise((r) => setTimeout(r, 1000))]);
    if (ctx.state !== "running") {
      release();
      throw new Error("The browser kept audio paused for this page. Press Record again.");
    }

    const source = ctx.createMediaStreamSource(stream);
    // ScriptProcessor rather than an AudioWorklet: a worklet needs a separate
    // module URL, which a source-only package cannot ship without forcing a
    // bundler configuration on whoever installs it.
    const processor = ctx.createScriptProcessor(4096, 1, 1);
    processor.onaudioprocess = (event) => {
      if (released) return;
      const block = Float32Array.from(event.inputBuffer.getChannelData(0));
      chunks.push(block);
      captured += block.length;
      let sum = 0;
      for (let i = 0; i < block.length; i += 1) sum += block[i] * block[i];
      onProgress?.(captured / ctx.sampleRate, Math.sqrt(sum / block.length));
    };
    source.connect(processor);
    // Routed to a silent gain node: without a path to the destination the
    // graph does not pull, but connecting it directly would echo the room.
    const mute = ctx.createGain();
    mute.gain.value = 0;
    processor.connect(mute);
    mute.connect(ctx.destination);
  })();
  // The caller awaits `ready`; this only keeps an unobserved rejection quiet.
  ready.catch(() => {});

  return {
    ready,
    stop: async () => {
      const deviceRate = ctx.sampleRate;
      release();
      const joined = new Float32Array(captured);
      let at = 0;
      for (const chunk of chunks) {
        joined.set(chunk, at);
        at += chunk.length;
      }
      return resample(joined, deviceRate, rate);
    },
    cancel: release,
  };
}

/** True when a recording is, to all intents, digital silence. */
export function isSilent(signal: Float32Array): boolean {
  let peak = 0;
  for (let i = 0; i < signal.length; i += 1) peak = Math.max(peak, Math.abs(signal[i]));
  return peak < 1e-4;
}

/** 16-bit mono PCM WAV, the one format every media element plays. */
export function encodeWav(signal: Float32Array, sampleRate: number): Blob {
  const bytes = new ArrayBuffer(44 + signal.length * 2);
  const view = new DataView(bytes);
  const text = (at: number, s: string) => {
    for (let i = 0; i < s.length; i += 1) view.setUint8(at + i, s.charCodeAt(i));
  };
  text(0, "RIFF");
  view.setUint32(4, 36 + signal.length * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, signal.length * 2, true);
  for (let i = 0; i < signal.length; i += 1) {
    const s = Math.max(-1, Math.min(1, signal[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([bytes], { type: "audio/wav" });
}

/**
 * Play a signal back, reporting progress.
 *
 * `onProgress` receives seconds elapsed while playing and `null` once it has
 * stopped, for whatever reason. `onError` receives a sentence to show if the
 * browser refuses to play at all.
 *
 * Returns a stop function. Call it synchronously from a click handler.
 */
export function playSignal(
  signal: Float32Array,
  sampleRate: number,
  onProgress: (seconds: number | null) => void,
  onError?: (message: string) => void,
): () => void {
  const url = URL.createObjectURL(encodeWav(signal, sampleRate));
  const audio = new Audio(url);
  let frame = 0;
  let stopped = false;

  const finish = () => {
    if (stopped) return;
    stopped = true;
    cancelAnimationFrame(frame);
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
    URL.revokeObjectURL(url);
    onProgress(null);
  };

  const tick = () => {
    if (stopped) return;
    onProgress(audio.currentTime);
    frame = requestAnimationFrame(tick);
  };

  audio.onended = finish;
  audio.onerror = () => {
    // Clearing the source in finish() raises an error event of its own.
    if (stopped) return;
    onError?.("The browser could not play this audio.");
    finish();
  };
  onProgress(0);
  audio.play().then(
    () => {
      if (!stopped) frame = requestAnimationFrame(tick);
    },
    () => {
      if (stopped) return;
      onError?.("The browser blocked playback. Press Play again.");
      finish();
    },
  );
  return finish;
}

/**
 * Fetch and decode an audio file to mono at `rate`.
 *
 * Decoding needs an AudioContext but not a user gesture, so this is safe to
 * call on mount to have clips ready before anyone presses Play — which matters,
 * because a play() that waits on a fetch has usually lost its gesture by the
 * time it runs.
 */
export async function loadAudio(url: string, rate: number): Promise<Float32Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not fetch ${url}: ${response.status}`);
  const bytes = await response.arrayBuffer();
  const Ctor = audioContextCtor();
  if (!Ctor) throw new Error("This browser has no Web Audio API.");
  const ctx = new Ctor();
  try {
    const buffer = await ctx.decodeAudioData(bytes);
    return resample(Float32Array.from(buffer.getChannelData(0)), buffer.sampleRate, rate);
  } finally {
    void ctx.close();
  }
}
