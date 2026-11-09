/**
 * R75（2026-11-06）：**任务渠道判定**的 node 端唯一事实源。
 *
 * ## 为什么单独一个模块
 *
 * 「这个任务走哪条下载通道」这一判断此前在 node 里存在**三份**：
 *   · prepare 路径（`routes/execute.ts` 的 `isZipChannel` 内联逻辑）；
 *   · accept 期**同步**闸（R70，谓词是「没有 gitRepo」）；
 *   · accept 期 **DNS** 预闸（R72）与 pull 预闸（R72/R74，同款谓词）。
 *
 * python 侧早在 R74 就把这条判定收敛成 `_zip_channel_enabled(task)`
 * （`routers/execute.py:2318`，条件与优先级逐条写在它的 docstring 里），
 * 并要求「accept 期的 packageUrl 闸与 prepare 期的下载前闸**都**按它判断」。
 * node 的三份实现里，prepare 那份与 python 等价，accept 那两份**只看了 `!gitRepo`**
 * ⇒ 多判了 `packageUrl`：一个 glue 渠道任务、或「无 codeSource/无 applicationId
 * 但载荷带了 packageUrl」的任务，会因为一个**根本不会被下载**的 URL 被 400 掉。
 *
 * ## 判定规则（与 `_zip_channel_enabled` 逐条对齐，勿单侧修改）
 *
 * 1. `codeSource === 'application_zip'` ⇒ 是 zip（写面校验过的**显式信号**）；
 * 2. 无 `codeSource` 但 `applicationId` **且** `packageUrl` 同时存在 ⇒ 是 zip
 *    （历史行/迁移置 NULL 的歧义场景：刻意看 `packageUrl` 这个正向信号）；
 * 3. 命中更高优先级的代码来源（`gitRepo` > `glueSource`）⇒ **不是** zip
 *    （写面互斥本应保证不可达；真出现则按文档优先级让位，由调用方留 ERROR 日志）。
 *
 * 别名（`gitRepo`/`git_repo` 这类）与全仓同一份 `readTaskAlias` 规则。
 */

/** 读任务的规范字段名，缺失时回落到 snake_case 别名（全仓同一份规则）。 */
export function readTaskAlias(
  task: Record<string, unknown> | null | undefined,
  canonical: string,
  alias: string,
): unknown {
  if (task === null || typeof task !== 'object') return undefined;
  const primary = task[canonical];
  if (primary !== undefined && primary !== null && primary !== '') return primary;
  const secondary = task[alias];
  if (secondary !== undefined && secondary !== null && secondary !== '') return secondary;
  return undefined;
}

export interface ZipChannelDecision {
  /** 该任务是否**真的**走 zip 整包渠道（`packageUrl` 会被用来下载）。 */
  enabled: boolean;
  /** 命中了更高优先级的代码来源（写面互斥下不可达，真出现时调用方留 ERROR 日志）。 */
  precedenceOverride: 'gitRepo' | 'glueSource' | null;
}

/**
 * 该任务是否走 zip 整包渠道 —— accept 闸与 prepare 下载前的**唯一判据**。
 *
 * 纯函数（无 IO、不读 config），因此可以被表驱动用例逐组合对齐 python 的真值表。
 */
export function isZipChannelEnabled(
  task: Record<string, unknown> | null | undefined,
): ZipChannelDecision {
  const codeSource = readTaskAlias(task, 'codeSource', 'code_source');
  const applicationId = readTaskAlias(task, 'applicationId', 'application_id');
  const packageUrl = readTaskAlias(task, 'packageUrl', 'package_url');
  const glueSource = readTaskAlias(task, 'glueSource', 'glue_source');
  const gitRepo = readTaskAlias(task, 'gitRepo', 'git_repo');

  const explicit = codeSource === 'application_zip';
  const inferred = !codeSource && Boolean(applicationId) && Boolean(packageUrl);
  if (!explicit && !inferred) return { enabled: false, precedenceOverride: null };

  // 优先级 git > glue > application_zip：命中更高优先级来源即让位。
  if (gitRepo) return { enabled: false, precedenceOverride: 'gitRepo' };
  if (glueSource) return { enabled: false, precedenceOverride: 'glueSource' };
  return { enabled: true, precedenceOverride: null };
}
