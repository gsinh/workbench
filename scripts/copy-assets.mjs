/**
 * Stage the data files the VAD experiment loads at runtime.
 *
 * Only the model and the sample clip: they are plain data that a static host
 * serves untouched, which is exactly what a host application does with them.
 *
 * onnxruntime's own runtime files are not copied. The package exports them as
 * subpaths, so the harness resolves them through the bundler instead — see
 * dev/main.tsx.
 */
import { cp, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(root, "public/vad");

await mkdir(target, { recursive: true });
for (const file of ["silero_vad.onnx", "speech-sample.wav"]) {
  await cp(join(root, "src/vad/assets", file), join(target, file));
}
console.log("assets: 2 vad file(s) -> public/vad");
