/**
 * R25（2026-11-05）：admin-api 单测的**默认环境隔离**。
 *
 * 约定（`docs/operations.md`「自检环境隔离（SELFTEST_SKIP_ENV_FILE）」第 1 条）：
 * 跑测试的夹具必须在**任何断言之前**把 `SELFTEST_SKIP_ENV_FILE=1` 放进环境。
 *
 * 为什么必须是默认：admin-api 有**三处** `.env` 读入（`main.ts` preload /
 * `app.module.ts` 的 `ConfigModule({ignoreEnvFile: shouldSkipEnvFile()})` /
 * `data-source.ts` 的 `dotenv.config()`），全部按这个键决定是否读文件。
 * 单测里一旦有 spec 间接 import 到 `app.module.ts` / `data-source.ts`，开发机的
 * `apps/admin-api/.env`（符号链接到仓库根 `.env`，实测注入 133 个键）就会进来，
 * 判据就被绑到本机环境上（R04 的原始动机）。
 *
 * 放在 `setupFiles`（而非 `setupFilesAfterEnv`）：前者在**测试框架加载前**执行，
 * 早于任何被测模块的 import —— 否则开关来得太晚，`data-source.ts` 已经在 import 期
 * 执行过 `dotenv.config()` 了。
 */
process.env.SELFTEST_SKIP_ENV_FILE = "1";
