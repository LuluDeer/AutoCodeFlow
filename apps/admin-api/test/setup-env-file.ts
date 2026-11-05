/**
 * R25/R26（2026-11-05）：admin-api 单测的**默认环境隔离 + 夹具默认值**。
 *
 * 约定（`docs/operations.md`「自检环境隔离（SELFTEST_SKIP_ENV_FILE）」第 1 条）：
 * 跑测试的夹具必须在**任何断言之前**把 `SELFTEST_SKIP_ENV_FILE=1` 放进环境，
 * 并且**自己提供**测试所需的最小配置值 —— 不许依赖开发机 `.env`。
 *
 * admin-api 有**三处** `.env` 读入（`main.ts` preload / `app.module.ts` 的
 * `ConfigModule({ignoreEnvFile: shouldSkipEnvFile()})` / `data-source.ts` 的 `dotenv.config()`），
 * 全部按这个键决定是否读文件。开关打开后 `ConfigModule` 的 Joi 校验会直接拒绝启动，
 * 除非这些**必填项**由夹具显式给出（`app.module.ts:152/185/186/190`）：
 *
 *   DB_PASSWORD · JWT_SECRET(≥32) · JWT_REFRESH_SECRET(≥32) · EXECUTOR_SECRET(≥16)
 *
 * 这些是**夹具值**，不是"从开发者 `.env` 抄来的生产值"：仅用于让校验通过，
 * 与任何真实环境无关；生产/CI 不加载本文件（它只出现在 `jest.setupFiles`）。
 *
 * 用 `setupFiles` 而非 `setupFilesAfterEnv`：前者在**测试框架加载前**执行，
 * 早于任何被测模块的 import —— 否则开关来得太晚，`data-source.ts` 已经在 import 期
 * 执行过 `dotenv.config()` 了。
 */
process.env.SELFTEST_SKIP_ENV_FILE = "1";

/** Joi 必填项（值本身无意义，只需满足长度/非空约束）。 */
const FIXTURE_ENV: Record<string, string> = {
  DB_PASSWORD: "test-db-password",
  JWT_SECRET: "test-jwt-secret-0123456789abcdef0123",
  JWT_REFRESH_SECRET: "test-jwt-refresh-secret-0123456789ab",
  EXECUTOR_SECRET: "test-executor-secret-16",
};

for (const [key, value] of Object.entries(FIXTURE_ENV)) {
  // 只在夹具没显式给的时候补（免得覆盖某个 spec 自己精心构造的值）。
  if (!process.env[key]) process.env[key] = value;
}
