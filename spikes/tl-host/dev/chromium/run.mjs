// The Chromium reference of the tl-host spike: the corpus (src/corpus.ts) and the reference board (src/board.ts) run by
// the same Editor (src/editor.ts) in a real page, with tldraw's fonts, measured by the browser's layout.
//
//   npm install --no-save playwright@1.64.1 && npx playwright install chromium   (once; in spikes/tl-host)
//   node dev/chromium/run.mjs
//
// Writes to out/: chromium-corpus.json, chromium-board.{svg,png}, chromium-board-records.json, chromium-env.json and
// chromium-fonts.json (the platform fonts Chromium used for the texts of TEXTS, per tldraw family, from CDP).
import { createServer } from 'node:http'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import { FACES, fontFaceCss } from './fonts.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')
const out = join(root, 'out')
const pageDir = join(out, 'chromium-page')
const fontDir = join(root, 'node_modules/@tldraw/assets/fonts')
mkdirSync(pageDir, { recursive: true })

// 1. the page: one ESM bundle and its CSS (tldraw.css), an HTML with the @font-face rules
await build({
  entryPoints: [join(here, 'page.ts')],
  outfile: join(pageDir, 'page.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'chrome120',
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'warning',
})
writeFileSync(join(pageDir, 'index.html'), `<!doctype html>
<html><head><meta charset="utf-8">
<link rel="stylesheet" href="page.css">
<style>
${fontFaceCss()}
html, body { margin: 0; padding: 0; }
</style>
</head><body><script type="module" src="page.js"></script></body></html>
`)

// 2. a server: the page's folder, and each font file at /fonts/<file> (the @font-face rules) and /<key> (tldraw's lookup)
const fontByKey = new Map(FACES.flatMap((f) => [[f.key, f.file], [`fonts/${f.file}`, f.file]]))
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' }
const fontRequests = []
const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname).slice(1) || 'index.html'
  try {
    if (fontByKey.has(path)) {
      fontRequests.push(path)
      res.writeHead(200, { 'content-type': 'font/woff2' }).end(readFileSync(join(fontDir, fontByKey.get(path))))
      return
    }
    if (path.includes('..') || path.includes('/')) throw new Error('not here')
    const ext = path.slice(path.lastIndexOf('.'))
    res.writeHead(200, { 'content-type': types[ext] ?? 'application/octet-stream' }).end(readFileSync(join(pageDir, path)))
  } catch {
    res.writeHead(404).end()
  }
})
await new Promise((ok) => server.listen(0, '127.0.0.1', ok))
const url = `http://127.0.0.1:${server.address().port}/`

// 3. the browser
const browser = await chromium.launch()
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  await page.goto(url)
  await page.waitForFunction(() => window.__ready !== undefined)
  const { faces } = await page.evaluate(() => window.__ready)
  const notLoaded = faces.filter((f) => f.status !== 'loaded')
  if (notLoaded.length) console.warn('font faces not loaded:', notLoaded)

  const t0 = Date.now()
  const corpus = await page.evaluate(() => window.runCorpus())
  const corpusMs = Date.now() - t0
  writeFileSync(join(out, 'chromium-corpus.json'), JSON.stringify(corpus, null, 1))

  const board = await page.evaluate(() => window.exportBoard())
  writeFileSync(join(out, 'chromium-board.svg'), board.svg ?? '')
  writeFileSync(join(out, 'chromium-board.png'), Buffer.from(board.png, 'base64'))
  writeFileSync(join(out, 'chromium-board-records.json'), JSON.stringify({ svgSize: board.svgSize, pngSize: board.pngSize, records: board.records }, null, 1))

  const fonts = await platformFonts(context, page)
  writeFileSync(join(out, 'chromium-fonts.json'), JSON.stringify(fonts, null, 1))

  const env = {
    playwright: JSON.parse(readFileSync(join(root, 'node_modules/playwright/package.json'), 'utf8')).version,
    chromium: browser.version(),
    userAgent: await page.evaluate(() => navigator.userAgent),
    os: { platform: os.platform(), release: os.release(), arch: os.arch(), version: os.version?.() },
    node: process.version,
    viewport: { width: 1280, height: 800, deviceScaleFactor: 1 },
    container: { width: 1080, height: 720 },
    fontFaces: faces,
    fontRequests: [...new Set(fontRequests)].sort(),
    corpusCases: Object.keys(corpus).length,
    corpusMs,
    pageErrors: errors,
  }
  writeFileSync(join(out, 'chromium-env.json'), JSON.stringify(env, null, 1))

  summarize(corpus, env, fonts)
} finally {
  await browser.close()
  server.close()
}

/**
 * Which platform fonts Chromium used for each text of TEXTS in each tldraw family (CDP CSS.getPlatformFontsForNode on
 * a div styled like tldraw's text: the family with its generic fallback). Tells the Node side which system fonts to
 * register as fallbacks.
 */
async function platformFonts(context, page) {
  await page.evaluate(() => {
    const generic = { tldraw_draw: 'sans-serif', tldraw_sans: 'sans-serif', tldraw_serif: 'serif', tldraw_mono: 'monospace' }
    const host = document.createElement('div')
    host.id = 'font-probes'
    for (const [family, fallback] of Object.entries(generic))
      for (const [tid, text] of Object.entries(window.TEXTS)) {
        const d = document.createElement('div')
        d.dataset.probe = `${tid}:${family}`
        d.style.cssText = `font-family: '${family}', ${fallback}; font-size: 24px; white-space: pre-wrap;`
        d.textContent = text
        host.appendChild(d)
      }
    document.body.appendChild(host)
    return new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok)))
  })
  const cdp = await context.newCDPSession(page)
  await cdp.send('DOM.enable')
  await cdp.send('CSS.enable')
  const { root } = await cdp.send('DOM.getDocument', { depth: -1 })
  const { nodeIds } = await cdp.send('DOM.querySelectorAll', { nodeId: root.nodeId, selector: '[data-probe]' })
  const result = {}
  for (const nodeId of nodeIds) {
    const { attributes } = await cdp.send('DOM.getAttributes', { nodeId })
    const probe = attributes[attributes.indexOf('data-probe') + 1]
    // the first calls after CSS.enable can answer [] (the agent has not seen the layout yet): ask again
    let fonts = []
    for (let attempt = 0; attempt < 20 && !fonts.length; attempt++) {
      if (attempt) await new Promise((ok) => setTimeout(ok, 50))
      ;({ fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId }))
    }
    result[probe] = fonts.map((f) => ({ familyName: f.familyName, postScriptName: f.postScriptName, isCustomFont: f.isCustomFont, glyphCount: f.glyphCount }))
  }
  await cdp.detach()
  return result
}

function summarize(corpus, env, fonts) {
  console.log(`Chromium ${env.chromium}, Playwright ${env.playwright}, ${env.os.platform} ${env.os.release} ${env.os.arch}`)
  console.log(`font faces loaded: ${env.fontFaces.filter((f) => f.status === 'loaded').length}/${env.fontFaces.length}; files fetched: ${env.fontRequests.length}`)
  console.log(`corpus: ${env.corpusCases} cases in ${env.corpusMs} ms`)
  const kinds = {}
  for (const id of Object.keys(corpus)) { const k = id.split(':')[0]; kinds[k] = (kinds[k] ?? 0) + 1 }
  console.log('  per kind:', Object.entries(kinds).map(([k, n]) => `${k} ${n}`).join(', '))
  const adj = {}
  for (const [id, row] of Object.entries(corpus)) if (id.startsWith('note:')) adj[row.fontSizeAdjustment] = (adj[row.fontSizeAdjustment] ?? 0) + 1
  console.log('  note fontSizeAdjustment:', Object.entries(adj).sort((a, b) => b[1] - a[1]).map(([v, n]) => `${v}×${n}`).join(', '))
  const grown = Object.entries(corpus).filter(([id, r]) => id.startsWith('note:') && r.growY > 0).length
  console.log(`  notes with growY > 0: ${grown}`)
  // platform fonts not from the tldraw faces, per text
  const fallbacks = {}
  for (const [probe, list] of Object.entries(fonts)) {
    const tid = probe.split(':')[0]
    for (const f of list) if (!f.isCustomFont) (fallbacks[tid] ??= new Set()).add(`${f.familyName} (${f.postScriptName})`)
  }
  console.log('platform fallback fonts (not tldraw faces):')
  for (const [tid, set] of Object.entries(fallbacks)) console.log(`  ${tid}: ${[...set].join(', ')}`)
  if (env.pageErrors.length) console.log('page errors:', env.pageErrors)
}
