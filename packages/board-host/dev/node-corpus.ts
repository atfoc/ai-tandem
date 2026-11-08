// Runs the corpus (packages/board-tl/src/model/corpus.ts) on the board host's runtime → out/node-corpus.json (the spike's
// format). Compare with the Chromium reference: in spikes/tl-host, `node dev/chromium/run.mjs`, then
// `node dev/compare.ts out/chromium-corpus.json ../../packages/board-host/out/node-corpus.json`.
// Usage: node dev/node-corpus.ts [case-id prefix]   (AIWB_BOARDHOST_DOM=jsdom for the fallback; OUT=<file> to write elsewhere)
import '../src/node/install-page.ts'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadRuntime } from '../src/node/runtime.ts'
const rt = await loadRuntime()
const { runCorpus } = await import('../../board-tl/src/model/corpus.ts')
const editor = rt.createEditor()
const only = process.argv[2] ? (id: string) => id.startsWith(process.argv[2]) : undefined
const t = performance.now()
const res = runCorpus(editor, { only })
console.log(Object.keys(res).length, 'cases', (performance.now() - t).toFixed(0), 'ms', rt.dom)
const out = process.env.OUT ?? fileURLToPath(new URL('../out/node-corpus.json', import.meta.url))
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, JSON.stringify(res, null, 1))
process.exit(0)
