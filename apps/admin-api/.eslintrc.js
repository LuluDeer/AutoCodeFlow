module.exports = {
  parser: '@typescript-eslint/parser',
  parserOptions: {
    project: 'tsconfig.eslint.json',
    tsconfigRootDir: __dirname,
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint/eslint-plugin'],
  extends: [
    'plugin:@typescript-eslint/recommended',
    'plugin:prettier/recommended',
  ],
  root: true,
  env: {
    node: true,
    jest: true,
  },
  ignorePatterns: ['.eslintrc.js'],
  rules: {
    '@typescript-eslint/interface-name-prefix': 'off',
    '@typescript-eslint/explicit-function-return-type': 'off',
    '@typescript-eslint/explicit-module-boundary-types': 'off',
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
    // ARCH-27（配置中心收口）：封禁 process.env 直读 —— 曾因 @Throttle
    // 装饰器求值期直读导致死配置（W-22，见 src/config/env.ts）。
    // 规约：新配置先注册进 configuration.ts + app.module.ts(Joi)，运行时经
    // ConfigService.get() 读取；仅模块求值期/无 DI 场景允许经
    // src/config/env.ts 的 getEnvVar() 读取，且调用点必须注释豁免理由。
    // 完整规约见 configuration.ts 头部「配置读取规约」。
    'no-restricted-properties': [
      'error',
      {
        object: 'process',
        property: 'env',
        message:
          'ARCH-27: 禁止直读 process.env — 配置须注册进 configuration.ts+Joi 并经 ConfigService 读取；模块求值期/无 DI 场景用 src/config/env.ts 的 getEnvVar()（豁免清单与规约见 configuration.ts 头部）',
      },
    ],
  },
  // ARCH-27 直读豁免清单（文件级 override，维护时必须保留理由注释；
  // 行内豁免用 eslint-disable-next-line no-restricted-properties + 理由）：
  //  - src/config/configuration.ts —— 唯一合法的 env → 配置映射层（ConfigModule load）
  //  - src/config/env.ts          —— 模块求值期/无 DI 场景的唯一收口 util（W-22 前科集中地）
  //  - **/*.spec.ts、test/**      —— 测试 fixture 需要直接操纵 env
  // 注意：src/main.ts 与 src/data-source.ts 已完成收口，不在豁免清单中；
  // src/migrations 目前无直读点，未来迁移文件如需读 env 必须走 getEnvVar()。
  overrides: [
    {
      files: [
        'src/config/configuration.ts',
        'src/config/env.ts',
        '**/*.spec.ts',
        'test/**/*.ts',
      ],
      rules: {
        'no-restricted-properties': 'off',
      },
    },
  ],
};
