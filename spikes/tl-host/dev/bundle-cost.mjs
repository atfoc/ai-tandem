// Bundles dev/cost.ts as the board host would ship (one .mjs, no type stripping) with one DOM fixed at build time, so
// the others are not loaded. Usage: node dev/bundle-cost.mjs jsdom|happy|linkedom → out/cost-<dom>.mjs
import { build } from 'esbuild'
const dom = process.argv[2] ?? 'jsdom'
const file = { jsdom: 'dom.ts', happy: 'dom-happy.ts', linkedom: 'dom-linkedom.ts' }[dom]
const src = new URL('../src/', import.meta.url).pathname
await build({
  entryPoints: [new URL('cost.ts', import.meta.url).pathname], bundle: true, platform: 'node', format: 'esm',
  outfile: new URL(`../out/cost-${dom}.mjs`, import.meta.url).pathname, logLevel: 'warning',
  external: ['skia-canvas', '@resvg/resvg-js', 'jsdom', 'happy-dom', 'linkedom', 'linebreak'],
  banner: { js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" },
  plugins: [{ name: 'one-dom', setup(b) {
    b.onResolve({ filter: /dom-pick\.ts$/ }, () => ({ path: 'dom-pick', namespace: 'one-dom' }))
    b.onLoad({ filter: /.*/, namespace: 'one-dom' }, () => ({ contents: `export const loadDom = () => import(${JSON.stringify(src + file)})`, loader: 'js', resolveDir: src }))
  } }],
})
