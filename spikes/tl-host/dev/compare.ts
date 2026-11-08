// Diffs two corpus results (src/corpus.ts runCorpus: { caseId: { field: number | null } }), e.g. Node against Chromium.
//
//   node dev/compare.ts <a.json> <b.json> [--json out.json] [--worst N]
//
// Prints a table per case kind (the id before the first ':') and per text id (the second field): the number of cases,
// how many have every numeric field within 0.01 and within 0.5 px, the largest absolute difference and the case it is
// in; then the worst N (default 30) differing cases with both values; then the keys found on one side only.
// --json writes every case's diff: { cases: { id: { maxDiff, fields: { f: { a, b, diff } } } }, onlyA, onlyB }.
import { readFileSync, writeFileSync } from 'node:fs'

type Row = Record<string, number | string | null>
type Result = Record<string, Row>

const args = process.argv.slice(2)
const flag = (name: string) => {
  const i = args.indexOf(name)
  if (i < 0) return undefined
  const v = args[i + 1]
  args.splice(i, 2)
  return v
}
const jsonOut = flag('--json')
const worstN = Number(flag('--worst') ?? 30)
if (args.length !== 2) {
  console.error('usage: node dev/compare.ts <a.json> <b.json> [--json out.json] [--worst N]')
  process.exit(2)
}
const [pathA, pathB] = args
const a: Result = JSON.parse(readFileSync(pathA, 'utf8'))
const b: Result = JSON.parse(readFileSync(pathB, 'utf8'))

interface FieldDiff { a: number | string | null; b: number | string | null; diff: number }
interface CaseDiff { maxDiff: number; fields: Record<string, FieldDiff> }

/** |a - b| for numbers; 0 when both are equal non-numbers (null, same string); Infinity when one side lacks a number. */
function fieldDiff(x: unknown, y: unknown): number {
  if (typeof x === 'number' && typeof y === 'number') return Math.abs(x - y)
  return x === y ? 0 : Infinity
}

const cases: Record<string, CaseDiff> = {}
const onlyA = Object.keys(a).filter((k) => !(k in b))
const onlyB = Object.keys(b).filter((k) => !(k in a))
for (const id of Object.keys(a)) {
  if (!(id in b)) continue
  const fields: Record<string, FieldDiff> = {}
  let maxDiff = 0
  for (const f of new Set([...Object.keys(a[id]), ...Object.keys(b[id])])) {
    const d = fieldDiff(a[id][f], b[id][f])
    fields[f] = { a: a[id][f] ?? null, b: b[id][f] ?? null, diff: d }
    maxDiff = Math.max(maxDiff, d)
  }
  cases[id] = { maxDiff, fields }
}

interface Group { n: number; eq: number; half: number; max: number; maxId: string }
function group(keyOf: (id: string) => string): Map<string, Group> {
  const groups = new Map<string, Group>()
  for (const [id, c] of Object.entries(cases)) {
    const k = keyOf(id)
    const g = groups.get(k) ?? { n: 0, eq: 0, half: 0, max: 0, maxId: '' }
    g.n++
    if (c.maxDiff <= 0.01) g.eq++
    if (c.maxDiff <= 0.5) g.half++
    if (c.maxDiff > g.max || !g.maxId) { g.max = Math.max(g.max, c.maxDiff); g.maxId = id }
    groups.set(k, g)
  }
  return groups
}

const fmt = (n: number) => (n === Infinity ? 'missing' : String(Math.round(n * 1000) / 1000))
function table(title: string, groups: Map<string, Group>) {
  const rows = [[title, 'cases', '≤0.01', '≤0.5px', 'max diff', 'in case']]
  let total: Group = { n: 0, eq: 0, half: 0, max: 0, maxId: '' }
  for (const [k, g] of groups) {
    rows.push([k, String(g.n), String(g.eq), String(g.half), fmt(g.max), g.max > 0 ? g.maxId : ''])
    total = { n: total.n + g.n, eq: total.eq + g.eq, half: total.half + g.half, max: Math.max(total.max, g.max), maxId: g.max >= total.max && g.max > 0 ? g.maxId : total.maxId }
  }
  rows.push(['all', String(total.n), String(total.eq), String(total.half), fmt(total.max), total.maxId])
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)))
  for (const [i, r] of rows.entries()) {
    console.log(r.map((c, j) => (j === 0 || j === 5 ? c.padEnd(widths[j]) : c.padStart(widths[j]))).join('  ').trimEnd())
    if (i === 0 || i === rows.length - 2) console.log(widths.map((w) => '-'.repeat(w)).join('  '))
  }
  console.log()
}

console.log(`a: ${pathA} (${Object.keys(a).length} cases)\nb: ${pathB} (${Object.keys(b).length} cases)\n`)
table('kind', group((id) => id.split(':')[0]))
table('text', group((id) => id.split(':')[1] ?? ''))

const differing = Object.entries(cases).filter(([, c]) => c.maxDiff > 0.01).sort((x, y) => y[1].maxDiff - x[1].maxDiff)
if (differing.length === 0) console.log('every common case equal within 0.01')
else {
  console.log(`worst ${Math.min(worstN, differing.length)} of ${differing.length} differing cases (fields: a / b):`)
  for (const [id, c] of differing.slice(0, worstN)) {
    const parts = Object.entries(c.fields).map(([f, d]) => (d.diff > 0.01 ? `${f} ${d.a} / ${d.b}` : `${f} ${d.a}`))
    console.log(`  ${fmt(c.maxDiff).padStart(8)}  ${id}  ${parts.join(', ')}`)
  }
}
if (onlyA.length) console.log(`\nonly in a (${onlyA.length}): ${onlyA.join(' ')}`)
if (onlyB.length) console.log(`\nonly in b (${onlyB.length}): ${onlyB.join(' ')}`)

if (jsonOut) {
  // Infinity is not JSON: write it as null
  writeFileSync(jsonOut, JSON.stringify({ a: pathA, b: pathB, cases, onlyA, onlyB }, (_, v) => (v === Infinity ? null : v), 1))
  console.log(`\nwrote ${jsonOut}`)
}
