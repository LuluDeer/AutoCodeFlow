/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import dotenv from 'dotenv';

dotenv.config();

export default defineConfig({
  plugins: [react()],
  resolve: {
    // F-01：monaco-editor 0.53 的 package.json 无 main/exports（仅 module），
    // 显式补上 module 解析条件——vitest 会把 resolve.mainFields 重置为 []，
    // 不补齐则测试侧 "Failed to resolve import monaco-editor"。
    mainFields: ['module'],
  },
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
            // F-01：GlueEditor 通过 monaco-setup.ts 本地引入 monaco-editor 后，
            // 该 chunk 才真正生效。GlueEditor 仅被路由级 lazy 页面
            // （TaskFormPage/TaskDetailPage）引用，monaco 主包不进首屏 chunk。
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
    server: {
      deps: {
        // F-01：monaco-editor 0.53 的 package.json 无 main/exports（仅 module），
        // vitest 默认将 node_modules 交给 Node 解析会直接 "Cannot find module"；
        // inline 后改由 Vite 按 module 字段解析（GlueEditor 本地化 monaco 的
        // 测试侧配套，未 mock GlueEditor 的组件级测试因此能加载真实模块）。
        inline: ['monaco-editor'],
      },
    },
  },
} as Parameters<typeof defineConfig>[0]);
