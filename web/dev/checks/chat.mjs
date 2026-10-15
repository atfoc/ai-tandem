// The readers of the chat view for the checks of the new build (package S4; the counterpart of the old `.thread .msg` reads). No dash in
// the name: the runner does not take it for a check. testIDs of screens/chat: `chat-head` (+ `chat-head-name`, `chat-head-sub`,
// `chat-head-server`, `chat-name-input`, `chat-hide`), `thread`, `thread-scroll`, `msg` (dataSet role, item, quotable, streaming,
// sending), `note`, `empty-thread`, `suggestion`, `remote-bar` (kind off | gone) with `remote-bar-text`, `remote-bar-state` and
// `remote-servers`, `remote-off` (kind), `typing`, `wait-line` (wait), `prefix-end`, `forked-from`, `sent-quote-card`.
import { until } from "../shot.mjs";
import { byTid } from "./sel.mjs";

export const WAIT = 15000;

/** The messages the thread draws, top to bottom as they are on screen (a virtual list keeps no order in the page): [{ role, text, item }].
 *  `sending`: the message that is on its way. A long thread draws only the rows near the window: this is for a short one. */
export function messages(page) {
  return page.evaluate(() => [...document.querySelectorAll('[data-testid="msg"]')]
    .map((e) => ({ e, top: e.getBoundingClientRect().top }))
    .sort((a, b) => a.top - b.top)
    .map(({ e }) => ({ role: e.dataset.role + (e.dataset.sending ? " sending" : ""), text: (e.textContent ?? "").trim(), item: e.dataset.item === undefined ? undefined : +e.dataset.item })));
}

/** The text of the first element of that testID (under `root`, the page by default), "" for none. */
export const textOf = (page, id, data, root = page) => byTid(root, id, data).first().textContent({ timeout: 2000 }).catch(() => "");

/** Waits (generously) for the text of an element to include `want`; answers whether it did. */
export const says = (page, id, want, data) => until(async () => (await textOf(page, id, data)).includes(want), 10000);

/** Waits for the thread of the chat on screen to have a message of the user. */
export const threadShown = (page) => byTid(page, "msg", { role: "user" }).first().waitFor({ state: "visible", timeout: WAIT });
