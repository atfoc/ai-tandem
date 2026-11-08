// What each DOM costs the board host (risk 8.8): jsdom, happy-dom, linkedom (src/dom-pick.ts). Each DOM in a fresh
// process (node --expose-gc, gc before every memory reading), the DOMs interleaved over ROUNDS rounds; medians.
//   node dev/cost-dom.ts                 → all three, ROUNDS=3 (env), writes out/cost-dom.json and prints a table
//   node --expose-gc dev/cost-dom.ts one <jsdom|happy|linkedom>   → one process's numbers as JSON (used by the above)
// Also checks that the editor creates, updates and deletes the reference board on that DOM.
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

type Any = any
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); const n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2 }
const MB = (b: number) => Math.round((b / 1048576) * 10) / 10

async function one(dom: string) {
  const gc = (globalThis as Any).gc as () => void
  if (!gc) throw new Error('run with node --expose-gc')
  const mem = () => { gc(); gc(); const m = process.memoryUsage(); return { rss: MB(m.rss), heap: MB(m.heapUsed) } }
  process.env.TLHOST_DOM = dom // loadHost() picks the DOM from it
  const out: Any = { which: dom }
  out.bare = mem()
  let t = performance.now()
  const { loadDom } = await import('../src/dom-pick.ts')
  const mod = await loadDom(dom)
  out.importDomMs = performance.now() - t
  t = performance.now()
  mod.installPage()
  out.installDomMs = performance.now() - t
  out.dom = mem()
  t = performance.now()
  const { loadHost } = await import('../src/headless.ts')
  const host = await loadHost()
  const { buildBoard } = await import('../src/board.ts')
  const { exportPng } = await import('../src/export.ts')
  const { toRichText } = await import('tldraw')
  out.loadTldrawMs = performance.now() - t
  out.tldraw = mem()

  const editors = [host.createHeadlessEditor()]
  const ids = buildBoard(editors[0])
  out.one = mem()
  for (let i = 1; i < 10; i++) { const e = host.createHeadlessEditor(); buildBoard(e); editors.push(e) }
  out.ten = mem()

  // create / update / delete on this DOM
  const e = editors[0]
  const n0 = e.getCurrentPageShapes().length
  e.updateShape({ id: ids.note, type: 'note', props: { richText: toRichText('Updated on ' + dom + '\nwith two lines') } } as Any)
  e.updateShape({ id: ids.geo, type: 'geo', x: 10 } as Any)
  const upd = (e.getShape(ids.note) as Any).props.richText.content.length === 2 && e.getShape(ids.geo)!.x === 10
  const noteBounds = e.getShapePageBounds(ids.note)!
  e.deleteShapes([...e.getCurrentPageShapeIds()])
  out.crud = { created: n0, updated: upd, noteH: noteBounds.h, afterDelete: e.getCurrentPageShapes().length }

  // buildBoard on a warm editor, cleared page each time
  buildBoard(e); e.deleteShapes([...e.getCurrentPageShapeIds()]) // warm-up
  const builds: number[] = []
  for (let i = 0; i < 20; i++) {
    e.deleteShapes([...e.getCurrentPageShapeIds()])
    const t0 = performance.now(); buildBoard(e); builds.push(performance.now() - t0)
  }
  out.buildBoardMs = median(builds)

  // one PNG of the board, warm (node-board.ts's options)
  const png = async () => (await exportPng(e, undefined, { padding: 32, background: true }))!
  await png()
  const pngs: number[] = []
  for (let i = 0; i < 10; i++) { const t0 = performance.now(); await png(); pngs.push(performance.now() - t0) }
  out.pngMs = median(pngs)
  for (const ed of editors) ed.dispose()
  return out
}

if (process.argv[2] === 'one') {
  const r = await one(process.argv[3] ?? 'jsdom')
  process.stdout.write('\nRESULT ' + JSON.stringify(r) + '\n')
  process.exit(0)
} else {
  const DOMS = ['jsdom', 'happy', 'linkedom']
  const rounds = Number(process.env.ROUNDS ?? 3)
  const runs: Record<string, Any[]> = Object.fromEntries(DOMS.map((d) => [d, []]))
  const self = fileURLToPath(import.meta.url)
  for (let r = 0; r < rounds; r++) {
    for (const d of DOMS) {
      const txt = execFileSync(process.execPath, ['--expose-gc', self, 'one', d], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, TLHOST_DOM: d } })
      const line = txt.split('\n').find((l) => l.startsWith('RESULT '))!
      runs[d].push(JSON.parse(line.slice(7)))
      process.stderr.write(`round ${r + 1} ${d} done\n`)
    }
  }
  const pick = (d: string, f: (x: Any) => number) => median(runs[d].map(f))
  const rows: [string, (x: Any) => number, number][] = [
    ['RSS bare Node (MB)', (x) => x.bare.rss, 0],
    ['RSS after DOM installed (MB)', (x) => x.dom.rss, 0],
    ['heapUsed after DOM installed (MB)', (x) => x.dom.heap, 1],
    ['RSS after tldraw + skia loaded (MB)', (x) => x.tldraw.rss, 0],
    ['heapUsed after tldraw + skia loaded (MB)', (x) => x.tldraw.heap, 1],
    ['RSS, 1 editor with the board (MB)', (x) => x.one.rss, 0],
    ['heapUsed, 1 editor with the board (MB)', (x) => x.one.heap, 1],
    ['RSS, 10 editors with the board (MB)', (x) => x.ten.rss, 0],
    ['heapUsed, 10 editors with the board (MB)', (x) => x.ten.heap, 1],
    ['import DOM module (ms)', (x) => x.importDomMs, 0],
    ['install DOM (ms)', (x) => x.installDomMs, 1],
    ['import + install DOM (ms)', (x) => x.importDomMs + x.installDomMs, 0],
    ['load tldraw + skia + host (ms)', (x) => x.loadTldrawMs, 0],
    ['buildBoard, warm (ms, median of 20)', (x) => x.buildBoardMs, 2],
    ['PNG of the board, warm (ms, median of 10)', (x) => x.pngMs, 1],
  ]
  const lines = [`| (median of ${rounds} processes) | ${DOMS.join(' | ')} |`, `|---|${DOMS.map(() => '---:').join('|')}|`]
  for (const [name, f, dp] of rows) lines.push(`| ${name} | ${DOMS.map((d) => pick(d, f).toFixed(dp)).join(' | ')} |`)
  console.log(lines.join('\n'))
  console.log('crud:', JSON.stringify(Object.fromEntries(DOMS.map((d) => [d, runs[d].map((x) => x.crud)[0]]))))
  mkdirSync('out', { recursive: true })
  writeFileSync('out/cost-dom.json', JSON.stringify({ node: process.version, platform: `${process.platform}-${process.arch}`, runs, table: lines }, null, 1))
}
