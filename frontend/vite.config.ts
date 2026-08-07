import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    'process.env.DRAGGABLE_DEBUG': 'false',
  },
  optimizeDeps: {
    rolldownOptions: {
      transform: {
        define: {
          'process.env.DRAGGABLE_DEBUG': 'false',
        },
      },
    },
  },
  server: {
    proxy: {
      '/api': 'http://localhost:8000',
      '/health': 'http://localhost:8000',
    },
  },
})
