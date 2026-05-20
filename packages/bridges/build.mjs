import * as esbuild from 'esbuild'
import { mkdir } from 'node:fs/promises'

const minify = process.env.NODE_ENV === 'production'

await mkdir('dist', { recursive: true })

await esbuild.build({
  entryPoints: ['src/vendor-entry.js'],
  outfile: 'dist/vendor.js',
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['es2020'],
  sourcemap: !minify,
  minify,
  external: ['@spacedevin/juke-cards'],
})

console.log('built dist/vendor.js', minify ? '(minified)' : '')
