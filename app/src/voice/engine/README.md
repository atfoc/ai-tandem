# voice/engine

Platform-free: it uses only the ports (`../ports.ts`) and imports no screen, no `react-native` and no `expo-*`. Its tests run under
`node --test` with fake ports (architecture §3).

| File | What |
|---|---|
| `state.ts` | the voice store (session, problem, reading) and the settings store, with subscribe |
| `player.ts` | the one audio queue (VC-11) |
| `speaker.ts` | sentences → TTS requests → player (VC-12) |
| `listener.ts` | the STT socket session (VC-19) |
| `session.ts` | dictation, speech mode, the pill: one session at a time (VC-18) |
| `reply.ts` | follows a chat's reply in the store and feeds the speaker (VC-22) |
| `keycheck.ts` | Test key and the voice list |
| `testseam.ts` | `window.__aiwbVoice` in a build for the checks (VC-32) |
