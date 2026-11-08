// Helpers shared by dev/sync.ts and dev/reconnect.ts (research scripts, not tests).
import type { Editor } from 'tldraw'

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function waitFor(what: string, pred: () => boolean, timeoutMs = 3000): Promise<number> {
  const t0 = performance.now()
  while (!pred()) {
    if (performance.now() - t0 > timeoutMs) throw new Error(`timed out waiting for: ${what}`)
    await new Promise((r) => setImmediate(r))
  }
  return performance.now() - t0
}

/** Until the parent's measurer (src/measure.ts) lands: jsdom measures 0, and a frame's label needs a span. */
export function stubMeasure(editor: Editor) {
  const tm = (editor as any).textMeasure
  tm.measureTextSpans = () => [{ text: 'x', box: { x: 0, y: 0, w: 10, h: 10 } }]
}

/** Document records of a store (shapes, bindings, pages, document, assets), keyed by id, serializable. */
export function docRecords(store: any): Record<string, any> {
  return store.serialize('document')
}

export function sameDocs(a: any, b: any): { equal: boolean; diff: string[] } {
  const ra = docRecords(a), rb = docRecords(b)
  const diff: string[] = []
  for (const id of new Set([...Object.keys(ra), ...Object.keys(rb)])) {
    if (JSON.stringify(ra[id]) !== JSON.stringify(rb[id])) diff.push(id)
  }
  return { equal: diff.length === 0, diff }
}

export function shapeIds(store: any): string[] {
  return Object.keys(docRecords(store)).filter((k) => k.startsWith('shape:')).sort()
}

const warnings: string[] = []
/** Captures console.warn / console.error lines (tldraw's sync client reports problems there). */
export function captureConsole() {
  for (const k of ['warn', 'error'] as const) {
    const orig = console[k].bind(console)
    console[k] = (...a: any[]) => {
      warnings.push(`${k}: ${a.map((x) => (x instanceof Error ? x.message : typeof x === 'string' ? x : JSON.stringify(x))).join(' ').slice(0, 300)}`)
      if (process.env.VERBOSE) orig(...a)
    }
  }
  return {
    take(): string[] {
      return warnings.splice(0)
    },
  }
}

export function ms(n: number) {
  return `${n.toFixed(1)} ms`
}
