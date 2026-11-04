/**
 * 自检专用：**跳过 `.env` 文件加载**的开关（R04，2026-11-05）。
 *
 * ## 为什么需要它
 *
 * `ConfigModule.forRoot({ envFilePath: ".env" })`（`app.module.ts`）按**进程 cwd**
 * 解析该文件。而仓库的开发态约定是 `apps/admin-api/.env` **符号链接到仓库根 `.env`**
 * （`.gitignore` 覆盖，不进版本库）。自检脚本以 `cwd = apps/admin-api` 起 admin-api
 * 子进程，于是**自检吃到了开发者本机的环境变量**：
 *
 *   · 夹具只显式传 ~18 个键，而 Nest 的 `assignVariablesToProcess(config, override)`
 *     只跳过 `process.env` 里**已有**的键（`@nestjs/config` 的 `override` 未传）⇒
 *     另外 **133 个键**从开发者 `.env` 注入；
 *   · 后果实测：`test:pull-dispatch` 断言 ④⑤ 全红（执行器 `fetchToken`/心跳/回调 401），
 *     而同一份代码在 CI（无该符号链接）是绿的 ⇒ **本地门禁 ≠ CI**，且红点离改动很远，
 *     极易被误判成"自己写坏了"。
 *
 * ## 语义（默认关闭，生产零变化）
 *
 * `SELFTEST_SKIP_ENV_FILE=1` ⇒ 起进程时**不读** `.env`；未设置或为 `0` ⇒ 与今天
 * **逐字节一致**（`ignoreEnvFile` 默认 false，加载顺序、Joi 校验、`load` 工厂都不动）。
 * 只认字面量 `"1"`：其它值（`"true"` / `"yes"` / 空串）一律按关闭处理——自检开关不需要
 * 宽松的真值解析，宽松只会让"以为开了其实没开"成为新的调试成本。
 *
 * ## 边界
 *
 * - 生产 / CI / compose / docker **从不设置**该键 ⇒ 运行时行为不变；
 * - 只有 `scripts/*-selftest.mjs`（经 `scripts/lib/selftest-hermetic.mjs`）设置它；
 * - 与 `NODE_ENV` 无关，刻意**不**按 `NODE_ENV=test` 推断：jest 会自动设 `test`，
 *   那会把「所有 jest 运行都不读 `.env`」变成一次宽得多的行为变更。
 */

/** 开关键名（自检 helper 与 app 必须用同一字面量；由 `check:guard-harness` 的接线判据钉住）。 */
export const SELFTEST_SKIP_ENV_FILE_KEY = "SELFTEST_SKIP_ENV_FILE";

/**
 * 是否跳过 `.env` 文件加载。
 *
 * @param env 注入点（默认 `process.env`），便于单测不污染真实环境。
 */
export function shouldSkipEnvFile(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[SELFTEST_SKIP_ENV_FILE_KEY] === "1";
}
