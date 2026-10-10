/* eslint-disable no-undef */
// Generates the PWA icon as a PNG. Run with Node.
import { writeFileSync, mkdirSync } from 'node:fs'
import { deflateSync } from 'node:zlib'

const sizes = [192, 512]
mkdirSync('public/icons', { recursive: true })

function makeIcon(size) {
  const width = size
  const height = size
  const bg = [244, 240, 232] // paper
  const fg = [212, 105, 66] // accent
  const rows = []
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(width * 4)
    for (let x = 0; x < width; x++) {
      const radius = width * 0.22
      const inside = inRoundedRect(x + 0.5, y + 0.5, radius, width, height)
      const dx = x - width / 2
      const dy = y - height / 2
      const dotR = width * 0.12
      const inDot = dx * dx + dy * dy <= dotR * dotR
      const color = inDot ? fg : inside ? bg : [0, 0, 0, 0]
      const alpha = inside ? 255 : 0
      row[x * 4] = color[0]
      row[x * 4 + 1] = color[1]
      row[x * 4 + 2] = color[2]
      row[x * 4 + 3] = alpha
    }
    rows.push(row)
  }
  const png = encodePng(width, height, rows)
  writeFileSync(`public/icons/icon-${size}.png`, png)
  console.log(`wrote public/icons/icon-${size}.png`)
}

function inRoundedRect(x, y, r, w, h) {
  if (x < r && y < r) return (x - r) ** 2 + (y - r) ** 2 <= r * r
  if (x > w - r && y < r) return (x - (w - r)) ** 2 + (y - r) ** 2 <= r * r
  if (x < r && y > h - r) return (x - r) ** 2 + (y - (h - r)) ** 2 <= r * r
  if (x > w - r && y > h - r) return (x - (w - r)) ** 2 + (y - (h - r)) ** 2 <= r * r
  return x >= r && x <= w - r && y >= r && y <= h - r
}

// Minimal PNG encoder (no zlib dependency): uncompressed IDAT with filter 0 per row.
function encodePng(width, height, rows) {
  const raw = Buffer.alloc(height * (1 + width * 4))
  let offset = 0
  for (const row of rows) {
    raw[offset] = 0
    offset += 1
    row.copy(raw, offset)
    offset += row.length
  }
  const crcTable = makeCrcTable()
  const chunks = []
  chunks.push(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) // signature
  chunks.push(pngChunk('IHDR', Buffer.concat([
    u32(width), u32(height), Buffer.from([8, 6, 0, 0, 0]),
  ]), crcTable))
  chunks.push(pngChunk('IDAT', deflateSync(raw), crcTable))
  chunks.push(pngChunk('IEND', Buffer.alloc(0), crcTable))
  return Buffer.concat(chunks)
}

function pngChunk(type, data, crcTable) {
  const typeBuf = Buffer.from(type, 'ascii')
  const crc = crc32(Buffer.concat([typeBuf, data]), crcTable)
  return Buffer.concat([u32(data.length), typeBuf, data, u32(crc >>> 0)])
}

function u32(value) {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(value >>> 0)
  return b
}

function makeCrcTable() {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
}

function crc32(buf, table) {
  let c = 0xffffffff
  for (const byte of buf) c = table[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

sizes.forEach(makeIcon)
