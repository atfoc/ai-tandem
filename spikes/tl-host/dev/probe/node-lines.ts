// The Node side of dev/probe/chromium-lines.mjs: the same cases through measure.ts's layoutHtml, the same output shape.
// Usage: node dev/probe/node-lines.ts cases.json
import { readFileSync } from 'node:fs'
import { installPage } from '../../src/dom.ts'
installPage()
const { layoutHtml } = await import('../../src/measure.ts')
const cases = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;')
const out = cases.map((c: any) => {
  const html = '<div class="tl-rich-text">' + c.text.split('\n').map((t: string) => '<p>' + (t ? esc(t) : '<br>') + '</p>').join('') + '</div>'
  const l = layoutHtml(html, { fontFamily: c.family, fontSize: c.size, fontWeight: 'normal', fontStyle: 'normal', lineHeight: 1.35, maxWidth: c.maxWidth ?? null, overflowWrap: c.nobreak ? 'normal' : 'break-word' })
  return { w: l.w, h: l.h, scrollWidth: l.scrollWidth, lines: l.lines.map((x) => ({ text: x.text, w: x.widthWithSpaces })) }
})
console.log(JSON.stringify(out, null, 1))
process.exit(0)
