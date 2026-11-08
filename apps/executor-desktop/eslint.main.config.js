// R176：desktop 此前是**全仓最后一个「有代码但完全没有静态检查」**的 TS 项目
// （170 个 ts/tsx，登记在 `scripts/lint-gate-exemptions.json` 判据⑤）。
// 本轮按登记里写明的动作兑现：「按渲染进程 / 主进程 / worker **三份独立 config**
// 分段补（不要合并成一份）」——本文件是其中**第一份**。
//
// ## 为什么必须分段，而不是一份 eslint.config.js
// desktop 是**三段互不相同的运行环境**，一份「都能过」的配置只能取三段的最小
// 公约数，于是每一段真正的危险都会漏掉：
//
//   ① `src/main/**` + `src/preload/**` = **Electron 主进程**：Node 环境，
//      `tsconfig.json` 的 `module`/`moduleResolution` 都是 `node16` ⇒ **产物是
//      CommonJS**。本 config 覆盖这一段。
//   ② `src/renderer/**` = **浏览器渲染进程**：vite + React，`moduleResolution:
//      bundler`，带 `@ → src/renderer` 别名 ⇒ 见 `eslint.renderer.config.js`。
//   ③ `src/agent-worker/**` = **独立 worker 进程**（esbuild 单文件 bundle，
//      `ELECTRON_RUN_AS_NODE=1` 子进程）⇒ 见 `eslint.worker.config.js`。
//
// 三段共用的部分（typescript-eslint recommended + `no-unused-vars` 下划线
// 约定 + 关掉 `no-explicit-any`）逐份抄写而不是抽公共文件：**规则差异必须是
// 显式的**，抽出去以后「哪一段关了什么」就得跳文件才看得见，而三份各自完整
// 的 config 允许你只看一份就知道这一段到底受什么约束。
//
// ## 本段（主进程 / preload）的关键决定
//
// · **`no-require-imports` 关掉**：这不是"为了绿而放水"，是环境事实。本段是
//   CJS 产物，且 `require()` 在这里是**有意的延迟/条件加载**——
//   `agent/browser.ts` 的 `require('playwright-core')`（可选依赖，缺了就降级）、
//   `token-crypto.ts` 的 `require('electron')`（selftest 里不能 import electron）、
//   `executor-process.ts` 的条件 `require('http')`。改成静态 import 会改变
//   加载时机与可选依赖语义（= 改源码行为，本轮禁止）。renderer / worker 那两份
//   **保留规则开启**（实测 0 处 require），差异显式。
// · **`no-explicit-any` 关掉**：实测 `src/main` 有 62 处（`as any` / `: any`），
//   与 `apps/executor-node/eslint.config.js` 同款处置。本轮目标是**把门立起来**，
//   不是重写 170 个文件的类型；关了以后 `no-unused-vars` / `no-unreachable` 等
//   真正会咬人的规则照常生效。
// · **`no-unused-vars` 带下划线约定**：仓库既有约定是 `_` 前缀 = 有意留空的占位
//   （`catch (_e)`、解构剔除字段）；不这么配会把约定当成错误，逼人写
//   `eslint-disable`（那才是真正该禁止的）。
// · **不启用 `no-console`**：主进程/worker 的日志走 electron-log 与 stderr，
//   `console` 本身不是缺陷；一旦开启，仓库里既有的 `// eslint-disable-next-line
//   no-console` 会变成"无用指令"。同理不启用 core `no-undef`（typescript-eslint
//   recommended 已用 `eslint-recommended` 关掉），Node 全局由 tsc 的 `@types/node` 保证。
const tseslint = require('typescript-eslint');

/** 本段扫描面：主进程 + preload（与 `tsconfig.json` 的 include 一致）。 */
const FILES = ['src/main/**/*.ts', 'src/preload/**/*.ts'];

module.exports = [
  {
    // 只挡**产物与非源码**：其它两段由各自的 config 负责，这里不重复扫，
    // 免得同一文件被三套规则各判一次（那种"三份 config 互相打架"比一份还糟）。
    ignores: [
      'dist/**',
      'dist-selftest/**',
      'dist-electron/**',
      'node_modules/**',
      'resources/**',
      'src/renderer/**',
      'src/agent-worker/**',
      'e2e/**',
      'scripts/**',
      'eslint.*.config.js',
    ],
  },
  // typescript-eslint recommended 的每个 config 对象都显式收敛到本段文件面。
  // 不这么做，第 1 个对象（parser + plugin）会落到"任意文件"，renderer 的
  // tsx 也会被这套 config 咬到——那正是"一份 config 误伤三段"的起点。
  ...tseslint.configs.recommended.map((cfg) => ({ ...cfg, files: FILES })),
  {
    files: FILES,
    // 既有 18 处 `eslint-disable` 指令（本段 11 处）指向的都是**本轮没启用**的
    // 规则：`no-console` / `no-control-regex` / `@typescript-eslint/no-require-imports`
    // （本段已刻意关掉）/ 已废弃的 `no-var-requires`。源码本轮**禁止改动** ⇒ 无法
    // 清理这些指令 ⇒ 关掉「无用指令」报告，否则 10 条 warning 会永久盖住真信号。
    // 这是**记录在案**的取舍，不是"看不见"：清理指令后应恢复默认（warn）。
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    rules: {
      // 见头注：实测 62 处，与 executor-node 先例同款处置。
      '@typescript-eslint/no-explicit-any': 'off',
      // CJS 主进程的延迟/条件 require，见头注。
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          args: 'after-used',
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
    },
  },
];
