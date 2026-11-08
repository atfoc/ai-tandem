// What a short-lived editor per agent call would cost (goal 7.5's alternative): make an editor, load a board snapshot,
// apply one batch, read the diff, dispose. Against a persistent editor: the batch alone. Usage: node --expose-gc dev/cost-editor.ts
import { loadHost } from '../src/headless.ts'
const host = await loadHost()
const { buildBoard } = await import('../src/board.ts')
const { getSnapshot, loadSnapshot } = await import('tldraw')
const med = (a: number[]) => a.sort((x, y) => x - y)[a.length >> 1]
for (const copies of [1, 10, 50]) {
  const src = host.createHeadlessEditor()
  for (let i = 0; i < copies; i++) buildBoard(src, { x: (i % 10) * 1000, y: Math.floor(i / 10) * 700 + (i ? 1 : 0) })
  const shapes = src.getCurrentPageShapeIds().size
  const snap = getSnapshot(src.store)
  const json = JSON.stringify(snap)
  const tNew: number[] = [], tLoad: number[] = [], tBatch: number[] = [], tPersist: number[] = []
  for (let r = 0; r < 7; r++) {
    let t = performance.now()
    const e = host.createHeadlessEditor()
    tNew.push(performance.now() - t)
    t = performance.now()
    loadSnapshot(e.store, JSON.parse(json))
    tLoad.push(performance.now() - t)
    t = performance.now()
    const before = e.store.serialize()
    buildBoard(e, { x: 50_000 + r * 1000, y: 50_000 })
    const after = e.store.serialize()
    const changed = Object.keys(after).filter((k) => before[k] !== after[k]).length
    tBatch.push(performance.now() - t)
    e.dispose()
    t = performance.now()
    buildBoard(src, { x: 60_000 + r * 1000, y: 60_000 })
    tPersist.push(performance.now() - t)
    void changed
  }
  console.log(`${shapes} shapes (${(json.length / 1024).toFixed(0)} KB): new editor ${med(tNew).toFixed(1)} ms, load snapshot ${med(tLoad).toFixed(1)} ms, batch+diff ${med(tBatch).toFixed(1)} ms | persistent editor batch ${med(tPersist).toFixed(1)} ms`)
  src.dispose()
}
process.exit(0)
