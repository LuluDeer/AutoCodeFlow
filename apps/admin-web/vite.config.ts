/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import dotenv from 'dotenv';

dotenv.config();

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5176,
    proxy: {
      '/api': {
        target: (process.env.VITE_API_URL_INTERNAL || 'http://localhost:3002').replace(/\/api\/?$/, ''),
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    rollupOptions: {
      output: {
        manualChunks: {
          // Split large vendor libraries into separate chunks
          'vendor-react': ['react', 'react-dom', 'react-router-dom'],
          'vendor-antd': ['antd', '@ant-design/icons', '@ant-design/cssinjs'],
          'vendor-charts': ['recharts'],
          'vendor-monaco': ['@monaco-editor/react', 'monaco-editor'],
          'vendor-query': ['@tanstack/react-query', 'ahooks'],
          'vendor-utils': ['axios', 'dayjs'],
        },
      },
    },
  },
  define: {
    'process.env.VITE_API_URL_INTERNAL': JSON.stringify(process.env.VITE_API_URL_INTERNAL || 'http://localhost:3002'),
    'process.env.VITE_API_URL_EXTERNAL': JSON.stringify(process.env.VITE_API_URL_EXTERNAL || ''),
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: [],
  },
} as any);
