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
// 注意：本文件**故意不声明 `window.electronAPI`**。
// 现状是 6 个文件各自 `declare const window: Window & { electronAPI: {...} }`
// （Wizard / StatusWindow / AppsPage / HistoryPage / ConfigPage / main.tsx），
// 彼此字段集不一致；那 6 份是被本文件之外的模块内声明，会**遮蔽**全局
// `Window`，在此再加一份全局声明既不减少任何一条既有错误，又会产出第 7 份
// 不一致的契约。收敛它们需要同时删改那 6 个文件，属于评估报告 P4
// （`electron-api.d.ts`）的范围，本轮（P0→P2）不做。
// ─────────────────────────────────────────────────────────────────────────────
