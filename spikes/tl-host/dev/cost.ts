// E: rough cost of the board host (goal 6.5, risk 8.8). Fresh process: node --expose-gc dev/cost.ts
// - start: from process start (performance.timeOrigin) to the host loaded (jsdom, tldraw, sync-core, skia-canvas, fonts)
//   and to the first room with an editor peer ready;
// - memory (RSS, heap; after gc): loaded, then 1 and 10 rooms, each a TLSocketRoom + the agent's editor peer + one
//   window client (a bare TLSyncClient), each holding the reference board;
// - one agent batch on a warm peer: buildBoard (9 shapes, 2 bindings, measured text) + whenSettled (pushed and
//   acknowledged by the room, so in its storage) + the room's snapshot as JSON (the save) — median of 15;
// - one PNG of the reference board (export.ts, resvg) — median of 10.
const t0 = performance.now()
const mem = () => { (globalThis as any).gc?.(); const m = process.memoryUsage(); return { rss: +(m.rss / 1048576).toFixed(0), heap: +(m.heapUsed / 1048576).toFixed(0) } }
const med = (a: number[]) => +[...a].sort((x, y) => x - y)[a.length >> 1].toFixed(1)
const out: Record<string, unknown> = { node: process.version, before: { ...mem(), sinceStartMs: +t0.toFixed(0) } }

const { loadHost } = await import('../src/headless.ts')
const host = await loadHost()
const room = await import('../src/room.ts')
const { buildBoard } = await import('../src/board.ts')
const { exportPng } = await import('../src/export.ts')
await import('../src/measure.ts')
out.loaded = { ...mem(), sinceStartMs: +performance.now().toFixed(0) }

type Pair = { r: ReturnType<typeof room.createRoom>; agent: Awaited<ReturnType<typeof room.connectEditor>>; win: Awaited<ReturnType<typeof room.connectClient>> }
const pairs: Pair[] = []
const open = async (i: number) => {
  const r = room.createRoom()
  const agent = await room.connectEditor(r, { userId: `agent${i}`, userName: 'Agent' })
  const win = await room.connectClient(r, { userId: `win${i}`, userName: 'Window' })
  buildBoard(agent.editor)
  await agent.whenSettled()
  pairs.push({ r, agent, win })
}
await open(0)
out.firstRoomReadySinceStartMs = +performance.now().toFixed(0)
await new Promise((res) => setTimeout(res, 200))
out.rooms1 = mem()
for (let i = 1; i < 10; i++) await open(i)
await new Promise((res) => setTimeout(res, 500))
out.rooms10 = mem()

// one agent batch on a warm peer
const p = pairs[0]
const batch: number[] = [], save: number[] = []
for (let k = 0; k < 15; k++) {
  const t = performance.now()
  buildBoard(p.agent.editor, { x: 2000 + k * 1000, y: 2000 })
  await p.agent.whenSettled()
  const t2 = performance.now()
  JSON.stringify(p.r.getCurrentSnapshot())
  save.push(performance.now() - t2)
  batch.push(t2 - t)
}
out.batchMs = med(batch)
out.saveMs = med(save)
out.shapesAfterBatches = p.agent.editor.getCurrentPageShapeIds().size

// one PNG of a fresh reference board
const q = pairs[1]
const png: number[] = []
let size = ''
for (let k = 0; k < 10; k++) { const t = performance.now(); const r = await exportPng(q.agent.editor); png.push(performance.now() - t); size = `${r!.width}x${r!.height}` }
out.pngMs = med(png)
out.pngFirstMs = +png[0].toFixed(0)
out.pngSize = size
out.afterPng = mem()
console.log(JSON.stringify(out, null, 1))
for (const x of pairs) { x.agent.close(); x.win.close(); x.r.close() }
process.exit(0)
