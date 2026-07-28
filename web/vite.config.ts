import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Dev-mode proxy: the SPA runs on Vite's dev server while the API runs in the
// Express process (src/web/server.ts), so same-origin cookies work without CORS.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: `http://localhost:${process.env.WEB_PORT ?? '3001'}`,
        changeOrigin: true,
      },
    },
  },
})
