// Which DOM the page is made of: TLHOST_DOM=jsdom (default, dom.ts) | happy (dom-happy.ts) | linkedom (dom-linkedom.ts).
// Loaded dynamically so only the chosen DOM is imported (literal imports, so a bundler can follow them). Imports nothing
// else (dev/cost-dom.ts measures the DOM alone).
export async function loadDom(which = process.env.TLHOST_DOM ?? 'jsdom'): Promise<typeof import('./dom.ts')> {
  if (which === 'jsdom') return import('./dom.ts')
  if (which === 'happy') return import('./dom-happy.ts') as any
  if (which === 'linkedom') return import('./dom-linkedom.ts') as any
  throw new Error(`TLHOST_DOM: unknown DOM ${which}`)
}
