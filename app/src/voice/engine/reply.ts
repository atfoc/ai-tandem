// The reply of a spoken turn, spoken as it streams in (architecture VC-22, goal 3.1). The follower watches the branch's list in core's
// store (`items[branchKey(chat, branch)]`): it finds the user message the turn sent (the first user item at the item count of the send
// or after it, with the turn's text), then takes the `text` items after it, in order, and feeds the new part of each to the sentence
// splitter; `done`, or a later item, flushes the item's last sentence. A text that is not a continuation of what was fed (a rewrite) is
// fed from where the feeding stopped, so nothing is said twice (goal 4.7). The turn is over at its `end` item, at the next user message,
// or when the branch stops being busy after it was (or is idle with the reply's last text finished); the follower then closes the
// utterance and answers once the speaker has played it.
//
// The utterance starts with the first sentence (until then the session is "thinking"); a reply with nothing to say answers at once.
import { branchKey, stateOf } from "@aiwb/core/logic/branches.ts";
import { isBusy } from "@aiwb/core/logic/status.ts";
import { getState, subscribe, threadAt } from "@aiwb/core/state/store.ts";
import type { Item } from "@aiwb/core/types.ts";
import { createSplitter } from "../logic/sentences.ts";
import type { VoiceProblem } from "../index.ts";
import { speaker } from "./speaker.ts";
import type { SpeakHandle } from "./speaker.ts";
import { sameTurnText } from "./marks.ts";

export type ReplyResult = "played" | "stopped" | VoiceProblem;

export interface ReplyFollower {
  /** Stops following; the reply's sound is stopped when it is this follower's. `done` answers "stopped" (if it had not answered). */
  stop(): void;
  readonly done: Promise<ReplyResult>;
}

export function followReply(o: {
  chat: string;
  branch: string;
  /** The branch's item count when the turn was sent: the turn's user message is at this index or after it. */
  before: number;
  /** The text the turn sent. */
  text: string;
  owner: "speech" | "pill";
  anchor: string;
  /** What "Try again" does after a "can't reach" of a sentence. */
  retry?: () => void;
  skipCode: boolean;
  /** The first sound of a sentence: the session shows the sentence and goes to "speaking". */
  onSentence(sentence: string): void;
  onLevel(level: number): void;
}): ReplyFollower {
  const key = branchKey(o.chat, o.branch);
  const uKey = `reply:${o.chat}:${o.branch}:${o.before}`;
  let settle!: (r: ReplyResult) => void;
  const done = new Promise<ReplyResult>((resolve) => { settle = resolve; });
  let finished = false;
  let handle: SpeakHandle | null = null;
  /** The index of the turn's user message, once it is in the list. */
  let userAt = -1;
  /** The item being fed, and how much of its text was fed (the longest it has been: a rewrite is fed from there on). */
  let cursor = -1;
  let fedLen = 0;
  let sawBusy = false;
  let closing = false;

  const say = (sentence: string) => {
    if (finished) return;
    handle ??= startUtterance();
    handle.say(sentence);
  };
  const splitter = createSplitter({ skipCode: o.skipCode, onSentence: say });

  function startUtterance(): SpeakHandle {
    const h = speaker.begin({ key: uKey, owner: o.owner, anchor: o.anchor, retry: o.retry, onSentence: o.onSentence, onLevel: o.onLevel });
    void h.done.then(finish);
    return h;
  }

  function finish(r: ReplyResult): void {
    if (finished) return;
    finished = true;
    off();
    settle(r);
  }

  /** The turn is over: the last sentence is flushed and the utterance closed; the answer comes when it has played. */
  function close(): void {
    if (closing || finished) return;
    closing = true;
    off();
    if (cursor >= 0) splitter.flush();
    if (!handle) { finish("played"); return; }
    handle.end();
  }

  const busy = (): boolean => {
    const s = getState();
    return isBusy(stateOf(s.states, s.chats[o.chat], o.branch)?.status);
  };

  function look(): void {
    if (closing || finished) return;
    const s = getState();
    if (!s.chats[o.chat]) { close(); return; }
    if (busy()) sawBusy = true;
    const items: readonly Item[] = threadAt(s, key)?.items ?? [];
    if (userAt < 0) {
      for (let i = Math.max(0, o.before); i < items.length; i++) {
        const it = items[i];
        if (it.kind === "user" && sameTurnText(it.text ?? "", o.text)) { userAt = i; cursor = i + 1; fedLen = 0; break; }
      }
      if (userAt < 0) return;
    }
    // Feed the items after the user message, in order: the open one's new text; a finished one is flushed and the next one taken.
    while (cursor < items.length) {
      const it = items[cursor];
      if (it.kind === "user" || it.kind === "end") { close(); return; }
      if (it.kind === "text") {
        const text = it.text ?? "";
        if (text.length > fedLen) { splitter.push(text.slice(fedLen)); fedLen = text.length; }
        if (!it.done && cursor === items.length - 1) break;
        splitter.flush();
      }
      cursor++;
      fedLen = 0;
    }
    // The branch stopped after it was busy; or it is not busy and the reply's last text is finished (a server that sends no `end`).
    const lastDone = cursor === items.length && items[items.length - 1]?.kind === "text" && !!items[items.length - 1].done;
    if ((sawBusy || lastDone) && !busy()) close();
  }

  const unsubscribe = subscribe(look);
  let subscribed = true;
  function off(): void {
    if (!subscribed) return;
    subscribed = false;
    unsubscribe();
  }
  look();

  return {
    stop() {
      if (finished) return;
      const h = handle;
      finish("stopped");
      if (h && speaker.current()?.key === uKey) speaker.stopAll();
    },
    done,
  };
}
