// The reference board (dev/board.ts) exported by the board host's runtime → out/node-board.png/.svg and its records, for
// comparison with the Chromium reference (spikes/tl-host/dev/chromium: out/chromium-board.*) by spikes/tl-host/dev/picdiff.ts.
// Usage: node dev/node-board.ts   (AIWB_BOARDHOST_DOM=jsdom for the fallback)
import '../src/node/install-page.ts'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { loadRuntime } from '../src/node/runtime.ts'
const rt = await loadRuntime()
const { buildBoard } = await import('./board.ts')
const { exportPng } = await import('../src/node/export.ts')
const editor = rt.createEditor()
buildBoard(editor)
const t = performance.now()
const r = (await exportPng(editor, undefined, { padding: 32, background: true }))!
console.log('resvg', (performance.now() - t).toFixed(0), 'ms', r.width, 'x', r.height, rt.dom)
const out = fileURLToPath(new URL('../out/', import.meta.url))
mkdirSync(out, { recursive: true })
writeFileSync(out + 'node-board.png', r.png)
writeFileSync(out + 'node-board.svg', r.svg)
const records = editor.getCurrentPageShapes().map((s: any) => { const { richText, ...props } = s.props; return { id: s.id, type: s.type, x: s.x, y: s.y, props, bounds: editor.getShapePageBounds(s) } })
writeFileSync(out + 'node-board-records.json', JSON.stringify(records, null, 1))
process.exit(0)
