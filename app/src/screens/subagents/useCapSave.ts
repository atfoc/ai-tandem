// The cap's slider in the Subagents popover and the phone's sheet saves through this hook (the logic is capsave.ts): the value to show
// (the committed one until the chat has it) and the commit.
import { useEffect, useRef, useState } from "react";

import { api } from "@aiwb/core/api.ts";
import { pickSubs, subSettings } from "@aiwb/core/logic/subsettings.ts";
import { getState, shownBranch, shownView, upsertChat } from "@aiwb/core/state/store.ts";
import type { ChatView } from "@aiwb/core/types.ts";

import { createCapSaver, type CapSaver } from "./capsave.ts";

export type CapSaveProps = {
  c: ChatView;
  /** The composer sends, or another of the toolbar's changes is being saved (this save's own busy flag makes it true too: capsave.ts). */
  disabled: boolean;
  onBusy(busy: boolean): void;
  onError(msg: string): void;
};

export function useCapSave(p: CapSaveProps): { value: number; commit(v: number): void } {
  const [want, setWant] = useState<number | null>(null);
  const live = useRef(p);
  live.current = p;
  const saver = useRef<CapSaver | null>(null);
  saver.current ??= createCapSaver({
    settings: () => subSettings(shownView(getState(), live.current.c.id) ?? live.current.c),
    blocked: () => live.current.disabled,
    send: (change) => pickSubs((x) => api.configure(live.current.c.id, shownBranch(getState(), live.current.c.id), x), change, upsertChat),
    busy: (on) => live.current.onBusy(on),
    error: (msg) => live.current.onError(msg),
    want: setWant,
  });
  const cap = subSettings(p.c).cap;
  useEffect(() => saver.current?.chatCap(), [cap]);
  return { value: want ?? cap, commit: (v) => saver.current?.commit(v) };
}
