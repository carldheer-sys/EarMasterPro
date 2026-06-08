import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  root: path.resolve(__dirname, 'apps/desktop'),
  publicDir: path.resolve(__dirname, 'public'),
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'apps/desktop/src'),
      '@common': path.resolve(__dirname, 'packages/common/src'),
    },
  },
  build: {
    outDir: path.resolve(__dirname, 'dist/desktop'),
    emptyOutDir: true,
  },
})
