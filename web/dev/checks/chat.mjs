// The readers of the chat view for the checks of the new build (package S4; the counterpart of the old `.thread .msg` reads). No dash in
// the name: the runner does not take it for a check. testIDs of screens/chat: `chat-head` (+ `chat-head-name`, `chat-head-sub`,
// `chat-head-server`, `chat-name-input`, `chat-hide`), `thread`, `thread-scroll`, `msg` (dataSet role, item, quotable, streaming,
// sending), `note`, `empty-thread`, `suggestion`, `remote-bar` (kind off | gone) with `remote-bar-text`, `remote-bar-state` and
// `remote-servers`, `remote-off` (kind), `typing`, `wait-line` (wait), `prefix-end`, `forked-from`, `sent-quote-card`.
import { until } from "../shot.mjs";
import { byTid, press } from "./sel.mjs";

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

// ---- (X2 chunk 1) a chat of a server that is not connected, on the phone
// The phone has no top banner (goal 3.5: `remote-bar` is not drawn there). Its header says "● <Server> · offline" in `chat-head-sub`; what blocks
// the composer is V1's bar in the toolbar's place, testID `composer-block` (dataSet kind offline | gone, place toolbar; v1-design.md §1) with
// `block-servers` for offline only. The server's name, while it is connected, is in Chat info's Server row.
/** The block the phone's composer draws in the box's or the toolbar's place (not the cards above the box): { kind, place, text, servers } or null. */
export function composerBlock(page) {
  return page.evaluate(() => {
    const e = [...document.querySelectorAll('[data-testid="composer-block"]')].find((x) => x.dataset.place !== "above");
    return e ? { kind: e.dataset.kind, place: e.dataset.place, text: (e.textContent ?? "").replace(/\s+/g, " ").trim(), servers: !!e.querySelector('[data-testid="block-servers"]') } : null;
  });
}

/** Send is off: not drawn at all (V1's block takes the toolbar's place) or drawn and disabled. */
export async function sendIsOff(page) {
  const send = byTid(page, "send");
  return !(await send.count()) || await send.first().isDisabled();
}

/** The sub-line of the phone's header (`chat-head-sub`), spaces folded. */
export async function headSub(page) { return (await textOf(page, "chat-head-sub")).replace(/\s+/g, " ").trim(); }

/** The server the open chat is on, read from Chat info's Server row ("<name> · <state>"; "This computer" for this computer's own); the sheet is closed. */
export async function serverInInfo(page, fail) {
  await press(page, byTid(page, "chat-more").first());
  await byTid(page, "chat-info").first().waitFor({ state: "visible", timeout: 10000 });
  const row = byTid(page, "chat-info-row", { row: "server" }).first();
  await row.waitFor({ state: "visible", timeout: 10000 });
  const name = ((await row.innerText()).replace(/\s+/g, " ").trim().replace(/^Server\s*/, "").split(" · ")[0] ?? "").trim();
  await page.keyboard.press("Escape");
  if (!await until(async () => !await byTid(page, "chat-info").count(), 5000)) fail("Escape did not close Chat info");
  return name;
}
