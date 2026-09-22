/**
 * Silero VAD v5, running in WebAssembly.
 *
 * A 2.3 MB neural voice-activity detector, MIT licensed, and the production
 * default for this job. It is here to be compared against the energy detector
 * in `energy.ts` — the one the latency-budget and diarization experiments both
 * use, and whose limits both of them admit to.
 *
 * Nothing is uploaded. The weights come down once from wherever the host
 * serves them; the audio never leaves the page.
 *
 * The one thing that is easy to get wrong, and which fails silently rather
 * than throwing: v5 keeps a 64-sample context that is concatenated *outside*
 * the graph. Feed it a bare 512-sample frame and inference runs, returns no
 * error, and reports about 0.001 for every frame of perfectly good speech.
 * The model input is 576 samples — the previous frame's tail, then the frame.
 */

import type { InferenceSession, Tensor, env as OrtEnv } from "onnxruntime-web";

/** Samples per decision at 16 kHz. */
export const FRAME = 512;
/** Samples of previous audio prepended before inference. */
export const CONTEXT = 64;
/** The only sample rate this wrapper configures. */
export const SAMPLE_RATE = 16000;

type Ort = {
  InferenceSession: { create: typeof InferenceSession.create };
  Tensor: new (
    type: string,
    data: Float32Array | BigInt64Array,
    dims?: readonly number[],
  ) => Tensor;
  env: typeof OrtEnv;
};

export type SileroOptions = {
  /** Where the host serves silero_vad.onnx. */
  modelUrl: string;
  /**
   * Directory holding onnxruntime's own .wasm binaries. The runtime otherwise
   * fetches them from a public CDN, which a page claiming to keep everything
   * local should not be quietly doing.
   */
  wasmPaths?: string;
};

export class SileroVad {
  #session: InferenceSession;
  #ort: Ort;
  #state: Tensor;
  #context = new Float32Array(CONTEXT);
  #sr: Tensor;

  private constructor(ort: Ort, session: InferenceSession) {
    this.#ort = ort;
    this.#session = session;
    this.#state = new ort.Tensor("float32", new Float32Array(2 * 128), [2, 1, 128]);
    this.#sr = new ort.Tensor("int64", BigInt64Array.from([BigInt(SAMPLE_RATE)]), []);
  }

  /**
   * Load the model. `onnxruntime-web` is imported dynamically so that it —
   * and its WebAssembly — only arrive when a reader actually asks for the
   * neural detector, rather than on every page that mounts the component.
   */
  static async load({ modelUrl, wasmPaths }: SileroOptions): Promise<SileroVad> {
    const ort = (await import("onnxruntime-web")) as unknown as Ort;
    if (wasmPaths) ort.env.wasm.wasmPaths = wasmPaths;
    // Single-threaded: cross-origin isolation is required for threads, and a
    // static site generally cannot set the COOP/COEP headers that need.
    ort.env.wasm.numThreads = 1;
    ort.env.logLevel = "error";

    const response = await fetch(modelUrl);
    if (!response.ok) throw new Error(`Could not fetch the model: ${response.status}`);
    const weights = new Uint8Array(await response.arrayBuffer());
    const session = await ort.InferenceSession.create(weights, {
      executionProviders: ["wasm"],
    });
    return new SileroVad(ort, session);
  }

  /** Forget the conversation so far. */
  reset(): void {
    this.#state = new this.#ort.Tensor("float32", new Float32Array(2 * 128), [2, 1, 128]);
    this.#context = new Float32Array(CONTEXT);
  }

  /** Speech probability for one 512-sample frame. */
  async process(frame: Float32Array): Promise<number> {
    if (frame.length !== FRAME) {
      throw new Error(`Expected ${FRAME} samples, received ${frame.length}.`);
    }
    const input = new Float32Array(CONTEXT + FRAME);
    input.set(this.#context, 0);
    input.set(frame, CONTEXT);

    const result = await this.#session.run({
      input: new this.#ort.Tensor("float32", input, [1, CONTEXT + FRAME]),
      state: this.#state,
      sr: this.#sr,
    });

    this.#state = result.stateN as Tensor;
    this.#context = frame.slice(FRAME - CONTEXT);
    return (result.output as Tensor).data[0] as number;
  }

  /** Run over a whole signal, one probability per frame. */
  async processAll(signal: Float32Array): Promise<Float32Array> {
    this.reset();
    const count = Math.floor(signal.length / FRAME);
    const out = new Float32Array(count);
    for (let i = 0; i < count; i += 1) {
      out[i] = await this.process(signal.subarray(i * FRAME, (i + 1) * FRAME));
    }
    return out;
  }
}
