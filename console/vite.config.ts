import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath, URL } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'

const configPath = path.resolve(__dirname, '..', 'config.json')
const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
const apiPort = config.ports?.sotagent_api ?? 4800
const consolePort = config.ports?.sotagent_console ?? 4805

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  base: './',
  preview: { allowedHosts: ["128gb.banteng-edmontosaurus.ts.net"] },
  server: {
    port: consolePort,
    strictPort: true,
    proxy: {
      '/api': `http://127.0.0.1:${apiPort}`,
    },
  },
})
