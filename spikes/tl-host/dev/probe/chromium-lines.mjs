// Research probe (not a test): Chromium's line boxes for texts in a div styled like tldraw's measuring div.
// Usage: node dev/probe/chromium-lines.mjs cases.json > out.json   (cases: [{family, size, maxWidth, nobreak, text}])
import { chromium } from 'playwright'
import fs from 'fs'
import http from 'http'
const dir = new URL('../../node_modules/@tldraw/assets/fonts', import.meta.url).pathname
const faces = { tldraw_draw: ['Shantell_Sans-Informal_Regular','Shantell_Sans-Informal_Bold'], tldraw_sans: ['IBMPlexSans-Medium','IBMPlexSans-Bold'], tldraw_serif: ['IBMPlexSerif-Medium','IBMPlexSerif-Bold'], tldraw_mono: ['IBMPlexMono-Medium','IBMPlexMono-Bold'] }
const css = Object.entries(faces).map(([f, [n, b]]) => `@font-face{font-family:${f};src:url(${n}.woff2);font-weight:normal}@font-face{font-family:${f};src:url(${b}.woff2);font-weight:bold}`).join('\n')
const html = `<!doctype html><style>${css}
.m{position:absolute;top:0;left:0;width:max-content;box-sizing:border-box;white-space:pre-wrap;overflow-wrap:break-word;word-wrap:break-word;unicode-bidi:plaintext;line-break:normal;word-break:normal}
.m p{margin:0;min-height:1lh}</style><body></body>`
const srv = http.createServer((q, r) => { if (q.url === '/') { r.setHeader('content-type','text/html'); return r.end(html) } try { r.end(fs.readFileSync(dir + q.url)) } catch { r.statusCode = 404; r.end() } }).listen(0)
const cases = JSON.parse(fs.readFileSync(process.argv[2]))
const b = await chromium.launch(); const p = await b.newPage()
await p.goto(`http://127.0.0.1:${srv.address().port}/`)
await p.evaluate(async () => { for (const f of ['tldraw_draw','tldraw_sans','tldraw_serif','tldraw_mono']) { await document.fonts.load(`16px ${f}`); await document.fonts.load(`bold 16px ${f}`) } })
const out = await p.evaluate((cases) => cases.map(c => {
  const d = document.createElement('div'); d.className = 'm'
  Object.assign(d.style, { fontFamily: c.family, fontSize: c.size + 'px', lineHeight: Math.round(c.size * 1.35) + 'px', maxWidth: c.maxWidth ? c.maxWidth + 'px' : '', overflowWrap: c.nobreak ? 'normal' : 'break-word' })
  d.innerHTML = '<div class="tl-rich-text">' + c.text.split('\n').map(t => '<p>' + (t ? t.replace(/&/g,'&amp;').replace(/</g,'&lt;') : '<br>') + '</p>').join('') + '</div>'
  document.body.appendChild(d)
  const lines = []
  for (const pEl of d.querySelectorAll('p')) {
    const tn = pEl.firstChild; if (!tn || tn.nodeType !== 3) { lines.push({ text: '' }); continue }
    const r = new Range(); let cur = null, top = null
    const s = tn.textContent
    for (let i = 0; i < s.length; i++) {
      if (s.charCodeAt(i) >= 0xdc00 && s.charCodeAt(i) <= 0xdfff) continue
      const e = i + (s.codePointAt(i) > 0xffff ? 2 : 1)
      r.setStart(tn, i); r.setEnd(tn, e)
      const rects = r.getClientRects(); const rc = rects[rects.length - 1]
      if (!rc) { if (cur) cur.text += s.slice(i, e); continue }
      if (top === null || Math.abs(rc.top - top) > 1) { cur = { text: '', left: rc.left, right: rc.right }; lines.push(cur); top = rc.top }
      cur.text += s.slice(i, e); cur.right = Math.max(cur.right, rc.right)
    }
  }
  const rect = d.getBoundingClientRect()
  const res = { w: rect.width, h: rect.height, scrollWidth: d.scrollWidth, lines: lines.map(l => ({ text: l.text, w: l.right - l.left })) }
  d.remove(); return res
}), cases)
console.log(JSON.stringify(out, null, 1))
await b.close(); srv.close()
