import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CANVAS_THEMES, DARK, canvasFilter, canvasThemeOf, shown, targets } from "../src/logic/canvastheme.ts";
import { PALETTE, rgb } from "../src/logic/flavours.ts";
import { FLAVOURS } from "../src/logic/theme.ts";

const maxDiff = (a: string, b: string) => Math.max(...rgb(a).map((v, i) => Math.abs(v - rgb(b)[i])));

test("canvasThemeOf: plain light has no filter, the others have theirs", () => {
  assert.equal(canvasThemeOf("light", null), null);
  assert.equal(canvasThemeOf("dark", null), "dark");
  assert.equal(canvasThemeOf("light", "latte"), "latte");
  assert.equal(canvasThemeOf("dark", "mocha"), "mocha");
  assert.deepEqual(CANVAS_THEMES, ["dark", ...FLAVOURS]);
});

test("plain dark's ground and ink are the --bg and --text of styles.css's dark theme", () => {
  const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  const block = /^:root\[data-theme="dark"\] \{([^}]*)\}/m.exec(styles)?.[1] ?? "";
  assert.equal(/^\s*--bg: (#[0-9a-f]{6});/m.exec(block)?.[1], DARK.ground);
  assert.equal(/^\s*--text: (#[0-9a-f]{6});/m.exec(block)?.[1], DARK.ink);
  assert.deepEqual(targets("dark"), { ground: DARK.ground, ink: DARK.ink });
  for (const f of FLAVOURS) assert.deepEqual(targets(f), { ground: PALETTE[f].base, ink: PALETTE[f].text });
});

test("a filter: 20 matrix numbers, three tables of 256 that never fall, a unique id", () => {
  const ids = new Set<string>();
  for (const t of CANVAS_THEMES) {
    const f = canvasFilter(t);
    assert.equal(f.id, `aiwb-canvas-${t}`);
    ids.add(f.id);
    assert.equal(f.matrix.length, 20, t);
    assert.deepEqual(f.matrix.slice(15), [0, 0, 0, 1, 0], `${t}: alpha stays`);
    for (const row of [0, 1, 2]) assert.equal(f.matrix[row * 5 + 3], 0, `${t}: the colour rows leave alpha out`);
    for (const [name, tab] of Object.entries(f.tables)) {
      assert.equal(tab.length, 256, `${t} ${name}`);
      assert.ok(tab.every((v, i) => v >= 0 && v <= 1 && (i === 0 || v >= tab[i - 1])), `${t} ${name} is monotone in 0 to 1`);
      const end = t === "latte" ? rgb(PALETTE.latte.base)[["r", "g", "b"].indexOf(name)] / 255 : 1;
      assert.equal(tab[0], 0); assert.ok(Math.abs(tab[255] - end) < 1e-5, `${t} ${name}: ends at ${tab[255]}`);
    }
  }
  assert.equal(ids.size, CANVAS_THEMES.length);
  assert.deepEqual(canvasFilter("latte").matrix, [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0], "Latte's first stage is the identity");
});

test("every theme shows the stored white as its ground and the stored #1e1e1e as its ink", () => {
  for (const t of CANVAS_THEMES) {
    const { ground, ink } = targets(t);
    assert.ok(maxDiff(shown(t, "#ffffff"), ground) <= 1, `${t}: white is ${shown(t, "#ffffff")}, not ${ground}`);
    assert.ok(maxDiff(shown(t, "#1e1e1e"), ink) <= 1, `${t}: #1e1e1e is ${shown(t, "#1e1e1e")}, not ${ink}`);
  }
});

test("the dark themes' first stage is Excalidraw's invert(93%) hue-rotate(180deg), by the spec's formulas", () => {
  // computed here the way the CSS Filter Effects spec says, one filter after the other
  const invert = (c: number[]) => c.map((v) => 0.93 + v * (1 - 2 * 0.93));
  const hue = (c: number[]) => {
    const a = Math.PI, cos = Math.cos(a), sin = Math.sin(a);
    const m = [
      [0.213 + cos * 0.787 - sin * 0.213, 0.715 - cos * 0.715 - sin * 0.715, 0.072 - cos * 0.072 + sin * 0.928],
      [0.213 - cos * 0.213 + sin * 0.143, 0.715 + cos * 0.285 + sin * 0.140, 0.072 - cos * 0.072 - sin * 0.283],
      [0.213 - cos * 0.213 - sin * 0.787, 0.715 - cos * 0.715 + sin * 0.715, 0.072 + cos * 0.928 + sin * 0.072],
    ];
    return m.map((row) => row[0] * c[0] + row[1] * c[1] + row[2] * c[2]);
  };
  for (const t of ["dark", ...FLAVOURS.slice(1)] as const) {
    const f = canvasFilter(t);
    for (const sample of [[0, 0, 0], [1, 1, 1], [30 / 255, 30 / 255, 30 / 255], [1, 0, 0], [0, 1, 0], [0, 0, 1], [0.8, 0.3, 0.55], [0.1, 0.9, 0.4]]) {
      const want = hue(invert(sample));
      const got = [0, 1, 2].map((i) => f.matrix[i * 5] * sample[0] + f.matrix[i * 5 + 1] * sample[1] + f.matrix[i * 5 + 2] * sample[2] + f.matrix[i * 5 + 4]);
      got.forEach((v, i) => assert.ok(Math.abs(v - want[i]) < 1e-4, `${t} ${sample}: channel ${i} is ${v}, the spec's ${want[i]}`));
    }
  }
  // greys stay grey through it: a grey x comes out as 0.93 - 0.86 x in every channel
  const m = canvasFilter("dark").matrix;
  for (const row of [0, 1, 2]) {
    assert.ok(Math.abs(m[row * 5] + m[row * 5 + 1] + m[row * 5 + 2] + 0.86) < 1e-4 && m[row * 5 + 4] === 0.93, `row ${row}`);
  }
});
