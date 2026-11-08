// Which DOM the page is made of: TLHOST_DOM=jsdom (default, dom.ts) | happy (dom-happy.ts) | linkedom (dom-linkedom.ts).
// Loaded dynamically so only the chosen DOM is imported. Imports nothing else (dev/cost-dom.ts measures the DOM alone).
export async function loadDom(which = process.env.TLHOST_DOM ?? 'jsdom') {
  const mod = which === 'happy' ? './dom-happy.ts' : which === 'linkedom' ? './dom-linkedom.ts' : which === 'jsdom' ? './dom.ts' : null
  if (!mod) throw new Error(`TLHOST_DOM: unknown DOM ${which}`)
  return (await import(mod)) as typeof import('./dom.ts')
}
