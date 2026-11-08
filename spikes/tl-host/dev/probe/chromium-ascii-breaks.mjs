// Research probe (not a test): which pairs of printable ASCII characters Chromium allows a line break between (Blink keeps
// a table of its own for ASCII pairs instead of asking ICU). Writes src/ascii-breaks.json: { "<a><b>": true } for the
// pairs that break. Each pair is laid out as "x<a><b>x" in a zero-width pre-wrap div; a break between a and b shows as b
// starting a new line.
import { chromium } from 'playwright'
import fs from 'fs'
const chars = []
for (let c = 0x21; c <= 0x7e; c++) chars.push(String.fromCharCode(c))
const b = await chromium.launch(); const p = await b.newPage()
const version = b.version()
await p.setContent(`<!doctype html><style>div{font:16px Helvetica;width:0;white-space:pre-wrap;overflow-wrap:normal;word-break:normal;line-break:normal}</style><body></body>`)
const res = await p.evaluate((chars) => {
  const out = {}
  for (const a of chars) for (const c of chars) {
    const d = document.createElement('div')
    d.textContent = 'x' + a + c + 'x'
    document.body.appendChild(d)
    const tn = d.firstChild, r = new Range()
    r.setStart(tn, 1); r.setEnd(tn, 2); const ra = r.getClientRects()[0]
    r.setStart(tn, 2); r.setEnd(tn, 3); const rb = [...r.getClientRects()].pop()
    if (Math.abs(ra.top - rb.top) > 1) out[a + c] = true
    d.remove()
  }
  return out
}, chars)
await b.close()
const file = new URL('../../src/ascii-breaks.json', import.meta.url)
fs.writeFileSync(file, JSON.stringify({ chromium: version, pairs: Object.keys(res) }, null, 0))
console.log(Object.keys(res).length, 'breaking pairs of', chars.length ** 2)
