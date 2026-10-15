// The driver of the sidebar's drags for the checks of the new build (a helper module of the drag's area: no dash in its name, so the runner does not
// take it for a check): it replaced `dragger` of dev/shot.mjs (gone with the page it drove), which drove HTML drag events through the DevTools protocol. The app drags
// with a pointer gesture (AD-70), so this one moves the pointer of the viewport (`pointerDragger` of sel.mjs): a mouse presses and moves, a finger is
// held (past the 300 ms of the long press) and then moves. The same calls at every viewport:
//   at(locator, fx, fy)             a point of an element's box, scrolled to first
//   row(name), head(name, fx, fy)   the point of a row's box (its middle), or of a group's header (fractions of its box: 0.3, 0.2 is the upper half)
//   OUTSIDE                         a point that is in no zone: on the page beside the sidebar, or on the sidebar's head where the sidebar is the page
//   start(p)                        press (and hold) at p, then move a little: answers whether the page started a drag (its label is drawn)
//   over(p)                         the pointer goes to p, and the page has drawn what it made of it
//   drop(), cancel()                the release where the pointer is; the cancel the pointer's own way (Escape with a mouse, the system's cancel for a finger)
//   lit()                           what is lit, by name: "group(Shop).drop [VISIBLE]", "head(Shop).drop-before [VISIBLE]", "loose.drop [VISIBLE]"
//   groupOf(name), parentOf(name)   where a row or a group is now ("" ungrouped or top level, null when it is not drawn)
import { until } from "../shot.mjs";
import { byTid, pointerDragger, tidSel, touchNow } from "./sel.mjs";

const T = (id) => `[data-testid=${JSON.stringify(id)}]`;

/** In the page, handed to `page.evaluate`: the readers the driver uses, put on `window` once. */
function install() {
  const nameOf = (g) => g?.querySelector(":scope > [data-testid=side-group-head] [data-testid=side-group-name], :scope > [style*=contents] > [data-testid=side-group-head] [data-testid=side-group-name]")?.textContent;
  const rows = () => [...document.querySelectorAll("[data-testid=side-row]")];
  // (a place near an edge of the list is brought to its middle: a pointer held in the edge zone scrolls the list after a moment, and the check is not about that)
  window.__keep = (e) => {
    const tree = document.querySelector("[data-testid=side-tree]")?.getBoundingClientRect(), r = e.getBoundingClientRect();
    if (tree && (r.top < tree.top + 60 || r.bottom > tree.bottom - 60)) e.scrollIntoView({ block: "center" });
  };
  window.__row = (name) => rows().find((r) => r.querySelector("[data-testid=side-name]")?.textContent === name);
  window.__head = (name) => [...document.querySelectorAll("[data-testid=side-group-head]")].find((h) => h.querySelector("[data-testid=side-group-name]")?.textContent === name);
  window.__lit = () => [...document.querySelectorAll("[data-drop=true], [data-drop-before=true]")].map((e) => {
    const before = e.dataset.dropBefore === "true", box = getComputedStyle(e).boxShadow;
    return (before ? "head(" + nameOf(e.closest("[data-testid=side-group]")) + ")" : e.dataset.testid === "side-loose" ? "loose" : "group(" + nameOf(e) + ")") + (before ? ".drop-before" : ".drop") + (box === "none" ? " [hidden]" : " [VISIBLE]");
  });
  window.__groupOf = (el) => (el ? nameOf(el.parentElement?.closest("[data-testid=side-group]")) ?? "" : null);
}

/** The sidebar as it is drawn: the group each row is in ("" ungrouped; rows nested under a board go with it and are left out) and the group each group is in. */
export const treeOf = (page) => page.evaluate(() => {
  const nameOf = (g) => g?.querySelector(":scope > [data-testid=side-group-head] [data-testid=side-group-name], :scope > [style*=contents] > [data-testid=side-group-head] [data-testid=side-group-name]")?.textContent ?? "";
  const rows = {}, groups = {};
  for (const r of document.querySelectorAll("[data-testid=side-tree] [data-testid=side-row]")) {
    if (r.closest("[data-testid=side-board-chats]")) continue;
    rows[r.querySelector("[data-testid=side-name]")?.textContent] = nameOf(r.closest("[data-testid=side-group]"));
  }
  for (const g of document.querySelectorAll("[data-testid=side-tree] [data-testid=side-group]")) groups[nameOf(g)] = nameOf(g.parentElement.closest("[data-testid=side-group]"));
  return { rows, groups };
});

/** steps: how many moves a move of the pointer is made of (10 by default, a hand's path; 1 jumps, as a check that looks at the mark in each place wants). */
export async function dragReader(page, { hold, steps } = {}) {
  await page.evaluate(install);
  const d = await pointerDragger(page, { ...(hold === undefined ? {} : { hold }), ...(steps === undefined ? {} : { steps }) });
  const touch = await touchNow(page);
  const frame = () => page.evaluate(() => new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(() => ok()))));
  const point = async (what, name, fx, fy) => {
    const p = await page.evaluate(([what, name, fx, fy]) => {
      const e = (what === "row" ? window.__row : window.__head)(name);
      if (!e) return null;
      window.__keep(e);
      const r = e.getBoundingClientRect();
      return { x: r.left + r.width * fx, y: r.top + r.height * fy };
    }, [what, name, fx, fy]);
    if (!p) throw new Error(`the sidebar has no ${what === "row" ? "row" : "group"} "${name}"`);
    return p;
  };
  const ghost = () => byTid(page, "drag-ghost").count().then((n) => n > 0);
  const viewport = page.viewportSize();
  const outside = async () => {
    const side = await byTid(page, "side").first().boundingBox();
    // (the page beside the sidebar; where the sidebar is the whole page, its head)
    if (side && side.x + side.width + 60 < viewport.width) return { x: (side.x + side.width + viewport.width) / 2, y: viewport.height / 2 };
    const brand = await byTid(page, "side-brand").first().boundingBox();
    return { x: brand.x + brand.width / 2, y: brand.y + brand.height / 2 };
  };
  let out = await outside();
  return {
    drawn: frame,
    touch,
    get OUTSIDE() { return out; },
    async refreshOutside() { out = await outside(); return out; },
    /** A point of a locator's box (fractions of it), scrolled to first: a section's head, say. */
    async at(locator, fx = 0.5, fy = 0.5) {
      await locator.evaluate((e) => window.__keep(e));
      const b = await locator.boundingBox();
      if (!b) throw new Error("the page does not show what the drag is to go to");
      return { x: b.x + b.width * fx, y: b.y + b.height * fy };
    },
    row: (name) => point("row", name, 0.5, 0.5),
    head: (name, fx = 0.3, fy = 0.5) => point("head", name, fx, fy),
    /** Press at p and move a little; `none`: the page is expected to start no drag (a short look, then false). */
    async start(p, { none = false } = {}) {
      await d.start(p);
      // (a few pixels past the slop of a mouse; a finger that holds has begun the drag already)
      await d.move({ x: p.x + 9, y: p.y + 5 });
      const began = await until(ghost, none ? 700 : 10000);
      if (!began) { await d.end(); await frame(); return false; }
      return true;
    },
    // (a real drag moves the pointer over and over, and React commits what one set a moment later)
    async over(p) { await d.move(p); await frame(); },
    async drop() { await d.end(); await frame(); await until(async () => !(await ghost()), 5000); await frame(); },
    async cancel() { await d.cancel(); await frame(); await until(async () => !(await ghost()), 5000); await frame(); },
    ghost,
    lit: () => page.evaluate(() => window.__lit()),
    groupOf: (name) => page.evaluate((n) => window.__groupOf(window.__row(n)), name),
    parentOf: (name) => page.evaluate((n) => window.__groupOf(window.__head(n)?.closest("[data-testid=side-group]")), name),
  };
}

export { tidSel, T };
