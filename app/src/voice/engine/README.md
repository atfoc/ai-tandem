# voice/engine

Platform-free: it uses only the ports (`../ports.ts`) and imports no screen, no `react-native` and no `expo-*`. Its tests run under
`node --test` with fake ports (architecture §3).

| File | What |
|---|---|
| `state.ts` | the voice store (session, problem, reading) and the settings store, with subscribe |
| `player.ts` | the one audio queue (VC-11) |
| `speaker.ts` | sentences → TTS requests → the speed (`logic/stretch.ts`, one stretch per sentence) → player (VC-12) |
| `listener.ts` | the STT socket session (VC-19) |
| `session.ts` | dictation, speech mode, the pill: one session at a time (VC-18) |
| `reply.ts` | follows a chat's reply in the store and feeds the speaker (VC-22) |
| `devices.ts` | routes (what a lost device does to a session, a reading, a preview), notices, the pause's `resume`, the microphone test, the lists of Settings (voice-devices VD-6 to VD-16) |
| `keycheck.ts` | Test key and the voice list |
| `testseam.ts` | `window.__aiwbVoice` in a build for the checks (VC-32) |

**The playback speed** (small-improvements goal 3.1) is applied here, once, for every platform: `speaker.ts` gives each sentence its own
stretch when the sentence's first audio is drained, at the speed the settings have then, pushes the sentence's chunks through it and flushes
it at the sentence's end. The sentence's mark is written just before its first non-empty stretched audio, so marks, level and `drained`
follow the stretched sound without any other change. At 1× nothing is stretched: the player gets the service's bytes as they came. The
platform players are never asked to play faster or slower. The method and its reasons are in `docs/architecture.md`, "The playback speed".
