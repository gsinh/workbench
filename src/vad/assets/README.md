# Assets

Binary files the VAD experiment loads at runtime. They are **not** imported as
modules — a source-only package cannot ship binaries through `exports` — so a
host serves them and passes their URLs to the component.

| File | What it is | Licence |
| --- | --- | --- |
| `silero_vad.onnx` | Silero VAD v5 weights, 2.3 MB | MIT — see `LICENSE.silero` |
| `speech-sample.wav` | 11s of speech, 16 kHz mono | Public domain (US government work) |

`speech-sample.wav` is the JFK excerpt distributed with whisper.cpp as
`samples/jfk.wav`. It is a US government work and therefore not subject to
copyright in the United States.

To serve them, copy this directory into your public assets and point the
component at the results:

```tsx
<VadCompare
  modelUrl="/vad/silero_vad.onnx"
  sampleUrl="/vad/speech-sample.wav"
/>
```
