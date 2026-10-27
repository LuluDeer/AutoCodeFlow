/**
 * 确定性测试数据（替代 @faker-js/faker）
 *
 * ## 为什么不用 faker（2026-10-27 审计轮 #7 实测）
 *
 * `@faker-js/faker@10` 是**纯 ESM**（`package.json` 的 `"type": "module"`，
 * `dist/` 只有 ESM 入口，无 CJS 双发）。而本仓 admin-api 的测试入口是
 * `npx --node-options=--experimental-vm-modules jest` + ts-jest(CJS)：
 * 在 vm-modules 模式下 faker 的 `dist/index.js` 被当 ESM 求值，于是 import 期
 * 直接抛 `ReferenceError: exports is not defined`。
 *
 * 后果是**双重假绿**：`test/factories/__tests__/*.spec.ts` 不但因为
 * `rootDir: "src"` 从未被收集，即使强行收集也会在 import 期炸掉。
 * 本轮两层一起修：jest 加 `roots` 收编 + 工厂改为确定性生成（不再依赖 ESM-only 包）。
 *
 * ## 语义
 *
 * 进程内递增序号 ⇒ id / username / email 天然唯一且可复现；日期取固定基准
 * （不用 `Date.now()`，避免"时间炸弹"式用例——仓内已有前科：
 * dashboard-ui04 的固定日期串曾随 7 天滚动窗失效）。
 */

/** 进程内递增序号：保证同一次运行内唯一，且与真实时间无关。 */
let seq = 0;

/** 下一个序号（从 1 开始）。 */
export function nextSeq(): number {
  seq += 1;
  return seq;
}

/** 四位补零的序号后缀，用于拼唯一用户名/邮箱。 */
export function uniqueSuffix(): string {
  return String(nextSeq()).padStart(4, "0");
}

/** 固定基准时间（2026-01-01T00:00:00Z）——测试数据的"现在"。 */
export const BASE_TIME = Date.UTC(2026, 0, 1, 0, 0, 0);

/** 基准时间之前 N 分钟。 */
export function pastDate(minutesAgo = 60): Date {
  return new Date(BASE_TIME - minutesAgo * 60_000);
}

/**
 * 真实时钟之后 N 天。
 *
 * 与 pastDate 不同，**这里必须相对真实 now**：`lockedUntil` 这类字段的语义就是
 * "晚于现在"，用固定基准（BASE_TIME）会在基准日之后立刻变成过去时间
 * （实测：用例 `lockedUntil 应该是未来时间` 直接红）。这类"必须晚于 now"的
 * 断言本身不受时间炸弹影响——它永远相对当前时刻成立。
 */
export function futureDate(daysAhead = 1): Date {
  return new Date(Date.now() + daysAhead * 86_400_000);
}

/** 字母-only 词表（用于必须匹配 /^[a-z-]+$/ 的字段，如任务名）。 */
const WORDS = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"];
export function nextWord(): string {
  return WORDS[nextSeq() % WORDS.length];
}
