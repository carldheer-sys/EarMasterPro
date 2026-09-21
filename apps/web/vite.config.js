import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { createHash } from 'crypto'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import path from 'path'

/**
 * Stamps dist/web/sw.js with a build version derived from the emitted
 * index.html + catalog.json contents. Any app or catalog change produces a
 * new CACHE_NAME, so activating the new SW evicts all stale cached data.
 */
function swVersionStamp(outDir) {
  return {
    name: 'sw-version-stamp',
    apply: 'build',
    closeBundle() {
      const swPath = path.join(outDir, 'sw.js')
      const indexPath = path.join(outDir, 'index.html')
      const catalogPath = path.join(outDir, 'catalog', 'catalog.json')
      if (!existsSync(swPath)) return
      const hash = createHash('sha1')
      for (const p of [indexPath, catalogPath]) {
        if (existsSync(p)) hash.update(readFileSync(p))
      }
      const version = hash.digest('hex').slice(0, 12)
      writeFileSync(swPath, readFileSync(swPath, 'utf8').replaceAll('__SW_VERSION__', `b${version}`))
      console.log(`[sw] stamped cache version b${version}`)
    },
  }
}

export default defineConfig({
  root: __dirname,
  publicDir: path.resolve(__dirname, '../../public'),
  plugins: [react(), swVersionStamp(path.resolve(__dirname, '../../dist/web'))],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@common': path.resolve(__dirname, '../../packages/common/src'),
    },
  },
  build: {
    outDir: path.resolve(__dirname, '../../dist/web'),
    emptyOutDir: true,
  },
})
