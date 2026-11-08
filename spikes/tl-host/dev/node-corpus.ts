// Runs the corpus (src/corpus.ts) on the headless editor in Node → out/node-corpus.json. Compare with
// out/chromium-corpus.json (dev/chromium/run.mjs) by `node dev/compare.ts out/chromium-corpus.json out/node-corpus.json`.
import { mkdirSync, writeFileSync } from 'node:fs'
import { loadHost } from '../src/headless.ts'
const host = await loadHost()
const { runCorpus } = await import('../src/corpus.ts')
const editor = host.createHeadlessEditor()
const only = process.argv[2] ? (id: string) => id.startsWith(process.argv[2]) : undefined
const t = performance.now()
const res = runCorpus(editor, { only })
console.log(Object.keys(res).length, 'cases', (performance.now() - t).toFixed(0), 'ms')
mkdirSync('out', { recursive: true })
writeFileSync(process.env.OUT ?? 'out/node-corpus.json', JSON.stringify(res, null, 1))
process.exit(0)
