// R176：desktop 三份独立 flat config 的**第三份** —— agent worker。
// 三段环境总述见 `eslint.main.config.js` 头注。
//
// ## 本段（src/agent-worker）的关键决定
//
// · **只有 1 个文件，但仍然是独立的一份 config**：`src/agent-worker/main.ts`
//   经 esbuild 打成单文件 bundle，由主进程以 `ELECTRON_RUN_AS_NODE=1` 子进程
//   spawn（`scripts/bundle-agent-worker.cjs`）。它与主进程**环境相同（Node）、
//   约束不同**：stdout 只承载 JSON 行协议 ⇒ 任何 `console.*` 直接打 stdout 都会
//   毒化协议（文件里为此劫持了整个 console）。这正是"不能与主进程共用一份"的
//   具体理由；也是本段**没有**跟随主进程关掉 `no-require-imports` 的原因。
// · **`no-explicit-any` 保持开启**（不做与主进程/渲染层相同的降级）：实测本段
//   0 处 `any` ⇒ 关掉它只是"为了统一好看"而丢掉一个真实可用的闸。三份 config
//   差异显式，就应该显式在这里。
// · **`no-require-imports` 保持开启**：本段是 ESM 源码（`import * as fs from
//   'fs'`），0 处 `require()`；出现就是真缺陷。
// · **不启用 `no-console`**：worker 的第一件事就是劫持 console 把输出改道到
//   stderr（`src/agent-worker/main.ts` 顶部）。开启 core `no-console` 会把那段
//   劫持本身判成违规，并让既有的 `// eslint-disable-next-line no-console`
//   成为"无用指令"——两个方向都是假信号。
const tseslint = require('typescript-eslint');

/** 本段扫描面：与 `tsconfig.worker.json` 的 include 一致。 */
const FILES = ['src/agent-worker/**/*.ts'];

module.exports = [
  {
    ignores: [
      'dist/**',
      'dist-electron/**',
      'node_modules/**',
      'src/main/**',
      'src/preload/**',
      'src/renderer/**',
      'e2e/**',
      'scripts/**',
      'eslint.*.config.js',
    ],
  },
  ...tseslint.configs.recommended.map((cfg) => ({ ...cfg, files: FILES })),
  {
    files: FILES,
    // 本段唯一的既有指令是 `// eslint-disable-next-line no-console`（console 劫持
    // 那段）——`no-console` 本轮不启用（见头注）⇒ 该指令无用。源码本轮禁改 ⇒
    // 与另两份 config 同款关掉「无用指令」报告（理由见 eslint.main.config.js）。
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    rules: {
      // 与另外两段同款的下划线占位约定（仓库统一约定，不是本段特例）。
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
