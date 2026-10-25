// The voices this session already knows (S3): Choose voice fills it with every page it loads, and the Voice screen reads the chosen
// voice's description from it, so the screen never asks the service for it (goal 4.5: no request before the person uses voice).
// A module store of one map; a hook re-reads when it changes.
import { useSyncExternalStore } from "react";

import type { VoiceInfo } from "../../voice/index.ts";

const known = new Map<string, VoiceInfo>();
const listeners = new Set<() => void>();

/** Remembers voices as the service listed them (a later listing of the same voice replaces the earlier). */
export function rememberVoices(list: readonly VoiceInfo[]): void {
  let changed = false;
  for (const v of list) {
    const was = known.get(v.id);
    if (was && was.name === v.name && was.about === v.about && was.previewUrl === v.previewUrl) continue;
    known.set(v.id, v);
    changed = true;
  }
  if (changed) listeners.forEach((l) => l());
}

/** What this session knows of a voice, or undefined. */
export const voiceInfo = (id: string | null): VoiceInfo | undefined => (id === null ? undefined : known.get(id));

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

export function useVoiceInfo(id: string | null): VoiceInfo | undefined {
  return useSyncExternalStore(subscribe, () => voiceInfo(id), () => undefined);
}
