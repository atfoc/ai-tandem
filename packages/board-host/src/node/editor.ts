// The tldraw Editor, built the same way in Node (board host) and in a page (the Chromium reference of dev/chromium).
// No React, no UI: the Editor class with tldraw's default shapes, bindings, tools and side effects, on a store of its own
// (or one given: a sync client's store). In Node the DOM comes from page.ts and textMeasure is replaced (measure.ts).
// The shape and binding utils come from ../schema.ts (the board host's one schema). No Node-only import: a browser page may
// bundle this module.
import {
  DefaultColorStyle,
  DefaultDashStyle,
  DefaultFillStyle,
  DefaultFontStyle,
  Editor,
  createTLStore,
  defaultAddFontsFromNode,
  defaultShapeTools,
  defaultTools,
  registerDefaultSideEffects,
  tipTapDefaultExtensions,
} from 'tldraw'
import type { TLStore } from 'tldraw'
import { FillColorStyle } from '@aiwb/board-tl/model/styles.ts'
import { bindingUtils as defaultBindingUtils, shapeUtils as defaultShapeUtils } from '../schema.ts'

export interface EditorOptions {
  /** The element the editor lives in: a div in the page, or one of dom.ts's document. */
  container: HTMLElement
  /** A store made elsewhere (a sync client's). Default: a new store with the default schema. */
  store?: TLStore
  /** tldraw font name (`tldraw_sans_bold`…) → URL, for the SVG export's embedded @font-face (Node: file: URLs). */
  fontAssetUrls?: Record<string, string>
}

export function createStore(): TLStore {
  return createTLStore({ shapeUtils: defaultShapeUtils, bindingUtils: defaultBindingUtils })
}

export function createEditor({ container, store, fontAssetUrls }: EditorOptions): Editor {
  const editor = new Editor({
    store: store ?? createStore(),
    shapeUtils: defaultShapeUtils,
    bindingUtils: defaultBindingUtils,
    tools: [...defaultTools, ...defaultShapeTools],
    getContainer: () => container,
    fontAssetUrls,
    initialState: 'select',
    options: {
      text: { addFontsFromNode: defaultAddFontsFromNode, tipTapConfig: { extensions: tipTapDefaultExtensions } },
    },
  })
  registerDefaultSideEffects(editor)
  setNextStyles(editor)
  return editor
}

/** The styles of new elements, as the window sets them for people (packages/board-tl/src/view/Board.tsx `setNextStyles`): the
 *  sans font, solid lines, shapes filled white with a black border and black text. tldraw's createShapes fills every style prop
 *  an element is created without from these, so what an agent leaves out is what a person gets (design 7.1 "Sizes"). */
export function setNextStyles(editor: Editor) {
  editor.setStyleForNextShapes(DefaultFontStyle, 'sans')
  editor.setStyleForNextShapes(DefaultDashStyle, 'solid')
  editor.setStyleForNextShapes(DefaultFillStyle, 'fill')
  editor.setStyleForNextShapes(FillColorStyle, 'white')
  editor.setStyleForNextShapes(DefaultColorStyle, 'black')
}
