/* eslint-disable no-undef */
// Copies the self-hosted Instrument Sans files (SIL OFL-1.1) out of the
// @fontsource-variable package into public/fonts, so the app serves one
// deliberate face from its own origin — no third-party requests at runtime.
// Run with Node after bumping the package: node scripts/copy-font.mjs
import { copyFileSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const source = join('node_modules', '@fontsource-variable', 'instrument-sans')
const target = join('public', 'fonts')
mkdirSync(target, { recursive: true })

// The wght-only variable files: one 400-700 file per subset. The latin-ext
// file is only fetched when a page actually contains those characters, so it
// costs nothing for an English session.
const files = [
  ['files/instrument-sans-latin-wght-normal.woff2', 'instrument-sans-latin-wght.woff2'],
  ['files/instrument-sans-latin-ext-wght-normal.woff2', 'instrument-sans-latin-ext-wght.woff2'],
  ['LICENSE', 'instrument-sans-OFL.txt'],
]

for (const [from, to] of files) {
  const destination = join(target, to)
  copyFileSync(join(source, from), destination)
  console.log(`wrote ${destination} (${statSync(destination).size} bytes)`)
}
