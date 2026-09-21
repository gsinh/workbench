# lab

Interactive experiments in voice, latency and real-time systems. Each one is a
self-contained React component you can drop into your own app, read for the
idea, or lift a piece out of.

Live at [gsinh.com/lab](https://gsinh.com/lab).

## Run them

```bash
git clone https://github.com/gsinh/lab.git
cd lab
npm install
npm run dev
```

That starts a small Vite harness with the experiments mounted. It is not part
of the published package — it exists so the components can be developed and
demonstrated without a host application.

## Use one in your own app

The package ships **TypeScript source, not a bundle**, so your bundler compiles
it with the rest of your code and tree-shakes what you do not use.

```bash
npm install github:gsinh/lab
```

```tsx
import { VoiceLatency } from "@gsinh/lab/voice-latency";

export function Page() {
  return <VoiceLatency />;
}
```

Because it is source, a framework that treats `node_modules` as pre-compiled
needs to be told otherwise. In Next.js:

```ts
// next.config.ts
const nextConfig = { transpilePackages: ["@gsinh/lab"] };
```

Vite, Rollup and Webpack 5 need no configuration.

### What it expects from you

`react`, `react-dom` and `@chakra-ui/react` v3 are peer dependencies — the
components use your copies, so there is no duplicate React and no second
Chakra system.

The components are written against Chakra's **own** semantic tokens
(`bg.panel`, `fg.muted`, `border`, the `l1`/`l2`/`l3` radii), so they inherit
whatever theme you already have. The one thing worth setting is
`colorPalette`, which decides what the accents resolve to:

```ts
createSystem(defaultConfig, defineConfig({
  globalCss: { html: { colorPalette: "blue" } },
}));
```

Chart series colours are deliberately *not* drawn from `colorPalette`. They
were validated as a set — lightness band, chroma floor, and colour-vision
separation between neighbouring segments in both light and dark mode — and
re-deriving them from a theme would break that.

## The experiments

### `voice-latency` — Voice agent latency budget

Where the gap between a user's last word and an agent's first one actually
goes. Seven costs in series, of which the model is rarely the largest; the
usual winner is the silence you make the user sit through before you will
admit they have finished talking.

The reader's configuration is drawn against four reference architectures on a
shared axis, so each choice reads as a length rather than an assertion. A
second chart covers barge-in — how long the agent keeps talking after being
interrupted — which is the same playout buffer working against you in the
opposite direction.

**Three of the seven stages are measured, not estimated**: the audio stack's
capture and sink latency from `AudioContext`, this browser's TTS
time-to-first-audio from `speechSynthesis`, and a live energy VAD running the
endpointing setting against the real microphone. Audio never leaves the page
and nothing is downloaded. The other four stages need infrastructure a static
page cannot reach, and are sliders with documented defaults.

| Module | What it is | Dependencies |
| --- | --- | --- |
| `model.ts` | The arithmetic — stages, presets, `budget()`, `bargeIn()`, axis helpers | **none** |
| `palette.ts` | Validated series colours and per-slot label ink | **none** |
| `Budget.tsx` | Stacked bars, gridlines, tooltip, legend, table view | React, Chakra |
| `Controls.tsx` | `Knob` (labelled slider) and `Choice` (segmented control) | React, Chakra |
| `Measure.tsx` | The device measurements and the live VAD | React, Chakra |

`model.ts` is plain TypeScript with no React and no browser APIs. If you want
one file out of this repo, it is that one:

```ts
import { budget, total, PRESETS } from "@gsinh/lab/voice-latency";

total(budget(PRESETS[0].params)); // 3360
```

A longer write-up — why the stages are in series, why endpointing drifts long,
the chunk stage nobody draws, and what the model leaves out — is at
[gsinh.com/lab/voice-agent-latency-budget](https://gsinh.com/lab/voice-agent-latency-budget).

## Licence

MIT. Use it, change it, ship it commercially; just keep the copyright notice.
