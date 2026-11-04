/**
 * 「保存配置」的前置判定表（`requestSave` 的 if/else 骨架）。
 *
 * 原实现是一串 28 行的嵌套判断：脏否 → 要不要重启 → 执行器在不在跑。它的
 * 三类结局（直接存 / 弹「运行中会中断」确认 / 状态不明时保守提示）在本仓
 * 缺陷史里反复出过问题（虚惊重启、以及"状态无法确认时把运行中当空闲"）。
 * 抽成一张纯真值表后，每个格子都有一条真跑断言（见 pure-logic.selftest.mjs），
 * 而不是靠读源码文本猜。
 *
 * 语义与 `finalizeConfigSave` 的真实判据同源：`needsRestart` 来自
 * `main/config-restart.ts` 的唯一字段清单（改语言/日志级别/通知不重启）。
 */

/** 执行器运行状态的可得性（`unprobed` = 还没问；`unavailable` = 问不到/问失败）。 */
export type SaveStatus = 'unprobed' | 'running' | 'stopped' | 'unavailable';

/** 判定结果。`probe` = 需要先取一次运行状态再判。 */
export type SavePlan = 'noop' | 'save' | 'probe' | 'confirm-running' | 'confirm-unknown';

export type SavePlanInput = {
  isDirty: boolean;
  saving: boolean;
  checkingSaveImpact: boolean;
  needsRestart: boolean;
  status: SaveStatus;
};

/**
 * 真值表。优先级：先看能不能动（脏/在存/正在判定 → noop），再看重启需求
 * （不需要重启就与运行状态无关 → 直接存），最后看状态。
 */
export function planSave(input: SavePlanInput): SavePlan {
  if (!input.isDirty || input.saving || input.checkingSaveImpact) return 'noop';
  // 不需要重启的保存与执行器是否在跑无关——这正是"改语言也被提示会重启"的修法。
  if (!input.needsRestart) return 'save';
  switch (input.status) {
    case 'unprobed':
      return 'probe';
    case 'running':
      return 'confirm-running';
    case 'stopped':
      return 'save';
    default:
      // 状态取不到/读取抛错：保守提示，绝不把可能运行中的任务当空闲处理。
      return 'confirm-unknown';
  }
}

/**
 * `saveConfig()` 返回值的**三态归一**（R7-B 写路径出仓时从 `save()` 里抽出）。
 *
 * 三个分支都有缺陷史，且都在"静默失败"一侧：
 *   · 主进程可能在**载荷形状被拒**时 resolve `{ok:false}`（不是 reject）⇒ 当成功
 *     处理就会显示「✓ 已保存，配置已生效」而其实什么都没写。
 *   · `reloadError`：配置**已落盘**但执行器热重载失败 ⇒ 既不能报"已生效"
 *     （用户以为执行器在跑，实际停在停止态），也不能丢掉"已落盘"这件事
 *     （调用方仍要更新基线），所以它是独立的一档。
 *   · 其余（含旧版 preload 返回 `undefined`）⇒ 成功。
 *
 * 判定与本模块其余部分一样是纯的：不读 `t`、不 setState、不碰 IPC，只把
 * 返回值映射成可判别的出口，使"哪个分支做了什么"能被真执行断言逐格钉住
 *（`writer-layer.selftest.mjs`），而不是靠读 `save()` 的源码文本猜。
 */
export type SaveOutcome =
  | { kind: 'rejected' }
  | { kind: 'reloadFailed'; message: string }
  | { kind: 'ok' };

export function classifySaveResult(
  result: { ok?: boolean; reloadError?: string } | null | undefined,
): SaveOutcome {
  // 原实现 `if (r && r.ok === false)`：真值判断不能省——`r` 为 null/undefined
  // 时读 `.ok` 会抛（旧版 preload / 通道缺失），那会落进 catch 变成"保存失败"。
  if (result && result.ok === false) return { kind: 'rejected' };
  if (result?.reloadError) return { kind: 'reloadFailed', message: result.reloadError };
  return { kind: 'ok' };
}

/**
 * 唯一有副作用的一步：向主进程取运行状态，并把「没有通道 / 调用抛错 / 形状不对」
 * 一律归成 `unavailable`（调用方据此走保守提示）。取值函数由调用方注入，
 * 本模块因此不 import electron / preload，也就能被 node 直接跑。
 */
export async function saveStatusOf(
  getStatus?: () => Promise<{ running: boolean }>,
): Promise<SaveStatus> {
  if (typeof getStatus !== 'function') return 'unavailable';
  try {
    const snapshot = await getStatus();
    // 原实现是 `if (snapshot.running)`：snapshot 为 null 时抛 TypeError 落进
    // catch（保守提示）。这里显式把 null 归成 unavailable，保住同一条语义，
    // 而不是把"形状不对"当成"没在跑"直接放行保存。
    if (snapshot == null) return 'unavailable';
    return snapshot.running ? 'running' : 'stopped';
  } catch {
    return 'unavailable';
  }
}
