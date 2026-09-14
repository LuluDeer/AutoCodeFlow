/**
 * F-01（DEEP_REVIEW @0ef3bbe）：Monaco 语言服务 worker 本地化装配。
 *
 * 此前 @monaco-editor/react 未配置本地 monaco（默认从 jsdelivr CDN 动态加载），
 * 内网/离线部署下 Glue 编辑器永远停在 loading。GlueEditor 侧通过
 * `loader.config({ monaco })` 注入本地 monaco 实例后，monaco 的语言服务仍需要
 * Web Worker（MonacoEnvironment 缺失会在控制台报错并降级功能），故在此统一装配。
 *
 * worker 加载采用 Vite 官方 `?worker` 后缀导入：Vite 会把 worker 入口连同其
 * 相对依赖（monaco 0.53 的 editor.worker.js 内部 import './editor.worker.start'）
 * 打包成自包含的 hash 资产（dist/assets/editor.worker-*.js / ts.worker-*.js）。
 * 不用裸 `new URL('monaco-editor/...worker.js', import.meta.url)`：该模式对
 * node_modules 裸说明符只会按原始资源原样拷贝，worker 内部的相对 import 在
 * dist 中会 404。
 *
 * GlueEditor 实际语言取值（LANGUAGE_MAP）：python / javascript(node) / shell。
 *  - javascript/typescript → ts.worker（语言服务：补全/诊断）；
 *  - python/shell 等其余语言 → editor.worker（base worker；monarch 分词在主线程，
 *    base worker 足够）。
 */
import type { Environment } from 'monaco-editor';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import TsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';

(self as unknown as { MonacoEnvironment: Environment }).MonacoEnvironment = {
  getWorker(_workerId: string, label: string): Worker {
    if (label === 'typescript' || label === 'javascript') {
      return new TsWorker();
    }
    return new EditorWorker();
  },
};
