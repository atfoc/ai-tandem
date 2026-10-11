import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { ADDED, COLOURS, FLOORS, PAIRS, PALETTE, contrast, flavourCss, flavourTokens, luminance, mix } from "../src/logic/flavours.ts";
import { FLAVOURS, type Flavour } from "../src/logic/theme.ts";

const CSS = new URL("../src/flavours.css", import.meta.url);
const token = (f: Flavour, name: string) => { const t = flavourTokens(f).find((x) => x.name === name); assert.ok(t, `${f} sets ${name}`); return t; };
const near = (a: number, b: number) => Math.abs(a - b) < 0.006;

test("the palette: four flavours of 26 colours, the ones of @catppuccin/palette 1.8.0", () => {
  assert.deepEqual(Object.keys(PALETTE), [...FLAVOURS]);
  for (const f of FLAVOURS) {
    assert.deepEqual(Object.keys(PALETTE[f]), [...COLOURS]);
    for (const c of COLOURS) assert.match(PALETTE[f][c], /^#[0-9a-f]{6}$/, `${f} ${c}`);
  }
  assert.equal(COLOURS.length, 26);
  // a colour of each end of each flavour, as the package's css/catppuccin.css has them
  assert.deepEqual(FLAVOURS.map((f) => [PALETTE[f].rosewater, PALETTE[f].mauve, PALETTE[f].text, PALETTE[f].base, PALETTE[f].crust]), [
    ["#dc8a78", "#8839ef", "#4c4f69", "#eff1f5", "#dce0e8"],
    ["#f2d5cf", "#ca9ee6", "#c6d0f5", "#303446", "#232634"],
    ["#f4dbd6", "#c6a0f6", "#cad3f5", "#24273a", "#181926"],
    ["#f5e0dc", "#cba6f7", "#cdd6f4", "#1e1e2e", "#11111b"],
  ]);
  // Latte is the light one
  assert.deepEqual(FLAVOURS.map((f) => luminance(PALETTE[f].base) > luminance(PALETTE[f].text)), [true, false, false, false]);
});

test("contrast and mixing are WCAG's and color-mix's", () => {
  assert.equal(contrast("#000000", "#ffffff"), 21);
  assert.equal(contrast("#ffffff", "#ffffff"), 1);
  assert.equal(contrast("#1e1e2e", "#cdd6f4"), contrast("#cdd6f4", "#1e1e2e"));
  // the research's table (G5 §Q-D), to two places
  const p = PALETTE;
  assert.ok(near(contrast(p.latte.text, p.latte.base), 7.06) && near(contrast(p.mocha.text, p.mocha.base), 11.34));
  assert.ok(near(contrast(p.latte.subtext0, p.latte.base), 4.37) && near(contrast(p.latte.mauve, p.latte.mantle), 4.45));
  assert.ok(near(contrast(p.frappe.red, p.frappe.base), 4.65) && near(contrast(p.latte.yellow, p.latte.base), 2.31));
  assert.equal(mix("#ffffff", "#000000", 1), "#ffffff");
  assert.equal(mix("#ffffff", "#000000", 0), "#000000");
  assert.equal(mix("#ff0000", "#0000ff", 0.25), "#4000bf");
});

test("a token is the palette colour of its role", () => {
  for (const f of FLAVOURS) {
    const from = (name: string) => token(f, name).from;
    assert.deepEqual(["--bg", "--panel", "--line", "--line-2", "--text"].map(from), ["base", "mantle", "surface0", "surface1", "text"], f);
    assert.deepEqual(["--accent", "--accent-fill", "--on-accent", "--user-text"].map(from), ["mauve", "mauve", "base", "text"], f);
    assert.deepEqual(["--danger", "--danger-fill", "--on-danger"].map(from), ["red", "red", "base"], f);
    assert.deepEqual(["--syn-keyword", "--syn-title", "--syn-attr"].map(from), ["mauve", "blue", "blue"], f);
    for (const t of flavourTokens(f)) if (t.from) { assert.equal(t.value, PALETTE[f][t.from], `${f} ${t.name}`); }
  }
  // in the three dark flavours nothing is under its floor: every colour is the palette's own
  for (const f of FLAVOURS.slice(1)) {
    const from = (name: string) => token(f, name).from;
    assert.deepEqual(["--muted", "--faint", "--ok", "--warn"].map(from), ["subtext0", "overlay1", "green", "yellow"], f);
    assert.deepEqual(["--syn-string", "--syn-number", "--syn-type"].map(from), ["green", "peach", "yellow"], f);
    assert.deepEqual(flavourTokens(f).filter((t) => !t.from).map((t) => t.name), ["--accent-soft", "--warn-soft", "--danger-soft"], `${f}: only the tints are mixed`);
  }
});

test("Latte: a colour under its floor gives way to the next of its family, or is mixed toward Text", () => {
  const p = PALETTE.latte;
  // a family has a stronger colour
  assert.equal(token("latte", "--muted").from, "subtext1");
  assert.match(token("latte", "--muted").note, /^Subtext 0 is 4\.36:1 on Base, under 4\.5:1$/);
  assert.equal(token("latte", "--faint").from, "overlay2");
  assert.match(token("latte", "--faint").note, /^Overlay 1 is 2\.46:1 on the accent's tint, under 3:1$/);
  // no family: the least mix toward Text, in steps of 5 %, that has the floor; the recipe says which
  // (the ground named is the one the colour is weakest on, of those it must be read on; ok's is its own tint, behind
  // an added line of a change, which gets darker as ok does)
  const mantle = () => p.mantle, added = (ok: string) => mix(ok, p.base, ADDED / 100);
  for (const [name, colour, on, under] of [["--ok", "green", "an added line's ground", added], ["--warn", "yellow", "Mantle", mantle], ["--syn-string", "green", "Mantle", mantle],
    ["--syn-number", "peach", "Mantle", mantle], ["--syn-type", "yellow", "Mantle", mantle]] as const) {
    const t = token("latte", name), m = /^(\w+) (\d+) %, Text (\d+) %: ([\d.]+):1 on ([\w' ]+) \(/.exec(t.note);
    assert.ok(m, `${name}: ${t.note}`);
    const share = Number(m[2]);
    assert.equal(t.from, "");
    assert.equal(m[1].toLowerCase(), colour); assert.equal(m[5], on);
    assert.equal(share + Number(m[3]), 100); assert.equal(share % 5, 0);
    assert.equal(t.value, mix(p[colour], p.text, share / 100), `${name} is the mix its note says`);
    const weaker = mix(p[colour], p.text, (share + 5) / 100);
    assert.ok(contrast(t.value, under(t.value)) >= FLOORS.weak, `${name} has its floor`);
    assert.ok(Number(m[4]) <= contrast(t.value, under(t.value)), `${name}: the ratio told is not rounded up`);
    assert.ok(contrast(weaker, under(weaker)) < FLOORS.weak, `${name}: one step less of Text is under the floor`);
  }
  // the accent's tint is Mauve at 10 % over Base, in every flavour
  for (const f of FLAVOURS) assert.equal(token(f, "--accent-soft").value, mix(PALETTE[f].mauve, PALETTE[f].base, 0.1), f);
  // what passes as it is stays the palette's
  assert.deepEqual(["--accent", "--danger", "--syn-keyword", "--syn-title"].map((n) => token("latte", n).from), ["mauve", "red", "mauve", "blue"]);
});

test("every floor holds in every flavour", () => {
  for (const f of FLAVOURS) {
    for (const pair of PAIRS) {
      const c = contrast(token(f, pair.fg).value, token(f, pair.bg).value);
      assert.ok(c >= pair.floor, `${f}, ${pair.what}: ${pair.fg} on ${pair.bg} is ${c.toFixed(2)}:1, under ${pair.floor}:1`);
    }
  }
  // the goal's own floors are all among them
  const has = (fg: string, bg: string, floor: number) => PAIRS.some((x) => x.fg === fg && x.bg === bg && x.floor === floor);
  for (const fg of ["--text", "--muted", "--accent", "--danger"]) assert.ok(has(fg, "--bg", 4.5), fg);
  assert.ok(has("--on-accent", "--accent-fill", 4.5));
  for (const fg of ["--faint", "--ok", "--warn"]) assert.ok(has(fg, "--bg", 3), fg);
  for (const k of ["keyword", "string", "number", "title", "type", "attr"]) assert.ok(has(`--syn-${k}`, "--panel", 3), k);
  assert.ok(has("--knob", "--line-2", 3) && has("--knob-on", "--accent-fill", 3));
});

test("the signs of a change have their floor on their own lines' grounds, in every flavour", () => {
  // styles.css: an added line is on ok's tint and a removed one on danger's, each over the background, with its sign in that colour
  const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  const share = (cls: string, token: string) => {
    const m = new RegExp(`\\.diff-row\\.${cls} \\{ background: color-mix\\(in srgb, var\\(${token}\\) (\\d+)%, transparent\\); \\} \\.diff-row\\.${cls} \\.diff-sign \\{ color: var\\(${token}\\); \\}`).exec(styles);
    assert.ok(m, `styles.css draws a .diff-row.${cls} on a tint of ${token}, its sign in ${token}`);
    return Number(m[1]) / 100;
  };
  const add = share("add", "--ok"), del = share("del", "--danger");
  assert.equal(add * 100, ADDED, "the tint the palette module holds ok to is the one styles.css draws");
  for (const f of FLAVOURS) {
    const bg = token(f, "--bg").value;
    for (const [what, colour, tint] of [["+", token(f, "--ok").value, add], ["−", token(f, "--danger").value, del]] as const) {
      const c = contrast(colour, mix(colour, bg, tint));
      assert.ok(c >= FLOORS.weak, `${f}: the "${what}" of a change is ${c.toFixed(2)}:1 on its line's ground, under ${FLOORS.weak}:1`);
    }
  }
  // Latte's Green needs one step more of Text for it than for the accent's tint
  assert.match(token("latte", "--ok").note, /^Green 75 %, Text 25 %: 3\.10:1 on an added line's ground \(Green is 2\.55:1 on an added line's ground, under 3:1\)$/);
});

test("a flavour sets no agent colour, no chart colour, no hover, backdrop or shadow", () => {
  for (const f of FLAVOURS) {
    for (const t of flavourTokens(f)) assert.doesNotMatch(t.name, /^--(claude|cursor|pi|viz|hover|backdrop|shadow)/, `${f} ${t.name}`);
    assert.deepEqual(flavourTokens(f).map((t) => t.name), flavourTokens("mocha").map((t) => t.name), `${f} sets the tokens the others set`);
  }
});

test("every token a flavour sets is one styles.css has, and flavours.css is what the module says", () => {
  const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  const root = /^:root \{([^}]*)\}/m.exec(styles)?.[1] ?? "";
  for (const t of flavourTokens("latte")) assert.match(root, new RegExp(`^\\s*${t.name}: `, "m"), `${t.name} is a token of :root`);
  if (process.env.WRITE) writeFileSync(CSS, flavourCss());
  const css = readFileSync(CSS, "utf8");
  assert.equal(css, flavourCss(), "src/flavours.css is not what logic/flavours.ts says: run WRITE=1 npm test");
  // the licence's notice, in a comment the build keeps
  assert.match(css, /^\/\*![\s\S]*Copyright \(c\) 2021 Catppuccin[\s\S]*The above copyright notice and this permission notice shall be included[\s\S]*?\*\//);
  for (const f of FLAVOURS) assert.equal(css.split(`:root[data-flavour="${f}"] {`).length, 2, `one block for ${f}`);
  assert.match(readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8"), /import "\.\/styles\.css";\nimport "\.\/flavours\.css";/, "after styles.css, whose tokens it replaces");
});
