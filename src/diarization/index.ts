/**
 * Speaker diarization from first principles.
 *
 * `Diarize` is the demo. `dsp` and `cluster` are plain TypeScript with no
 * React and no browser APIs — framing, MFCCs, voice activity, embeddings and
 * clustering — so the pipeline can be run over a Float32Array anywhere,
 * including in a test. `synth` generates the sample conversation and scores a
 * result against its known script.
 */
export { default as Diarize } from "./Diarize";
export * from "./dsp";
export * from "./cluster";
export * from "./synth";
