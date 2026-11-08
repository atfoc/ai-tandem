// The page tldraw runs on in the board host's process: a DOM on the global object, installed before any tldraw module is
// evaluated (src/node/install-page.ts is the first import of src/bin.ts), shared by every editor of the process.
//
// linkedom by default (decision O4: ~55 MB and ~150 ms less than jsdom, identical results in the spike); jsdom when
// AIWB_BOARDHOST_DOM=jsdom. jsdom is required only inside dom-jsdom.ts's installPage, so it is never loaded unless chosen.
// Installing is synchronous and idempotent.
import { installPage as installJsdom } from './dom-jsdom.ts'
import { installPage as installLinkedom } from './dom-linkedom.ts'
import type { Page } from './dom-shims.ts'

export type { Page }
export type DomKind = 'linkedom' | 'jsdom'

let installed: { page: Page; dom: DomKind } | null = null

/** Which DOM AIWB_BOARDHOST_DOM asks for (linkedom when unset or empty). */
export function chosenDom(env: Record<string, string | undefined> = process.env): DomKind {
  const v = (env.AIWB_BOARDHOST_DOM ?? '').trim().toLowerCase()
  if (v === '' || v === 'linkedom') return 'linkedom'
  if (v === 'jsdom') return 'jsdom'
  throw new Error(`AIWB_BOARDHOST_DOM: unknown DOM "${v}" (linkedom or jsdom)`)
}

/** Installs the page (the DOM AIWB_BOARDHOST_DOM picks) on the global object. Synchronous, idempotent: a second call returns
 *  the first page whatever the environment says by then. */
export function installPage(): { page: Page; dom: DomKind } {
  if (installed) return installed
  const dom = chosenDom()
  unrefBroadcastChannels()
  const page = dom === 'jsdom' ? installJsdom() : installLinkedom()
  installed = { page, dom }
  return installed
}

/** The installed page, or null before installPage. */
export function currentPage(): { page: Page; dom: DomKind } | null {
  return installed
}

/** tldraw opens a BroadcastChannel ("tldraw-user-sync") when its TLUserPreferences module is evaluated; in Node that channel
 *  keeps the process alive for ever. Headless there is no other tab to sync preferences with: channels made after this are
 *  unref'd so they never hold the process (a test file ends when its tests end, the process when its work ends). */
function unrefBroadcastChannels() {
  const g = globalThis as any
  const BC = g.BroadcastChannel
  if (!BC || BC.__aiwbUnref) return
  class UnrefBroadcastChannel extends BC {
    static __aiwbUnref = true
    constructor(name: string) {
      super(name)
      ;(this as any).unref?.()
    }
  }
  g.BroadcastChannel = UnrefBroadcastChannel
}
