// The four Catppuccin flavours as colour tokens: the palette, which palette colour each token of styles.css takes,
// and what is taken in its place where the palette's colour is too weak to read. DOM-free. src/flavours.css is what
// flavourCss() answers, written by test/flavours.test.ts (WRITE=1) and held to it by the same test.
//
// The palette is Catppuccin's own, @catppuccin/palette 1.8.0 (MIT, Copyright (c) 2021 Catppuccin), used as its style
// guide says (https://github.com/catppuccin/catppuccin/blob/main/docs/style-guide.md): Base behind everything, Mantle
// for secondary panes, the surfaces for lines, Text, Subtext and Overlay for text, Base for text on an accent, Green,
// Yellow and Red for ok, warning and danger. The accent is Mauve: the app's accent is a violet, and Mauve is the only
// candidate that passes as text on Base in all four flavours.
//
// The guide puts legibility first, so each colour has a floor (FLOORS): 4.5:1 on Base for what is read as text, 3:1
// for the weak ones (faint text, ok, warning, the colours of code), on every ground the app puts them on
// (flavourTokens says which). A colour under its floor gives way to the next stronger one of its family (Subtext 0,
// Subtext 1; Overlay 1, Overlay 2); one with no family, or whose family does not pass either, is mixed toward Text in
// steps of 5 % until it passes, and the recipe is written beside it. In the three dark flavours nothing is under its
// floor and every colour is the palette's own; the mixes are Latte's.
//
// A flavour sets no agent colour, no chart colour, no hover, backdrop or shadow: those stay the ones of the light or
// dark theme it is laid over (logic/theme.ts).
import { FLAVOURS, type Flavour } from "./theme.ts";

export const COLOURS = ["rosewater", "flamingo", "pink", "mauve", "red", "maroon", "peach", "yellow", "green", "teal", "sky", "sapphire", "blue", "lavender",
  "text", "subtext1", "subtext0", "overlay2", "overlay1", "overlay0", "surface2", "surface1", "surface0", "base", "mantle", "crust"] as const;
export type Colour = typeof COLOURS[number];

const palette = (hexes: string): Record<Colour, string> => {
  const list = hexes.trim().split(/\s+/);
  return Object.fromEntries(COLOURS.map((c, i) => [c, "#" + list[i]])) as Record<Colour, string>;
};

/** Each flavour's 26 colours, in the order of COLOURS. */
export const PALETTE: Record<Flavour, Record<Colour, string>> = {
  latte: palette(`dc8a78 dd7878 ea76cb 8839ef d20f39 e64553 fe640b df8e1d 40a02b 179299 04a5e5 209fb5 1e66f5 7287fd
    4c4f69 5c5f77 6c6f85 7c7f93 8c8fa1 9ca0b0 acb0be bcc0cc ccd0da eff1f5 e6e9ef dce0e8`),
  frappe: palette(`f2d5cf eebebe f4b8e4 ca9ee6 e78284 ea999c ef9f76 e5c890 a6d189 81c8be 99d1db 85c1dc 8caaee babbf1
    c6d0f5 b5bfe2 a5adce 949cbb 838ba7 737994 626880 51576d 414559 303446 292c3c 232634`),
  macchiato: palette(`f4dbd6 f0c6c6 f5bde6 c6a0f6 ed8796 ee99a0 f5a97f eed49f a6da95 8bd5ca 91d7e3 7dc4e4 8aadf4 b7bdf8
    cad3f5 b8c0e0 a5adcb 939ab7 8087a2 6e738d 5b6078 494d64 363a4f 24273a 1e2030 181926`),
  mocha: palette(`f5e0dc f2cdcd f5c2e7 cba6f7 f38ba8 eba0ac fab387 f9e2af a6e3a1 94e2d5 89dceb 74c7ec 89b4fa b4befe
    cdd6f4 bac2de a6adc8 9399b2 7f849c 6c7086 585b70 45475a 313244 1e1e2e 181825 11111b`),
};

// ---- colour arithmetic (sRGB, as WCAG 2 and CSS color-mix(in srgb) do it)

export const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
export const hex = (c: number[]) => "#" + c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");

/** The relative luminance of a colour, 0 (black) to 1 (white). */
export function luminance(colour: string): number {
  const [r, g, b] = rgb(colour).map((v) => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** The contrast ratio of two colours, 1 to 21. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** `share` (0 to 1) of a, the rest b. */
export function mix(a: string, b: string, share: number): string {
  const [x, y] = [rgb(a), rgb(b)];
  return hex(x.map((v, i) => v * share + y[i] * (1 - share)));
}

// ---- the floors

/** The least contrast of each kind of colour against what is behind it. */
export const FLOORS = { text: 4.5, weak: 3 };

export type Token = {
  name: string;      // the custom property, "--muted"
  value: string;     // its colour, a hex
  from: Colour | ""; // the palette colour it is, or "" for a mix
  note: string;      // why it is not the palette colour of its role, or how a tint is made; "" when there is nothing to say
};
/** A pair that has a floor: `fg` on `bg` (token names), at least `floor`. */
export type Pair = { fg: string; bg: string; floor: number; what: string };

const NAMES: Record<Colour, string> = Object.fromEntries(COLOURS.map((c) => [c, c[0].toUpperCase() + c.slice(1).replace(/(\d)$/, " $1")])) as Record<Colour, string>;
const ratio = (n: number) => (Math.floor(n * 100) / 100).toFixed(2); // (never rounded up to a floor it does not reach)

/** What a colour is drawn on: a colour, or one made of the colour itself (its own tint). */
type Ground = { name: string; value: string | ((colour: string) => string) };

/** How much of ok is behind an added line of a change: styles.css `.diff-row.add`, on which the line's "+" is ok. */
export const ADDED = 15;

/** The first colour of `family` that has `floor` on every ground of `on`; with none, the family's first mixed toward
 *  Text until it has. The note tells the ground on which the colour is weakest. */
function strong(p: Record<Colour, string>, family: Colour[], on: Ground[], floor: number): Omit<Token, "name"> {
  const least = (value: string) => on.map((g) => ({ g, c: contrast(value, typeof g.value === "string" ? g.value : g.value(value)) })).sort((a, b) => a.c - b.c)[0];
  const first = family[0], was = least(p[first]), weak = `${NAMES[first]} is ${ratio(was.c)}:1 on ${was.g.name}, under ${floor}:1`;
  for (const c of family) if (least(p[c]).c >= floor) return { value: p[c], from: c, note: c === first ? "" : weak };
  for (let share = 95; share >= 0; share -= 5) {
    const value = mix(p[first], p.text, share / 100), now = least(value);
    if (now.c >= floor) return { value, from: "", note: `${NAMES[first]} ${share} %, Text ${100 - share} %: ${ratio(now.c)}:1 on ${now.g.name} (${weak})` };
  }
  throw new Error(`no mix of ${first} and text has ${floor}:1 on ${on.map((g) => g.name).join(", ")}`);
}

/** A tint: `share` % of a colour over Base, as the guide tints a background (a colour at 10 to 20 % opacity). */
const tint = (p: Record<Colour, string>, c: Colour, share: number): Omit<Token, "name"> =>
  ({ value: mix(p[c], p.base, share / 100), from: "", note: `${NAMES[c]} at ${share} % over Base` });

const is = (p: Record<Colour, string>, c: Colour): Omit<Token, "name"> => ({ value: p[c], from: c, note: "" });

/** The tokens a flavour sets, in the order of styles.css. */
export function flavourTokens(f: Flavour): Token[] {
  const p = PALETTE[f];
  const base: Ground = { name: "Base", value: p.base }, mantle: Ground = { name: "Mantle", value: p.mantle };
  // the accent's tint, behind a chosen row and the user's message: the lightest the guide has, so that the faint text
  // of a chosen row keeps its floor on it with the palette's own colour (at 15 % Frappé's Overlay 1 is 2.75:1 on it)
  const soft = tint(p, "mauve", 10), chosen: Ground = { name: "the accent's tint", value: soft.value };
  // A colour that is read as text has its floor on Base. The weak ones (faint, ok, warning) are small marks all over
  // the secondary panes too, so they have theirs on Mantle as well; faint text and ok are also on a chosen row, and
  // ok is the "+" of an added line in a tool card's change, on its own tint over Base.
  const added: Ground = { name: "an added line's ground", value: (ok) => mix(ok, p.base, ADDED / 100) };
  const t: Record<string, Omit<Token, "name">> = {
    "--bg": is(p, "base"),
    "--panel": is(p, "mantle"),
    "--line": is(p, "surface0"),
    "--line-2": is(p, "surface1"),
    "--text": is(p, "text"),
    "--muted": strong(p, ["subtext0", "subtext1"], [base], FLOORS.text),
    "--faint": strong(p, ["overlay1", "overlay2"], [base, mantle, chosen], FLOORS.weak),
    "--accent": strong(p, ["mauve"], [base], FLOORS.text),
    "--accent-fill": is(p, "mauve"),
    "--accent-soft": soft,
    "--on-accent": is(p, "base"),
    "--user-text": is(p, "text"),
    "--warn": strong(p, ["yellow"], [base, mantle], FLOORS.weak),
    "--warn-soft": tint(p, "yellow", 12),
    "--danger": strong(p, ["red"], [base], FLOORS.text),
    "--danger-fill": is(p, "red"),
    "--on-danger": is(p, "base"),
    "--danger-soft": tint(p, "red", 12),
    "--ok": strong(p, ["green"], [base, mantle, chosen, added], FLOORS.weak),
    // the switch: its knob is Text on the track of a line when off, Base on the accent when on
    "--knob": is(p, "text"),
    "--knob-on": is(p, "base"),
    // code, on a code block (a secondary pane)
    "--syn-keyword": strong(p, ["mauve"], [mantle], FLOORS.weak),
    "--syn-string": strong(p, ["green"], [mantle], FLOORS.weak),
    "--syn-number": strong(p, ["peach"], [mantle], FLOORS.weak),
    "--syn-title": strong(p, ["blue"], [mantle], FLOORS.weak),
    "--syn-type": strong(p, ["yellow"], [mantle], FLOORS.weak),
    "--syn-attr": strong(p, ["blue"], [mantle], FLOORS.weak),
  };
  return Object.entries(t).map(([name, v]) => ({ name, ...v }));
}

/** Every pair of tokens that has a floor: the goal's own list, then what the app puts on a fill or a tint. */
export const PAIRS: Pair[] = [
  { fg: "--text", bg: "--bg", floor: FLOORS.text, what: "text" },
  { fg: "--muted", bg: "--bg", floor: FLOORS.text, what: "muted text" },
  { fg: "--accent", bg: "--bg", floor: FLOORS.text, what: "the accent" },
  { fg: "--danger", bg: "--bg", floor: FLOORS.text, what: "danger" },
  { fg: "--on-accent", bg: "--accent-fill", floor: FLOORS.text, what: "text on a filled button" },
  { fg: "--on-danger", bg: "--danger-fill", floor: FLOORS.text, what: "text on a danger button" },
  { fg: "--faint", bg: "--bg", floor: FLOORS.weak, what: "faint text" },
  { fg: "--ok", bg: "--bg", floor: FLOORS.weak, what: "ok" },
  { fg: "--warn", bg: "--bg", floor: FLOORS.weak, what: "warning" },
  ...["keyword", "string", "number", "title", "type", "attr"].map((k) => ({ fg: `--syn-${k}`, bg: "--panel", floor: FLOORS.weak, what: `code: ${k}` })),
  { fg: "--knob", bg: "--line-2", floor: FLOORS.weak, what: "the switch's knob on its track, off" },
  { fg: "--knob-on", bg: "--accent-fill", floor: FLOORS.weak, what: "the switch's knob on its track, on" },
  // not in the goal's list: the app's text on its own tints, and what it puts on a secondary pane
  { fg: "--text", bg: "--panel", floor: FLOORS.text, what: "text on a secondary pane" },
  { fg: "--user-text", bg: "--accent-soft", floor: FLOORS.text, what: "the user's message" },
  { fg: "--text", bg: "--warn-soft", floor: FLOORS.text, what: "text on a warning's tint" },
  { fg: "--text", bg: "--danger-soft", floor: FLOORS.text, what: "text on a danger's tint" },
  { fg: "--faint", bg: "--panel", floor: FLOORS.weak, what: "faint text on a secondary pane" },
  { fg: "--ok", bg: "--panel", floor: FLOORS.weak, what: "ok on a secondary pane" },
  { fg: "--warn", bg: "--panel", floor: FLOORS.weak, what: "warning on a secondary pane" },
  { fg: "--ok", bg: "--accent-soft", floor: FLOORS.weak, what: "ok on a chosen row" },
  { fg: "--faint", bg: "--accent-soft", floor: FLOORS.weak, what: "faint text on a chosen row" },
];

// ---- the stylesheet

/** The palette's licence notice, which the stylesheet and the web export carry (the MIT licence asks that every copy does). */
export const NOTICE = `/*!
 * The colours of the Catppuccin flavours (Latte, Frappé, Macchiato, Mocha) are the palette of
 * @catppuccin/palette 1.8.0, https://github.com/catppuccin/palette
 *
 * MIT License
 *
 * Copyright (c) 2021 Catppuccin
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */`;

const HEAD = `/* The four Catppuccin flavours, each laid over the light or dark theme of styles.css (theme.ts sets data-flavour on
   <html> beside data-theme; index.html before the first paint). A block is the flavour's palette (--ctp-*), then the
   tokens it sets; a token it does not set stays the theme's.
   Written from logic/flavours.ts, where the choices are explained: do not edit it by hand, change the module and
   run  WRITE=1 npm test  (test/flavours.test.ts holds this file to the module). */`;

/** The text of src/flavours.css. */
export function flavourCss(): string {
  const blocks = FLAVOURS.map((f) => {
    const lines = [
      ...COLOURS.map((c) => `  --ctp-${c}: ${PALETTE[f][c]};`),
      ...flavourTokens(f).map((t) => `  ${t.name}: ${t.from ? `var(--ctp-${t.from})` : t.value};${t.note ? ` /* ${t.note} */` : ""}`),
    ];
    return `:root[data-flavour="${f}"] {\n${lines.join("\n")}\n}`;
  });
  return [NOTICE, HEAD, ...blocks].join("\n\n") + "\n";
}
