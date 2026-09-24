/**
 * Stage the data files the experiments load at runtime.
 *
 * Only the model and the sample clip: they are plain data that a static host
 * serves untouched, which is exactly what a host application does with them.
 *
 * onnxruntime's own runtime files are not copied. The package exports them as
 * subpaths, so the harness resolves them through the bundler instead — see
 * dev/main.tsx.
 */
import { cp, mkdir, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(root, "public/vad");

await mkdir(target, { recursive: true });
for (const file of ["silero_vad.onnx", "speech-sample.wav"]) {
  await cp(join(root, "src/vad/assets", file), join(target, file));
}

// The latency budget's call player: six short voice clips.
const voices = join(root, "public/voice-latency");
const clips = (await readdir(join(root, "src/voice-latency/assets"))).filter((f) =>
  f.endsWith(".wav"),
);
await mkdir(voices, { recursive: true });
for (const file of clips) {
  await cp(join(root, "src/voice-latency/assets", file), join(voices, file));
}
// The System One experiment: its scenarios, the recorded Laya decisions (if
// scripts/record-decisions.mjs has been run), the word timings and the clips.
const systemOne = join(root, "public/system-one");
await mkdir(systemOne, { recursive: true });
const s1Files = ["scenarios.json", "decisions.json"];
let s1 = 0;
for (const file of s1Files) {
  try {
    await cp(join(root, "src/system-one", file), join(systemOne, file));
    s1 += 1;
  } catch {
    // decisions.json does not exist until the recording script has run.
  }
}
for (const file of await readdir(join(root, "src/system-one/assets"))) {
  await cp(join(root, "src/system-one/assets", file), join(systemOne, file));
  s1 += 1;
}
console.log(
  `assets: 2 vad file(s) -> public/vad, ${clips.length} clip(s) -> public/voice-latency, ${s1} file(s) -> public/system-one`,
);
