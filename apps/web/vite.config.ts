import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    proxy: {
      '/api': 'http://localhost:3001',
      '/socket.io': {
        target: 'http://localhost:3001',
        ws: true,
        // Silence harmless ECONNRESET noise that fires whenever the browser
        // tears down a Socket.IO connection (HMR reload, StrictMode double-
        // mount, navigating away from Monitor). The socket reconnects on its
        // own — only real proxy errors should print.
        configure: (proxy) => {
          proxy.on('error', (err) => {
            const code = (err as NodeJS.ErrnoException).code
            if (code === 'ECONNRESET' || code === 'EPIPE') return
            // eslint-disable-next-line no-console
            console.error('[vite proxy]', err.message)
          })
        },
      },
    },
  },
})
