#!/usr/bin/env node
/**
 * Record what Laya decides, word by word, for each scripted call.
 *
 * Laya is an open "System One" decision model (Convai Innovations, weights
 * Apache-2.0, run here through @receptron/laya). It does not write text: given
 * a state and typed questions, it returns calibrated probabilities in one
 * forward pass. This script replays each caller turn in
 * src/system-one/scenarios.json one word at a time and asks every question
 * after every word — the way a voice agent would, as the transcript streams in.
 *
 * The page does not run the model; it replays this file. So everything it
 * shows is a real Laya output, recorded once, with the conditions it was
 * recorded under written into the file.
 *
 * Run it (Node 20+; the first run downloads ~1.7 GB of weights from Hugging
 * Face and caches them under ~/.cache/receptron-laya):
 *
 *   npm install --no-save @receptron/laya@0.1.2
 *   node scripts/record-decisions.mjs
 *
 * Options:
 *   --dry-run        Check the scenarios and questions, print the plan, load nothing.
 *   --out <path>     Where to write (default: src/system-one/decisions.json).
 *   --revision <rev> Hugging Face revision of the ONNX bundle (default: main;
 *                    or set LAYA_REVISION). Pin a commit hash to reproduce a run.
 *   --model-dir <d>  Use an ONNX bundle already on disk instead of downloading.
 *   --mock           Use a fake model that returns uniform answers. For testing
 *                    this script only; refuses to write to the default path.
 */

import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCENARIOS = path.join(ROOT, "src/system-one/scenarios.json");
const DEFAULT_OUT = path.join(ROOT, "src/system-one/decisions.json");
const PACKAGE = "@receptron/laya";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const dryRun = flag("--dry-run");
const mock = flag("--mock");
const out = path.resolve(option("--out") ?? DEFAULT_OUT);
const revision = option("--revision") ?? process.env.LAYA_REVISION ?? "main";
const modelDir = option("--model-dir");

if (mock && out === DEFAULT_OUT) {
  console.error("--mock writes fake answers; pass --out somewhere other than the real decisions file.");
  process.exit(1);
}

const spec = JSON.parse(await readFile(SCENARIOS, "utf8"));
const { questions, scenarios } = spec;

/* ------------------------------------------------------------------ */
/* Validate before anything is loaded                                  */
/* ------------------------------------------------------------------ */

const problems = [];
for (const [id, q] of Object.entries(questions)) {
  if (!["choice", "score", "noul"].includes(q.type)) problems.push(`${id}: unknown type ${q.type}`);
  if (q.type === "choice") {
    const names = Array.isArray(q.criteria) ? q.criteria : Object.keys(q.criteria ?? {});
    if (names.length < 2) problems.push(`${id}: a choice needs at least two options`);
    if (names.length >= 20) problems.push(`${id}: Laya recommends fewer than 20 options`);
    for (const [name, text] of Object.entries(q.criteria ?? {})) {
      // A rough bound: Laya cuts each option to 48 tokens; ~5 characters a token.
      if (`${name}: ${text ?? ""}`.length > 200) problems.push(`${id}.${name}: option text is long enough to be cut`);
    }
  }
  if (q.type === "score" && (!Array.isArray(q.criteria) || q.criteria.length < 2)) {
    problems.push(`${id}: a score needs at least two ordered levels`);
  }
}
for (const s of scenarios) {
  if (!s.id || !s.caller || !s.agent) problems.push(`scenario ${s.id ?? "?"}: needs id, agent and caller`);
  const words = s.caller.split(/\s+/).filter(Boolean);
  if (s.pauseAfterWord !== undefined && (s.pauseAfterWord < 1 || s.pauseAfterWord >= words.length)) {
    problems.push(`${s.id}: pauseAfterWord ${s.pauseAfterWord} is outside the turn`);
  }
}
if (problems.length > 0) {
  console.error("scenarios.json has problems:\n  " + problems.join("\n  "));
  process.exit(1);
}

const plan = scenarios.map((s) => ({ id: s.id, words: s.caller.split(/\s+/).filter(Boolean) }));
const calls = plan.reduce((n, s) => n + s.words.length, 0);
console.log(
  `${scenarios.length} scenarios, ${calls} decisions (one per word), ${Object.keys(questions).length} questions each.`,
);
if (dryRun) {
  for (const s of plan) console.log(`  ${s.id}: ${s.words.length} words`);
  console.log("Dry run: nothing loaded, nothing written.");
  process.exit(0);
}

/* ------------------------------------------------------------------ */
/* Load the model                                                      */
/* ------------------------------------------------------------------ */

let laya;
let packageVersion = "mock";
if (mock) {
  laya = mockLaya();
} else {
  let mod;
  try {
    mod = await import(PACKAGE);
  } catch {
    console.error(`${PACKAGE} is not installed. Run:\n  npm install --no-save ${PACKAGE}@0.1.2`);
    process.exit(1);
  }
  try {
    const pkg = JSON.parse(
      await readFile(path.join(ROOT, "node_modules", PACKAGE, "package.json"), "utf8"),
    );
    packageVersion = pkg.version;
  } catch {
    packageVersion = "unknown";
  }
  console.log(
    modelDir
      ? `Loading Laya from ${modelDir}…`
      : `Loading Laya (revision ${revision}); the first run downloads ~1.7 GB…`,
  );
  let lastLogged = 0;
  try {
    laya = await mod.Laya.load({
      ...(modelDir ? { modelDir: path.resolve(modelDir) } : { revision }),
      onProgress: ({ file, received, total }) => {
        const now = Date.now();
        if (total && now - lastLogged > 2000) {
          lastLogged = now;
          console.log(`  ${file}: ${Math.round((received / total) * 100)}%`);
        }
      },
    });
  } catch (error) {
    console.error(`\nCould not load Laya: ${error instanceof Error ? error.message : error}`);
    console.error(
      modelDir
        ? "Check that the directory holds laya.onnx, laya.onnx.data, laya_config.json and tokenizer/."
        : "The weights come from huggingface.co. Check the connection (and any proxy), or download the\n" +
            "bundle another way and pass --model-dir <dir>.",
    );
    process.exit(1);
  }
}

/* ------------------------------------------------------------------ */
/* Record                                                              */
/* ------------------------------------------------------------------ */

// One warm-up call, so the first recorded latency is not the cold start.
await laya.systemOne({ agent_said: "Hello.", caller_so_far: "Hi." }, questions);

const round = (x, places = 4) => Math.round(x * 10 ** places) / 10 ** places;
const roundAll = (probs) => Object.fromEntries(Object.entries(probs).map(([k, v]) => [k, round(v)]));

const recorded = [];
const latencies = [];
for (const scenario of scenarios) {
  const words = scenario.caller.split(/\s+/).filter(Boolean);
  const steps = [];
  for (let k = 1; k <= words.length; k += 1) {
    // The state is what a streaming voice agent has at this moment: what it
    // last said, and the caller's words so far.
    const state = { agent_said: scenario.agent, caller_so_far: words.slice(0, k).join(" ") };
    const started = performance.now();
    const result = await laya.systemOne(state, questions);
    const ms = performance.now() - started;
    latencies.push(ms);

    const answers = {};
    for (const [id, answer] of Object.entries(result.answers)) {
      if (answer.type === "noul") answers[id] = { p: round(answer.noul) };
      else if (answer.type === "choice") {
        answers[id] = { choice: answer.choice, probs: roundAll(answer.probabilities), confidence: round(answer.confidence) };
      } else {
        answers[id] = { score: round(answer.score), probs: roundAll(answer.probabilities), confidence: round(answer.confidence) };
      }
    }
    steps.push({ words: k, text: state.caller_so_far, ms: round(ms, 1), answers });
    const done = answers.turn_complete?.p;
    process.stdout.write(
      `  ${scenario.id} ${String(k).padStart(2)}/${words.length}  done=${done?.toFixed(2)}  intent=${answers.intent?.choice}  reply=${answers.reply?.choice}  ${ms.toFixed(0)} ms\n`,
    );
  }
  recorded.push({ id: scenario.id, steps });
}

await laya.close?.();

/* ------------------------------------------------------------------ */
/* Write, with the conditions it was recorded under                    */
/* ------------------------------------------------------------------ */

const sorted = [...latencies].sort((a, b) => a - b);
const pct = (p) => round(sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))], 1);

// Fingerprint the bundle that was actually used, so a later run can tell
// whether it is comparing like with like.
let bundle = null;
if (!mock && laya.modelDir) {
  try {
    const config = await readFile(path.join(laya.modelDir, "laya_config.json"));
    const weights = await stat(path.join(laya.modelDir, "laya.onnx.data"));
    bundle = {
      configSha256: createHash("sha256").update(config).digest("hex"),
      weightsBytes: weights.size,
    };
  } catch {
    bundle = null;
  }
}

const output = {
  $comment:
    "Generated by scripts/record-decisions.mjs from scenarios.json. Real Laya outputs; do not edit by hand. Re-run the script to regenerate.",
  model: mock ? "mock (not Laya)" : "Laya (Convai Innovations, Apache-2.0) via @receptron/laya",
  package: `${PACKAGE}@${packageVersion}`,
  revision: mock ? null : modelDir ? `local bundle` : revision,
  bundle,
  recordedAt: new Date().toISOString(),
  machine: {
    platform: `${os.platform()} ${os.release()}`,
    arch: os.arch(),
    cpu: os.cpus()[0]?.model ?? "unknown",
    cores: os.cpus().length,
    node: process.version,
  },
  latencyMs: { median: pct(0.5), p90: pct(0.9), min: round(sorted[0], 1), max: round(sorted.at(-1), 1), calls: sorted.length },
  questions,
  scenarios: recorded,
};

await writeFile(out, JSON.stringify(output, null, 2) + "\n");
console.log(
  `\nWrote ${path.relative(process.cwd(), out)}: ${calls} decisions, median ${output.latencyMs.median} ms, p90 ${output.latencyMs.p90} ms per call.`,
);

/* ------------------------------------------------------------------ */

/** A stand-in with Laya's shape and uniform answers, for testing this script. */
function mockLaya() {
  const uniform = (names) => Object.fromEntries(names.map((n) => [n, 1 / names.length]));
  return {
    modelDir: null,
    async systemOne(_state, qs) {
      const answers = {};
      for (const [id, q] of Object.entries(qs)) {
        if (q.type === "noul") answers[id] = { type: "noul", noul: 0.5, rl_agent: { act_probability: 0.5 } };
        else {
          const names = Array.isArray(q.criteria) ? q.criteria : Object.keys(q.criteria);
          const probabilities = uniform(q.type === "score" ? names.map((_, i) => String(i)) : names);
          answers[id] =
            q.type === "choice"
              ? { type: "choice", choice: names[0], probabilities, confidence: 0, rl_agent: { act_probability: 0.5 } }
              : { type: "score", score: (names.length - 1) / 2, legend: {}, probabilities, confidence: 0, rl_agent: { act_probability: 0.5 } };
        }
      }
      return { model: "mock", answers, usage: { input_tokens: 0, output_tokens: 0 } };
    },
    async close() {},
  };
}
