// E-41（DEEP_REVIEW 0ef3bbe）：executor-node 此前是全仓唯一无 ESLint 的 TS 项目
// （根 package.json lint:node 是 echo 占位）。对齐 apps/admin-api/.eslintrc.js 的
// legacy v8 配置风格，去掉 NestJS/ARCH-27 专属规则（executor-node 无 DI 配置中心）。
module.exports = {
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint/eslint-plugin'],
  extends: ['plugin:@typescript-eslint/recommended'],
  root: true,
  env: {
    node: true,
    jest: true,
  },
  ignorePatterns: ['.eslintrc.js', 'dist/', 'node_modules/'],
  rules: {
    '@typescript-eslint/no-explicit-any': 'off',
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
  },
  overrides: [
    {
      // spec 文件用 CommonJS require() 做 ts-jest mock（jest.mock 工厂内
      // require 模块以建立隔离），且测试 mock 常用 Function 类型——这是
      // ts-jest 生态惯例，不对测试代码强制执行 ESM  import / 精确函数签名。
      files: ['**/*.spec.ts', '**/test/**/*.ts'],
      rules: {
        '@typescript-eslint/no-require-imports': 'off',
        '@typescript-eslint/no-unsafe-function-type': 'off',
      },
    },
  ],
};
