// dom.ts on happy-dom instead of jsdom (risk 8.8 spike: a lighter DOM). Same Page interface; pick with TLHOST_DOM=happy.
import { Window } from 'happy-dom'
import { GLOBALS } from './dom-globals.ts'
import { blankIframeDocuments, copyGlobals, installCommonShims, makePage } from './dom-shims.ts'
import type { Page } from './dom-shims.ts'

type Any = any
export type { Page }
let page: Page | null = null

export function installPage(): Page {
  if (page) return page
  const w = new Window({
    url: 'http://localhost/',
    settings: {
      disableJavaScriptEvaluation: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true,
      disableIframePageLoading: true, disableComputedStyleRendering: true,
    } as Any,
  }) as Any
  w.document.write('<!doctype html><html><head></head><body></body></html>')
  // An <iframe> without src has no contentDocument in happy-dom (tldraw's StyleEmbedder needs one).
  blankIframeDocuments(w)
  copyGlobals(w, GLOBALS)
  installCommonShims(w)
  page = makePage(w)
  return page
}
