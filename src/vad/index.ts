/**
 * Energy versus neural voice activity detection.
 *
 * `VadCompare` is the demo. `energy` is plain TypeScript with no dependencies;
 * `silero` wraps the ONNX model and imports onnxruntime-web dynamically, so
 * neither it nor its WebAssembly is fetched until a reader asks for it.
 *
 * The model weights and the sample clip are binary, and a source-only package
 * cannot ship binaries through `exports` — the host serves them and passes
 * their URLs in. See src/vad/assets/README.md.
 */
export { default as VadCompare, type VadCompareProps } from "./VadCompare";
export * from "./energy";
export * from "./silero";
export * from "./audio";
