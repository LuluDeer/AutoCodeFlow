// R175：为 packages/acf-cli 补 ESLint 入口（此前登记在 scripts/lint-gate-exemptions.json，
// 现已回收）。结构照 apps/executor-node/eslint.config.js（flat config + typescript-eslint
// 的 recommended），规则按本包实情调：
//
// ① 本包是 **ESM**（package.json 的 `type: module`，tsconfig `module: nodenext`）
//    ⇒ 本文件本身按 ESM 写（import/export default），不能用 CommonJS 的
//    `module.exports` + `require`（那会在 ESM 包里直接抛 ERR_REQUIRE_ESM）。
// ② 测试文件在 `src/__tests__/` 下（vitest 惯例，`.test.ts` 命名）⇒ 对测试放宽
//    `no-explicit-any` / `no-require-imports` / `no-unsafe-function-type`（同 executor-node
//    先例），并把 `no-unused-vars` 降为 **warn**（存量未用变量是测试卫生问题，
//    不是运行时缺陷；先报告、不让它红）。
// ③ `no-explicit-any` 在**源码**里保持 error：本包源码只有两处 `any`，且都已带
//    `// eslint-disable-next-line @typescript-eslint/no-explicit-any`（既有约定）⇒
//    不必为了让门禁变绿而关掉整条规则，也不必改源码。
// ④ 下划线前缀表示有意留空的占位符（catch (_e) 等）——仓库既有约定。
import tseslint from 'typescript-eslint';

export default [
  {
    ignores: ['dist/', 'node_modules/', 'coverage/', 'eslint.config.js'],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      // 仓库既有约定：下划线前缀表示有意留空的占位符（catch (_e)、解构剔除字段等）
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
      // 本包 `task glue` 用 `new Function(source)` 做**纯语法检查**（不调用），
      // 源码里已有 `// eslint-disable-next-line no-new-func` 标注该例外。
      // 显式启用这条规则 ⇒ 那条标注从此是「被用上的」而不是「失效的标注」
      // （ESLint 9+ 默认把失效标注报成 warning）。
      'no-new-func': 'error',
    },
  },
  {
    // 测试文件：vitest 用例里大量 `as any`（读内部字段做断言）与 `require()`
    // 式 mock 属生态惯例，不对测试代码强制精确类型/ESM import。
    files: ['**/__tests__/**/*.ts', '**/*.spec.ts', '**/*.test.ts', '**/test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-unsafe-function-type': 'off',
      // 存量未用变量（如 `const logs = captureStdout();` 后未再引用）先报为 warning：
      // 报告但不阻塞门禁 —— 这些是测试卫生问题，不是运行时缺陷。
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          args: 'after-used',
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
    },
    linterOptions: {
      // 本段刻意关掉了 `no-explicit-any` ⇒ 测试里既有的
      // `// eslint-disable-next-line @typescript-eslint/no-explicit-any`
      // 标注会变成「失效标注」并被报成 warning（噪音，非缺陷）。
      reportUnusedDisableDirectives: 'off',
    },
  },
];
