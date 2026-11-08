// The reference board: one of each default shape the prototype uses (goal 3.2), made by one batch of operations.
// Used by the Node checks (A), by the picture comparison with Chromium (C) and by the cost measurements (E).
import { compressLegacySegments, createShapeId, toRichText } from 'tldraw'
import type { Editor, TLShapeId } from 'tldraw'

export interface BoardIds {
  note: TLShapeId
  note2: TLShapeId
  geo: TLShapeId
  ellipse: TLShapeId
  text: TLShapeId
  arrow: TLShapeId
  frame: TLShapeId
  inFrame: TLShapeId
  draw: TLShapeId
}

/** Creates the board in one transaction (one undo step, one sync push). Ids are fixed so both sides match. */
export function buildBoard(editor: Editor, offset = { x: 0, y: 0 }): BoardIds {
  const id = (s: string) => createShapeId(s + (offset.x || offset.y ? `_${offset.x}_${offset.y}` : ''))
  const ids: BoardIds = {
    note: id('note'), note2: id('note2'), geo: id('geo'), ellipse: id('ellipse'), text: id('text'),
    arrow: id('arrow'), frame: id('frame'), inFrame: id('inframe'), draw: id('draw'),
  }
  const { x, y } = offset
  editor.run(() => {
    editor.createShape({ id: ids.note, type: 'note', x: x + 0, y: y + 0, props: { color: 'yellow', richText: toRichText('Ship the board host\nand measure it') } })
    editor.createShape({ id: ids.note2, type: 'note', x: x + 240, y: y + 0, props: { color: 'light-green', richText: toRichText('A much longer sticky note text that has to shrink so that it still fits inside the square of the note') } })
    editor.createShape({ id: ids.geo, type: 'geo', x: x + 0, y: y + 280, props: { geo: 'rectangle', w: 200, h: 100, color: 'blue', fill: 'semi', richText: toRichText('API gateway with a label long enough to grow the shape') } })
    editor.createShape({ id: ids.ellipse, type: 'geo', x: x + 520, y: y + 280, props: { geo: 'ellipse', w: 180, h: 110, color: 'red', fill: 'solid', font: 'sans', richText: toRichText('Database') } })
    editor.createShape({ id: ids.arrow, type: 'arrow', x: x + 0, y: y + 0, props: { start: { x: x + 200, y: y + 330 }, end: { x: x + 520, y: y + 335 }, richText: toRichText('calls'), color: 'black' } })
    editor.createBindings([
      { type: 'arrow', fromId: ids.arrow, toId: ids.geo, props: { terminal: 'start', normalizedAnchor: { x: 0.5, y: 0.5 }, isExact: false, isPrecise: false, snap: 'none' } },
      { type: 'arrow', fromId: ids.arrow, toId: ids.ellipse, props: { terminal: 'end', normalizedAnchor: { x: 0.5, y: 0.5 }, isExact: false, isPrecise: false, snap: 'none' } },
    ] as any)
    editor.createShape({ id: ids.text, type: 'text', x: x + 0, y: y + 460, props: { size: 'l', font: 'sans', richText: toRichText('Free text: Žluťoučký кон 日本 🚀') } })
    editor.createShape({ id: ids.frame, type: 'frame', x: x + 520, y: y + 0, props: { w: 320, h: 220, name: 'Sprint 12' } })
    editor.createShape({ id: ids.inFrame, type: 'geo', parentId: ids.frame, x: 20, y: 40, props: { geo: 'diamond', w: 140, h: 120, color: 'violet', richText: toRichText('Inside') } })
    editor.createShape({
      id: ids.draw, type: 'draw', x: x + 300, y: y + 470,
      props: {
        color: 'green', size: 'm',
        segments: compressLegacySegments([{ type: 'free', points: Array.from({ length: 24 }, (_, i) => ({ x: i * 10, y: Math.sin(i / 3) * 30, z: 0.5 })) }]),
        isComplete: true,
      },
    } as any)
  })
  return ids
}
