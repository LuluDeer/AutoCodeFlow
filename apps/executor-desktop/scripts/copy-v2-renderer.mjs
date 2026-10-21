#!/usr/bin/env node
/**
 * 把 V2 构建产物复制到桌面端的正式加载位置：`dist/renderer-v2/`。
 *
 * 为什么不直接在 electron-builder 里引用 ../executor-desktop-v2/dist：
 * 打包器只收本包目录下的文件，且主进程的路径解析（window-manager）以
 * `dist/renderer-v2` 为锚点；复制一步让「构建 / 打包 / 运行时」三者同源。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, '../../executor-desktop-v2/dist');
const dest = path.resolve(here, '../dist/renderer-v2');

if (!fs.existsSync(path.join(src, 'index.html'))) {
  console.error('[copy-v2-renderer] missing V2 build. Run: (cd ../executor-desktop-v2 && npm run build)');
  process.exit(1);
}

fs.rmSync(dest, { recursive: true, force: true });
fs.cpSync(src, dest, { recursive: true });
console.log(`[copy-v2-renderer] ${src} -> ${dest}`);
