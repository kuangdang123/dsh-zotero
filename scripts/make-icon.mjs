#!/usr/bin/env node
/**
 * Renders `icon.png` (512×512, the raster twin of `icon.svg`) without any
 * dependency: shapes are rasterised at 4× and box-downsampled for anti-aliasing,
 * then written as a truecolour PNG through `node:zlib`.
 *
 * The plugin-market catalog only accepts raster icons (png/jpg/webp), while the
 * DSH display metadata uses the SVG; both must show the same artwork.
 *   npm run icon
 */
import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'icon.png')
const SIZE = 512
const SS = 4
const N = SIZE * SS
const UNIT = N / 24 // the SVG viewBox is 24×24

const px = new Uint8Array(N * N * 4) // premultiplied is unnecessary: we compose source-over

const hex = (value) => {
  const n = Number.parseInt(value.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

const RED = hex('#C94F4F')
const CREAM = hex('#F2E6D8')
const PAPER = hex('#FFF3F3')
const STICKY = hex('#F4C64F')
const FOLD = hex('#D9A62B')

/** Source-over one pixel with `coverage` in [0, 1]. */
function blend(x, y, [r, g, b], coverage) {
  if (coverage <= 0) return
  if (coverage > 1) coverage = 1
  const i = (y * N + x) * 4
  const a = coverage
  const dstA = px[i + 3] / 255
  const outA = a + dstA * (1 - a)
  if (outA === 0) return
  px[i] = Math.round((r * a + px[i] * dstA * (1 - a)) / outA)
  px[i + 1] = Math.round((g * a + px[i + 1] * dstA * (1 - a)) / outA)
  px[i + 2] = Math.round((b * a + px[i + 2] * dstA * (1 - a)) / outA)
  px[i + 3] = Math.round(outA * 255)
}

function roundedRect(x, y, w, h, radius, color) {
  const cx = (x + w / 2) * UNIT
  const cy = (y + h / 2) * UNIT
  const hw = (w / 2) * UNIT
  const hh = (h / 2) * UNIT
  const r = radius * UNIT
  for (let py = Math.max(0, Math.floor(cy - hh)); py < Math.min(N, Math.ceil(cy + hh)); py++) {
    for (let pxi = Math.max(0, Math.floor(cx - hw)); pxi < Math.min(N, Math.ceil(cx + hw)); pxi++) {
      const dx = Math.abs(pxi + 0.5 - cx) - (hw - r)
      const dy = Math.abs(py + 0.5 - cy) - (hh - r)
      const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) - r
      const inside = Math.min(Math.max(dx, dy), 0)
      if (outside + inside <= 0) blend(pxi, py, color, 1)
    }
  }
}

function capsule(x1, y1, x2, y2, width, color) {
  const ax = x1 * UNIT
  const ay = y1 * UNIT
  const bx = x2 * UNIT
  const by = y2 * UNIT
  const half = (width / 2) * UNIT
  const minX = Math.max(0, Math.floor(Math.min(ax, bx) - half - 1))
  const maxX = Math.min(N, Math.ceil(Math.max(ax, bx) + half + 1))
  const minY = Math.max(0, Math.floor(Math.min(ay, by) - half - 1))
  const maxY = Math.min(N, Math.ceil(Math.max(ay, by) + half + 1))
  const vx = bx - ax
  const vy = by - ay
  const len2 = vx * vx + vy * vy || 1
  for (let py = minY; py < maxY; py++) {
    for (let pxi = minX; pxi < maxX; pxi++) {
      const wx = pxi + 0.5 - ax
      const wy = py + 0.5 - ay
      const t = Math.min(1, Math.max(0, (wx * vx + wy * vy) / len2))
      const distance = Math.hypot(wx - vx * t, wy - vy * t)
      if (distance <= half) blend(pxi, py, color, 1)
    }
  }
}

function polygon(points, color) {
  const xs = points.map(([x]) => x * UNIT)
  const ys = points.map(([, y]) => y * UNIT)
  const minX = Math.max(0, Math.floor(Math.min(...xs)))
  const maxX = Math.min(N, Math.ceil(Math.max(...xs)))
  const minY = Math.max(0, Math.floor(Math.min(...ys)))
  const maxY = Math.min(N, Math.ceil(Math.max(...ys)))
  for (let py = minY; py < maxY; py++) {
    for (let pxi = minX; pxi < maxX; pxi++) {
      const x = pxi + 0.5
      const y = py + 0.5
      let inside = false
      for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        const xi = xs[i]
        const yi = ys[i]
        const xj = xs[j]
        const yj = ys[j]
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
      }
      if (inside) blend(pxi, py, color, 1)
    }
  }
}

// Same artwork as icon.svg: a red card behind, a cream card on top with ruled
// lines, and a folded yellow note on the lower right.
roundedRect(3.5, 3, 12, 18, 1.4, RED)
roundedRect(8.5, 3, 12, 18, 1.4, CREAM)
capsule(6.4, 6.6, 12.6, 6.6, 1.3, PAPER)
capsule(6.4, 9.2, 12.6, 9.2, 1.3, PAPER)
capsule(6.4, 11.8, 10.6, 11.8, 1.3, PAPER)
polygon([[11.6, 13.2], [18, 13.2], [18, 16.8], [14.8, 19.4], [11.6, 19.4]], STICKY)
polygon([[14.8, 16.8], [14.8, 19.4], [18, 16.8]], FOLD)

// Box-downsample the supersampled buffer.
const out = Buffer.alloc(SIZE * SIZE * 4)
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    let r = 0
    let g = 0
    let b = 0
    let a = 0
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const i = ((y * SS + sy) * N + (x * SS + sx)) * 4
        const alpha = px[i + 3] / 255
        r += px[i] * alpha
        g += px[i + 1] * alpha
        b += px[i + 2] * alpha
        a += alpha
      }
    }
    const i = (y * SIZE + x) * 4
    const n = SS * SS
    out[i + 3] = Math.round((a / n) * 255)
    if (a > 0) {
      out[i] = Math.round(r / a)
      out[i + 1] = Math.round(g / a)
      out[i + 2] = Math.round(b / a)
    }
  }
}

// PNG container: signature, IHDR, IDAT (8-bit RGBA), IEND.
const chunk = (type, data) => {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4, 8), data])) >>> 0, 0)
  return Buffer.concat([head, data, crc])
}

const table = (() => {
  const values = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    values[i] = c >>> 0
  }
  return values
})()

function crc32(buffer) {
  let c = 0xffffffff
  for (const byte of buffer) c = table[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(SIZE, 0)
ihdr.writeUInt32BE(SIZE, 4)
ihdr[8] = 8 // bit depth
ihdr[9] = 6 // colour type RGBA
const scanlines = Buffer.alloc(SIZE * (SIZE * 4 + 1))
for (let y = 0; y < SIZE; y++) {
  scanlines[y * (SIZE * 4 + 1)] = 0 // filter: none
  out.copy(scanlines, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4)
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(scanlines, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
])
writeFileSync(OUT, png)
console.log(`wrote ${OUT} (${SIZE}×${SIZE}, ${png.length} bytes)`)