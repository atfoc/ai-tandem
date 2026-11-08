// tldraw's text measuring without a browser (goal 4.8, risk 8.2): a replacement for editor.textMeasure that lays text out
// as Chromium lays out tldraw's measuring div (TextManager.ts in @tldraw/editor), with skia-canvas and tldraw's own font
// files (fonts.ts).
//
// What tldraw asks (5.6.0): measureHtml(html, opts) for every label (geo, note, text, arrow), measureHtmlBatch for many
// geo labels at once, measureTextSpans(text, opts) for frame headings, measureText for the cursor chat bubble. The html is
// TipTap's (renderHtmlFromRichTextForMeasurement): <div class="tl-rich-text"><p dir="auto">…</p>…</div>, with <br />,
// <strong>, <em>, <code>, <mark>, <a>, lists and headings.
//
// The div it is measured in (editor.css .tl-text-measure + getMeasureStyles): position absolute, width max-content,
// max-width / min-width from opts, box-sizing border-box, white-space pre-wrap, overflow-wrap break-word (or normal with
// disableOverflowWrapBreaking), word-break normal, line-height = round(fontSize × lineHeight) px. So:
//   w = clamp(max-content width, minWidth, maxWidth) (+ padding), h = the sum of the line boxes, scrollWidth = the
//   widest line, overflow included, as an integer.
// Lines are broken greedily at UAX #14 opportunities (the `linebreak` package, as ICU does for Blink), trailing spaces
// hang (pre-wrap), a word longer than the line is broken between graphemes only with overflow-wrap: break-word, and
// widths are rounded to Blink's LayoutUnit (1/64 px).
//
// layoutHtml() returns the lines themselves (text runs with their fonts and positions), which export.ts uses to draw the
// same text into the SVG that the measurement promised.
import LineBreaker from 'linebreak'
import { Canvas } from 'skia-canvas'
import type { BoxModel, Editor, TLMeasureTextOpts, TLMeasureTextSpanOpts } from 'tldraw'
import { resolveFont } from './fonts.ts'
import type { ResolvedFont } from './fonts.ts'

type Any = any

// ---------------------------------------------------------------------------------------------- the model of a text

export interface Run {
  text: string
  font: ResolvedFont
  /** Inline marks, for drawing: */
  mark?: boolean
  link?: boolean
  underline?: boolean
  strike?: boolean
}

export interface Block {
  runs: Run[]
  /** Padding-left of a list item's content (px) and its marker ("•", "1."). */
  indent: number
  marker?: string
  lineHeight: number
  marginTop: number
  marginBottom: number
  /** The block's own primary font (its size and family decide the strut and the marker). */
  font: ResolvedFont
}

export interface LinePiece {
  text: string
  font: ResolvedFont
  /** x from the line's start, and width (px, unrounded). */
  x: number
  w: number
  run: Run
}

export interface Line {
  /** Top of the line box, from the top of the content box. */
  top: number
  height: number
  /** The baseline, from the top of the content box. */
  baseline: number
  /** Offset of the line's start (the block's indent). */
  left: number
  /** Width without hanging trailing spaces, and with them. */
  width: number
  widthWithSpaces: number
  pieces: LinePiece[]
  /** The block's marker, on its first line. */
  marker?: string
  text: string
}

export interface Layout {
  w: number
  h: number
  scrollWidth: number
  /** The width the lines were broken at (content box), or null when they were not wrapped. */
  wrapWidth: number | null
  lines: Line[]
}

export interface LayoutOptions {
  fontFamily: string
  fontSize: number
  fontWeight: string
  fontStyle: string
  /** The unitless multiplier tldraw passes (1.35). */
  lineHeight: number
  maxWidth: number | null
  minWidth?: number | null
  padding?: number
  overflowWrap?: 'break-word' | 'normal' | 'anywhere'
  /** word-break: break-all (truncated spans). */
  breakAll?: boolean
}

// --------------------------------------------------------------------------------------------- measuring with skia

const ctx = new Canvas(16, 16).getContext('2d') as Any
const widthCache = new Map<string, number>()

/** The advance width of `text` in one font, shaped as one piece (as a browser shapes a text item). */
export function textWidth(font: ResolvedFont, text: string): number {
  if (!text) return 0
  const key = font.native + '\u0000' + text
  let w = widthCache.get(key)
  if (w === undefined) {
    ctx.font = font.native
    w = ctx.measureText(text).width as number
    if (widthCache.size > 50_000) widthCache.clear()
    widthCache.set(key, w)
  }
  return w
}

const metricsCache = new Map<string, { ascent: number; descent: number }>()
/** The primary font's ascent and descent, rounded as Blink rounds them on macOS (SimpleFontData). */
export function fontMetrics(font: ResolvedFont): { ascent: number; descent: number } {
  let m = metricsCache.get(font.native)
  if (!m) {
    ctx.font = font.native
    const t = ctx.measureText('x')
    m = { ascent: Math.round(t.fontBoundingBoxAscent), descent: Math.round(t.fontBoundingBoxDescent) }
    metricsCache.set(font.native, m)
  }
  return m
}

/** Blink's LayoutUnit: 1/64 px. Inline sizes are snapped up so a text never wraps in the box made for it. */
export const LU = 64
export const luCeil = (x: number) => Math.ceil(x * LU - 1e-6) / LU
export const luFloor = (x: number) => Math.floor(x * LU + 1e-6) / LU
export const luRound = (x: number) => Math.round(x * LU) / LU

// ------------------------------------------------------------------------------------------------- html → blocks

const HEADING_SCALE: Record<string, number> = { H1: 2, H2: 1.5, H3: 1.17, H4: 1, H5: 0.83, H6: 0.67 }

function parseHtml(html: string, o: LayoutOptions): Block[] {
  const doc = (globalThis as Any).document as Document
  const root = doc.createElement('div')
  root.innerHTML = html
  const blocks: Block[] = []
  const baseLh = Math.round(o.fontSize * o.lineHeight)

  interface Ctx { weight: string; style: string; family: string; size: number; mark?: boolean; link?: boolean; underline?: boolean; strike?: boolean }
  const base: Ctx = { weight: o.fontWeight, style: o.fontStyle, family: o.fontFamily, size: o.fontSize }

  const newBlock = (c: Ctx, extra: Partial<Block> = {}): Block => ({
    runs: [], indent: 0, lineHeight: baseLh, marginTop: 0, marginBottom: 0,
    font: resolveFont(c.family, c.weight, c.style, c.size), ...extra,
  })

  let cur: Block | null = null
  let indent = 0
  let pendingMarker: string | undefined

  const inline = (node: Node, c: Ctx) => {
    if (node.nodeType === 3) {
      if (!cur) cur = newBlock(c, { indent })
      const text = node.textContent ?? ''
      if (text) cur.runs.push({ text, font: resolveFont(c.family, c.weight, c.style, c.size), mark: c.mark, link: c.link, underline: c.underline, strike: c.strike })
      return
    }
    if (node.nodeType !== 1) return
    const el = node as Element
    const tag = el.tagName
    if (tag === 'BR') {
      if (!cur) cur = newBlock(c, { indent })
      cur.runs.push({ text: '\n', font: resolveFont(c.family, c.weight, c.style, c.size) })
      return
    }
    if (tag === 'P' || /^H[1-6]$/.test(tag)) {
      flush()
      let bc = c
      let extra: Partial<Block> = { indent }
      if (tag !== 'P') {
        const size = c.size * HEADING_SCALE[tag]
        bc = { ...c, size, weight: 'bold' }
        extra = { ...extra, lineHeight: size * o.lineHeight, marginTop: 5, marginBottom: 10 }
      }
      cur = newBlock(bc, extra)
      if (pendingMarker) { cur.marker = pendingMarker; pendingMarker = undefined }
      for (const ch of el.childNodes) inline(ch, bc)
      flush(true)
      return
    }
    if (tag === 'UL' || tag === 'OL') {
      flush()
      const zero = textWidth(resolveFont(c.family, c.weight, c.style, c.size), '0')
      const items = [...el.children].filter((x) => x.tagName === 'LI')
      const pad = (tag === 'OL' && items.length >= 100 ? 3.625 : tag === 'OL' && items.length >= 10 ? 2.625 : 1.625) * zero
      indent += pad
      items.forEach((li, i) => {
        pendingMarker = tag === 'OL' ? `${i + 1}.` : '•'
        for (const ch of li.childNodes) inline(ch, c)
        flush()
      })
      indent -= pad
      return
    }
    const next: Ctx = { ...c }
    if (tag === 'STRONG' || tag === 'B') next.weight = 'bold'
    else if (tag === 'EM' || tag === 'I') next.style = 'italic'
    else if (tag === 'CODE') next.family = "'tldraw_mono', monospace"
    else if (tag === 'MARK') next.mark = true
    else if (tag === 'A') { next.link = true; next.underline = true }
    else if (tag === 'U') next.underline = true
    else if (tag === 'S' || tag === 'DEL') next.strike = true
    for (const ch of el.childNodes) inline(ch, next)
  }

  const flush = (force = false) => {
    if (cur && (cur.runs.length || force)) blocks.push(cur)
    cur = null
  }

  for (const ch of root.childNodes) {
    // the wrapper <div class="tl-rich-text"> (or bare text from measureText)
    if (ch.nodeType === 1 && (ch as Element).tagName === 'DIV') for (const g of ch.childNodes) inline(g, base)
    else inline(ch, base)
  }
  flush()
  if (!blocks.length) blocks.push(newBlock(base))
  return blocks
}

// ----------------------------------------------------------------------------------------------- line breaking

interface Flat {
  text: string
  /** Run index for each UTF-16 position. */
  runAt: Int32Array
  runs: Run[]
}

function flatten(b: Block): Flat {
  const text = b.runs.map((r) => r.text).join('')
  const runAt = new Int32Array(text.length)
  let p = 0
  b.runs.forEach((r, i) => { runAt.fill(i, p, p + r.text.length); p += r.text.length })
  return { text, runAt, runs: b.runs }
}

/** The pieces of [a, b) cut at run boundaries. */
function piecesOf(f: Flat, a: number, b: number): { run: Run; a: number; b: number }[] {
  const out: { run: Run; a: number; b: number }[] = []
  let s = a
  while (s < b) {
    const r = f.runAt[s]
    let e = s
    while (e < b && f.runAt[e] === r) e++
    out.push({ run: f.runs[r], a: s, b: e })
    s = e
  }
  return out
}

function widthOf(f: Flat, a: number, b: number): number {
  let w = 0
  for (const p of piecesOf(f, a, b)) w += textWidth(p.run.font, f.text.slice(p.a, p.b).replace(/\n/g, ''))
  return w
}

const isSpace = (ch: string) => ch === ' ' || ch === '\t' || ch === '　'
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

interface Opp { pos: number; required: boolean }

function opportunities(text: string, breakAll: boolean): Opp[] {
  const out: Opp[] = []
  if (breakAll) {
    for (const g of graphemes.segment(text)) if (g.index > 0) out.push({ pos: g.index, required: text[g.index - 1] === '\n' })
  } else {
    const lb = new LineBreaker(text)
    let br: Any
    while ((br = lb.nextBreak())) out.push({ pos: br.position, required: br.required || text[br.position - 1] === '\n' })
  }
  // the end of the text is always a (soft) end
  if (!out.length || out[out.length - 1].pos !== text.length) out.push({ pos: text.length, required: false })
  // linebreak marks \n as required; make sure every \n is one
  return out
}

/** The end of [a, e) without its hanging trailing spaces (and the forced break itself). */
function trimEnd(text: string, a: number, e: number): number {
  let t = e
  if (t > a && text[t - 1] === '\n') t--
  while (t > a && isSpace(text[t - 1])) t--
  return t
}

interface RawLine { a: number; b: number; width: number; widthWithSpaces: number }

function breakLines(f: Flat, avail: number | null, wrap: 'break-word' | 'normal' | 'anywhere', breakAll: boolean): RawLine[] {
  const { text } = f
  const lines: RawLine[] = []
  if (!text.length) return [{ a: 0, b: 0, width: 0, widthWithSpaces: 0 }]
  const opps = opportunities(text, breakAll || wrap === 'anywhere' && false)
  const fits = (w: number) => avail === null || luCeil(w) <= avail + 1e-6
  let start = 0
  let oi = 0
  while (start < text.length) {
    while (oi < opps.length && opps[oi].pos <= start) oi++
    let end = -1
    for (let j = oi; j < opps.length; j++) {
      const o = opps[j]
      const w = widthOf(f, start, trimEnd(text, start, o.pos))
      if (fits(w)) {
        end = o.pos
        if (o.required) break
      } else break
    }
    if (end < 0) {
      // the first word does not fit on an empty line
      const o = opps[oi] ?? { pos: text.length }
      end = o.pos
      if (wrap !== 'normal') {
        let last = start
        const word = text.slice(start, trimEnd(text, start, o.pos))
        for (const g of graphemes.segment(word)) {
          const e = start + g.index + g.segment.length
          if (!fits(widthOf(f, start, e))) break
          last = e
        }
        if (last === start) last = start + ([...graphemes.segment(word)][0]?.segment.length ?? 1)
        if (last < trimEnd(text, start, o.pos)) end = last
      }
    }
    const t = trimEnd(text, start, end)
    let e2 = end
    if (e2 > start && text[e2 - 1] === '\n') e2--
    lines.push({ a: start, b: end, width: widthOf(f, start, t), widthWithSpaces: widthOf(f, start, e2) })
    start = end
  }
  // a forced break at the very end of a block adds no line (<p>text<br></p>), but an empty block is one line
  return lines
}

// -------------------------------------------------------------------------------------------------- layout

/** Lays out tldraw's measuring html as Chromium would in the .tl-text-measure div. */
export function layoutHtml(html: string, o: LayoutOptions): Layout {
  const blocks = parseHtml(html, o)
  const pad = o.padding ?? 0
  const wrap = o.overflowWrap ?? 'break-word'
  const flats = blocks.map(flatten)

  // max-content: every block unwrapped
  let maxContent = 0
  for (let i = 0; i < blocks.length; i++) {
    for (const l of breakLines(flats[i], null, wrap, false)) {
      maxContent = Math.max(maxContent, luCeil(blocks[i].indent + l.widthWithSpaces))
    }
  }
  const maxW = o.maxWidth != null ? o.maxWidth : Infinity
  const minW = o.minWidth ?? 0
  const borderBox = Math.max(minW, Math.min(maxW, maxContent + pad * 2))
  const content = Math.max(0, borderBox - pad * 2)
  const wrapWidth = maxContent > content + 1e-6 ? content : null

  const lines: Line[] = []
  let y = 0
  let prevMarginBottom = 0
  let overflow = 0
  blocks.forEach((b, i) => {
    const margin = i === 0 ? b.marginTop : Math.max(prevMarginBottom, b.marginTop)
    y += margin
    const avail = wrapWidth === null ? null : Math.max(0, content - b.indent)
    const raw = breakLines(flats[i], avail, wrap, !!o.breakAll)
    const m = fontMetrics(b.font)
    raw.forEach((r, li) => {
      const height = b.lineHeight
      const baseline = y + Math.floor((height - (m.ascent + m.descent)) / 2) + m.ascent
      const pieces: LinePiece[] = []
      let x = 0
      for (const p of piecesOf(flats[i], r.a, r.b)) {
        const text = flats[i].text.slice(p.a, p.b).replace(/\n/g, '')
        if (!text) continue
        const w = textWidth(p.run.font, text)
        pieces.push({ text, font: p.run.font, x, w, run: p.run })
        x += w
      }
      overflow = Math.max(overflow, b.indent + r.width)
      lines.push({
        top: y, height, baseline, left: b.indent, width: r.width, widthWithSpaces: r.widthWithSpaces, pieces,
        marker: li === 0 ? b.marker : undefined, text: flats[i].text.slice(r.a, r.b),
      })
      y += height
    })
    prevMarginBottom = b.marginBottom
    if (i === blocks.length - 1) y += b.marginBottom
  })
  const h = y + pad * 2
  const scrollWidth = Math.round(Math.max(borderBox, luCeil(overflow) + pad * 2))
  return { w: borderBox, h, scrollWidth, wrapWidth, lines }
}

const parsePadding = (p: string | undefined) => (p ? parseFloat(p) || 0 : 0)

function optsToLayout(opts: TLMeasureTextOpts): LayoutOptions {
  return {
    fontFamily: opts.fontFamily,
    fontSize: opts.fontSize,
    fontWeight: opts.fontWeight,
    fontStyle: opts.fontStyle,
    lineHeight: opts.lineHeight,
    maxWidth: opts.maxWidth || null, // tldraw: `opts.maxWidth ? … : undefined`, so 0 means none
    minWidth: opts.minWidth || null,
    padding: parsePadding(opts.padding),
    overflowWrap: opts.disableOverflowWrapBreaking ? 'normal' : 'break-word',
  }
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** normalizeTextForDom of TextManager.ts: newlines to \n, empty lines to a space. */
function normalizeText(text: string): string {
  return text.replace(/\r?\n|\r/g, '\n').split('\n').map((x) => x || ' ').join('\n')
}

const ALIGN: Record<string, 'left' | 'center' | 'right'> = {
  start: 'left', 'start-legacy': 'left', middle: 'center', 'middle-legacy': 'center', end: 'right', 'end-legacy': 'right',
}

// ------------------------------------------------------------------------------------- the TextManager replacement

/** What editor.textMeasure must answer, measured with skia-canvas. Installed by installCanvasMeasure(editor). */
export class CanvasTextManager {
  measureHtml(html: string, opts: TLMeasureTextOpts) {
    const l = layoutHtml(html, optsToLayout(opts))
    return { x: 0, y: 0, w: l.w, h: l.h, scrollWidth: opts.measureScrollWidth ? l.scrollWidth : 0 }
  }

  measureHtmlBatch(requests: { html: string; opts: TLMeasureTextOpts }[]) {
    return requests.map((r) => this.measureHtml(r.html, r.opts))
  }

  measureText(text: string, opts: TLMeasureTextOpts) {
    // as TextManager.measureText: the text in a div's textContent (white-space pre-wrap keeps its newlines)
    const html = escapeHtml(normalizeText(text)).replace(/\n/g, '<br>')
    return this.measureHtml(html, opts)
  }

  /** Frame headings: spans of words and spaces per line, positioned as Range.getClientRects would give them. */
  measureTextSpans(text: string, opts: TLMeasureTextSpanOpts): { text: string; box: BoxModel }[] {
    if (text === '') return []
    const truncate = opts.overflow === 'truncate-ellipsis' || opts.overflow === 'truncate-clip'
    const elementWidth = Math.ceil(opts.width - opts.padding * 2)
    const run = (width: number) =>
      layoutHtml(escapeHtml(normalizeText(text)).replace(/\n/g, '<br>'), {
        fontFamily: opts.fontFamily, fontSize: opts.fontSize, fontWeight: opts.fontWeight, fontStyle: opts.fontStyle,
        lineHeight: opts.lineHeight, maxWidth: width, minWidth: width,
        overflowWrap: truncate ? 'anywhere' : 'break-word', breakAll: truncate,
      })
    let layout = run(elementWidth)
    const align = ALIGN[opts.textAlign] ?? 'left'
    const toSpans = (l: Layout, width: number, onlyFirst: boolean) => {
      const spans: { text: string; box: BoxModel }[] = []
      const lines = onlyFirst ? l.lines.slice(0, 1) : l.lines
      for (const line of lines) {
        const shift = align === 'center' ? (width - line.width) / 2 : align === 'right' ? width - line.width : 0
        const font = line.pieces[0]?.font
        const m = font ? fontMetrics(font) : { ascent: opts.fontSize, descent: 0 }
        const h = m.ascent + m.descent
        const top = line.baseline - m.ascent
        // cut the line into runs of spaces / non-spaces, as measureElementTextNodeSpans does
        let x = line.left + shift
        for (const p of line.pieces) {
          const parts = p.text.match(/\s+|\S+/g) ?? []
          for (const part of parts) {
            const w = textWidth(p.font, part)
            const last = spans[spans.length - 1]
            const sp = /\s/.test(part)
            if (last && last.box.y === top && /\s/.test(last.text) === sp) {
              last.text += part
              last.box.w += w
            } else spans.push({ text: part, box: { x, y: top, w, h } })
            x += w
          }
        }
      }
      return spans
    }
    const didTruncate = truncate && layout.lines.length > 1
    if (opts.overflow === 'truncate-ellipsis' && didTruncate) {
      const font = layout.lines[0].pieces[0]?.font ?? resolveFont(opts.fontFamily, opts.fontWeight, opts.fontStyle, opts.fontSize)
      const ellipsisWidth = Math.ceil(textWidth(font, '…'))
      layout = run(elementWidth - ellipsisWidth)
      const spans = toSpans(layout, elementWidth - ellipsisWidth, true)
      const last = spans[spans.length - 1]
      if (!last) return spans
      spans.push({
        text: '…',
        box: { x: Math.min(last.box.x + last.box.w, opts.width - opts.padding - ellipsisWidth), y: last.box.y, w: ellipsisWidth, h: last.box.h },
      })
      return spans
    }
    return toSpans(layout, elementWidth, truncate)
  }

  measureElementTextNodeSpans(): never {
    throw new Error('measureElementTextNodeSpans needs a laid-out DOM element; not available in the board host')
  }

  dispose() {}
}

/** Replaces the editor's DOM text measuring with the canvas one. Call right after the editor is made. */
export function installCanvasMeasure(editor: Editor): CanvasTextManager {
  const old = editor.textMeasure as Any
  try { old.dispose?.() } catch { /* its measuring div is gone either way */ }
  const tm = new CanvasTextManager()
  ;(editor as Any).textMeasure = tm
  return tm
}
