import { defineConfig } from 'vite'
import path from 'path'

// Mirrors the resolve aliases in apps/web/vite.config.js so tests can import
// app code that uses the @/ and @common/ path aliases.
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'apps/web/src'),
      '@common': path.resolve(import.meta.dirname, 'packages/common/src'),
    },
  },
  test: {
    // Console.log-style test scripts; no globals needed
    include: ['tests/**/*.test.js'],
  },
})
