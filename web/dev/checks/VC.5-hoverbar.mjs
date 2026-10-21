// VC.5 (voice-chats P14F, a follow-up of P14's Read aloud): the mouse's hover bar of a message holds every action, Read aloud last, on a short message of the
// person's and on a reply, in a narrow pane (the chat panel beside a board, at the saved widths 300, 400 and 760 px) and in a wide one: the bar stays inside the
// thread (never over the sidebar, nor its resizer), each of its buttons is the element at its own centre (nothing of the next message covers it), and it is one
// line. P14's `width: max-content` had grown it to the left past the pane's edge, where the sidebar's resizer took the click on Branch (A2.2, A2.3).
import { check, seed } from "../shot.mjs";
import { openAt } from "./composer.mjs";
import { byTid } from "./sel.mjs";

export const viewports = ["desktop"];

await check("VC.5 the hover bar of a message stays in the thread and every action in it is reachable", async ({ url, layout, open, fail }) => {
  const states = await seed(url, "A2");
  for (const id of ["plain-move", "board-move"]) {
    const s = states.find((x) => x.id === id);
    if (!s) { fail(`the seed has no state ${id}`); continue; }
    for (const width of [300, 400, 760]) {
      const { page, ctx } = await openAt(open, s, layout, width);
      for (const role of ["assistant", "user"]) {
        const name = `${id} at ${width} px, a ${role} message`;
        const msg = byTid(page, "msg", { role }).first();
        await msg.hover();
        await byTid(msg, "fk-acts").first().waitFor({ state: "visible", timeout: 15000 });
        const r = await msg.evaluate((m) => {
          const bar = m.querySelector('[data-testid="fk-acts"]'), b = bar.getBoundingClientRect();
          const thread = m.closest('[data-testid="thread"]').getBoundingClientRect();
          const acts = [...bar.querySelectorAll('[data-testid="fk-act"]')].map((el) => {
            const q = el.getBoundingClientRect(), hit = document.elementFromPoint(q.x + q.width / 2, q.y + q.height / 2);
            return { kind: el.dataset.kind, hit: el.contains(hit), top: q.top };
          });
          return { left: b.left, right: b.right, height: b.height, thread: { left: thread.left, right: thread.right }, acts };
        });
        if (r.left < r.thread.left - 0.5 || r.right > r.thread.right + 0.5) fail(`${name}: the bar is at ${Math.round(r.left)}-${Math.round(r.right)} px, the thread at ${Math.round(r.thread.left)}-${Math.round(r.thread.right)}`);
        const blocked = r.acts.filter((a) => !a.hit).map((a) => a.kind);
        if (blocked.length) fail(`${name}: the actions ${blocked} are not the element at their own centre`);
        if (r.acts.at(-1)?.kind !== "read") fail(`${name}: Read aloud is not the last action (${r.acts.map((a) => a.kind)})`);
        if (r.acts.length < 4) fail(`${name}: the bar has ${r.acts.length} actions: ${r.acts.map((a) => a.kind)}`);
        if (new Set(r.acts.map((a) => Math.round(a.top))).size > 1) fail(`${name}: the bar is on more than one line`);
        await page.mouse.move(1, 1);
      }
      await ctx.close();
    }
  }
}, { viewports, page: false });
