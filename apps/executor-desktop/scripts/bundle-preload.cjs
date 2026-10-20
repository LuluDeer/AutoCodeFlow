#!/usr/bin/env node
// preload 自包含打包。
//
// 沙箱（webPreferences.sandbox: true）里的 preload 只拿到受限 require——
// 仅 electron / events / timers / url 可用，**相对路径 require 一律加载失败**
// （"module not found: ./xxx"）。tsc 的输出是逐文件 emit，preload 一旦出现
// `import { ... } from './bridge-args'` 就会编译成 require("./bridge-args")，
// 整个 preload 加载失败：contextBridge 没执行，渲染层的 window.electronAPI
// 是 undefined，Wizard 在 useEffect 里读 getConfig 直接抛错、被 ErrorBoundary
// 兜成错误页（CI desktop-e2e-smoke 全红即此形态，R102-A1 实证）。
//
// 所以生产构建必须把 preload（及其相对依赖）内联成单文件；electron 保持
// external，由沙箱注入。esbuild 已是本包 devDependency（agent-worker bundle
// 同源），产物确定。
'use strict';

const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const DESKTOP = path.resolve(__dirname, '..');
const ENTRY = path.join(DESKTOP, 'src', 'preload', 'index.ts');
const OUT_DIR = path.join(DESKTOP, 'dist', 'preload');
const OUT = path.join(OUT_DIR, 'index.js');

esbuild.buildSync({
  entryPoints: [ENTRY],
  outfile: OUT,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'es2020',
  external: ['electron'],
  sourcemap: true,
  logLevel: 'warning',
});

// tsc 会为 preload 目录下的其它模块单独 emit；打包后它们都是死文件
// （沙箱里也 require 不到），清掉避免造成"运行时还会做模块解析"的误判。
for (const name of fs.readdirSync(OUT_DIR)) {
  if (name === 'index.js' || name === 'index.js.map') continue;
  if (name.endsWith('.js') || name.endsWith('.js.map')) {
    fs.rmSync(path.join(OUT_DIR, name));
  }
}

// 不变量守卫：产物里不得再有相对 require。esbuild 正常打包不会留下它，
// 但这条判据让"改回 tsc 直出"或"配置漏了 bundle"在构建期就红，而不是
// 等到 e2e 里以白屏/错误边界的形式暴露。
const built = fs.readFileSync(OUT, 'utf8');
const relativeRequire = built.match(/require\(\s*["']\.\.?\//);
if (relativeRequire) {
  console.error(
    `[bundle-preload] 产物仍含相对 require（${relativeRequire[0]}）——沙箱 preload 无法加载`,
  );
  process.exit(1);
}
