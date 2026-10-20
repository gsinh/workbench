#!/usr/bin/env python3
"""
Record how long two 8B agents reason before they can answer, for the
"thinking without words" experiment.

  A  HybridAgent-8B-Agentic (Together AI, MIT): reasons partly in latent space —
     hidden states fed back through its HybridLink adapter, no token decoded —
     and partly in text. Run through the repo's own engine.
  B  Qwen3-8B with thinking on: the same family and size, reasoning in text
     only. Run through a minimal agent loop written here.

Both get the same questions, GPU, sampling, step budget, tool caps and the
same Python tool (the HybridAgent repo's PythonTool). Neither gets search: the
questions carry every number they need, and a search call is answered "not
available". Each question is run with several seeds, one at a time (batch 1).

For each run the file records the answer and whether it is right, the steps
taken (text tokens, latent steps, tool calls), the time until the final
answer starts — for a voice agent, the reasoning's share of the reply delay —
and the full trace: every latent step's nearest tokens for A, the <think> text
for B. The page replays this file; it does not run either model.

Read the confound before quoting a result: A and B differ in post-training
(A was RL-trained on agentic tasks) as well as in latent reasoning, so a gap
measures both together.

Usage (one NVIDIA GPU with 24 GB or more; models load one at a time):

  pip install "git+https://github.com/togethercomputer/HybridAgent.git"
  python scripts/record-hybrid.py

  --dry-run          Check the questions and the answer matcher. Loads nothing.
  --mock             Write fake runs for building the page. Refuses the real path.
  --only a|b         Record one model; merges into an existing output file.
  --seeds N          Seeds per question per model (default 3).
  --out PATH         Default: src/hybrid-agent/runs.json

The Python tool runs code the models write, in a subprocess with a timeout and
a memory cap — guardrails, not a sandbox. Run this on a rented GPU or a
Hugging Face Space (see space/), not on a machine holding secrets.
"""
from __future__ import annotations

import argparse
import json
import platform
import random
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
QUESTIONS = ROOT / "src/hybrid-agent/questions.json"
DEFAULT_OUT = ROOT / "src/hybrid-agent/runs.json"

HYBRID_MODEL = "togethercomputer/HybridAgent-8B-Agentic"
TEXT_MODEL = "Qwen/Qwen3-8B"

# The HybridAgent repo's inference defaults (interpretable_latent_mode
# GENERATION_DEFAULTS), applied to both models.
SETTINGS = dict(
    max_response_tokens=4096,  # text tokens + latent steps
    max_tool_calls=5,
    max_search_calls=5,
    max_python_calls=5,
    terminate_on_tool_cap=True,
    max_turns=30,
    temperature=0.6,
    top_p=0.95,
    top_k=20,
    repetition_penalty=1.1,
    min_latent_steps=4,
    max_latent_steps=200,
)
PYTHON_TIMEOUT_S = 120
READOUT_TOP_K = 3
NO_SEARCH = "Search is not available in this run. Use the numbers in the question and the python tool."


# --------------------------------------------------------------------------
# Questions and scoring (no torch needed)
# --------------------------------------------------------------------------

def load_questions() -> list[dict]:
    return json.loads(QUESTIONS.read_text())["questions"]


# A thousands separator only when three digits follow it, so "1,25" is not 125.
_NUMBER = re.compile(r"-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d+(?:\.\d+)?")


def matches(prediction: str, rule: dict) -> bool:
    """Score a prediction: the first number in it, compared within a tolerance."""
    if not prediction:
        return False
    text = prediction.replace("\\,", "").replace("{,}", "")
    found = _NUMBER.search(text)
    if not found:
        return False
    try:
        value = float(found.group().replace(",", ""))
    except ValueError:
        return False
    if rule["type"] == "number":
        return abs(value - rule["value"]) <= rule.get("tolerance", 0) + 1e-9
    raise ValueError(f"unknown match type {rule['type']}")


def check_questions(questions: list[dict]) -> list[str]:
    problems = []
    seen = set()
    for q in questions:
        for key in ("id", "question", "answer", "match"):
            if key not in q:
                problems.append(f"{q.get('id', '?')}: missing {key}")
        if q["id"] in seen:
            problems.append(f"{q['id']}: duplicate id")
        seen.add(q["id"])
        if not matches(q["answer"], q["match"]):
            problems.append(f"{q['id']}: its own answer {q['answer']!r} does not match its rule")
        # The matcher must also reject a near miss and accept a boxed, formatted answer.
        if matches(str(q["match"]["value"] + 1), q["match"]):
            problems.append(f"{q['id']}: the rule accepts a wrong answer")
        if not matches(f"\\boxed{{{q['answer']}}}", q["match"]):
            problems.append(f"{q['id']}: the rule rejects the boxed answer")
    return problems


# --------------------------------------------------------------------------
# Shared helpers
# --------------------------------------------------------------------------

def median(values: list[float]) -> float | None:
    values = sorted(v for v in values if v is not None)
    if not values:
        return None
    mid = len(values) // 2
    return values[mid] if len(values) % 2 else (values[mid - 1] + values[mid]) / 2


def step_summary(log: list[tuple[str, float]]) -> dict:
    """Median milliseconds per generation step, by kind."""
    out = {}
    for kind in ("text", "latent"):
        times = [dt * 1000 for k, dt in log if k == kind]
        out[kind] = round(median(times), 2) if times else None
    return out


def segment_dicts(segments) -> list[dict]:
    """Trace segments in the page's compact shape."""
    out = []
    for s in segments:
        d = {"kind": s.kind}
        if s.text:
            d["text"] = s.text
        if s.tool:
            d["tool"] = s.tool
        if s.kind == "latent":
            d["exit"] = s.exit
            d["steps"] = [
                {
                    "t": st.token,
                    "c": round(float(st.cosine), 3),
                    "alt": [[tok, round(float(cos), 3)] for tok, _tid, cos in st.candidates[1:]],
                }
                for st in s.steps
            ]
        out.append(d)
    return out


def revision_of(model_id: str) -> str | None:
    try:
        from huggingface_hub import HfApi

        return HfApi().model_info(model_id).sha
    except Exception:
        return None


def pick_device():
    import torch

    if torch.cuda.is_available():
        return torch.device("cuda")
    if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        return torch.device("mps")
    return torch.device("cpu")


def synchronize(device) -> None:
    import torch

    if device.type == "cuda":
        torch.cuda.synchronize()
    elif device.type == "mps":
        torch.mps.synchronize()


def tool_executor():
    """The repo's Python tool, plus a search tool that always declines."""
    from hybrid_agent.tools import BaseTool, PythonTool, ToolExecutor

    class NoSearch(BaseTool):
        @property
        def name(self) -> str:
            return "search_unavailable"

        @property
        def trigger_tag(self) -> str:
            return "search"

        def execute(self, content: str, **kwargs) -> str:
            return NO_SEARCH

    executor = ToolExecutor()
    executor.register_tool(PythonTool(python_path=sys.executable, timeout=PYTHON_TIMEOUT_S))
    executor.register_tool(NoSearch())
    return executor


# --------------------------------------------------------------------------
# A: HybridAgent, through the repo's engine
# --------------------------------------------------------------------------

def record_hybrid(questions, seeds, log) -> tuple[list[dict], dict]:
    import torch
    from hybrid_agent import DECODE, FEED, LATENT, SYSTEM_PROMPT, extract_answer, load_hybrid_agent
    from hybrid_agent.readout import latent_readout
    from interpretable_latent_mode import LatentRecordingEngine, LatentStep, Segment, parse_segments

    device = pick_device()
    log(f"Loading {HYBRID_MODEL} on {device}…")
    model, tokenizer = load_hybrid_agent(HYBRID_MODEL, device=device)
    model.eval()
    executor = tool_executor()
    embed_weight = model.backbone.get_input_embeddings().weight

    class TimedEngine(LatentRecordingEngine):
        """The repo's recording engine, plus a wall-clock time for every step and
        the moment the final <answer> starts."""

        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            self.step_log: list[tuple[str, float]] = []
            self.answer_at: float | None = None
            self._t0 = 0.0

        def run(self, rng=None):
            synchronize(self.device)
            self._t0 = time.perf_counter()
            super().run(rng)

        def _decode_step(self, rng):
            row = self.rows[0]
            kind = {DECODE: "text", LATENT: "latent", FEED: "feed"}.get(row.mode)
            synchronize(self.device)
            started = time.perf_counter()
            super()._decode_step(rng)
            synchronize(self.device)
            if kind:
                self.step_log.append((kind, time.perf_counter() - started))
            if self.answer_at is None and kind == "text" and "<answer>" in self._row_tail(row):
                self.answer_at = time.perf_counter() - self._t0

    def one(question: str, seed: int):
        engine = TimedEngine(
            model, tokenizer, device, executor, SYSTEM_PROMPT, question, batch_size=1, **SETTINGS,
        )
        engine.run(torch.Generator(device=device).manual_seed(seed))
        row = engine.rows[0]
        result = engine.row_result(row)
        spans = []
        for vectors, readout in zip(engine.spans[row.idx], row.latent_spans):
            steps = []
            if vectors:
                cands = latent_readout(torch.stack(vectors), embed_weight, tokenizer, top_k=READOUT_TOP_K)
                for i, c in enumerate(cands):
                    token, token_id, cosine = c[0]
                    steps.append(LatentStep(index=i, token=token, token_id=token_id, cosine=cosine, candidates=c))
            spans.append(Segment(kind="latent", steps=steps, exit=readout.exit, pseudo_text=readout.pseudo_text))
        return engine, result, spans

    log("Warm-up run…")
    one(questions[0]["question"], seed=1234)

    runs = []
    for q in questions:
        for seed in range(seeds):
            engine, result, spans = one(q["question"], seed)
            prediction = extract_answer(result["output"])
            text_tokens = result["generation_steps"] - result["latent_steps"]
            run = {
                "model": "hybrid",
                "question": q["id"],
                "seed": seed,
                "prediction": prediction,
                "correct": matches(prediction, q["match"]),
                "msBeforeAnswer": round(engine.answer_at * 1000) if engine.answer_at is not None else None,
                "totalMs": round(engine.total_time * 1000),
                "llmMs": round(engine.llm_time * 1000),
                "toolMs": round(engine.tool_time * 1000),
                "forwardPasses": result["generation_steps"],
                "textTokens": text_tokens,
                "latentSteps": result["latent_steps"],
                "latentSpans": result["latent_spans"],
                "pythonCalls": result["python_calls"],
                "searchCalls": result["search_calls"],
                "endReason": result["end_reason"],
                "stepMs": step_summary(engine.step_log),
                "segments": segment_dicts(parse_segments(result["output"], spans)),
            }
            runs.append(run)
            log(
                f"  A {q['id']:<10} seed {seed}  {'✓' if run['correct'] else '✗'} {prediction!r:<10} "
                f"answer at {run['msBeforeAnswer']} ms  {text_tokens} text + {run['latentSteps']} latent"
            )

    meta = {"id": HYBRID_MODEL, "revision": revision_of(HYBRID_MODEL), "loop": "HybridAgent repo engine"}
    del model
    _free(device)
    return runs, meta


# --------------------------------------------------------------------------
# B: Qwen3-8B with thinking, through a minimal loop written here
# --------------------------------------------------------------------------

def text_only_prompt() -> str:
    """HybridAgent's system prompt with the latent-mode instructions taken out, so
    both agents are told the same format, tools and answer convention."""
    from hybrid_agent import SYSTEM_PROMPT

    lines = [l for l in SYSTEM_PROMPT.split("\n") if not l.startswith("- <latent>")]
    prompt = "\n".join(lines)
    return prompt.replace("<latent>This is the latent reasoning process.</latent>", " ")


def record_text(questions, seeds, log) -> tuple[list[dict], dict]:
    import torch
    from hybrid_agent import extract_answer
    from interpretable_latent_mode import parse_segments
    from transformers import AutoModelForCausalLM, AutoTokenizer, StoppingCriteria, StoppingCriteriaList

    device = pick_device()
    log(f"Loading {TEXT_MODEL} on {device}…")
    tokenizer = AutoTokenizer.from_pretrained(TEXT_MODEL)
    model = AutoModelForCausalLM.from_pretrained(TEXT_MODEL, dtype=torch.bfloat16).to(device)
    model.eval()
    executor = tool_executor()
    system = text_only_prompt()
    stops = ["</python>", "</search>", "</answer>"]

    class Timer(StoppingCriteria):
        """Never stops generation; times each step and notes when <answer> starts."""

        def __init__(self, t0: float):
            self.t0 = t0
            self.last = None
            self.log: list[tuple[str, float]] = []
            self.answer_at: float | None = None
            self.tail = ""

        def __call__(self, input_ids, scores, **kwargs):
            synchronize(device)
            now = time.perf_counter()
            if self.last is not None:
                self.log.append(("text", now - self.last))
            self.last = now
            self.tail = (self.tail + tokenizer.decode(input_ids[0, -1:]))[-40:]
            if self.answer_at is None and "<answer>" in self.tail:
                self.answer_at = now - self.t0
            return torch.zeros(input_ids.shape[0], dtype=torch.bool, device=input_ids.device)

    def one(question: str, seed: int) -> dict:
        torch.manual_seed(seed)
        messages = [{"role": "system", "content": system}, {"role": "user", "content": question}]
        prompt = tokenizer.apply_chat_template(
            messages, tokenize=False, add_generation_prompt=True, enable_thinking=True,
        )
        ids = tokenizer(prompt, return_tensors="pt").input_ids.to(device)
        synchronize(device)
        t0 = time.perf_counter()
        timer = Timer(t0)
        cache = None
        output = ""
        generated = 0
        python_calls = search_calls = 0
        tool_ms = 0.0
        end_reason = ""
        turns = 1
        while True:
            budget = SETTINGS["max_response_tokens"] - generated
            if budget <= 0:
                end_reason = "budget"
                break
            timer.last = None
            out = model.generate(
                input_ids=ids,
                attention_mask=torch.ones_like(ids),
                past_key_values=cache,
                max_new_tokens=budget,
                do_sample=True,
                temperature=SETTINGS["temperature"],
                top_p=SETTINGS["top_p"],
                top_k=SETTINGS["top_k"],
                repetition_penalty=SETTINGS["repetition_penalty"],
                stop_strings=stops,
                tokenizer=tokenizer,
                stopping_criteria=StoppingCriteriaList([timer]),
                return_dict_in_generate=True,
            )
            new = out.sequences[0, ids.shape[1]:]
            cache = out.past_key_values
            ids = out.sequences
            generated += len(new)
            text = tokenizer.decode(new, skip_special_tokens=False)
            ended = re.search(r"(<\|im_end\|>|<\|endoftext\|>)\s*$", text)
            if ended:
                output += text[: ended.start()]
                end_reason = "eos"
                break
            output += text
            stop = next((s for s in stops if text.rstrip().endswith(s)), None)
            if stop == "</answer>":
                end_reason = "eos"
                break
            if stop is None:
                end_reason = "budget"
                break
            tag = stop[2:-1]
            if python_calls + search_calls >= SETTINGS["max_tool_calls"] or (
                tag == "python" and python_calls >= SETTINGS["max_python_calls"]
            ):
                end_reason = "tool_cap"
                break
            content = executor.extract_content(output, tag)
            started = time.perf_counter()
            if tag == "python":
                python_calls += 1
            else:
                search_calls += 1
            result = executor.execute(tag, content)
            tool_ms += (time.perf_counter() - started) * 1000
            observation = f"<result>{result}</result>"
            output += observation
            turns += 1
            if turns > SETTINGS["max_turns"]:
                end_reason = "max_turns"
                break
            obs_ids = tokenizer(observation, add_special_tokens=False, return_tensors="pt").input_ids.to(device)
            ids = torch.cat([ids, obs_ids], dim=1)
        synchronize(device)
        total = time.perf_counter() - t0
        return {
            "output": output,
            "generated": generated,
            "python_calls": python_calls,
            "search_calls": search_calls,
            "end_reason": end_reason,
            "answer_at": timer.answer_at,
            "total": total,
            "tool_ms": tool_ms,
            "log": timer.log,
        }

    log("Warm-up run…")
    one(questions[0]["question"], seed=1234)

    runs = []
    for q in questions:
        for seed in range(seeds):
            r = one(q["question"], seed)
            prediction = extract_answer(r["output"])
            run = {
                "model": "text",
                "question": q["id"],
                "seed": seed,
                "prediction": prediction,
                "correct": matches(prediction, q["match"]),
                "msBeforeAnswer": round(r["answer_at"] * 1000) if r["answer_at"] is not None else None,
                "totalMs": round(r["total"] * 1000),
                "llmMs": round(r["total"] * 1000 - r["tool_ms"]),
                "toolMs": round(r["tool_ms"]),
                "forwardPasses": r["generated"],
                "textTokens": r["generated"],
                "latentSteps": 0,
                "latentSpans": 0,
                "pythonCalls": r["python_calls"],
                "searchCalls": r["search_calls"],
                "endReason": r["end_reason"],
                "stepMs": step_summary(r["log"]),
                "segments": segment_dicts(parse_segments(r["output"])),
            }
            runs.append(run)
            log(
                f"  B {q['id']:<10} seed {seed}  {'✓' if run['correct'] else '✗'} {prediction!r:<10} "
                f"answer at {run['msBeforeAnswer']} ms  {run['textTokens']} text tokens"
            )

    meta = {"id": TEXT_MODEL, "revision": revision_of(TEXT_MODEL), "loop": "minimal loop in scripts/record-hybrid.py, transformers generate()"}
    del model
    _free(device)
    return runs, meta


def _free(device) -> None:
    import gc

    import torch

    gc.collect()
    if device.type == "cuda":
        torch.cuda.empty_cache()


# --------------------------------------------------------------------------
# Mock data, for building the page only
# --------------------------------------------------------------------------

def mock_runs(questions, seeds) -> tuple[list[dict], dict]:
    rng = random.Random(7)
    words = "So the the answer is is time = distance / speed so let me check with python".split()
    runs = []
    for q in questions:
        for model in ("hybrid", "text"):
            for seed in range(seeds):
                latent = model == "hybrid"
                text_tokens = rng.randint(150, 500) if latent else rng.randint(400, 1400)
                latent_steps = rng.randint(40, 160) if latent else 0
                ms_step = 28.0
                answer_ms = round((text_tokens + latent_steps) * ms_step + rng.randint(200, 900))
                segments = [{"kind": "text", "text": "<think>\nMock reasoning about the question."}]
                if latent:
                    steps = [
                        {"t": rng.choice(words), "c": round(rng.uniform(0.35, 0.98), 3),
                         "alt": [[rng.choice(words), round(rng.uniform(0.2, 0.5), 3)] for _ in range(2)]}
                        for _ in range(rng.randint(8, 24))
                    ]
                    segments.append({"kind": "latent", "exit": "anchor", "steps": steps})
                    segments.append({"kind": "text", "text": "Let me compute it.\n</think>"})
                else:
                    segments[0]["text"] += " " + " ".join(rng.choice(words) for _ in range(120)) + "\n</think>"
                segments += [
                    {"kind": "tool_call", "tool": "python", "text": "print(1 + 1)"},
                    {"kind": "tool_result", "text": "2"},
                    {"kind": "answer", "text": f"\\boxed{{{q['answer']}}}"},
                ]
                correct = rng.random() > 0.2
                runs.append({
                    "model": model, "question": q["id"], "seed": seed,
                    "prediction": q["answer"] if correct else "0", "correct": correct,
                    "msBeforeAnswer": answer_ms, "totalMs": answer_ms + 300,
                    "llmMs": answer_ms - 150, "toolMs": 150,
                    "forwardPasses": text_tokens + latent_steps, "textTokens": text_tokens,
                    "latentSteps": latent_steps, "latentSpans": 3 if latent else 0,
                    "pythonCalls": 1, "searchCalls": 0, "endReason": "eos",
                    "stepMs": {"text": ms_step, "latent": ms_step if latent else None},
                    "segments": segments,
                })
    meta = {
        "hybrid": {"id": "mock (not HybridAgent)", "revision": None, "loop": "mock"},
        "text": {"id": "mock (not Qwen3)", "revision": None, "loop": "mock"},
    }
    return runs, meta


# --------------------------------------------------------------------------

def main() -> None:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--mock", action="store_true")
    p.add_argument("--only", choices=["a", "b"])
    p.add_argument("--seeds", type=int, default=3)
    p.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = p.parse_args()
    out = args.out.resolve()

    def log(message: str) -> None:
        print(message, flush=True)

    questions = load_questions()
    problems = check_questions(questions)
    if problems:
        sys.exit("questions.json has problems:\n  " + "\n  ".join(problems))
    log(f"{len(questions)} questions, {args.seeds} seeds each, per model: {len(questions) * args.seeds} runs.")
    if args.dry_run:
        for q in questions:
            log(f"  {q['id']:<10} {q['answer']:<6} {q['question'][:70]}…")
        log("Dry run: answers and matcher check out. Nothing loaded, nothing written.")
        return
    if args.mock and out == DEFAULT_OUT.resolve():
        sys.exit("--mock writes fake runs; pass --out somewhere other than the real runs file.")

    existing = json.loads(out.read_text()) if args.only and out.exists() else None
    if args.mock:
        runs, models = mock_runs(questions, args.seeds)
    else:
        runs = [r for r in (existing or {}).get("runs", []) if r["model"] != {"a": "hybrid", "b": "text"}.get(args.only)] if args.only else []
        models = dict((existing or {}).get("models", {})) if args.only else {}
        if args.only in (None, "a"):
            r, m = record_hybrid(questions, args.seeds, log)
            runs += r
            models["hybrid"] = m
        if args.only in (None, "b"):
            r, m = record_text(questions, args.seeds, log)
            runs += r
            models["text"] = m

    machine = {"platform": platform.platform(), "python": platform.python_version()}
    if not args.mock:
        import torch
        import transformers

        machine.update({
            "torch": torch.__version__,
            "transformers": transformers.__version__,
            "gpu": torch.cuda.get_device_name(0) if torch.cuda.is_available() else str(pick_device()),
        })

    output = {
        "$comment": "Generated by scripts/record-hybrid.py. Real model outputs unless `models` says mock; do not edit by hand.",
        "recordedAt": datetime.now(timezone.utc).isoformat(),
        "machine": machine,
        "models": models,
        "settings": {**SETTINGS, "python_timeout_s": PYTHON_TIMEOUT_S, "readout_top_k": READOUT_TOP_K, "seeds": args.seeds, "search": "not available"},
        "questions": [q["id"] for q in questions],
        "runs": runs,
    }
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(output, ensure_ascii=False, indent=1) + "\n")

    for model in ("hybrid", "text"):
        mine = [r for r in runs if r["model"] == model]
        if mine:
            med = median([r["msBeforeAnswer"] for r in mine])
            right = sum(r["correct"] for r in mine)
            log(f"{model}: median {med} ms before the answer, {right}/{len(mine)} correct")
    log(f"Wrote {out}")


if __name__ == "__main__":
    main()
