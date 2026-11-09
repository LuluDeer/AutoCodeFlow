/**
 * R23（2026-11-05）：executor-node 侧 `.env` 加载的**自检开关**（与 admin-api 的 R04 同语义）。
 *
 * ## 为什么需要
 *
 * R04 在 admin-api 侧收掉了**三个** `.env` 入口，并引入 `SELFTEST_SKIP_ENV_FILE=1` 让自检跑在
 * 干净环境里（否则开发机仓库根的 `.env` 会把夹具没显式给的键全部注进来，把判据绑到本机环境）。
 * **executor-node 侧从未做同等约束**：`src/main.ts` 顶部有一处**无条件** `dotenv.config(...)`。
 *
 * 目前 node 的 jest 恰好不会碰到它（`jest.config` 的 `collectCoverageFrom` 排除了 `src/main.ts`，
 * 且**没有任何 spec 导入 main**）—— 但这是"恰好"，不是"被判据钉住"：
 * 谁在某条 spec 里 `import "../main"`（或再写一处 dotenv），测试就会静默读开发者的 `.env`。
 *
 * ## 开关语义（三态，逐字对齐 `apps/admin-api/src/config/selftest-env.ts`）
 *
 * · 未设置 ⇒ **加载**（生产 / compose / CI 行为与引入开关前逐字节一致）；
 * · `="1"` ⇒ **不加载**（自检唯一的认可取值）；
 * · 其它任意值（含 `"0"` / `"true"` / 空串）⇒ **加载**（不发明宽松真值，避免"看起来关了其实开着"）。
 */
export const SELFTEST_SKIP_ENV_FILE_KEY = "SELFTEST_SKIP_ENV_FILE";

/** 是否跳过 `.env` 文件加载（只认字符串 `"1"`）。 */
export function shouldSkipEnvFile(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[SELFTEST_SKIP_ENV_FILE_KEY] === "1";
}

/** 是否应当加载 `.env`（`shouldSkipEnvFile` 的读法正向化，便于 main.ts 直读）。 */
export function shouldLoadEnvFile(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return !shouldSkipEnvFile(env);
}
