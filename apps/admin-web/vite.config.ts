/// <reference types="vitest" />
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import dotenv from 'dotenv';
// F-30（DEEP_REVIEW 0ef3bbe）：首帧主题脚本的单一来源。
import { THEME_INIT_SCRIPT } from './src/theme/tokens.ts';

dotenv.config();

/**
 * F-30（DEEP_REVIEW 0ef3bbe）：index.html 曾内联一份手写的首帧主题脚本，与
 * src/theme/tokens.ts 的 THEME_INIT_SCRIPT 构成双事实源（改一处漏一处即 FOUC
 * 回归）。现收敛为单一来源：脚本正文只存在于 tokens.ts，构建/开发期由本插件
 * 注入 <head> 末尾（injectTo:'head'，与原先内联位置等价——DOM 解析前执行）。
 */
export function themeInitPlugin(): Plugin {
  return {
    name: 'autoflow-theme-init',
    transformIndexHtml() {
      return [{ tag: 'script', children: THEME_INIT_SCRIPT, injectTo: 'head' }];
    },
  };
}

export default defineConfig({
  plugins: [react(), themeInitPlugin()],
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
  // F-31（DEEP_REVIEW 0ef3bbe）：原 define 块把 process.env.VITE_API_URL_* 注入代码，但
  // 全仓消费方一律走 import.meta.env.VITE_API_URL_*（client.ts:5-6 等），该 define 无任何
  // 消费方，属死配置，已删除（.env 经 Vite 自动暴露给 import.meta.env 即可）。
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: [],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['e2e/**', '**/e2e/**', '**/*.e2e.{ts,tsx,js,cjs}'],
    // DEEP_REVIEW 轮7 验证发现（2026-09-14）：本套件为 jsdom + antd 重型页面，
    // 83 文件全量跑时单文件 transform/import 累计达数百秒，首个渲染用例实测
    // 0.3~2s（空闲）→ 并发下 >5s，vitest 默认 5s 上限会产出**超时假红**
    // （同一 HEAD 实测：空闲 2 红 / 中等负载 14 红 / 高负载 31 红，全部为
    // Exceeded timeout 而非断言失败；抬至 30s 后 83/83、725/725 全绿）。
    // 故显式给足预算；真正挂死的用例仍会在 30s 处失败，不会静默。
    testTimeout: 30_000,
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
