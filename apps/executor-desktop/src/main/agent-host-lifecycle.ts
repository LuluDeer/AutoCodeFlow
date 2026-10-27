/** Connection and workspace values captured when an AgentHost is created. */
export interface AgentHostIdentityParts {
  baseUrl: string;
  token: string | null;
  address: string;
  workDir: string;
}

export function agentHostIdentity(parts: AgentHostIdentityParts): string {
  return JSON.stringify([parts.baseUrl, parts.token, parts.address, parts.workDir]);
}

/**
 * B：连续 defer 的次数上限——到顶即强制重建（'replace'），绝不允许无限 defer。
 *
 * 为什么必须封顶：defer 的唯一依据是「当前 tick 在飞」，而调用方每 30s 同步
 * 一次。只要 tick 一直在飞（worker 卡住、不回 tick-result 的旧形态），身份
 * 替换就被永久推迟 ⇒ 旧 worker 继续用旧 token / 旧 workDir 收单——身份替换
 * 被无限劫持，这是安全面而不只是体验面。
 *
 * 20 次 ≈ 30s 轮询下 10 分钟，取值理由：
 *  - 正常 tick 是秒级（一次 poll，无指派即返回），远到不了上限；
 *  - 单指派合法耗时可达小时级（闸门 maxWallClockMs = 2h），上限取得太小会让
 *    「指派进行中改配置」每次都强制并存两个 worker，得不偿失；
 *  - 10 分钟是「用户改完 token / workDir 后旧身份还能收多久单」可接受的上界。
 * tick 侧另有看门狗（agent-worker-process.ts 的 TICK_WATCHDOG_MS）兜住
 * 「tick 永不落定」，两者互不依赖：任一生效，defer 都不可能无限。
 */
export const MAX_AGENT_HOST_DEFERS = 20;

export function agentHostTransition(
  currentIdentity: string | null,
  desiredIdentity: string,
  tickInFlight: boolean,
  deferStreak = 0,
): 'create' | 'keep' | 'defer' | 'replace' {
  if (currentIdentity === null) return 'create';
  if (currentIdentity === desiredIdentity) return 'keep';
  if (!tickInFlight) return 'replace';
  // B：defer 到顶后不再"等 tick 结束"，按强制重建处理。旧 worker 的收尾
  // （agentEnabled=false → withdraw → shutdownWhenIdle）由调用方排队执行，
  // 不会掐断正在跑的指派（worker 侧 withdraw 延后到指派终态）。
  return deferStreak >= MAX_AGENT_HOST_DEFERS ? 'replace' : 'defer';
}
