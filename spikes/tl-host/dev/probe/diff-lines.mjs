// Runs both probes on a cases file and prints, per case, the lines that differ. Usage: node dev/probe/diff-lines.mjs cases.json
import { execFileSync } from 'node:child_process'
const f = process.argv[2]
const here = new URL('.', import.meta.url).pathname
const cases = JSON.parse((await import('node:fs')).readFileSync(f, 'utf8'))
const a = JSON.parse(execFileSync('node', [here + 'chromium-lines.mjs', f], { maxBuffer: 1 << 26 }))
const b = JSON.parse(execFileSync('node', [here + 'node-lines.ts', f], { maxBuffer: 1 << 26 }))
cases.forEach((c, i) => {
  const x = a[i], y = b[i]
  const same = x.lines.length === y.lines.length && x.lines.every((l, j) => l.text === y.lines[j].text)
  const dw = Math.abs(x.w - y.w), dh = Math.abs(x.h - y.h)
  console.log(`${same && dw < 0.01 && dh < 0.01 ? 'OK ' : 'DIFF'} #${i} ${c.family.split(',')[0]} ${c.size}px max=${c.maxWidth ?? 'auto'}${c.nobreak ? ' nobreak' : ''}  w ${x.w.toFixed(3)} / ${y.w.toFixed(3)}  h ${x.h} / ${y.h}  sw ${x.scrollWidth} / ${y.scrollWidth}  ${JSON.stringify(c.text.slice(0, 40))}`)
  if (!same || process.env.ALL) for (let j = 0; j < Math.max(x.lines.length, y.lines.length); j++) {
    const l1 = x.lines[j], l2 = y.lines[j]
    console.log(`    ${l1?.text === l2?.text ? '  ' : '≠ '}${JSON.stringify(l1?.text)} ${l1?.w?.toFixed(3)}  |  ${JSON.stringify(l2?.text)} ${l2?.w?.toFixed(3)}`)
  }
})
