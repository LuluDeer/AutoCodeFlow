/**
 * F-01（DEEP_REVIEW @0ef3bbe）：Monaco 语言服务 worker 本地化装配。
 *
 * 此前 @monaco-editor/react 未配置本地 monaco（默认从 jsdelivr CDN 动态加载），
 * 内网/离线部署下 Glue 编辑器永远停在 loading。GlueEditor 侧通过
 * `loader.config({ monaco })` 注入本地 monaco 实例后，monaco 的语言服务仍需要
 * Web Worker（MonacoEnvironment 缺失会在控制台报错并降级功能），故在此统一装配。
 *
 * worker 加载采用 Vite 官方 `?worker` 后缀导入：Vite 会把 worker 入口连同其
 * 相对依赖打包成自包含的 hash 资产（dist/assets/editor.worker-*.js）。
 * 不用裸 `new URL('monaco-editor/...worker.js', import.meta.url)`：该模式对
 * node_modules 裸说明符只会按原始资源原样拷贝，worker 内部的相对 import 在
 * dist 中会 404。
 *
 * 网络性能审计（2026-09-18）：
 *  - 主包从 `monaco-editor`（index = editor.api + 全量语言贡献）换成
 *    `monaco-editor/esm/vs/editor/editor.api`（只含编辑器核心与语言 API），
 *    再按需注册 GlueEditor 实际使用的三种语言（python/javascript/shell 的
 *    monarch 语法高亮）。实测 vendor-monaco 从 4.16MB 降到 2.42MB（raw），
 *    brotli 后 499KB；ts/json/css/html 等语言贡献不再打进主包。
 *  - 移除 TsWorker（ts.worker-*.js 单文件 ~5.9MB）：JavaScript/TypeScript 的
 *    语言服务（补全/诊断）不再加载，降级为 monarch 语法高亮——Glue 脚本
 *    编辑器是短代码输入场景，体积收益远大于 IDE 级补全。如需恢复 JS
 *    IntelliSense，仅需重新引入 ts.worker 并按下表分发 label。
 *      - python/shell → editor.worker（base worker；monarch 分词在主线程）；
 *      - javascript/typescript → ts.worker（语言服务：补全/诊断）。
 */
import type { Environment } from 'monaco-editor';
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
// 只注册编辑器实际使用的语言（monarch 语法高亮贡献从 editor.api 取 languages）
import 'monaco-editor/esm/vs/basic-languages/python/python.contribution';
import 'monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution';
import 'monaco-editor/esm/vs/basic-languages/shell/shell.contribution';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';

(self as unknown as { MonacoEnvironment: Environment }).MonacoEnvironment = {
  // 不再按 label 分发：所有语言统一返回 base editor.worker（体积优化见文件头注释）。
  // 形参一并省略（tseslint no-unused-vars 对未使用形参报 error；少形参赋值在 TS 中合法）。
  getWorker(): Worker {
    return new EditorWorker();
  },
};

export { monaco };
