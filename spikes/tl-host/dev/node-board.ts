// The reference board (src/board.ts) exported in Node → out/node-board.png/.svg and its records, for comparison with
// dev/chromium (out/chromium-board.*). Usage: node dev/node-board.ts [resvg|skia]
import { writeFileSync, mkdirSync } from 'node:fs'
import { loadHost } from '../src/headless.ts'
const host = await loadHost()
const { buildBoard } = await import('../src/board.ts')
const { exportPng } = await import('../src/export.ts')
const editor = host.createHeadlessEditor()
buildBoard(editor)
const rasterizer = (process.argv[2] ?? 'resvg') as any
const t = performance.now()
const r = (await exportPng(editor, undefined, { padding: 32, background: true, rasterizer }))!
console.log(rasterizer, (performance.now() - t).toFixed(0), 'ms', r.width, 'x', r.height)
mkdirSync('out', { recursive: true })
writeFileSync('out/node-board.png', r.png)
writeFileSync('out/node-board.svg', r.svg)
const records = editor.getCurrentPageShapes().map((s: any) => { const { richText, ...props } = s.props; return { id: s.id, type: s.type, x: s.x, y: s.y, props, bounds: editor.getShapePageBounds(s) } })
writeFileSync('out/node-board-records.json', JSON.stringify(records, null, 1))
process.exit(0)
