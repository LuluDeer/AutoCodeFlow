/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import dotenv from 'dotenv';

dotenv.config();

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: Number(process.env.VITE_PORT || 5176),
    proxy: {
      '/api': {
        target: 'http://localhost:3105',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          // Split large vendor libraries into separate chunks
          const chunks: Array<[string, string[]]> = [
            ['vendor-react', ['react', 'react-dom', 'react-router-dom']],
            // Keep route-heavy UI libraries out of forced vendor chunks so lazy pages
            // can share only the pieces they actually import.
            ['vendor-charts', ['recharts']],
            ['vendor-monaco', ['@monaco-editor/react', 'monaco-editor']],
            ['vendor-query', ['@tanstack/react-query', 'ahooks']],
            ['vendor-utils', ['axios', 'dayjs']],
          ];

          for (const [name, packages] of chunks) {
            if (packages.some((pkg) => id.includes(`/node_modules/${pkg}/`))) {
              return name;
            }
          }
        },
      },
    },
  },
  define: {
    'process.env.VITE_API_URL_INTERNAL': JSON.stringify(process.env.VITE_API_URL_INTERNAL || 'http://localhost:3105'),
    'process.env.VITE_API_URL_EXTERNAL': JSON.stringify(process.env.VITE_API_URL_EXTERNAL || ''),
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: [],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['e2e/**', '**/e2e/**', '**/*.e2e.{ts,tsx,js,cjs}'],
  },
} as any);
