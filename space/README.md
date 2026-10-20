---
title: Record thinking without words
emoji: 🎙️
colorFrom: blue
colorTo: indigo
sdk: gradio
app_file: app.py
pinned: false
license: mit
---

# Record: thinking without words

Records the runs behind the lab experiment *Does thinking without words let a voice agent speak sooner?*
It runs [HybridAgent-8B-Agentic](https://github.com/togethercomputer/HybridAgent), which reasons partly in
latent space, and Qwen3-8B, which reasons in text. Both answer the same questions, with the same sampling, budget and
Python tool. Search is turned off. The output is `runs.json`.

The recorder and the questions are fetched from
[gsinh/workbench](https://github.com/gsinh/workbench) (`scripts/record-hybrid.py`,
`src/hybrid-agent/questions.json`) when the Space starts.

## Steps

1. Create a new Space on Hugging Face with the **Gradio** SDK. Upload these three files: `app.py`,
   `requirements.txt` and `README.md`.
2. In *Settings → Space hardware*, pick an **Nvidia L4** or **A10G small** (24 GB). Both 8B models
   fit, one at a time. The free CPU tier is far too slow, and ZeroGPU is untested here: its per-call time
   limits are likely shorter than a full recording.
3. Wait for the build. The first start downloads about 32 GB of weights.
4. Press **Record**. It takes roughly 20–60 minutes for 6 questions × 3 seeds × 2 models. The log
   shows each run as it finishes.
5. Download `runs.json` and commit it to the workbench as `src/hybrid-agent/runs.json`.
6. **Pause the Space** (*Settings → Pause*). Paid hardware bills for as long as it runs.

The Python tool runs code the models write, inside this Space's container. Keep secrets out of the Space.
