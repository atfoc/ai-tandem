# Host lane: the Chromium reference of our sticky's fit and our geo's label size (design 10 A5)

**Result: the board host stores exactly what Chromium stores, in all 98 cases.** That covers 46 stickies (`fitted`) and 52 geo
rectangles (`growY`), CJK and emoji included. The sticky's own measurements at the stored size and one px above it
(`w`, `h`, `scrollWidth`) are also equal in every case. No difference was found, so nothing in `measure.ts` or `shapes/`
needs to change (goal 3.5, 4.12).

## What was measured

- **Chromium**: 156.0.8078.4 (Playwright 1.64.1, headless, viewport 1280×800, deviceScaleFactor 1), darwin-arm64 (macOS 27,
  Darwin 27.0.0), 2026-11-08, tldraw 5.6.0.
- **The page** is the host's own Editor (`packages/board-host/src/node/editor.ts`: UI-less, `SHAPE_UTILS` and
  `defaultBindingUtils` from the shared model) with tldraw's DOM text measuring, in a `tl-container` div with `tldraw.css`.
  The 16 faces of `board-tl/src/model/fonts.ts` are given as `data:` URLs, both as the editor's `fontAssetUrls` and as
  `FontFace`s in `document.fonts`. All 16 were `loaded` before the first shape was made (O5).
- **The board host**: `loadRuntime().createEditor()` (linkedom + skia-canvas measuring), the same case code.
- **How the shapes are made**: through `editor.createShapes`, with the props `apply.ts` sets, so the sticky's
  `onBeforeCreate` fits and the geo measures its label.
  - sticky: `{ w, h: w, richText, fontSize }`, with `fontSize` 0 (automatic), or the fixed 16 (`s`) or 48 (`xl`);
  - geo: `{ font: 'sans', dash: 'solid', geo: 'rectangle', w: 200, h: 100, richText, labelSize }`.
- **The cases**:
  - every corpus text (`TEXTS`, 13) as a sticky 200 and 300 wide, automatic size;
  - 5 texts (short, long, longword, multi, accented) at the fixed sizes `s` and `xl`, at both widths;
  - every text as a geo at `labelSize` s, m, l and xl.

## The comparison

| kind | cases | equal | within 0.5 px | worst |
|---|---:|---:|---:|---:|
| sticky (`fitted`, w, h) | 46 | 46 | 46 | 0 |
| geo (`growY`, w, h) | 52 | 52 | 52 | 0 |

Sticky `fitted` (px). Every value is the same in Chromium and the host; a difference would be shown as **c/n**:

| text | 200:auto | 300:auto | 200:s | 300:s | 200:xl | 300:xl |
|---|---:|---:|---:|---:|---:|---:|
| short | 48 | 72 | 16 | 16 | 48 | 48 |
| word | 48 | 72 |  |  |  |  |
| long | 18 | 28 | 16 | 16 | 48 | 48 |
| multi | 21 | 35 | 16 | 16 | 48 | 48 |
| longword | 6 | 7 | 16 | 16 | 48 | 48 |
| accented | 23 | 36 | 16 | 16 | 48 | 48 |
| cyrillic | 21 | 32 |  |  |  |  |
| cjk | 24 | 39 |  |  |  |  |
| emoji | 33 | 53 |  |  |  |  |
| mixed | 13 | 21 |  |  |  |  |
| spaces | 25 | 40 |  |  |  |  |
| hyphens | 18 | 29 |  |  |  |  |
| kerning | 31 | 49 |  |  |  |  |

Geo rectangle 200×100, `growY` (px) per `labelSize`, all equal:

| text | s | m | l | xl |
|---|---:|---:|---:|---:|
| short | 0 | 0 | 0 | 0 |
| word | 0 | 0 | 0 | 0 |
| long | 76 | 172 | 282 | 405 |
| multi | 52 | 82 | 107 | 190 |
| longword | 28 | 82 | 107 | 190 |
| accented | 28 | 82 | 142 | 319 |
| cyrillic | 52 | 112 | 177 | 319 |
| cjk | 4 | 52 | 107 | 190 |
| emoji | 0 | 0 | 2 | 61 |
| mixed | 52 | 112 | 177 | 319 |
| spaces | 0 | 22 | 37 | 147 |
| hyphens | 52 | 142 | 177 | 405 |
| kerning | 0 | 0 | 37 | 61 |

## Differences

None, CJK and emoji included. The spike's PingFang finding (risk 8.7) does not show here: the `cjk` and `emoji` stickies and
geos are equal at every size. That only proves it for these texts on this Mac. The finding still holds for system fallback
fonts on other machines.

The options the spike's corpus never used do not cause a difference either: `disableOverflowWrapBreaking`,
`measureScrollWidth`, odd font sizes (7, 13, 21, 23, 33, 53…) and `maxWidth - 1`. The measured `w`, `h` and `scrollWidth`
are equal at the stored size and one px above it.

Notes for the window lane (not differences):

- When a text wraps, the measured `w` is the `maxWidth` (167 on a 200 sticky). So the width side of the fit only ever bites
  through `scrollWidth`, the long word. Most fits are decided by the whole-pixel height.
- `sticky:longword:200:auto` overflows even at the minimum size 6 (`scrollWidth` 181 > 168). It is stored as 6 on both
  sides.
- A first run of the script compared measurements made with the wrong font, because the theme lookup it used returned
  nothing, so the fallback font was measured. Even those were equal on both sides. The script now uses the sticky's own
  `stickyMeasure`.

## What is committed

- `packages/board-host/test/reference.ts` `STICKY_REFERENCE`: 15 cases.
  - stickies: short, long, longword, multi, accented and cyrillic at 200 and 300 (automatic), plus long at 200 with `s`;
  - geo: long at `labelSize` s and xl.
- `packages/board-host/test/sticky.test.ts`: makes those shapes on a runtime editor and checks they equal the reference.

## How to re-run

Scripts are in `/tmp/bb-host-stickyref/src/` (not committed). Set up:

```sh
mkdir -p /tmp/bb-host-stickyref/src && cd /tmp/bb-host-stickyref && npm init -y && npm install playwright@1.64.1
W=<worktree>; ln -sfn $W/node_modules /tmp/bb-host-stickyref/src/node_modules
echo '{"type":"module"}' > /tmp/bb-host-stickyref/src/package.json
```

Then write the four files below and run:

```sh
cd /tmp/bb-host-stickyref/src
node run.mjs                                                                                    # Chromium → ../out/chromium.json
node --import $W/packages/board-host/test/tsx-hook.ts --experimental-strip-types node.ts        # host, compare, print the table
```

The absolute worktree paths in the imports must be changed to the worktree you run in.

### `cases.ts`

```ts
// The cases, the same in Chromium (page.ts) and in Node (node.ts): stickies and our geo created through editor.createShapes,
// with the props packages/board-tl/src/model/apply.ts sets (sticky: w = h, richText, fontSize; geo: font sans, dash solid,
// geo rectangle, w, h, richText, labelSize). Returns { caseId: { ...numbers } }.
import type { Editor } from 'tldraw'

type Tl = { toRichText: any; createShapeId: any; stickyMeasure: any }

const r3 = (n: number) => Math.round(n * 1000) / 1000
const STICKY_FIXED: Record<string, number> = { s: 16, xl: 48 }
const FIXED_TEXTS = ['short', 'long', 'longword', 'multi', 'accented']

export function runCases(editor: Editor, tl: Tl, TEXTS: Record<string, string>) {
  const out: Record<string, Record<string, number>> = {}
  const clear = () => {
    const ids = [...editor.getCurrentPageShapeIds()]
    if (ids.length) editor.deleteShapes(ids)
  }
  // the sticky's own measure (sticky.tsx stickyMeasure), for the diagnosis: the layout at the stored size and one px above
  const measure = (shape: unknown, fontSize: number, innerW: number) => {
    const m = tl.stickyMeasure(editor, shape)(fontSize, innerW)
    return { w: r3(m.w), h: r3(m.h), sw: r3(m.scrollWidth ?? 0) }
  }
  const sticky = (id: string, text: string, w: number, fontSize: number) => {
    const sid = tl.createShapeId()
    const richText = tl.toRichText(text)
    editor.createShapes([{ id: sid, type: 'aiwb-sticky', x: 0, y: 0, props: { w, h: w, richText, fontSize } } as never])
    const s = editor.getShape(sid) as any
    const at = measure(s, s.props.fitted, w - 32)
    const up = measure(s, s.props.fitted + 1, w - 32)
    out[id] = { fitted: s.props.fitted, w: s.props.w, h: s.props.h, mW: at.w, mH: at.h, mSW: at.sw, upW: up.w, upH: up.h, upSW: up.sw }
    clear()
  }
  for (const [tid, text] of Object.entries(TEXTS)) {
    for (const w of [200, 300]) sticky(`sticky:${tid}:${w}:auto`, text, w, 0)
  }
  for (const tid of FIXED_TEXTS) for (const [k, px] of Object.entries(STICKY_FIXED)) for (const w of [200, 300]) sticky(`sticky:${tid}:${w}:${k}`, TEXTS[tid], w, px)

  for (const [tid, text] of Object.entries(TEXTS)) {
    for (const labelSize of ['s', 'm', 'l', 'xl']) {
      const gid = tl.createShapeId()
      editor.createShapes([{ id: gid, type: 'geo', x: 0, y: 0, props: { font: 'sans', dash: 'solid', geo: 'rectangle', w: 200, h: 100, richText: tl.toRichText(text), labelSize } } as never])
      const g = editor.getShape(gid) as any
      out[`geo:${tid}:${labelSize}`] = { growY: r3(g.props.growY), w: r3(g.props.w), h: r3(g.props.h) }
      clear()
    }
  }
  return out
}
```

### `page.ts`

```ts
// The Chromium side: the host's Editor (packages/board-host/src/node/editor.ts: SHAPE_UTILS, defaultBindingUtils, UI-less)
// with tldraw's own DOM text measuring; the 16 faces of board-tl's FONT_FACES as data: URLs (fontAssetUrls and FontFace),
// all loaded before anything is measured (O5).
import 'tldraw/tldraw.css'
import * as tldraw from 'tldraw'
import { createEditor } from '/Users/pedjat/Documents/projects/ai-whiteboard/.worktrees/bb-host-stickyref/packages/board-host/src/node/editor.ts'
import { FONT_FACES } from '/Users/pedjat/Documents/projects/ai-whiteboard/.worktrees/bb-host-stickyref/packages/board-tl/src/model/fonts.ts'
import { TEXTS } from '/Users/pedjat/Documents/projects/ai-whiteboard/.worktrees/bb-host-stickyref/packages/board-tl/src/model/corpus.ts'
import { stickyMeasure } from '/Users/pedjat/Documents/projects/ai-whiteboard/.worktrees/bb-host-stickyref/packages/board-tl/src/model/shapes/sticky.tsx'
import { runCases } from './cases.ts'

declare global { interface Window { __FONTS: Record<string, string>; __ready: Promise<unknown>; runCases: () => unknown; TEXTS: Record<string, string> } }
window.TEXTS = TEXTS

async function loadFonts() {
  for (const f of FONT_FACES) {
    const face = new FontFace(f.family, `url(${window.__FONTS[f.file]}) format("woff2")`, { weight: f.weight, style: f.style })
    document.fonts.add(face)
  }
  await Promise.all([...document.fonts].map((f) => f.load()))
  await document.fonts.ready
  return [...document.fonts].map((f) => ({ family: f.family, weight: f.weight, style: f.style, status: f.status }))
}

const container = document.createElement('div')
container.className = 'tl-container tl-theme__light'
container.style.cssText = 'position: relative; width: 1080px; height: 720px; overflow: hidden;'
document.body.appendChild(container)

window.__ready = loadFonts().then((faces) => {
  const fontAssetUrls = Object.fromEntries(FONT_FACES.map((f) => [f.key, window.__FONTS[f.file]]))
  const editor = createEditor({ container, fontAssetUrls })
  ;(window as any).editor = editor
  window.runCases = () => runCases(editor, { ...tldraw, stickyMeasure } as any, TEXTS)
  return { faces }
})
```

### `run.mjs`

```js
// Chromium reference of the sticky fit and the geo labelSize: bundles page.ts, serves it with the 16 fonts inlined as data:
// URLs, runs the cases, writes out/chromium.json (+ env, platform fonts of the texts).
//   node /tmp/bb-host-stickyref/src/run.mjs
import { createServer } from 'node:http'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'
import { build } from 'esbuild'
import { chromium } from '/tmp/bb-host-stickyref/node_modules/playwright/index.mjs'

const W = '/Users/pedjat/Documents/projects/ai-whiteboard/.worktrees/bb-host-stickyref'
const here = '/tmp/bb-host-stickyref/src'
const out = '/tmp/bb-host-stickyref/out'
const pageDir = join(out, 'page')
mkdirSync(pageDir, { recursive: true })
const fontDir = join(W, 'node_modules/@tldraw/assets/fonts')

await build({
  entryPoints: [join(here, 'page.ts')], outfile: join(pageDir, 'page.js'), bundle: true, format: 'esm', platform: 'browser',
  target: 'chrome120', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'warning',
  nodePaths: [join(W, 'node_modules')],
})
const { FONT_FACES } = await import(join(W, 'packages/board-tl/src/model/fonts.ts'))
const fonts = Object.fromEntries(FONT_FACES.map((f) => [f.file, `data:font/woff2;base64,${readFileSync(join(fontDir, f.file)).toString('base64')}`]))
writeFileSync(join(pageDir, 'fonts.js'), `window.__FONTS = ${JSON.stringify(fonts)};`)
writeFileSync(join(pageDir, 'index.html'), `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="page.css">
<style>html, body { margin: 0; padding: 0; }</style></head><body><script src="fonts.js"></script><script type="module" src="page.js"></script></body></html>`)

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' }
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname.slice(1) || 'index.html'
  try {
    if (path.includes('/') || path.includes('..')) throw new Error()
    res.writeHead(200, { 'content-type': types[path.slice(path.lastIndexOf('.'))] ?? 'application/octet-stream' }).end(readFileSync(join(pageDir, path)))
  } catch { res.writeHead(404).end() }
})
await new Promise((ok) => server.listen(0, '127.0.0.1', ok))
const browser = await chromium.launch()
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  await page.goto(`http://127.0.0.1:${server.address().port}/`)
  await page.waitForFunction(() => window.__ready !== undefined)
  const { faces } = await page.evaluate(() => window.__ready)
  const cases = await page.evaluate(() => window.runCases())
  writeFileSync(join(out, 'chromium.json'), JSON.stringify(cases, null, 1))
  const env = {
    chromium: browser.version(), playwright: JSON.parse(readFileSync('/tmp/bb-host-stickyref/node_modules/playwright/package.json', 'utf8')).version,
    userAgent: await page.evaluate(() => navigator.userAgent), os: `${os.platform()} ${os.release()} ${os.arch()}`,
    facesLoaded: faces.filter((f) => f.status === 'loaded').length, faces: faces.length, cases: Object.keys(cases).length, errors,
  }
  writeFileSync(join(out, 'chromium-env.json'), JSON.stringify(env, null, 1))
  console.log(env)
} finally {
  await browser.close()
  server.close()
}
```

### `node.ts`

```ts
// The Node side: the same cases on loadRuntime().createEditor() (linkedom + skia-canvas measuring); compares with
// out/chromium.json and prints the table.
//   node --import <W>/packages/board-host/test/tsx-hook.ts --experimental-strip-types /tmp/bb-host-stickyref/src/node.ts
import '/Users/pedjat/Documents/projects/ai-whiteboard/.worktrees/bb-host-stickyref/packages/board-host/src/node/install-page.ts'
import { readFileSync, writeFileSync } from 'node:fs'
import { loadRuntime } from '/Users/pedjat/Documents/projects/ai-whiteboard/.worktrees/bb-host-stickyref/packages/board-host/src/node/runtime.ts'
import { TEXTS } from '/Users/pedjat/Documents/projects/ai-whiteboard/.worktrees/bb-host-stickyref/packages/board-tl/src/model/corpus.ts'
import * as tldraw from 'tldraw'
import { stickyMeasure } from '/Users/pedjat/Documents/projects/ai-whiteboard/.worktrees/bb-host-stickyref/packages/board-tl/src/model/shapes/sticky.tsx'
import { runCases } from './cases.ts'

const rt = await loadRuntime()
const editor = rt.createEditor()
const got = runCases(editor, { ...tldraw, stickyMeasure } as any, TEXTS)
editor.dispose()
writeFileSync('/tmp/bb-host-stickyref/out/node.json', JSON.stringify(got, null, 1))
const ref = JSON.parse(readFileSync('/tmp/bb-host-stickyref/out/chromium.json', 'utf8'))

// stored values (the goal): sticky fitted, geo growY; the measures (mW…) only for the diagnosis
const STORED: Record<string, string[]> = { sticky: ['fitted', 'w', 'h'], geo: ['growY', 'w', 'h'] }
const table: Record<string, { cases: number; equal: number; within05: number; worst: number }> = {}
const diffs: string[] = []
const measureDiffs: string[] = []
for (const [id, r] of Object.entries<Record<string, number>>(ref)) {
  const kind = id.split(':')[0]
  const g = got[id]
  const t = (table[kind] ??= { cases: 0, equal: 0, within05: 0, worst: 0 })
  t.cases++
  let worst = 0
  for (const k of STORED[kind]) worst = Math.max(worst, Math.abs(r[k] - g[k]))
  if (worst === 0) t.equal++
  if (worst <= 0.5) t.within05++
  t.worst = Math.max(t.worst, worst)
  if (worst > 0) diffs.push(`${id}: chromium ${JSON.stringify(r)}\n${' '.repeat(id.length + 2)}node     ${JSON.stringify(g)}`)
  else if (kind === 'sticky') {
    const mk = ['mW', 'mH', 'mSW', 'upW', 'upH', 'upSW']
    const md = Math.max(...mk.map((k) => Math.abs(r[k] - g[k])))
    if (md > 0) measureDiffs.push(`${id} (fitted equal, measures differ by ${md.toFixed(3)}): c ${mk.map((k) => r[k]).join(' ')} | n ${mk.map((k) => g[k]).join(' ')}`)
  }
}
console.table(table)
console.log('stored differences:\n' + (diffs.join('\n') || '(none)'))
console.log('measure-only differences (stored equal):\n' + (measureDiffs.join('\n') || '(none)'))
process.exit(0)
```


## Re-run in our font (host lane lead, the same day)

The first run created the stickies without a `font`, so `editor.createShapes` took the editor's next-shape font, tldraw's
default `draw` (Shantell Sans), on both sides. People's stickies are in IBM Plex Sans (the window sets `sans` as the next-shape
font; O5), and so are the agent's now (apply.ts sets `font` on every element; the host's editor sets the window's next-shape
styles). Re-run with `font: 'sans'` on the stickies, same Chromium 156.0.8078.4: **sticky 46/46 and geo 52/52 equal, no stored
or measure-only difference.** `STICKY_REFERENCE` holds the sans values (8 `fitted` values changed, e.g. `long:200` 18 → 19,
`multi:300` 35 → 39) and `test/sticky.test.ts` creates its stickies with `font: "sans"`.
