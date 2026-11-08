// The text corpus and the operations run on it, the same in Node and in Chromium (dev/chromium). runCorpus returns
// { [caseId]: { ...numbers } }: what tldraw stores (note growY and fontSizeAdjustment, geo growY, text w) and what it
// measures (raw measureHtml, frame heading spans, arrow label sizes). dev/compare.ts diffs two results.
import {
  createShapeId,
  getArrowInfo,
  renderHtmlFromRichTextForMeasurement,
  toRichText,
} from 'tldraw'
import type { Editor, TLGeoShape, TLNoteShape, TLTextShape } from 'tldraw'

export const TEXTS: Record<string, string> = {
  short: 'Hi',
  word: 'Hello world',
  long: 'The quick brown fox jumps over the lazy dog and keeps running far beyond the edge of the shape it was put in',
  multi: 'Line one\nLine two\n\nLine four after an empty one',
  longword: 'Supercalifragilisticexpialidocious_and_more_without_any_spaces',
  accented: 'Žluťoučký kůň úpěl ďábelské ódy — façade naïve résumé Ærøskøbing',
  cyrillic: 'Съешь же ещё этих мягких французских булок, да выпей чаю. Ђурђевдан',
  cjk: '日本語のテキストと中文文本以及한국어 텍스트가 섞여 있습니다',
  emoji: 'Ship it 🚀🎉 👍🏽 👨‍👩‍👧 ✅ ❤️ done',
  mixed: 'API → DB (v2.1): 42% faster; e-mail@example.com https://example.com/a/b',
  spaces: '  two leading,   three inside, two trailing  ',
  hyphens: 'state-of-the-art well-known long-hyphenated-compound-words-everywhere',
  kerning: 'AV To Ty WA Yo LT P. F, AVAVAV',
}

export const FONTS = ['draw', 'sans', 'serif', 'mono'] as const
export const SIZES = ['s', 'm', 'l', 'xl'] as const

type Row = Record<string, number | string | null>
export type CorpusResult = Record<string, Row>

const r2 = (n: number) => Math.round(n * 1000) / 1000

/** Every case id, so a run can be limited to some (`only`): `kind:text:font:size[:extra]`. */
export function runCorpus(editor: Editor, opts: { only?: (id: string) => boolean } = {}): CorpusResult {
  const out: CorpusResult = {}
  const want = opts.only ?? (() => true)
  const page = editor.getCurrentPageId()
  const clear = () => {
    const ids = [...editor.getPageShapeIds(page)]
    if (ids.length) editor.deleteShapes(ids)
  }

  // 1. raw measureHtml, as the shapes call it (rich text html, tldraw font families, whole-pixel line height)
  const families: Record<string, string> = {
    draw: "'tldraw_draw', sans-serif",
    sans: "'tldraw_sans', sans-serif",
    serif: "'tldraw_serif', serif",
    mono: "'tldraw_mono', monospace",
  }
  for (const [tid, text] of Object.entries(TEXTS)) {
    const html = renderHtmlFromRichTextForMeasurement(editor, toRichText(text))
    for (const font of FONTS) {
      for (const fontSize of [12, 22, 36]) {
        for (const maxWidth of [null, 120]) {
          for (const owb of [false, true]) {
            if (owb && maxWidth === null) continue
            const id = `raw:${tid}:${font}:${fontSize}:${maxWidth ?? 'auto'}${owb ? ':nobreak' : ''}`
            if (!want(id)) continue
            const m = editor.textMeasure.measureHtml(html, {
              fontStyle: 'normal',
              fontWeight: 'normal',
              fontFamily: families[font],
              fontSize,
              lineHeight: 1.35,
              maxWidth,
              padding: '0px',
              disableOverflowWrapBreaking: owb,
              measureScrollWidth: true,
            })
            out[id] = { w: r2(m.w), h: r2(m.h), scrollWidth: r2(m.scrollWidth) }
          }
        }
      }
    }
  }

  // 2. shapes: what is stored after a create with text
  for (const [tid, text] of Object.entries(TEXTS)) {
    for (const font of FONTS) {
      for (const size of SIZES) {
        const base = `${tid}:${font}:${size}`
        const richText = toRichText(text)
        if (want(`note:${base}`)) {
          const id = createShapeId()
          editor.createShape({ id, type: 'note', x: 0, y: 0, props: { richText, font, size } })
          const s = editor.getShape<TLNoteShape>(id)!
          const b = editor.getShapePageBounds(id)!
          out[`note:${base}`] = { growY: r2(s.props.growY), fontSizeAdjustment: r2(s.props.fontSizeAdjustment ?? 1), w: r2(b.w), h: r2(b.h) }
        }
        if (want(`geo:${base}`)) {
          const id = createShapeId()
          editor.createShape({ id, type: 'geo', x: 0, y: 0, props: { geo: 'rectangle', w: 200, h: 100, richText, font, size } })
          const s = editor.getShape<TLGeoShape>(id)!
          out[`geo:${base}`] = { growY: r2(s.props.growY), h: r2(s.props.h), w: r2(s.props.w) }
        }
        if (want(`geoellipse:${base}`)) {
          const id = createShapeId()
          editor.createShape({ id, type: 'geo', x: 0, y: 0, props: { geo: 'ellipse', w: 160, h: 80, richText, font, size } })
          const s = editor.getShape<TLGeoShape>(id)!
          out[`geoellipse:${base}`] = { growY: r2(s.props.growY), h: r2(s.props.h), w: r2(s.props.w) }
        }
        if (want(`text:${base}`)) {
          const id = createShapeId()
          editor.createShape({ id, type: 'text', x: 0, y: 0, props: { richText, font, size, autoSize: true } })
          const s = editor.getShape<TLTextShape>(id)!
          const b = editor.getShapePageBounds(id)!
          out[`text:${base}`] = { w: r2(s.props.w), bw: r2(b.w), bh: r2(b.h) }
        }
        if (want(`textfixed:${base}`)) {
          const id = createShapeId()
          editor.createShape({ id, type: 'text', x: 0, y: 0, props: { richText, font, size, autoSize: false, w: 150 } })
          const b = editor.getShapePageBounds(id)!
          out[`textfixed:${base}`] = { bw: r2(b.w), bh: r2(b.h) }
        }
        clear()
      }
    }
  }

  // 3. what is measured but not stored: arrow labels between two shapes, frame headings
  for (const [tid, text] of Object.entries(TEXTS)) {
    if (want(`arrow:${tid}`)) {
      const a = createShapeId(), b = createShapeId(), arrow = createShapeId()
      editor.createShape({ id: a, type: 'geo', x: 0, y: 0, props: { w: 100, h: 100 } })
      editor.createShape({ id: b, type: 'geo', x: 500, y: 0, props: { w: 100, h: 100 } })
      editor.createShape({ id: arrow, type: 'arrow', x: 0, y: 0, props: { start: { x: 50, y: 50 }, end: { x: 550, y: 50 }, richText: toRichText(text) } })
      editor.createBindings([
        { type: 'arrow', fromId: arrow, toId: a, props: { terminal: 'start', normalizedAnchor: { x: 0.5, y: 0.5 }, isExact: false, isPrecise: false, snap: 'none' } },
        { type: 'arrow', fromId: arrow, toId: b, props: { terminal: 'end', normalizedAnchor: { x: 0.5, y: 0.5 }, isExact: false, isPrecise: false, snap: 'none' } },
      ] as any)
      const geom = editor.getShapeGeometry(arrow) as any
      const label = geom.children?.find((c: any) => c.isLabel)
      const info = getArrowInfo(editor, arrow)
      out[`arrow:${tid}`] = {
        labelW: label ? r2(label.bounds.w) : null,
        labelH: label ? r2(label.bounds.h) : null,
        startX: info ? r2(info.start.point.x) : null,
        endX: info ? r2(info.end.point.x) : null,
      }
      clear()
    }
    if (want(`frame:${tid}`)) {
      const f = createShapeId()
      editor.createShape({ id: f, type: 'frame', x: 0, y: 0, props: { w: 320, h: 200, name: text.split('\n')[0] } })
      const geom = editor.getShapeGeometry(f) as any
      const heading = geom.children?.find((c: any) => c.isLabel)
      out[`frame:${tid}`] = heading ? { headW: r2(heading.bounds.w), headH: r2(heading.bounds.h) } : { headW: null, headH: null }
      clear()
    }
  }
  return out
}
