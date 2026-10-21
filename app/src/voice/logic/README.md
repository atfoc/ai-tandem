# voice/logic

Pure TypeScript: no React, no `react-native`, no `expo-*`, no ports. Its tests run under `node --test` (architecture §3).

| File | What |
|---|---|
| `speech.ts` | markdown → the words to say (VC-25) |
| `sentences.ts` | the streaming sentence splitter (VC-26) |
| `protocol.ts` | the voice service's constants, URLs, query, frames and event parsing (§2) |
| `problems.ts` | an answer, an event or an exception → a `VoiceProblem` (§2.6) |
| `turn.ts` | the turn machine: words, quiet, countdown, send (VC-20) |
| `settings.ts` | `VoiceSettings`: type, defaults, parse, clamp (VC-14) |
| `marks.ts` | the device-local mic marks: model and pruning (VC-23) |
| `pcm.ts` | Float32 → Int16 16 kHz, base64, RMS level, odd-byte carry (the web build's audio) |
