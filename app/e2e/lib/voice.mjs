// The stand-in voice service of the device flow `voice-mic` (package P17, goal 6.6, architecture §13 and §14.4): a flow whose header says
// `needs=voice` gets `web/dev/voicestandin.mjs` as a process of its own on a free port of this computer, the build is told where it is
// (EXPO_PUBLIC_AIWB_VOICE_BASE, which the app honours in a development build only, and only for a local host), and the flow is given `VOICE_CONTROL`,
// the stand-in's control over HTTP (`POST <VOICE_CONTROL>/script` with the steps of the next transcription, as the stand-in's header says).
// What the stand-in saw is read at the end (`checkLog`): the microphone's chunks must be 16 kHz and 100 ms, and what the client sent must break
// no rule of the protocol. No call goes outside this computer.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { adbPath } from "../../scripts/lib/devtools.mjs";
import { freePort, repo } from "./scratch.mjs";

/** Starts the stand-in alone on 127.0.0.1 (no prefix: the app builds its addresses from the origin, `origin.ts`). Answers { port, base, control, log(), stop() }. */
export async function startVoiceStandin({ out }) {
  const port = await freePort();
  const logFile = path.join(out, "voice-standin.log");
  const p = spawn(process.execPath, [path.join(repo, "web/dev/voicestandin.mjs"), "--port", String(port), "--prefix", ""], { stdio: ["ignore", "pipe", "pipe"] });
  let text = "";
  p.stdout.on("data", (d) => (text += d));
  p.stderr.on("data", (d) => (text += d));
  const end = Date.now() + 30000;
  while (!/^Voice: /m.test(text)) {
    if (p.exitCode !== null) throw new Error(`the stand-in voice service exited early:\n${text}`);
    if (Date.now() > end) throw new Error(`the stand-in voice service did not start:\n${text}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  const base = `http://127.0.0.1:${port}`;
  const call = async (route, body) => {
    const r = await fetch(`${base}/_control/${route}`, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`stand-in control ${route}: ${r.status} ${await r.text()}`);
    return r.json();
  };
  return {
    port, base, control: `${base}/_control`,
    log: () => call("log"),
    stop: async () => { p.kill("SIGTERM"); fs.writeFileSync(logFile, text); },
  };
}

/** What the stand-in's log of a run must show of the microphone and the speaker. Answers { problems: [text], lines: [text] } (the lines tell what was seen). */
export function checkLog(log) {
  const problems = [];
  const lines = [];
  const stt = log.filter((e) => e.kind === "stt");
  const tts = log.filter((e) => e.kind === "tts");
  if (!stt.length) problems.push("the stand-in saw no transcription socket: the microphone's audio never went up");
  for (const e of stt) {
    const seconds = e.startedAt && e.finishedAt ? (e.finishedAt - e.startedAt) / 1000 : null;
    const audio = (e.chunks * 100) / 1000;
    lines.push(`stt: ${e.chunks} chunks, sample rates ${JSON.stringify(e.sampleRates)}, a chunk is ${e.chunkMsMin}–${e.chunkMsMax} ms of audio${seconds === null ? "" : `, ${audio.toFixed(1)} s of audio in ${seconds.toFixed(1)} s (${(audio / seconds).toFixed(2)} of real time)`}, closed ${e.closeCode ?? "-"}`);
    if (e.chunks > 0) {
      if (JSON.stringify(e.sampleRates) !== "[16000]") problems.push(`stt: the sample rates the client sent are ${JSON.stringify(e.sampleRates)}, not [16000]`);
      if (e.chunkMsMin !== 100 || e.chunkMsMax !== 100) problems.push(`stt: a chunk is ${e.chunkMsMin}–${e.chunkMsMax} ms of audio, not 100`);
      // (the first chunk comes after the microphone has started and the last is cut by the socket's close: a wide band; a microphone that runs at half the rate or twice it is outside it)
      if (seconds !== null && seconds > 2 && (audio / seconds < 0.5 || audio / seconds > 1.5)) problems.push(`stt: ${audio.toFixed(1)} s of audio in ${seconds.toFixed(1)} s is not real time`);
    }
    if (!e.keyHeader) problems.push("stt: the socket came without the key header");
    if (!e.finishedAt) problems.push("stt: the socket is still open at the end of the run (the audio session did not stop)");
    if (e.problems?.length) problems.push(`stt: the client broke the protocol: ${e.problems.join("; ")}`);
  }
  for (const e of tts) {
    lines.push(`tts: ${e.chunks} chunks, ${e.bytes} bytes, ${e.cancelled ? "CANCELLED" : e.finishedAt ? "read to its end" : "not finished"}`);
    if (e.problems?.length) problems.push(`tts: the client broke the protocol: ${e.problems.join("; ")}`);
  }
  return { problems, lines };
}

/** The answer to the microphone prompt: `reset` (the system asks again), `grant` or `revoke` (iOS: `simctl privacy`; Android: `pm grant|revoke` of RECORD_AUDIO, the flags
 *  cleared first as devicectl does). The system ends the app whose permission changes (iOS: "tcc"), as it does when a person changes it in Settings: callers change it
 *  while the app is not running, or open the app again after. */
export function setMic({ platform, device, appId, action }) {
  if (!["reset", "grant", "revoke"].includes(action ?? "")) throw new Error("the microphone action is reset, grant or revoke");
  let r;
  if (platform === "ios") r = spawnSync("xcrun", ["simctl", "privacy", device, action, "microphone", appId], { encoding: "utf8" });
  else {
    const adb = (args) => spawnSync(adbPath(), ["-s", device, ...args], { encoding: "utf8" });
    if (action !== "grant") adb(["shell", "pm", "clear-permission-flags", appId, "android.permission.RECORD_AUDIO", "user-set", "user-fixed"]);
    r = adb(["shell", "pm", action === "grant" ? "grant" : "revoke", appId, "android.permission.RECORD_AUDIO"]);
  }
  if (r.status !== 0) throw new Error(`microphone ${action}: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
}

/** The routes of the control API that a voice flow needs of the device: `POST /voice/mic?action=reset|grant|revoke` (setMic) and `POST /voice/relaunch` (the app is
 *  stopped and opened again as the runner opens it, which a flow needs after the system ended the app for a changed permission). */
export function voiceRoutes({ platform, device, appId, terminate, open, say = () => {} }) {
  return {
    "POST /voice/mic": async (q) => {
      setMic({ platform, device, appId, action: q.get("action") });
      say(`microphone permission: ${q.get("action")}`);
      return {};
    },
    "POST /voice/relaunch": async () => { terminate(); open(); return {}; },
  };
}
