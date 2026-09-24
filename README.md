# workbench

Interactive experiments in voice, telephony and real-time systems. Each one is a
self-contained React component you can drop into your own app, read for the
idea, or lift a piece out of.

Live at [gsinh.com/lab](https://gsinh.com/lab).

## Run them

```bash
git clone https://github.com/gsinh/workbench.git
cd workbench
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
npm install github:gsinh/workbench
```

```tsx
import { VoiceLatency } from "@gsinh/workbench/voice-latency";

export function Page() {
  return <VoiceLatency />;
}
```

Because it is source, a framework that treats `node_modules` as pre-compiled
needs to be told otherwise. In Next.js:

```ts
// next.config.ts
const nextConfig = { transpilePackages: ["@gsinh/workbench"] };
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
endpointing setting against the real microphone. Audio never leaves the page.
The other four stages need infrastructure a static page cannot reach, and are
sliders with documented defaults.

**You can hear it.** Pass `clipsUrl` and a call player appears: a caller, the
silence your budget adds up to, then the agent, on a two-lane timeline with a
cursor that follows the audio. A second scenario has the caller pause
mid-number, so a short endpoint audibly cuts them off. The six clips (400 KB,
in `assets/`, generated with the Apache-2.0 Kokoro model — see `assets/NOTICE`)
are fetched when the player scrolls into view, and mixed into one track so a
single `<audio>` element plays it: exact timing, and no fight with iOS
autoplay rules or its silent switch.

**And be walked through it.** With the clips present, a "Take the 1-minute
tour" button runs seven steps — hear the batch build, hear streaming, shorten
endpointing, hear the cut-off, and so on. Each step highlights one control,
has a "Show me" that performs it, and responds to what the reader actually
did. `#tour-3` links open a step directly. The tour is generic
(`src/shared/Tour.tsx`) and knows nothing about latency.

```tsx
<VoiceLatency clipsUrl="/voice-latency/" />  // serve src/voice-latency/assets there
```

| Module | What it is | Dependencies |
| --- | --- | --- |
| `model.ts` | The arithmetic — stages, presets, `budget()`, `bargeIn()`, axis helpers | **none** |
| `palette.ts` | Validated series colours and per-slot label ink | **none** |
| `Budget.tsx` | Stacked bars, gridlines, tooltip, legend, table view | React, Chakra |
| `Controls.tsx` | `Knob` (labelled slider) and `Choice` (segmented control) | React, Chakra |
| `Measure.tsx` | The device measurements and the live VAD | React, Chakra |
| `call.ts` | The call as a timeline, and the mix of the clips into one track | **none** |
| `CallPlayer.tsx` | The call player and its timeline | React, Chakra |

`model.ts` is plain TypeScript with no React and no browser APIs. If you want
one file out of this repo, it is that one:

```ts
import { budget, total, PRESETS } from "@gsinh/workbench/voice-latency";

total(budget(PRESETS[0].params)); // 3360
```

A longer write-up — why the stages are in series, why endpointing drifts long,
the chunk stage nobody draws, and what the model leaves out — is at
[gsinh.com/lab/voice-agent-latency-budget](https://gsinh.com/lab/voice-agent-latency-budget).

### `stir-shaken` — STIR/SHAKEN inspector

Every signed telephone call carries a PASSporT: a JWT in which the originating
carrier asserts who is calling and how sure it is. Paste a SIP `Identity`
header and this decodes it, checks sixteen rules drawn from RFC 8224, RFC 8225,
RFC 8588 and ATIS-1000074, and verifies the signature.

The attestation explainer is the part worth reading. `A` is routinely taken to
mean "this call is legitimate". It does not. It means the carrier knows which
customer bought the number — a fact about billing relationships, not about
honesty. The panel says what each level asserts and, next to it, what people
wrongly read into it.

**The signature check is real.** The samples are signed with a genuine P-256
key against a self-signed certificate carrying the SHAKEN TNAuthList extension
OID, and verified in the browser by WebCrypto. The "attestation upgraded after
signing" sample passes every structural check and fails the signature, because
the attestation really was rewritten from `C` to `A` after signing.

Two honest limits, both stated on the page: a browser generally cannot fetch
the certificate from `x5u`, because certificate repositories serve no CORS
headers; and the saved samples are always stale against the 60-second
freshness window, which is itself the point — an old `iat` is what a replayed
token looks like.

**Send a call, and attack it.** An animated path — originating carrier, the
network, terminating carrier — carries the token across and shows the
receiving side's verdict, computed from the same checks as the rest of the
page. "Change the caller's number in transit" edits one claim in the signed
payload without re-signing (`tamperPayload` in `model.ts`), and the call is
rejected on its signature alone. "Replay it later" checks a genuine token
against the real clock instead of two seconds after signing, and it is caught
only by its age. A seven-step guided tour walks through both, plus a
gateway-attested call and a token with its claims out of order.

| Module | What it is | Dependencies |
| --- | --- | --- |
| `model.ts` | Parsing and every specification rule | **none** |
| `crypto.ts` | DER walking to SubjectPublicKeyInfo, WebCrypto verification | WebCrypto |
| `fixtures.ts` | The certificate and the signed samples | **none** |
| `CallPath.tsx` | The animated call path | React, Chakra |
| `StirShaken.tsx` | The inspector UI | React, Chakra |

`crypto.ts` has no ASN.1 dependency — reaching `SubjectPublicKeyInfo` inside an
X.509 certificate is about forty lines of DER walking, and they are written out
rather than hidden:

```ts
import { spkiFromCertificate, pemToDer, verifySignature } from "@gsinh/workbench/stir-shaken";

const spki = spkiFromCertificate(pemToDer(pem)); // feed straight to WebCrypto
```

### `diarization` — Speaker diarization from first principles

Who spoke when, with no model, no download and no network. The classical
pipeline, written out rather than imported: frame the audio, take MFCCs, find
speech by energy, cut it into turns, reduce each turn to a fixed vector by
statistics pooling, then cluster the vectors.

That embedding — the mean and standard deviation of a segment's MFCCs — is
exactly what an x-vector network pools to. The difference is that it first
passes the frames through trained layers and this does not, so the shape of
the pipeline is the real one and only the representation is weaker.

**It is scored, not asserted.** The sample conversation is synthesised in the
page from a known script, so the badge reports how many turns the clustering
actually got right. Forcing the speaker count to three drops it from 5/5 to
3/5, because the clustering splits a real speaker — the failure mode is on
screen rather than in a footnote.

**Watch it decide.** Play the conversation and a playhead crosses the
timeline while each segment's dot appears in the scatter as it is reached.
"Replay the grouping" then re-runs the agglomerative clustering one merge at a
time — each merge drawn as a line between the two groups' centres, the
timeline grey until the last merge colours it in. `cluster()` now returns the
merge `history` and `groupsAfter()` reconstructs the groups at any step, so
the replay shows what the algorithm actually did rather than an animation of
it. A six-step guided tour ends with forcing three speakers, where one real
voice splits in two and the score falls from 5/5 to 3/5.

| Module | What it is | Dependencies |
| --- | --- | --- |
| `dsp.ts` | FFT, mel filterbank, MFCC, cepstral mean normalization, energy VAD | **none** |
| `cluster.ts` | Segmentation, statistics pooling, agglomerative clustering, PCA | **none** |
| `synth.ts` | Source-filter synthesis of the sample, and scoring against its script | **none** |
| `Diarize.tsx` | Timeline, embedding scatter, microphone and file input | React, Chakra |

Three of the four modules are plain TypeScript over `Float32Array`, so the
whole pipeline runs anywhere — including in a test:

```ts
import { analyseFrames, DEFAULT_FRAMES, diarize, DEFAULT_OPTIONS } from "@gsinh/workbench/diarization";

const frames = analyseFrames(signal, { sampleRate: 16000, ...DEFAULT_FRAMES });
const { segments, speakerCount } = diarize(frames, DEFAULT_OPTIONS, signal.length / 16000);
```

**What it is not.** Two synthetic voices differing in both pitch and formants
are an easy case. Real diarization has to cope with overlapping speech, voices
of the same register, changing channels and background noise, and on all of
those a trained embedding beats statistics pooling by a wide margin. This is
the mechanism made legible, not a system to deploy.

### `vad` — Energy versus neural voice activity

Two voice-activity detectors on the same audio: an energy threshold, and
Silero VAD running in WebAssembly. It answers the question the latency budget
raises and cannot settle — endpointing is the largest line in that budget, and
the way to shrink it is a better classifier rather than a smaller number.

The visible result is not the one that was designed for. The door-slam button
does what it should — energy calls the burst speech, the model does not — but
the larger difference is that **the energy detector shreds continuous speech
into fragments** where the model holds it whole. That fragmenting is precisely
why a naive endpointer needs a long silence window: it is guarding against its
own dropouts between syllables.

**You can hear it.** A play control sweeps a playhead across the lanes, so
what you hear and what each detector claims line up. Without that the page
shows you two rows of coloured blocks about audio you cannot listen to, and no
way to judge which detector is right — which is how it shipped first, and was
wrong.

**And a guided tour.** "Take the 1-minute tour" walks through it in seven
steps: listen, add a door slam, play the slam in a close-up of the second
around it, load the model, turn the energy margin all the way up, then record
your own voice. The narration is computed from the run rather than written in
advance — on the sample clip, Silero fires on none of the slam's five frames,
and at the maximum 30 dB margin the energy detector still fires on two while
missing most of the speech it caught at 12 dB.

**What it costs, plainly.** The model is 2.3 MB. The runtime that executes it
is 13.6 MB of WebAssembly, about 3.7 MB compressed — so the honest figure is
roughly 6 MB over the wire, not the flattering 2.3. That gap is worth noticing
about on-device inference in a browser generally.

Weights are vendored and served by the host, not fetched from a third-party
CDN at runtime. Audio never leaves the page.

| Module | What it is | Dependencies |
| --- | --- | --- |
| `energy.ts` | Frame energy, noise floor, threshold detector | **none** |
| `silero.ts` | The ONNX model, loaded on demand | onnxruntime-web |
| `audio.ts` | Decoding and the noise-burst injector | Web Audio |
| `VadCompare.tsx` | Lanes, controls, microphone and file input | React, Chakra |

Two things that will cost you an afternoon if you implement this yourself:

**Silero v5 keeps a 64-sample context that is concatenated outside the graph.**
The model input is 576 samples, not 512. Feed it a bare frame and inference
runs, throws nothing, and reports about 0.001 for every frame of clean speech.

**Import `onnxruntime-web/wasm`, not `onnxruntime-web`.** The default entry
pulls the JSEP build with WebGPU and WebNN support — 27 MB against 13.6 MB,
for capability a WASM-only session never uses.

### `system-one` — System One decisions for a voice agent (in progress)

A voice agent that decides with a *System One* decision model — Laya, the
open, Apache-2.0 alternative to TypeSafe's Jev — instead of generating text:
after every word of the caller's turn it asks whether they have finished,
what they want, how frustrated they are, and which pre-written reply fits.
The page will replay real Laya outputs recorded offline, so it downloads
nothing.

Recording them is one command (Node 20+; the first run downloads ~1.7 GB of
weights from Hugging Face):

```sh
npm install --no-save @receptron/laya@0.1.2
node scripts/record-decisions.mjs            # writes src/system-one/decisions.json
node scripts/record-decisions.mjs --dry-run  # check scenarios.json without the model
```

The scenarios and questions live in `src/system-one/scenarios.json`, which
the script and the page both read. The output records the package version,
Hugging Face revision, a fingerprint of the bundle, the machine and the
latency per call, so the page can say exactly what it is showing.

### Shared: `src/shared/audio.ts`

Microphone capture and playback for all three audio experiments, written for
the browsers people actually use rather than the one a headless test uses. The
first version recorded nothing for a real reader while working in every automated
check. Three rules, each learned from that:

- **Create the AudioContext inside the click, before `await getUserMedia()`.**
  The permission prompt spends the user gesture; a context created after it
  can come back suspended, the graph never pulls, and the recording is empty
  without a single error. `startMicCapture` is synchronous for this reason.
- **Do not force a 16 kHz context onto a microphone.** Firefox refuses to
  connect a stream to a context at a different rate from the device. Capture
  at the device rate; resample afterwards.
- **Play through an `<audio>` element, not Web Audio.** On iOS the ring/silent
  switch mutes Web Audio but not media elements, so a Web Audio "Play" button
  is silent on a large share of phones.

Capture also turns off the browser's noise suppression, echo cancellation and
gain control. They exist to remove exactly the knocks and loudness
differences these experiments are about.

```tsx
import { VadCompare } from "@gsinh/workbench/vad";

<VadCompare
  modelUrl="/vad/silero_vad.onnx"
  sampleUrl="/vad/speech-sample.wav"
  wasmPaths={{ mjs: ortMjs, wasm: ortWasm }}
/>
```

The binaries live in `src/vad/assets/` — see the README there for serving them.

## Licence

MIT. Use it, change it, ship it commercially; just keep the copyright notice.
