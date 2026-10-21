# voice/platform

One file per platform, chosen by Metro's `.native.ts` / `.web.ts` suffix; each gives one port of `../ports.ts` (architecture §3).
`bridge.types.ts` is here already: the type of `window.aiwbVoice`, the desktop's voice face (VC-5).

| File | What |
|---|---|
| `keystore.native.ts` | the key in `expo-secure-store` (VC-3) |
| `keystore.web.ts` | Electron: the main process over `window.aiwbVoice`; else memory (VC-3) |
| `net.native.ts` | the RN WebSocket with the key's header, and `expo/fetch` streaming (VC-4) |
| `net.web.ts` | Electron: relayed by main over `window.aiwbVoice`; else page-direct to the stand-in (VC-4) |
| `origin.ts` | the one place an address of the voice service is made (VC-6) |
| `audio.native.ts` | over `app/modules/aiwb-audio` (VC-8) |
| `audio.web.ts` | Web Audio: `getUserMedia`, a script processor, an `AudioContext` player (VC-10) |
