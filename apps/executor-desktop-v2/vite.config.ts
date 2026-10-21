import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * 生产产物注入 CSP（dev 不注入，避免挡住 Vite HMR 的内联脚本）。
 * 桌面端渲染层只加载本地资源：脚本/字体/连接一律同源，样式允许
 * 内联（Radix 定位依赖 element.style）。
 */
function cspPlugin(): Plugin {
  return {
    name: 'acf-csp',
    apply: 'build',
    transformIndexHtml(html) {
      const csp = [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "font-src 'self' data:",
        "connect-src 'self'",
        "object-src 'none'",
        "base-uri 'none'",
        "frame-src 'none'",
        "form-action 'none'",
      ].join('; ');
      return html.replace(
        '<head>',
        `<head>\n    <meta http-equiv="Content-Security-Policy" content="${csp}" />`,
      );
    },
  };
}

// V2 渲染层刻意与壳解耦：同一份产物既能跑在 Electron（Phase 1），
// 也能在 Phase 2 原样交给 Tauri 的 webview。
export default defineConfig({
  // 产物要被 Electron 以 file:// 加载：资源必须相对路径。
  base: './',
  plugins: [react(), tailwindcss(), cspPlugin()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5273,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
