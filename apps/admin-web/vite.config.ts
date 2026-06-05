import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import dotenv from 'dotenv';

dotenv.config();

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: [],
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.VITE_API_URL_INTERNAL || 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
  },
  define: {
    'process.env.VITE_API_URL_INTERNAL': JSON.stringify(process.env.VITE_API_URL_INTERNAL || 'http://localhost:3001'),
    'process.env.VITE_API_URL_EXTERNAL': JSON.stringify(process.env.VITE_API_URL_EXTERNAL || ''),
  },
});
