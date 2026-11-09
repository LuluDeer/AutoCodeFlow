/// <reference types="vite/client" />

// ─────────────────────────────────────────────────────────────────────────────
// renderer 侧的 asset 模块声明（P0 / r7-renderer-check-plan.md §4）
//
// 为什么需要这个文件：renderer 从未进过任何 tsc program（tsconfig.selftest.json
// 的 include 里 renderer 命中 0 条、typecheck:desktop 只含 main+preload、vite
// 只转译不检查），所以 `import logo from './assets/acf-fox.png'` 在 tsc 眼里是
// 「找不到模块」。vite 自己有 asset 处理，产物正常 —— 缺的只是类型。
//
// 上面一行 `/// <reference types="vite/client" />` 一次性带来 vite 的
// 全部内置 asset 声明（*.png / *.svg / *.woff2 / *?url / *?raw / *.css …），
// 与 `vite.renderer.config.ts` 的解析行为同源，因此不另抄一份手写声明。
//
// 注意：`window.electronAPI` 的全局声明**已迁到 `electron-api.d.ts`**（R196 完成）。
// 此前这里是「**故意不声明**」，因为 9 个文件各自写了模块内的
// `declare const window: Window & { electronAPI: {...} }`，字段集彼此不一致；
// 在此再加一份只会产出**又一份**不一致的契约。R196 把那 9 份**全部删除**，
// 改为在 `electron-api.d.ts` 里**以 preload 的真实暴露面为准**声明一次
// （顺带消掉了 12 处 `(window as any).electronAPI`）。
// ─────────────────────────────────────────────────────────────────────────────
