// H1's reader of the phone's Home over testIDs (no dash in the name: not a check): `homeSeen`, what Home or a group's screen shows now
// (plans/ux-improvements/h1-design.md §8). The counterpart of side.mjs's readers for the sidebar.
import { tidSel } from "./sel.mjs";

const SCREEN = `${tidSel("home")}, ${tidSel("group-screen")}`;

/** What Home (or a group screen, `root` a locator of it) shows now:
 *    { state, server, key, title, sub, chips: [{ server, word, selected }], sections: [{ section, count }],
 *      rows: [{ kind, key, name, sub, attention, count, height }], list: { stale } | null, card?: { server, word, text } }
 *  `state` and `server` are Home's dataSet (empty for a group screen, which has `key` instead); `title` and `sub` the large title's two lines
 *  (a group screen's) or Home's one-server line `sub`; `selected` and `stale` booleans; `count` the number a group's badge says ("" for none).
 *  With no `root`, the screen on top (the last of Home and the group screens drawn: a screen pushed over Home leaves Home drawn under it). */
export async function homeSeen(page, root) {
  const at = (root ?? page.locator(SCREEN)).last();
  return at.evaluate((el) => {
    const q = (s) => [...el.querySelectorAll(s)], one = (s) => el.querySelector(s);
    const tid = (id) => `[data-testid="${id}"]`;
    const text = (e) => (e?.innerText ?? "").replace(/\s+/g, " ").trim();
    const list = one(tid("home-list"));
    const card = one(tid("problem-card"));
    const large = one(tid("large-title"));
    const lines = large ? large.innerText.split("\n").map((s) => s.trim()).filter(Boolean) : [];
    return {
      state: el.dataset.state ?? "",
      server: el.dataset.server ?? "",
      key: el.dataset.key ?? "",
      title: lines[0] ?? "",
      sub: text(one(tid("home-sub"))) || lines[1] || "",
      chips: q(tid("server-chip")).map((c) => ({ server: c.dataset.server, word: c.dataset.word, selected: c.dataset.selected === "true" })),
      sections: q(tid("home-section")).map((s) => ({ section: s.dataset.section, count: Number(s.dataset.count) })),
      rows: q(tid("home-row")).map((r) => ({
        kind: r.dataset.kind, key: r.dataset.key, name: text(r.querySelector(tid("home-row-name"))), sub: text(r.querySelector(tid("home-row-sub"))),
        attention: r.dataset.attention, count: r.dataset.count ?? "", height: r.getBoundingClientRect().height,
      })),
      list: list ? { stale: list.dataset.stale === "true" } : null,
      ...(card ? { card: { server: card.dataset.server, word: card.dataset.word, text: text(card) } } : {}),
    };
  });
}
