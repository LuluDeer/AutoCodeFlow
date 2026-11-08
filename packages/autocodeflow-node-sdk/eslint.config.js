// R175：为 packages/autocodeflow-node-sdk 补 ESLint 入口（此前登记在
// scripts/lint-gate-exemptions.json，现已回收）。结构照 apps/executor-node/eslint.config.js
//（flat config + typescript-eslint 的 recommended），规则按本包实情调：
//
// ① 本包是 **CommonJS**（package.json **无** `type` 字段；tsconfig `module: commonjs`，
//    build 走 tsup 输出 cjs+esm 双格式）⇒ 配置文件本身用 CommonJS 写
//    （require + module.exports），与 executor-node 同款。
// ② 测试文件在 `src/__tests__/` 下（**jest** 惯例，`.test.ts` 命名）⇒ 对测试放宽
//    `no-explicit-any` / `no-require-imports` / `no-unsafe-function-type`（同 executor-node
//    先例）：本包 `robustness.test.ts` 确实用 `require('../http-client')` 拿模块做
//    破坏性隔离（jest 的 `jest.resetModules()` 惯用法）。
// ③ `no-explicit-any` 在**源码**里保持 error：本包源码零 `any`（5 处全在测试里）
//    ⇒ 严格规则不会给源码带来任何噪音，无需关掉整条规则。
// ④ 下划线前缀表示有意留空的占位符（catch (_e) 等）——仓库既有约定。
const tseslint = require('typescript-eslint');

/** 仓库既有约定的未用变量容忍度（下划线前缀 = 有意留空的占位符）。 */
const UNUSED_VARS_BASE = {
  args: 'after-used',
  argsIgnorePattern: '^_',
  varsIgnorePattern: '^_',
  caughtErrorsIgnorePattern: '^_',
  ignoreRestSiblings: true,
};

module.exports = [
  {
    ignores: ['dist/', 'node_modules/', 'coverage/', 'eslint.config.js'],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', UNUSED_VARS_BASE],
    },
  },
  {
    // 【指名例外 · 1 处】src/context.ts:2 导入 `LogEntry` 后**从未使用**：
    // 该类型只在 `./types` 里被再导出（src/index.ts:48）与在 logger.ts 里使用，
    // 本文件不需要它 ⇒ 这是**死导入**，属真问题（不是格式问题），但源码不在本轮
    // 写域内 ⇒ 此处给它一条**指名**的例外（而不是把整条规则降级），
    // 并记为待清项（见 artifacts/autonomy/R175/impl-pkg-eslint.md 的「发现的真问题」）。
    // 清掉那条死导入后，本段应整段删除。
    files: ['src/context.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { ...UNUSED_VARS_BASE, varsIgnorePattern: '^(?:_|LogEntry$)' },
      ],
    },
  },
  {
    // 【指名例外 · 1 处】src/logger.ts:71 有一条既有的
    // `// eslint-disable-next-line no-console -- 唯一能到达执行日志的通道`。
    // 本包**不启用** `no-console`（本 SDK 的产品职责就是把日志写到 console，
    // logger.ts 里 5 处 console.* 都是它的正常输出通道）⇒ 那条标注在当前规则集下
    // 是「失效标注」，ESLint 9+ 默认会把它报成 warning（纯噪音、非缺陷）。
    // 只在本文件关掉「失效标注」上报，不做全包关（其它文件仍受该信号保护）。
    files: ['src/logger.ts'],
    linterOptions: {
      reportUnusedDisableDirectives: 'off',
    },
  },
  {
    // 测试文件：jest 用例里 `as any`（mock axios 实例）与 `require()` 拿模块
    // 属 jest 生态惯例，不对测试代码强制精确类型/ESM import。
    files: ['**/__tests__/**/*.ts', '**/*.spec.ts', '**/*.test.ts', '**/test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-unsafe-function-type': 'off',
      // 存量未用变量先报为 warning：报告但不阻塞门禁 —— 这些是测试卫生问题，
      // 不是运行时缺陷。
      '@typescript-eslint/no-unused-vars': ['warn', UNUSED_VARS_BASE],
    },
    linterOptions: {
      // 本段刻意关掉了 `no-explicit-any` ⇒ 测试里若带该规则的 disable 标注，
      // 会变成「失效标注」并被报成 warning（噪音，非缺陷）。
      reportUnusedDisableDirectives: 'off',
    },
  },
];
