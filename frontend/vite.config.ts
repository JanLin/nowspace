import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { readFileSync } from 'node:fs'

const host = process.env.TAURI_DEV_HOST;
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8'));

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    {
      // The deployed assets advertise their version so a running app can
      // detect that the server was updated and offer a restart.
      name: "emit-version-json",
      generateBundle() {
        this.emitFile({ type: "asset", fileName: "version.json", source: JSON.stringify({ version }) });
      },
    },
  ],
  define: {
    __APP_VERSION__: JSON.stringify(version),
    // Tauri builds bake in the sidecar address; plain web builds stay
    // same-origin (the backend serves the SPA itself).
    __API_BASE__: JSON.stringify(process.env.TAURI_ENV_PLATFORM ? "http://localhost:8000" : ""),
    __IS_TAURI__: JSON.stringify(!!process.env.TAURI_ENV_PLATFORM),
  },
  // prevent vite from obscuring rust errors
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
})
