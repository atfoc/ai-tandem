// The key and the voices (goal 3.7, architecture §2.4): Test key, the voice list, a voice's preview clip, and the keystore's four
// calls as the screens see them. A call here reads the key through the ports only when it is made (the net port adds it as the
// header); nothing here keeps a copy, and nothing here puts it in an error, a problem or a log.
import { parseVoices, testKeyQuery, VOICES_PATH, voicesQuery } from "../logic/protocol.ts";
import type { VoiceList } from "../logic/protocol.ts";
import { problemOfException } from "../logic/problems.ts";
import { VoiceProblemError, voicePorts } from "../ports.ts";
import type { VoiceProblemKind } from "../ports.ts";
import { dismissProblem, onReset, problemStore, showProblem } from "./state.ts";
import { playClipOnce, requestJson, speaker, stopPreviewClip } from "./speaker.ts";

/** The preview address of every voice seen in an answer of the service; a clip is fetched only from an address that came this way (VC-5). */
const previews = new Map<string, string>();
onReset(() => previews.clear());

export const hasKey = (): Promise<boolean> => voicePorts().keystore.has();

/** Keeps the key (without the spaces around it). An empty one is not a key: nothing is kept. A problem that blamed the old key goes. */
export async function setKey(key: string): Promise<void> {
  const k = key.trim();
  if (!k) return;
  await voicePorts().keystore.set(k);
  const shown = problemStore.get()?.kind;
  if (shown === "no_key" || shown === "key_rejected") dismissProblem();
}

/** Removes the key from this device: from the store it lives in. */
export async function removeKey(): Promise<void> {
  await voicePorts().keystore.clear();
}

/** Whether a key works and how many voices it finds. `key` is a typed one, not stored yet; without it the stored one is tested. A
 *  failure is a result, not an exception, and no popover: the screen that asked writes the sentence. */
export async function testKey(key?: string): Promise<{ ok: true; voices: number } | { ok: false; problem: VoiceProblemKind }> {
  const typed = key?.trim() || undefined;
  if (!typed && !(await hasKey().catch(() => false))) return { ok: false, problem: "no_key" };
  try {
    const json = await requestJson({ method: "GET", path: VOICES_PATH, query: testKeyQuery(), key: typed });
    return { ok: true, voices: parseVoices(json).total };
  } catch (e) {
    return { ok: false, problem: problemOfException(e) };
  }
}

/** A page of the service's voices (the short list, or the full list with a search and a cursor). Rejects with a `VoiceProblemError`:
 *  `no_key` when there is no key, else what the service or the network said. */
export async function voices(o: { all?: boolean; search?: string; cursor?: string } = {}): Promise<VoiceList> {
  if (!(await hasKey().catch(() => false))) throw new VoiceProblemError("no_key");
  let json: unknown;
  try {
    json = await requestJson({ method: "GET", path: VOICES_PATH, query: voicesQuery(o) });
  } catch (e) {
    throw new VoiceProblemError(problemOfException(e));
  }
  const list = parseVoices(json);
  for (const v of list.voices) if (v.previewUrl) previews.set(v.id, v.previewUrl);
  return list;
}

/** Plays a voice's own preview clip (no credits, goal 4.9): stops anything else playing, and is stopped by the next thing that plays.
 *  Resolves when the clip ends or is stopped. A failure shows the popover on `preview:<voice>` and resolves. */
export async function playPreview(voiceId: string): Promise<void> {
  const anchor = `preview:${voiceId}`;
  speaker.stopAll();
  try {
    let url = previews.get(voiceId);
    if (!url) {
      await voices();
      url = previews.get(voiceId);
    }
    if (!url) return;
    const from = url;
    await playClipOnce((signal) => voicePorts().net.preview(from, signal));
  } catch (e) {
    showProblem({ kind: problemOfException(e), anchor, retry: () => { void playPreview(voiceId); } });
  }
}

/** Stops the preview clip in play, if one is: the stop button of a sample. Nothing else that sounds is touched. */
export const stopPreview = (): void => stopPreviewClip();
