/// <reference types="vitest" />
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { gzipSync, brotliCompressSync, constants as zlibConstants } from 'node:zlib';
import { readdir, readFile, writeFile, stat } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
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

// 网络性能审计（2026-09-18）：构建产物预压缩 .gz/.br，nginx gzip_static 直接
// 发送预压缩文件，免去实时压缩 CPU 并支持 brotli。
// 实现选型：不引 vite-plugin-compression——0.5.1 用模块级共享 mtimeCache，同一
// 构建里注册 gzip+brotli 两个实例时第二个实例会跳过全部文件（实测 0 个 .br）；
// 且 O-21 本就不赞成为此引入新依赖。这里用零依赖内联插件，一次遍历产出两
// 种格式，行为确定（best 压缩级别、>=1024B 才压缩，与 nginx gzip_min_length
// 对齐；worker 产物 .wasm 一并覆盖）。
const ASSET_COMPRESS_EXT_RE = /\.(js|css|html|json|svg|xml|ico|txt|wasm|mjs)$/;
const ASSET_COMPRESS_MIN_BYTES = 1024;

function precompressAssetsPlugin(): Plugin {
  let outDir = 'dist';
  return {
    name: 'precompress-assets',
    apply: 'build',
    enforce: 'post',
    configResolved(config) {
      outDir = isAbsolute(config.build.outDir)
        ? config.build.outDir
        : join(config.root, config.build.outDir);
    },
    async closeBundle() {
      const files: string[] = [];
      const walk = async (dir: string): Promise<void> => {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          const p = join(dir, entry.name);
          if (entry.isDirectory()) await walk(p);
          else if (ASSET_COMPRESS_EXT_RE.test(entry.name)) files.push(p);
        }
      };
      await walk(outDir);
      for (const file of files) {
        try {
          const { size } = await stat(file);
          if (size < ASSET_COMPRESS_MIN_BYTES) continue;
          const content = await readFile(file);
          const gz = gzipSync(content, { level: zlibConstants.Z_BEST_COMPRESSION });
          await writeFile(`${file}.gz`, gz);
          const br = brotliCompressSync(content, {
            params: {
              [zlibConstants.BROTLI_PARAM_QUALITY]: zlibConstants.BROTLI_MAX_QUALITY,
              [zlibConstants.BROTLI_PARAM_MODE]: zlibConstants.BROTLI_MODE_TEXT,
            },
          });
          await writeFile(`${file}.br`, br);
        } catch (err) {
          console.error(`[precompress-assets] failed on ${file}:`, err);
        }
      }
    },
  };
}

export default defineConfig({
  plugins: [
    react(),
    themeInitPlugin(),
    precompressAssetsPlugin(),
  ],
  resolve: {
    // F-01：monaco-editor 0.53 的 package.json 无 main/exports（仅 module），
    // 显式补上 module 解析条件——vitest 会把 resolve.mainFields 重置为 []，
    // 不补齐则测试侧 "Failed to resolve import monaco-editor"。
    mainFields: ['module'],
    // 部署修复（BT/宝塔生产构建）：axios 1.20 的 browser 条件指向源码入口
    // index.js，依赖顶层 browser 字段的逐文件映射剥离 Node 适配器；Vite 8
    // (rolldown) 未应用该映射，form-data→combined-stream 进了浏览器包并在
    // 模块初始化期调 util.inherits → "r.inherits is not a function" 白屏。
    // 别名用绝对路径强制指向官方纯浏览器 ESM 预打包产物（无任何 Node 依赖，
    // 命名导出齐全）；不能用包子路径写法——axios exports 白名单不含该子路径。
    alias: {
      axios: fileURLToPath(
        new URL('./node_modules/axios/dist/esm/axios.js', import.meta.url),
      ),
    },
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
    // O-17（生产排障回溯）：产出 sourcemap 但不注入到 bundle（'hidden'）——
    // 浏览器不自动加载，Sentry/排障侧按 URL 拉取对应 .map；比 'sourcemap'
    // 更省首屏（不内嵌 sourceMappingURL）。
    // 网络性能审计（2026-09-18）：预压缩在构建期生成 .gz/.br（上方
    // viteCompression 插件），nginx gzip_static 直接发送预压缩文件，相对
    // O-21 的"仅运行时 gzip"省去实时压缩 CPU 并支持 brotli。
    sourcemap: 'hidden',
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
    // O-2：waitFor 默认预算统一（vi.waitFor 包装 10s + testing-library
    // asyncUtilTimeout 10s），详见 src/test-setup.ts 头注。
    setupFiles: ['src/test-setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['e2e/**', '**/e2e/**', '**/*.e2e.{ts,tsx,js,cjs}'],
    // R12-fix（admin-web-build 间歇性 Unhandled ReferenceError: window is
    // not defined）：coverage 仪器化 + 默认 threads 池下，worker 内多文件
    // 共享 jsdom 环境，环境 teardown 的异步残留会在下一文件 import 期访问
    // 已销毁的 window（第二轮/四轮/七轮同模式偶发，ui09 顶层桩修复后仍
    // 有其他文件命中）。forks 池每个测试文件独立子进程、环境彻底隔离，
    // 是 vitest 对『环境切换竞态 / teardown 残留』的标准解法；Linux CI
    // 与本地均支持，仅进程启动略增（可忽略，测试本身占大头）。
    pool: 'forks',
    // DEEP_REVIEW 轮7 验证发现（2026-09-14）：本套件为 jsdom + antd 重型页面，
    // 83 文件全量跑时单文件 transform/import 累计达数百秒，首个渲染用例实测
    // 0.3~2s（空闲）→ 并发下 >5s，vitest 默认 5s 上限会产出**超时假红**
    // （同一 HEAD 实测：空闲 2 红 / 中等负载 14 红 / 高负载 31 红，全部为
    // Exceeded timeout 而非断言失败；抬至 30s 后 83/83、725/725 全绿）。
    // O-2（测试体系审计，2026-09-18）复核：带 coverage 仪器化重跑 95 文件时，
    // 6 个重型页面文件的 9 个用例在**各自 15s 硬编码预算**下仍超时
    // （task-list-deep/task-template-prefill，见 task-template-prefill.test.tsx
    // 的 `}, 15_000)`），transform 累计 1531s——全局预算降到 10s 只会把更多
    // 用例推入假红。根因是 transform/import 慢而非用例本身慢；预算机制已按
    // 审计建议走「全局给足 + 重型用例 vitest.test(name, fn, N) 显式放宽」，
    // 全局 30s 保留（唯一有实测证据的全绿值），后续应从 poolOptions/transform
    // 侧治本（如 worker 数调优），而非继续压低全局预算。
    testTimeout: 30_000,
    // L-1（测试体系审计）：此前 870+ 用例在 CI 只跑不测覆盖率，无水位门控。
    // 加 v8 覆盖率收集（provider 包 @vitest/coverage-v8 已入 devDependencies）。
    // 阈值为 2026-09-18 实测水位地板：全量 871 例全绿下 stmts 75.9 / branches
    // 72.32 / funcs 66.81 / lines 77.58（排除 0% 的生成类型桩），留 ~3-4pt
    // 余量防首跑即红；覆盖率抬升后应同步上调。
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json'],
      reportsDirectory: 'coverage',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.{test,spec}.{ts,tsx}', 'src/e2e/**', 'src/main.tsx', 'src/types/generated/**'],
      thresholds: {
        statements: 72,
        branches: 68,
        functions: 62,
        lines: 74,
      },
    },
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
