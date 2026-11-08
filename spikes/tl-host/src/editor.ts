// The tldraw Editor, built the same way in Node (board host) and in a page (the Chromium reference of dev/chromium).
// No React, no UI: the Editor class with tldraw's default shapes, bindings, tools and side effects, on a store of its own
// (or one given: a sync client's store). In Node the DOM comes from dom.ts and textMeasure is replaced (measure.ts).
import {
  Editor,
  createTLStore,
  defaultAddFontsFromNode,
  defaultBindingUtils,
  defaultShapeTools,
  defaultShapeUtils,
  defaultTools,
  registerDefaultSideEffects,
  tipTapDefaultExtensions,
} from 'tldraw'
import type { TLStore } from 'tldraw'

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
  return editor
}
