// Pictures without a browser (goal 4.9, question C): tldraw's own SVG export, run on the jsdom page, made self-contained
// for a rasterizer that has no HTML layout, then rasterized to PNG.
//
// 1. editor.getSvgElement(ids, opts) renders tldraw's export components with react-dom into the jsdom document, exactly as
//    in a window. Shapes come out as SVG paths, except text: every rich-text label is a <foreignObject> holding HTML (no
//    SVG rasterizer outside a browser lays out HTML), and frame headings are SVG <text> with explicit positions.
// 2. textToPaths() replaces each of those with the glyph outlines (skia-canvas outlineText) of the lines measure.ts lays
//    out: the same fonts, the same line breaks, the same positions the measurement promised. Colour emoji have no
//    outlines; they become small PNG <image>s drawn by skia-canvas. tldraw's text outline (text-shadow of the background
//    colour, ±1 px in six directions) becomes six offset copies of the outline under it.
// 3. The result has no text and no HTML left; resvg rasterizes it (decision O4; the spike's skia-canvas rasterizer path is
//    removed: it drops the emoji images and is 6× slower).
//
// Lifted from spikes/tl-host/src/export.ts; textToPaths and the conversion are unchanged.
import { Resvg } from '@resvg/resvg-js'
import { Canvas } from 'skia-canvas'
import type { Editor, TLShapeId } from 'tldraw'
import { resolveFont } from './fonts.ts'
import { fontMetrics, layoutHtml, textWidth } from './measure.ts'
import type { Layout, LinePiece } from './measure.ts'

type Any = any
const SVG_NS = 'http://www.w3.org/2000/svg'

export interface ExportOptions {
  /** Around the shapes, in page px (default 32, as the spike and the Chromium reference). */
  padding?: number
  /** true (default): tldraw's background colour; false: transparent; a CSS colour: that colour instead of tldraw's. */
  background?: boolean | string
  /** Output pixels per page px (PNG only; default 1). */
  scale?: number
  /** tldraw's getSvgElement `bounds` (a Box): the part of the page to export. */
  bounds?: Any
  darkMode?: boolean
}

// ------------------------------------------------------------------------------------------- outlines from skia

const outlineCtx = new Canvas(16, 16).getContext('2d') as Any
const outlineCache = new Map<string, string>()

function outline(fontNative: string, text: string): string {
  const key = fontNative + '\u0000' + text
  let d = outlineCache.get(key)
  if (d === undefined) {
    outlineCtx.font = fontNative
    d = (outlineCtx.outlineText(text).d as string) || ''
    if (outlineCache.size > 20_000) outlineCache.clear()
    outlineCache.set(key, d)
  }
  return d
}

const EMOJI = /\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const emojiCache = new Map<string, { href: string; w: number; h: number; ascent: number }>()

/** A colour emoji cluster drawn by skia-canvas (the system's emoji font), as a PNG data URL at 2x. */
function emojiImage(fontNative: string, cluster: string) {
  const key = fontNative + '\u0000' + cluster
  let e = emojiCache.get(key)
  if (!e) {
    outlineCtx.font = fontNative
    const m = outlineCtx.measureText(cluster)
    const ascent = Math.ceil(m.actualBoundingBoxAscent) + 1
    const h = ascent + Math.ceil(m.actualBoundingBoxDescent) + 1
    const w = Math.ceil(m.width) + 1
    const s = 2
    const c = new Canvas(w * s, h * s)
    const x = c.getContext('2d') as Any
    x.scale(s, s)
    x.font = fontNative
    x.fillText(cluster, 0, ascent)
    e = { href: 'data:image/png;base64,' + (c.toBufferSync('png') as Buffer).toString('base64'), w, h, ascent }
    emojiCache.set(key, e)
  }
  return e
}

// --------------------------------------------------------------------------------------------- css helpers

function styleOf(el: Element | null): Record<string, string> {
  const out: Record<string, string> = {}
  const s = el?.getAttribute('style') ?? ''
  // split on ; outside parentheses and quotes
  let depth = 0, q = '', cur = ''
  const parts: string[] = []
  for (const ch of s) {
    if (q) { if (ch === q) q = ''; cur += ch; continue }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue }
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ';' && depth === 0) { parts.push(cur); cur = ''; continue }
    cur += ch
  }
  parts.push(cur)
  for (const p of parts) {
    const i = p.indexOf(':')
    if (i > 0) out[p.slice(0, i).trim().toLowerCase()] = p.slice(i + 1).trim()
  }
  if (out['font']) expandFont(out)
  return out
}

/** `font: [style] [variant] [weight] size[/line-height] family` → longhands (happy-dom serializes the shorthand when every
 *  font longhand is set; jsdom never does). Longhands written after it are kept. */
function expandFont(out: Record<string, string>) {
  const m = /^((?:(?:italic|oblique|normal|small-caps|bold|bolder|lighter|\d{3})\s+)*)([\d.]+px)(?:\s*\/\s*([\d.]+(?:px)?|normal))?\s+(.+)$/.exec(out['font'])
  if (!m) return
  const pre = m[1].trim().split(/\s+/).filter(Boolean)
  out['font-style'] ??= pre.find((t) => t === 'italic' || t === 'oblique') ?? 'normal'
  out['font-weight'] ??= pre.find((t) => /^(bold|bolder|lighter|\d{3})$/.test(t)) ?? 'normal'
  out['font-size'] ??= m[2]
  if (m[3] && m[3] !== 'normal') out['line-height'] ??= m[3]
  out['font-family'] ??= m[4]
}

const px = (v: string | undefined, d = 0) => (v ? parseFloat(v) : d)
const num = (el: Element, a: string, d = 0) => { const v = el.getAttribute(a); return v == null ? d : parseFloat(v) }

// ------------------------------------------------------------------------------------------- the conversion

interface Ctx { doc: Document; background: string; uid: () => string }

function el(doc: Document, tag: string, attrs: Record<string, string | number>): Element {
  const e = doc.createElementNS(SVG_NS, tag)
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v))
  return e
}

/** Draws one laid-out piece of text at (x, baseline): outline path + emoji images. */
function drawPiece(c: Ctx, g: Element, piece: { text: string; font: { native: string } }, x: number, baseline: number, fill: string, outlineColor: string | null) {
  const d = outline(piece.font.native, piece.text)
  if (d) {
    if (outlineColor) {
      const id = c.uid()
      const p = el(c.doc, 'path', { id, d, transform: `translate(${x} ${baseline})`, fill: outlineColor })
      const defs = el(c.doc, 'g', {})
      for (const [dx, dy] of [[0, -1], [0, 1], [-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        defs.appendChild(el(c.doc, 'path', { d, transform: `translate(${x + dx} ${baseline + dy})`, fill: outlineColor }))
      }
      void p
      g.appendChild(defs)
    }
    g.appendChild(el(c.doc, 'path', { d, transform: `translate(${x} ${baseline})`, fill }))
  }
  if (EMOJI.test(piece.text)) {
    let off = 0
    for (const { segment } of graphemes.segment(piece.text)) {
      if (EMOJI.test(segment) && !/^[#*0-9©®]$/.test(segment)) {
        const e = emojiImage(piece.font.native, segment)
        const prefix = piece.text.slice(0, piece.text.indexOf(segment, off))
        const ex = x + textWidth(piece.font as Any, prefix)
        g.appendChild(el(c.doc, 'image', { href: e.href, x: ex, y: baseline - e.ascent, width: e.w, height: e.h }))
      }
      off += segment.length
    }
  }
}

/** A tldraw rich-text <foreignObject> → a <g> of outlines, laid out as the HTML would be in a browser. */
function convertForeignObject(c: Ctx, fo: Element): Element {
  const x = num(fo, 'x'), y = num(fo, 'y'), w = num(fo, 'width'), h = num(fo, 'height')
  const outer = fo.firstElementChild as Element | null
  const inner = outer?.firstElementChild as Element | null
  const g = el(c.doc, 'g', {})
  if (!outer || !inner) return g
  const os = styleOf(outer), is = styleOf(inner)
  const padding = px(os['padding'])
  const fontFamily = (is['font-family'] ?? os['font-family'] ?? "'tldraw_draw', sans-serif").replace(/&quot;/g, '"')
  const fontSize = px(is['font-size'], 16)
  const lineHeightPx = px(is['line-height'], Math.round(fontSize * 1.35))
  const fill = is['color'] ?? 'rgb(0, 0, 0)'
  const align = is['text-align'] ?? 'start'
  const outlined = (is['text-shadow'] ?? 'none') !== 'none' && fo.classList.contains('tl-text__outline')
  const contentW = Math.max(0, w - padding * 2)
  const layout: Layout = layoutHtml(inner.innerHTML, {
    fontFamily, fontSize, fontWeight: is['font-weight'] ?? 'normal', fontStyle: is['font-style'] ?? 'normal',
    lineHeight: lineHeightPx / fontSize, maxWidth: contentW, minWidth: contentW,
    overflowWrap: is['overflow-wrap'] === 'normal' ? 'normal' : 'break-word',
  })
  const ai = os['align-items'] ?? 'center'
  const contentH = h - padding * 2
  const top = y + padding + (ai === 'flex-start' || ai === 'start' ? 0 : ai === 'flex-end' || ai === 'end' ? contentH - layout.h : (contentH - layout.h) / 2)
  for (const line of layout.lines) {
    const free = contentW - line.left - line.width
    const shift = align === 'center' ? free / 2 : align === 'right' || align === 'end' ? free : 0
    const lx = x + padding + line.left + shift
    const baseline = top + line.baseline
    for (const piece of line.pieces as LinePiece[]) {
      if (piece.run.mark) {
        const m = fontMetrics(piece.font)
        g.appendChild(el(c.doc, 'rect', { x: lx + piece.x, y: baseline - m.ascent, width: piece.w, height: m.ascent + m.descent, rx: 2, fill: '#fddd00' }))
      }
      drawPiece(c, g, piece, lx + piece.x, baseline, fill, outlined && !piece.run.mark ? c.background : null)
      if (piece.run.underline) {
        g.appendChild(el(c.doc, 'rect', { x: lx + piece.x, y: baseline + fontSize * 0.1, width: piece.w, height: Math.max(1, fontSize / 16), fill }))
      }
    }
    if (line.marker) {
      const f = line.pieces[0]?.font ?? resolveFont(fontFamily, 'normal', 'normal', fontSize)
      const mw = textWidth(f, line.marker + ' ')
      drawPiece(c, g, { text: line.marker, font: f }, x + padding + line.left - mw, baseline, fill, null)
    }
  }
  return g
}

/** An SVG <text> of tldraw's (frame headings: tspans with x/y, dominant-baseline mathematical) → outlines. */
function convertText(c: Ctx, text: Element): Element {
  const g = el(c.doc, 'g', {})
  const family = text.getAttribute('font-family') ?? 'sans-serif'
  const size = num(text, 'font-size', 16)
  const font = resolveFont(family, text.getAttribute('font-weight') ?? 'normal', text.getAttribute('font-style') ?? 'normal', size)
  let fill = text.getAttribute('fill')
  for (let p: Element | null = text.parentElement; !fill && p; p = p.parentElement) fill = p.getAttribute('fill')
  fill ??= '#000'
  // Blink: alignment-baseline mathematical shifts the baseline down by half the ascent (no MATH table)
  outlineCtx.font = font.native
  const ascent = outlineCtx.measureText('x').fontBoundingBoxAscent as number
  const mathematical = /mathematical/.test(text.getAttribute('dominant-baseline') ?? '') || /mathematical/.test(text.getAttribute('alignment-baseline') ?? '')
  const shift = mathematical ? ascent / 2 : 0
  const spans = text.querySelectorAll('tspan')
  const items = spans.length ? [...spans] : [text]
  for (const s of items) {
    const t = (s.textContent ?? '').replace(/​/g, '')
    if (!t.trim()) continue
    drawPiece(c, g, { text: t, font }, num(s, 'x', num(text, 'x')), num(s, 'y', num(text, 'y')) + shift, fill, null)
  }
  return g
}

/** Replaces every foreignObject label and every <text> of the SVG by outlines. Mutates and returns the element. */
export function textToPaths(svg: SVGSVGElement, background: string): SVGSVGElement {
  let n = 0
  const c: Ctx = { doc: svg.ownerDocument, background, uid: () => `tlh${n++}` }
  for (const fo of [...svg.querySelectorAll('foreignObject')]) fo.replaceWith(convertForeignObject(c, fo))
  for (const t of [...svg.querySelectorAll('text')]) t.replaceWith(convertText(c, t))
  // the embedded @font-face rules are not needed any more (and a rasterizer would ignore them)
  for (const s of [...svg.querySelectorAll('style')]) if (/@font-face/.test(s.textContent ?? '')) s.remove()
  return svg
}

function backgroundOf(svg: Element): string {
  const s = styleOf(svg)
  return s['background-color'] ?? 'rgb(249, 250, 251)'
}

export interface SvgResult {
  /** The SVG as XML, with no text and no HTML left. */
  svg: string
  /** Its size in page px (the export's bounds + padding). */
  width: number
  height: number
  /** The background colour painted under it, or null (transparent). */
  background: string | null
}

export interface PngResult {
  png: Buffer
  /** The PNG's size in pixels: floor(the SVG's size × scale), as tldraw's own export (pictureSize). */
  width: number
  height: number
  /** The SVG it was rasterized from. */
  svg: string
}

/** The PNG's size in pixels for an SVG of width × height page px at a scale: each side floor(side × scale), at least 1,
 *  as tldraw's own export (getSvgAsImage: Math.floor of the canvas size, the SVG drawn stretched onto it). */
export function pictureSize(width: number, height: number, scale: number): { width: number; height: number } {
  return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) }
}

/** The scale at which the long side of width × height page px is exactly `max` pixels by pictureSize: max / long, nudged up
 *  past floating-point error (2000 / L × L is 1999.999… for about one L in eight, which floor would make 1999). */
export function fitScale(width: number, height: number, max: number): number {
  const long = Math.max(width, height)
  let s = max / long
  while (Math.floor(long * s) < max) s = s * (1 + Number.EPSILON) + Number.MIN_VALUE
  return s
}

async function exportSvgElement(editor: Editor, ids: TLShapeId[] | undefined, opts: ExportOptions) {
  const shapes = ids ?? [...editor.getCurrentPageShapeIds()]
  const r = await editor.getSvgElement(shapes, { padding: opts.padding ?? 32, background: opts.background !== false, bounds: opts.bounds, darkMode: opts.darkMode })
  if (!r) return undefined
  // a colour asked for replaces tldraw's on the root (the text outlines take it too)
  if (typeof opts.background === 'string') (r.svg as Any).style.setProperty('background-color', opts.background)
  const svg = textToPaths(r.svg as SVGSVGElement, backgroundOf(r.svg))
  return { svg, width: r.width, height: r.height, background: opts.background === false ? null : backgroundOf(r.svg) }
}

const serialize = (svg: Element) => new (globalThis as Any).XMLSerializer().serializeToString(svg) as string

/** tldraw's SVG export, self-contained and without text elements. Undefined when there is nothing to export. */
export async function exportSvg(editor: Editor, ids?: TLShapeId[], opts: ExportOptions = {}): Promise<SvgResult | undefined> {
  const r = await exportSvgElement(editor, ids, opts)
  if (!r) return undefined
  return { svg: serialize(r.svg), width: r.width, height: r.height, background: r.background }
}

/** A PNG of the shapes (default: the whole page), as editor.toImage would make it in a window. Undefined when there is
 *  nothing to export. No cap on its size here: the caller (get_image) picks the scale (decision O4: 2000 px long side). */
export async function exportPng(editor: Editor, ids?: TLShapeId[], opts: ExportOptions = {}): Promise<PngResult | undefined> {
  const r = await exportSvgElement(editor, ids, opts)
  if (!r) return undefined
  const { width: w, height: h } = pictureSize(r.width, r.height, opts.scale ?? 1)
  // the root sized to the pixels, its viewBox stretched onto them (decision V2): resvg's fitTo would derive one side
  // from the other and round it up (a tall picture 1 px or more too high), tldraw's canvas floors both
  r.svg.setAttribute('width', String(w))
  r.svg.setAttribute('height', String(h))
  r.svg.setAttribute('preserveAspectRatio', 'none')
  const svg = serialize(r.svg)
  // the background is CSS on the root <svg> (a browser paints it, resvg does not)
  const resvg = new Resvg(svg, { fitTo: { mode: 'original' }, font: { loadSystemFonts: false }, shapeRendering: 2, imageRendering: 0, ...(r.background ? { background: r.background } : {}) })
  const img = resvg.render()
  if (img.width !== w || img.height !== h) throw new Error(`resvg drew ${img.width}×${img.height} px, not the ${w}×${h} asked for`)
  return { png: img.asPng(), width: w, height: h, svg }
}
