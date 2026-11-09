// R176：desktop 三份独立 flat config 的**第二份** —— 渲染进程。
// 为什么必须与主进程分开，见 `eslint.main.config.js` 的头注（三段环境总述）。
//
// ## 本段（renderer）的关键决定
//
// · **没有 React 插件，这是如实交代而不是省事**：`node_modules` 里既没有
//   `eslint-plugin-react-hooks` 也没有 `@eslint-react`（R176 实测 `ls` 两者皆无）。
//   本轮纪律是「没有就不装」（不为一条规则引一个新依赖树，且 renderer 的
//   hooks 依赖数组已经有构建期 selftest 之外的人工契约）⇒ 本段**不启用任何
//   react 规则**，只用 typescript-eslint recommended。**后果**：源码里 7 处
//   `// eslint-disable-next-line react-hooks/exhaustive-deps` 指向一个**未安装**
//   的插件规则 ⇒ 这些指令在本段是"无主指令"，不会因为缺规则而报错，也**不会**
//   保护任何东西。这是本段已知的、写在这里的覆盖缺口（详见回执「遗留」）。
// · **`jsx` 由解析器按扩展名处理**：`*.tsx` 交给 typescript-estree 自动开 JSX，
//   不需要 espree 的 `ecmaFeatures.jsx`；`moduleResolution: bundler` 与 `@/`
//   别名是 **tsc/vite 的事**，ESLint 不做模块解析（无 type-aware 规则）⇒
//   别名不需要在这里复刻。
// · **`no-explicit-any` R196 起改回 error**（此前是 `off`）：R176 立的门当时是
//   「先把门立起来，不重写 170 个文件的类型」⇒ 规则被关掉。R196 把根因挖出来了：
//   **`window.electronAPI` 从来没有全局类型声明** ⇒ 9 个文件各自抄了一份
//   `declare const window: Window & { electronAPI: {...} }`，**字段集彼此不一致**
//   ⇒ 页面要用别的文件才有的字段时，只能 `(window as any).electronAPI` 绕过去
//   （**12 处**）。⇒ 修法不是「逐处消 any」，而是**建一处全局契约**
//   （`src/renderer/electron-api.d.ts`，字段集取自 preload 的真实暴露面），
//   **删掉那 9 份不一致的局部声明** ⇒ 12 处 `as any` 全部消失。
//   ⇒ 规则现在是**开的**：新增 `any` 会立刻红，必须指名豁免并写明理由。
// · **`no-require-imports` 保持开启**：renderer 实测 0 处 `require()`，且它是
//   浏览器环境 ⇒ 出现 require 就是真缺陷（这正是三段差异里最该保留的一条）。
const tseslint = require('typescript-eslint');

/** 本段扫描面：与 `tsconfig.renderer.json` 的 include 一致（ts + tsx）。 */
const FILES = ['src/renderer/**/*.ts', 'src/renderer/**/*.tsx'];

module.exports = [
  {
    ignores: [
      // vite 的构建产物目录（`src/renderer/dist`），绝不能当源码扫
      'src/renderer/dist/**',
      'dist/**',
      'dist-electron/**',
      'node_modules/**',
      // `.selftest.mjs` 是纯 node 自检（不进 tsc program，也不进本段）
      'src/renderer/**/*.selftest.mjs',
      'src/main/**',
      'src/preload/**',
      'src/agent-worker/**',
      'e2e/**',
      'scripts/**',
      'eslint.*.config.js',
    ],
  },
  ...tseslint.configs.recommended.map((cfg) => ({ ...cfg, files: FILES })),
  {
    files: FILES,
    // 本段 7 处 `// eslint-disable-next-line react-hooks/exhaustive-deps` 指向一个
    // **未安装**的插件规则 ⇒ ESLint 会把它们判成
    // `Definition for rule 'react-hooks/exhaustive-deps' was not found` 的 **error**
    // （不是 warning，是能直接判红那种）。源码本轮禁改 ⇒ 只能从配置侧处理。
    //
    // 处置：`noInlineConfig: true` —— 本段**不接受任何内联禁用**。这比"给这 7 条打
    // 基线"更诚实也更严：① 那 7 条指令本来就一个规则都没关掉（插件不在），留着
    // 只是噪声；② 每次运行都会打印
    // `'…' has no effect because you have 'noInlineConfig' setting in your config`
    // ⇒ **缺口自己说话**，而不是被基线静默吞掉；③ 同时也堵死"以后有人拿
    // `/* eslint-disable */` 把 renderer 的违规糊过去"这条路。
    // 代价：本段出现 7 条 warning（exit 仍为 0）。插件装上后应改回允许内联并删掉
    // 源码里那 7 条指令（见回执「遗留」）。
    linterOptions: {
      noInlineConfig: true,
      reportUnusedDisableDirectives: 'off',
    },
    rules: {
      // 见头注：实测 12 处，与 executor-node 先例同款处置。
      // R196：规则**开**（此前 off）—— 详见头注「no-explicit-any」段。
      '@typescript-eslint/no-explicit-any': 'error',
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
  {
    // R196：**文件级指名豁免** —— `src/renderer/electron-api.d.ts`。
    //
    // 为什么这个文件必须豁免（而不是逐条写 disable）：
    // ① 该文件是 `window.electronAPI` 的**全局类型投影**，其中**跨 IPC 边界的返回值**
    //    一律是 `any` —— 那些数据的**精确类型在 main 端**（`ipc-handlers.ts` 的
    //    `ipcMain.handle(...)` 的返回值），经 `ipcRenderer.invoke` 回到 renderer；
    //    `invoke` 的静态返回类型本就是 `Promise<any>`。
    // ② 在 renderer 侧再抄一份精确类型 ⇒ **必然与 main 端漂移** ⇒ 那正是本轮
    //    **要消灭的那种重复契约**（此前是 9 份彼此不一致的局部 `declare const window`）。
    // ③ renderer 侧调用后**自己**收窄（各页面已有 `LogReadResultLike` 之类的局部形状）。
    //
    // ⚠️ 因此「新增 `any` 会不会被发现」的答案是：**会** —— 本豁免只覆盖这一个文件，
    //    renderer 的**其它**文件里新增 `any` 仍然立刻红。
    files: ['src/renderer/electron-api.d.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
];
