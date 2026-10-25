// UX.F1-kit.mjs's section "forms" (app/src/dev/kit/forms.tsx): what it proves is listed in UX.F1-kit.mjs's header. `run(c)` gets the
// check's helpers (c.T, c.rect, c.press, c.open, c.expect, …: UX.F1-kit.mjs `body`) and calls c.fail for what is wrong.
// P3 FormSheet: head Cancel · Title · Save, Save off until typing, the large detent, the leave guard (a P4 over the P3: Esc, the dimmed page and
// Cancel ask on a changed form; a clean one closes at once), Save busy then closed, a failed save kept open with `form-error`.
// P4 ConfirmSheet: tile, 20 pt title, 15 pt body, 50 pt full-width go button repeating verb and noun, grey Cancel, busy and error inside.
// The shell's `confirm()`: a sheet at the phone's width (`confirm-dialog` holding a `confirm-go`), today's centred dialog on the desktop.
const FIELD = '[data-testid="kit-form-field"]';

export async function run(c) {
  const { page, T, rect, win, near, expect, until, open, text, press, touch } = c;
  const last = () => text("kit-forms-last");
  const none = () => until(async () => !(await T("form-sheet").count()) && !(await T("confirm-sheet").count()) && !(await T("confirm-dialog").count()));
  const has = async (id) => (await T(id).count()) > 0;
  const disabled = async (id) => (await T(id).first().getAttribute("aria-disabled")) === "true";
  const px = (css) => c.fontPx(css);
  /** Closes whatever is left open, by Esc (a changed form asks first: Esc again on the guard's Discard). */
  const reset = async () => {
    for (let i = 0; i < 3 && !(await none()); i++) {
      if (await has("confirm-go")) await press(T("confirm-go").first()).catch(() => {});
      else await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
    }
  };
  const opened = async (name, id) => {
    await open(name);
    if (!expect(await until(async () => !!(await rect(id))), `${name}: no ${id} after ${name} was pressed`)) return false;
    await c.settled(id); // (the sheet rises: measure it once it has stopped)
    return true;
  };
  /** Waits until the sheet `css` stopped rising (c.settled), then gives its box. */
  const still = (css) => c.settled(css);
  const type = (v) => page.fill(FIELD, v);
  const form = '[data-testid="form-sheet"]', conf = '[data-testid="confirm-sheet"]';
  await reset();

  // ---- P3: the head, the large detent, a clean form closes at once
  if (await opened("form", form)) {
    await c.sweep(form, "form");
    const w = await win();
    const s = await until(async () => { const r = await rect(form); return r && near(r.y, 8, 2) ? r : null; });
    const r = await rect(form);
    expect(!!s, `form: the sheet's top is at ${r?.y}, not 8 px under the window's top`);
    expect(!!r && near(r.h, w.h - 8, 2), `form: the sheet is ${r?.h} px high, not the window (${w.h}) less the top safe area (0) and 8`);
    expect((await text("sheet-left")) === "Cancel" && (await text("sheet-title")) === "Rename chat" && (await text("sheet-right")) === "Save",
      `form: the head reads "${await text("sheet-left")}" · "${await text("sheet-title")}" · "${await text("sheet-right")}", not Cancel · Rename chat · Save`);
    expect((await text("sheet-sub")) === "Checkout service · Studio Mac", `form: the sub-line is "${await text("sheet-sub")}"`);
    expect(await disabled("sheet-right"), "form: Save is on before anything is typed");
    const title = await rect('[data-testid="sheet-title"]');
    expect(!!title && !!r && near(title.x + title.w / 2, r.x + r.w / 2, 4), "form: the title is not in the middle of the head");
    if (touch) for (const id of ["sheet-left", "sheet-right", "kit-form-field"]) {
      const b = await rect(`[data-testid="${id}"]`);
      expect(!!b && b.w >= 43.5 && b.h >= 43.5, `form: ${id} is ${b?.w}×${b?.h}, under 44`);
    }
    expect(((await c.minFontPx(form)) ?? 0) >= 13, `form: text in the sheet is ${await c.minFontPx(form)} px, under 13`);
    await type("Cart tests");
    expect(await until(async () => !(await disabled("sheet-right"))), "form: Save is still off after typing");
    await type("");
    expect(await until(async () => await disabled("sheet-right")), "form: Save is still on after the text was erased");
    await press(T("sheet-left"));
    expect(await none(), "form: a clean form's Cancel did not close it at once");
    expect((await has("confirm-sheet")) === false, "form: a clean form asked before closing");
  }

  // ---- P3: the leave guard
  if (await opened("form", form)) {
    await type("Cart tests");
    await press(T("sheet-left"));
    const asked = expect(await until(async () => !!(await rect(conf))), "guard: Cancel on a changed form did not open the discard confirm");
    if (asked) {
      const f = await still(form), g = await still(conf), w = await win();
      expect(!!f && !!g && g.w > 0 && g.h > 0 && f.h > 0, "guard: the form and the discard confirm are not both drawn");
      expect(!!g && g.bottom <= w.h + 1 && !!f && g.y > f.y, "guard: the discard confirm is not over the form's lower part");
      expect((await text("confirm-title")) === "Discard changes to “Rename chat”?", `guard: the title is "${await text("confirm-title")}"`);
      expect((await text("confirm-go")) === "Discard changes", `guard: the button reads "${await text("confirm-go")}", not "Discard changes"`);
      expect((await text("confirm-cancel")) === "Cancel", `guard: the other button reads "${await text("confirm-cancel")}", not "Cancel"`);
      await press(T("confirm-cancel"));
      expect(await until(async () => !(await has("confirm-sheet"))), "guard: Cancel did not close the discard confirm");
      expect((await has("form-sheet")) && (await page.inputValue(FIELD)) === "Cart tests", "guard: Cancel did not keep the form and its text");
    }
    // Esc asks too, and Esc on the confirm keeps editing
    await page.keyboard.press("Escape");
    expect(await until(async () => await has("confirm-sheet")), "guard: Esc on a changed form did not ask");
    await page.keyboard.press("Escape");
    expect(await until(async () => !(await has("confirm-sheet"))) && (await has("form-sheet")), "guard: Esc on the discard confirm closed more than the confirm");
    // a press on the dimmed page above the sheet asks too
    const w = await win();
    if (touch) await page.touchscreen.tap(w.w / 2, 3); else await page.mouse.click(w.w / 2, 3);
    expect(await until(async () => await has("confirm-sheet")), "guard: a press on the dimmed page did not ask");
    await press(T("confirm-go"));
    expect(await none(), "guard: Discard changes did not close both sheets");
    expect((await last()) === "closed", `guard: the readout says "${await last()}" after a discard`);
  }

  // ---- P3: Save busy, then closed
  if (await opened("form", form)) {
    await type("Cart tests");
    await press(T("sheet-right"));
    const busy = await page.evaluate(() => {
      const q = (id) => document.querySelector(`[data-testid="${id}"]`);
      return { right: q("sheet-right")?.getAttribute("aria-disabled"), left: q("sheet-left")?.getAttribute("aria-disabled"), word: q("sheet-right")?.textContent };
    });
    expect(busy.right === "true" && busy.left === "true", `save: while saving Save is ${busy.right} and Cancel ${busy.left} (aria-disabled), not both true`);
    expect(/saving/i.test(busy.word ?? ""), `save: while saving Save reads "${busy.word}"`);
    expect(await none(), "save: the form did not close after the save succeeded");
    expect(await until(async () => (await last()) === "saved:Cart tests"), `save: the readout says "${await last()}", not "saved:Cart tests"`);
  }

  // ---- P3: a failing save keeps the form open with the error
  if (await opened("form-fails", form)) {
    await type("Cart tests");
    await press(T("sheet-right"));
    expect(await until(async () => await has("form-error")), "form-fails: no form-error after the save threw");
    if (await has("form-error")) {
      expect((await text("form-error")) === "Could not save: the server is offline", `form-fails: the error reads "${await text("form-error")}"`);
      expect((await T("form-error").first().getAttribute("role")) === "alert", "form-fails: the error is not an alert");
      expect(((await px('[data-testid="form-error"]')) ?? 0) >= 13, `form-fails: the error is ${await px('[data-testid="form-error"]')} px, under 13`);
      const e = await rect('[data-testid="form-error"]'), f = await rect(form);
      expect(!!e && !!f && e.y >= f.y && e.bottom <= f.bottom, "form-fails: the error is outside the sheet");
    }
    expect(await has("form-sheet") && !(await disabled("sheet-right")) && !(await disabled("sheet-left")), "form-fails: the form is closed or its buttons stay off after the failure");
    expect((await last()) === "closed", `form-fails: the readout says "${await last()}"`);
    await press(T("sheet-left"));
    expect(await until(async () => await has("confirm-sheet")), "form-fails: Cancel on the changed form did not ask");
    await press(T("confirm-go"));
    expect(await none(), "form-fails: Discard changes did not close the form");
  }

  // ---- P4: the look, busy, then closed
  const DANGER_SOFT = { light: "rgb(253, 236, 236)" }; // tokens.ts `dangerSoft` of the light theme
  if (await opened("confirm", conf)) {
    await c.sweep(conf, "confirm");
    const s = await still(conf), w = await win();
    const go = await rect('[data-testid="confirm-go"]'), cancel = await rect('[data-testid="confirm-cancel"]');
    const tile = await rect('[data-testid="confirm-tile"]'), title = await rect('[data-testid="confirm-title"]'), body = await rect('[data-testid="confirm-body"]');
    expect(!!tile && tile.w >= 43.5 && near(tile.w, tile.h, 1), `confirm: the tile is ${tile?.w}×${tile?.h}, not a 44 pt square`);
    expect(!!tile && !!title && title.y >= tile.bottom && !!body && body.y >= title.bottom, "confirm: the tile, the title and the body are not in order down the sheet");
    const bg = await page.evaluate(() => getComputedStyle(document.querySelector('[data-testid="confirm-tile"]')).backgroundColor);
    expect(bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent", "confirm: the tile has no background");
    if ((await text("gallery-theme")) === "light") expect(bg === DANGER_SOFT.light, `confirm: the tile is ${bg}, not the soft red ${DANGER_SOFT.light}`);
    expect((await px('[data-testid="confirm-title"]')) === 20, `confirm: the title is ${await px('[data-testid="confirm-title"]')} px, not 20`);
    expect((await text("confirm-title")) === "Delete “Fix the flaky cart test”?", `confirm: the title is "${await text("confirm-title")}"`);
    expect(((await px('[data-testid="confirm-body"]')) ?? 0) >= 15, `confirm: the body is ${await px('[data-testid="confirm-body"]')} px, under 15`);
    expect(((await c.minFontPx(conf)) ?? 0) >= 13, `confirm: text in the sheet is ${await c.minFontPx(conf)} px, under 13`);
    expect(!!go && go.h >= 49.5, `confirm: the go button is ${go?.h} px high, under 50`);
    expect(!!go && !!s && near(go.w, s.w - 32, 2), `confirm: the go button is ${go?.w} px wide, not the sheet's content (${s && s.w - 32})`);
    expect(!!cancel && cancel.h >= 49.5 && !!go && cancel.y > go.bottom && !!s && near(cancel.w, go.w, 2), "confirm: Cancel is not a 50 pt button under the go button, as wide");
    expect(!!s && s.h <= w.h * 0.5 + 2, `confirm: the sheet is ${s?.h} px high, over half the window (${w.h / 2})`);
    expect((await text("confirm-go")) === "Delete chat", `confirm: the go button reads "${await text("confirm-go")}", not "Delete chat" (verb and noun)`);
    expect((await text("confirm-cancel")) === "Cancel", `confirm: the other button reads "${await text("confirm-cancel")}"`);
    const goBg = await page.evaluate(() => getComputedStyle(document.querySelector('[data-testid="confirm-go"]')).backgroundColor);
    const cancelBg = await page.evaluate(() => getComputedStyle(document.querySelector('[data-testid="confirm-cancel"]')).backgroundColor);
    expect(goBg !== cancelBg, "confirm: the go button and Cancel have the same background");
    await press(T("confirm-go"));
    const busy = await page.evaluate(() => { const g = document.querySelector('[data-testid="confirm-go"]'); return { off: g?.getAttribute("aria-disabled"), label: g?.textContent }; });
    expect(busy.off === "true" && busy.label === "Delete chat", `confirm: while busy the go button is ${JSON.stringify(busy)}, not off with its label kept`);
    expect(await none(), "confirm: the sheet did not close after the action succeeded");
    expect(await until(async () => (await last()) === "deleted"), `confirm: the readout says "${await last()}", not "deleted"`);
  }

  // ---- P4: a failing action keeps the sheet open with the error
  if (await opened("confirm-fails", conf)) {
    await press(T("confirm-go"));
    expect(await until(async () => await has("confirm-error")), "confirm-fails: no confirm-error after the action threw");
    if (await has("confirm-error")) {
      expect((await text("confirm-error")) === "Could not delete: the server is offline", `confirm-fails: the error reads "${await text("confirm-error")}"`);
      expect((await T("confirm-error").first().getAttribute("role")) === "alert", "confirm-fails: the error is not an alert");
      expect(((await px('[data-testid="confirm-error"]')) ?? 0) >= 13, "confirm-fails: the error is under 13 px");
    }
    expect((await has("confirm-sheet")) && !(await disabled("confirm-go")), "confirm-fails: the sheet closed or the go button stays off");
    expect((await last()) === "closed", `confirm-fails: the readout says "${await last()}"`);
    await press(T("confirm-cancel"));
    expect(await none(), "confirm-fails: Cancel did not close the sheet");
  }

  // ---- P4: tone accent
  if (await opened("confirm-accent", conf)) {
    const colours = await page.evaluate(() => {
      const bg = (id) => getComputedStyle(document.querySelector(`[data-testid="${id}"]`)).backgroundColor;
      return { tile: bg("confirm-tile"), go: bg("confirm-go") };
    });
    expect(colours.tile !== DANGER_SOFT.light && colours.go !== "rgb(224, 49, 49)", `confirm-accent: the tile (${colours.tile}) or the button (${colours.go}) is red`);
    expect((await text("confirm-go")) === "Save and close", `confirm-accent: the go button reads "${await text("confirm-go")}"`);
    await press(T("confirm-go"));
    expect(await none(), "confirm-accent: the sheet did not close");
    expect(await until(async () => (await last()) === "confirmed"), `confirm-accent: the readout says "${await last()}"`);
  }

  // ---- the shell's confirm(): a sheet on the phone, today's centred dialog on the desktop
  await open("shell-confirm");
  if (expect(await until(async () => await has("confirm-dialog")), "shell-confirm: no confirm-dialog after confirm() was called")) {
    const d = await still('[data-testid="confirm-dialog"]'), w = await win();
    await c.sweep('[data-testid="confirm-dialog"]', "shell-confirm");
    if (c.layout === "phone") {
      expect(await has("confirm-go") && await has("confirm-tile"), "shell-confirm: the phone's confirm is not a ConfirmSheet (no confirm-go or tile)");
      expect((await text("confirm-go")) === "Delete chat", `shell-confirm: the go button reads "${await text("confirm-go")}", not the request's confirmLabel`);
      expect(!!d && near(d.bottom, w.h, 2) && d.w >= w.w - 2, `shell-confirm: the phone's confirm is not a sheet at the bottom (${JSON.stringify(d)})`);
      await press(T("confirm-go"));
    } else {
      expect(!(await has("confirm-go")) && !(await has("confirm-tile")), "shell-confirm: the desktop's confirm is a ConfirmSheet, not today's dialog");
      expect(!!d && near(d.x + d.w / 2, w.w / 2, 2) && near(d.y + d.h / 2, w.h / 2, 4), `shell-confirm: the desktop's confirm is not centred (${JSON.stringify(d)})`);
      await press(page.locator('[data-testid="confirm-dialog"]').getByRole("button", { name: "Delete", exact: true }));
    }
    expect(await until(async () => !(await has("confirm-dialog"))), "shell-confirm: the confirm did not close after its action");
    expect(await until(async () => (await last()) === "shell-deleted"), `shell-confirm: the readout says "${await last()}", not "shell-deleted"`);
  }
  await reset();
}
