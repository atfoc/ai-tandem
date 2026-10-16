// The fonts of the stand-in page: every FontFace Excalidraw declares (family, file, unicode-range) is kept here, in the order
// it was declared, and registered with the native canvas under an alias of its own the first time a font string names its
// family. A font string (`20px Excalifont, Xiaolai, Segoe UI Emoji`) is rewritten into the list of those aliases, so the
// canvas picks, for each character, a piece of the family the way a browser picks a @font-face by its unicode-range.
// The native canvas is not imported here: registering a file with it goes through `setRegister` (canvas.ts's `register`).
import fs from "node:fs";
import { fileURLToPath } from "node:url";

export type Range = [number, number];

export interface Face {
  family: string;
  file: string | null;
  ranges: Range[];
  alias: string;
  registered: boolean;
  failed?: boolean;
  weight: string;
  style: string;
  buffer: Buffer | null;
}

export interface FaceDescriptors {
  unicodeRange?: string;
  weight?: string;
  style?: string;
}

export interface Run {
  font: string;
  text: string;
}

/** Registers a font file with the native canvas under `alias`; false when it cannot. */
export type Register = (file: string, alias: string) => boolean;

/** family -> its faces, in the order they were declared */
export const faces = new Map<string, Face[]>();
let n = 0;
let registerFile: Register = () => false;

/** The function that registers a font file with the native canvas (canvas.ts's `register`). */
export function setRegister(fn: Register): void {
  registerFile = fn;
}

/** Forgets every declared face and every cached font string and run (tests; a page declares its faces once). */
export function resetFaces(): void {
  faces.clear();
  cache.clear();
  runCache.clear();
}

/** The families the window does not ship (packages/board-view/build.mjs leaves Xiaolai out): a window has none of their faces,
 *  so the text falls back as it does there. AIWB_FONTS_ALL=1 keeps them (to measure what shipping them would change). */
export const NOT_SHIPPED: ReadonlySet<string> = new Set(process.env.AIWB_FONTS_ALL === "1" ? [] : ["Xiaolai"]);

/** Chromium's default ("standard") font, which it tries after the families of a font string and before the system's fallback
 *  per character (macOS: Times; Windows and Linux: Times New Roman, which fontconfig maps on Linux). AIWB_DEFAULT_FONT overrides. */
export const DEFAULT_FONT: string = process.env.AIWB_DEFAULT_FONT ?? (process.platform === "darwin" ? "Times" : "Times New Roman");

/** The system's colour emoji font, which Chromium draws an emoji cluster with (a VS16, a ZWJ sequence, a skin tone, or a
 *  character that is an emoji by default) when no face of the font string has it. AIWB_EMOJI_FONT overrides. */
export const EMOJI_FONT: string =
  process.env.AIWB_EMOJI_FONT ?? (process.platform === "darwin" ? "Apple Color Emoji" : process.platform === "win32" ? "Segoe UI Emoji" : "Noto Color Emoji");

/** A symbol that is an emoji only when asked to be (U+FE0F): Chromium on macOS draws it with a text font CoreText picks; the
 *  native canvas would take the colour emoji font. These text fonts are tried after the system families of the string and the
 *  default font (measured on macOS 15 against Chromium 156; other systems: none until measured there). AIWB_SYMBOL_FONTS
 *  (comma list) overrides. */
export const SYMBOL_FONTS: readonly string[] = (
  process.env.AIWB_SYMBOL_FONTS ?? (process.platform === "darwin" ? "Hiragino Sans,Zapf Dingbats,Lucida Grande,Apple Symbols,Helvetica,Menlo" : "")
)
  .split(",")
  .filter(Boolean);

/** "U+20-7e,U+a1" -> [[0x20,0x7e],[0xa1,0xa1]] */
export function parseRanges(s?: string): Range[] {
  if (!s) return [[0, 0x10ffff]];
  return s
    .split(/\s*,\s*/)
    .filter(Boolean)
    .map((r) => {
      const [a, b] = r.replace(/^U\+/i, "").split("-");
      const lo = parseInt(a.replace(/\?/g, "0"), 16);
      const hi = b ? parseInt(b, 16) : parseInt(a.replace(/\?/g, "f"), 16);
      return [lo, hi];
    });
}

/** The first `url(...)` of a FontFace source that is a file on this machine; null for none (a local() or a remote one). */
function fileOf(source: string): string | null {
  for (const m of String(source).matchAll(/url\(\s*["']?([^)"']+)["']?\s*\)/g)) {
    if (m[1].startsWith("file:")) {
      const p = fileURLToPath(m[1]);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

export function declare(family: string, source: string | ArrayBuffer | ArrayBufferView, descriptors: FaceDescriptors = {}): Face {
  const fam = String(family).replace(/^["']|["']$/g, "");
  const face: Face = {
    family: fam,
    file: typeof source === "string" ? fileOf(source) : null,
    ranges: parseRanges(descriptors.unicodeRange),
    alias: `aiwb-${++n}-${fam.replace(/\W+/g, "")}`,
    registered: false,
    weight: String(descriptors.weight ?? "400"),
    style: descriptors.style ?? "normal",
    buffer: typeof source === "string" ? null : Buffer.from(source instanceof ArrayBuffer ? new Uint8Array(source) : new Uint8Array(source.buffer, source.byteOffset, source.byteLength)),
  };
  let list = faces.get(fam);
  if (!list) faces.set(fam, (list = []));
  list.push(face);
  return face;
}

function register(face: Face): void {
  if (face.registered) return;
  face.registered = true;
  if (!face.file || !registerFile(face.file, face.alias)) face.failed = true;
}

interface SplitFont {
  head: string;
  families: string[];
}

/** Splits a CSS font shorthand into what comes before the family list and the families. */
function splitFont(font: string): SplitFont | null {
  const m = /^(.*?\d*\.?\d+(?:px|pt|em|rem|%)(?:\s*\/\s*\S+)?)\s+(.+)$/.exec(font.trim());
  if (!m) return null;
  const families = m[2]
    .split(",")
    .map((f) => f.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
  return { head: m[1], families };
}

const quoted = (f: string): string => (/^[\w-]+$/.test(f) ? f : JSON.stringify(f));
const weightOf = (f: Face): number => parseInt(f.weight, 10) || 400;

/** The faces of a family a normal-weight, normal-style font string is drawn with: CSS font matching for weight 400 takes 400,
 *  else 500, else the nearest lighter, else the nearest heavier (Excalidraw declares Nunito at 500 only). */
export function usableFaces(family: string): Face[] {
  if (NOT_SHIPPED.has(family)) return [];
  const list = (faces.get(family) ?? []).filter((x) => (x.file || x.buffer) && x.style === "normal");
  if (!list.length) return [];
  const ws = [...new Set(list.map(weightOf))];
  const pick = ws.includes(400)
    ? 400
    : ws.includes(500)
      ? 500
      : (ws.filter((w) => w < 400).sort((a, b) => b - a)[0] ?? ws.sort((a, b) => a - b)[0]);
  return list.filter((x) => weightOf(x) === pick);
}

/** The family list with each family Excalidraw declared replaced by its pieces. CSS Fonts 4: of faces with the same
 *  descriptors whose ranges overlap, the one defined last is checked first, so the pieces go in reverse order. */
export function expandFamilies(families: string[]): string[] {
  const out: string[] = [];
  for (const f of families) {
    if (NOT_SHIPPED.has(f)) continue;
    const pieces = usableFaces(f);
    // a family Excalidraw declares with no file (local: Helvetica, Segoe UI Emoji), or one it does not declare, is the system's
    if (!pieces.length) {
      out.push(f);
      continue;
    }
    for (const x of [...pieces].reverse()) {
      register(x);
      if (!x.failed) out.push(x.alias);
    }
  }
  if (DEFAULT_FONT && !out.includes(DEFAULT_FONT)) out.push(DEFAULT_FONT);
  return out;
}

const cache = new Map<string, string>();
/** The font string the native canvas is given for the one Excalidraw sets. */
export function nativeFont(font: string): string {
  const hit = cache.get(font);
  if (hit !== undefined) return hit;
  const s = splitFont(font);
  const v = s ? `${s.head} ${expandFamilies(s.families).map(quoted).join(", ")}` : font;
  // (kept only once Excalidraw has declared its faces: it does so lazily, at the first text it measures or loads)
  if (faces.size) cache.set(font, v);
  return v;
}

/** The face of `family` whose unicode-range holds `cp` as a browser would choose it (last declared first); null for none. */
export function faceFor(family: string, cp: number): Face | null {
  const list = usableFaces(family);
  for (let i = list.length - 1; i >= 0; i--) if (list[i].ranges.some(([a, b]) => cp >= a && cp <= b)) return list[i];
  return null;
}

// ---- runs: the face of each character by unicode-range, as a browser chooses it (CSS Fonts 4 "font matching" per character)
// A piece file holds glyphs outside its declared range (Google's subsets share glyphs), so the native canvas, which picks by
// glyph coverage, would keep runs in one piece and kern across what the browser splits. The text is cut into runs of one face;
// each run is measured and drawn alone, as a browser shapes each run with its own font.
const graphemes = new Intl.Segmenter("en", { granularity: "grapheme" });
// Blink shapes text word by word (CachingWordShaper): a space or a no-break space is a word of its own, and so is each CJK
// ideograph, so no kerning or shaping crosses them. Runs are cut there too.
const WORD_BREAK = /^[  ]$|^[⺀-⿟　-〿㐀-䶿一-鿿豈-﫿\u{20000}-\u{3134f}]/u;
const RTL = /[֐-ࣿיִ-﷿ﹰ-﻿]/;
const EMOJI = /️|‍|[\u{1f3fb}-\u{1f3ff}]|^\p{Emoji_Presentation}/u;
const TEXT_SYMBOL = /^\p{Emoji}/u;
const runCache = new Map<string, (Run & { alone?: boolean })[]>();

/** The runs of `text` under the CSS font string `font`: [{ font: native font string, text }]. One run when there is nothing to
 *  split (or, for drawing, the text is right-to-left: it is left to the native canvas whole). */
export function runsOf(font: string, text: string, { forDrawing = false }: { forDrawing?: boolean } = {}): Run[] {
  const s = splitFont(font);
  // (a width does not depend on the direction: right-to-left text is measured run by run, but drawn whole by the native canvas)
  if (!s || !text || (forDrawing && RTL.test(text))) return [{ font: nativeFont(font), text }];
  const key = font + "\u0000" + text;
  const hit = runCache.get(key);
  if (hit) return hit;
  // the families that are the system's (local or undeclared), with the default font: what a cluster no face covers is drawn with
  const system = [...s.families.filter((f) => !NOT_SHIPPED.has(f) && !usableFaces(f).length), DEFAULT_FONT].filter((f, i, a) => f && a.indexOf(f) === i);
  const systemList = system.map(quoted).join(", ");
  const out: (Run & { alone?: boolean })[] = [];
  for (const { segment } of graphemes.segment(text)) {
    const cp = segment.codePointAt(0)!;
    let face: Face | null = null;
    for (const f of s.families) {
      if (NOT_SHIPPED.has(f)) continue;
      face = faceFor(f, cp);
      if (face) break;
      if (!usableFaces(f).length) break;
    }
    if (face) register(face);
    // (a face whose range holds the character but whose file has no glyph for it: the browser goes on to the next family)
    const emoji = EMOJI.test(segment) && !segment.includes("︎");
    const symbol = !emoji && SYMBOL_FONTS.length > 0 && TEXT_SYMBOL.test(segment) && !/^[\d#*]/.test(segment);
    // what comes after the face (or is all there is): what a browser goes on to when the face has no glyph for the cluster
    const tail = emoji
      ? `${JSON.stringify(EMOJI_FONT)}, ${systemList}`
      : symbol
        ? `${systemList}, ${SYMBOL_FONTS.map((f) => JSON.stringify(f)).join(", ")}`
        : systemList;
    const native = face && !face.failed ? `${s.head} ${face.alias}, ${tail}` : `${s.head} ${tail}`;
    const last = out[out.length - 1];
    const alone = WORD_BREAK.test(segment);
    if (last && last.font === native && !alone && !last.alone) last.text += segment;
    else out.push({ font: native, text: segment, alone });
  }
  if (runCache.size > 20000) runCache.clear();
  runCache.set(key, out);
  return out;
}
