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
// · **`no-explicit-any` 关掉**：实测 `src/renderer` 12 处。与主进程同款处置
//   （关掉的只是这一条，recommended 其余规则照常）。
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
      '@typescript-eslint/no-explicit-any': 'off',
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
