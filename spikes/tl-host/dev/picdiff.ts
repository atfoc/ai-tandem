// Compares two PNGs (goal 6.5): sizes, share of pixels whose largest channel difference is over a quarter (64), share over
// 1/16 (16), and a diff picture (red where strong, faint grey where weak). Usage: node dev/picdiff.ts a.png b.png [diff.png]
import { writeFileSync } from 'node:fs'
import { Canvas, loadImage } from 'skia-canvas'

export async function picdiff(a: string | Buffer, b: string | Buffer, out?: string) {
  const [ia, ib] = await Promise.all([loadImage(a as any), loadImage(b as any)])
  const w = Math.max(ia.width, ib.width), h = Math.max(ia.height, ib.height)
  const read = (img: any) => { const c = new Canvas(w, h); const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, w, h); x.drawImage(img, 0, 0); return x.getImageData(0, 0, w, h).data }
  const da = read(ia), db = read(ib)
  const c = new Canvas(w, h), x = c.getContext('2d'), img = x.createImageData(w, h)
  let strong = 0, weak = 0
  for (let i = 0; i < da.length; i += 4) {
    const d = Math.max(Math.abs(da[i] - db[i]), Math.abs(da[i + 1] - db[i + 1]), Math.abs(da[i + 2] - db[i + 2]))
    if (d > 64) strong++
    if (d > 16) weak++
    const g = 255 - Math.round((255 - (da[i] + da[i + 1] + da[i + 2]) / 3) * 0.15)
    img.data.set(d > 64 ? [230, 0, 0, 255] : d > 16 ? [255, 170, 0, 255] : [g, g, g, 255], i)
  }
  x.putImageData(img, 0, 0)
  if (out) writeFileSync(out, await c.toBuffer('png'))
  const n = w * h
  return { a: [ia.width, ia.height], b: [ib.width, ib.height], sameSize: ia.width === ib.width && ia.height === ib.height, strong: strong / n, weak: weak / n }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = await picdiff(process.argv[2], process.argv[3], process.argv[4])
  console.log(JSON.stringify({ ...r, strongPct: (r.strong * 100).toFixed(3) + '%', weakPct: (r.weak * 100).toFixed(3) + '%' }))
}
