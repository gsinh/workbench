"""
A one-button Hugging Face Space that records the runs for the "thinking without
words" experiment in github.com/gsinh/workbench, and hands back runs.json.

It fetches the recorder and the questions from the workbench repo at start-up,
so the Space holds only this file, requirements.txt and README.md.
"""
import subprocess
import sys
import urllib.request
from pathlib import Path

import gradio as gr

WORKBENCH = "https://raw.githubusercontent.com/gsinh/workbench/main"
HERE = Path(__file__).resolve().parent
WORK = HERE / "workbench"
OUT = WORK / "runs.json"

for path in ("scripts/record-hybrid.py", "src/hybrid-agent/questions.json"):
    target = WORK / path
    target.parent.mkdir(parents=True, exist_ok=True)
    urllib.request.urlretrieve(f"{WORKBENCH}/{path}", target)


def record(seeds: int, only: str):
    """Run the recorder, streaming its log; return the file when it finishes."""
    command = [sys.executable, "-u", str(WORK / "scripts/record-hybrid.py"), "--seeds", str(int(seeds)), "--out", str(OUT)]
    if only != "both":
        command += ["--only", only]
    log = ""
    process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
    for line in process.stdout:
        log += line
        yield log, None
    code = process.wait()
    if code == 0 and OUT.exists():
        yield log + "\nDone. Download runs.json below, then pause this Space.", str(OUT)
    else:
        yield log + f"\nThe recorder exited with code {code}.", None


with gr.Blocks(title="Record: thinking without words") as demo:
    gr.Markdown(
        "## Record HybridAgent-8B vs Qwen3-8B\n"
        "Runs every question with each seed on this GPU, one model at a time, and writes `runs.json`. "
        "Expect roughly 20–60 minutes on an L4 or A10G. **Pause the Space when it is done** — paid hardware bills while it runs."
    )
    with gr.Row():
        seeds = gr.Number(value=3, precision=0, minimum=1, maximum=5, label="Seeds per question")
        only = gr.Radio(["both", "a", "b"], value="both", label="Models (a = HybridAgent, b = Qwen3)")
    start = gr.Button("Record", variant="primary")
    log = gr.Textbox(label="Log", lines=24, max_lines=24, autoscroll=True)
    file = gr.File(label="runs.json")
    start.click(record, inputs=[seeds, only], outputs=[log, file], concurrency_limit=1)

demo.queue().launch()
