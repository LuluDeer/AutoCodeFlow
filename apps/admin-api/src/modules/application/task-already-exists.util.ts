/**
 * LANG-ERR-01（D 项）：**按错误码判定「任务已存在」**，文本匹配仅作兜底。
 *
 * ## 为什么需要它（文本匹配是脆弱设计）
 *
 * 应用清单的自动注册会把「任务已存在」当作**正常跳过**（warn），其它错误才是
 * error 级故障。首版判据是 `msg.includes("already exists") || msg.includes("已存在")`
 * ——**按文案分类**。这在「全量错误码化」之后成了结构性缺陷：
 *
 *   1. 文案是**可翻译**的。今天的中文、昨天的英文、明天的任何措辞都会改变匹配
 *      结果，而分类判据不该随译文漂移；
 *   2. 本仓真实踩过一次**静默降级**：中文化改造把「已存在」类消息从英文改成中文，
 *      只留英文支的匹配随即失效，于是「正常跳过」被误报成 error 级故障——没有任何
 *      编译错误、没有测试失败，只是日志级别悄悄变了；
 *   3. `includes("已存在")` 还会**误伤**：任何正文里恰好含这三个字的其它错误
 *      （例如「无法回滚…名称已被其它任务占用」这类**真故障**）也会被判成「跳过」，
 *      把故障吞掉。这是比漏报更危险的**假阴性**。
 *
 * 现在 `task.service.ts` 的抛出形态是 `AppError`，携带**稳定码**。故判据改成：
 *
 *   · **① 按码**（首选）：`err instanceof AppError` 且码属于「名称/ID 已被占用」
 *     这一族 → 跳过。码是稳定标识符，与语言、措辞、版本全无关；
 *   · **② 按文本**（兜底）：仅用于**非 AppError** 的路径——旧版副本
 *     （滚动升级期间仍在跑）、以及第三方/底层库抛出的错误。**英文与中文并列**，
 *     因为存量日志与旧副本都是英文。
 *
 * ## 为什么把「一族码」而非单个码写进来
 *
 * 本仓有 4 个语义各异的「占用」码，且**刻意不合并**（处置动作不同，见
 * `catalog/task.ts` 里 TASK_NAME_TAKEN 的说明）：
 *   · `TASK_ID_EXISTS`            —— 显式 id 撞车；
 *   · `TASK_NAME_EXISTS`          —— 普通重名；
 *   · `TASK_NAME_TAKEN`           —— 重名且可能是回收站占用（提示去回收站找）；
 *   · `TASK_ROLLBACK_NAME_TAKEN`  —— 回滚时目标版本的名字被占。
 * 对**本判据**（"这次注册要不要当正常跳过"）而言四者同解，故并列；
 * 但对**用户提示**而言它们必须保持不同，故码不合并。
 *
 * ⚠️ 新增「占用」类码时**必须同步加进本表**：漏加不会报错，只会让该场景退回
 * 文本兜底——而中文文案一旦变化，兜底就失效，又变回静默降级。故本文件带一条
 * 自检用例（`catalog` 里名字含 EXISTS/TAKEN 的码必须都在表内）。
 */

/** 「任务名/ID 已被占用」这一族的稳定码。 */
export const TASK_ALREADY_EXISTS_CODES: readonly string[] = [
  "TASK_ID_EXISTS",
  "TASK_NAME_EXISTS",
  "TASK_NAME_TAKEN",
  "TASK_ROLLBACK_NAME_TAKEN",
  // 模板实例化/模板键占用：应用清单的自动注册也会走模板路径，
  // 这两个码同样表示「目标任务名/键已存在」，处置同「跳过」。
  "TASK_TEMPLATE_KEY_EXISTS",
  "TASK_TEMPLATE_INSTANTIATE_NAME_TAKEN",
];

/**
 * 文本兜底判据（仅用于非 `AppError` 路径）。
 *
 * 英文支**不是权宜**：两侧独立发版，滚动升级期间旧副本仍抛英文；且
 * `task_executions.errorMessage` 里**已落库的历史值**也是英文。
 * 中文支覆盖中文化之后的直接文本抛出路径。
 *
 * 措辞刻意收得比首版**更严**：只认「already exists」与「已存在」，不认宽泛的
 * 「exists」——后者会把「version does not exist」这类真故障误判成跳过。
 */
const TEXT_FALLBACK_PATTERNS: readonly string[] = ["already exists", "已存在"];

/**
 * 判定一个注册失败是否属于「任务已存在，正常跳过」。
 *
 * ## ⚠️ 为什么「有码但不在族内」必须**直接判 false**，不能继续走文本兜底
 *
 * 这是本判据最容易写错的一处，由 `task-already-exists.util.spec.ts` 抓出：
 * 首版写成「码命中 → true；否则走文本匹配」。于是当 `AppError` 的码**不在族内**
 * 但渲染出的 message **恰好含「已存在」**时（例如
 * `TASK_VERSION_ID_NOT_FOUND` 的文案是「依赖值必须是已存在的任务 ID」），
 * 文本兜底会把它判成「跳过」，**真故障被吞掉**。
 *
 * 码是**权威**：一旦异常带码，它的语义就由码决定，文案只是给人读的渲染结果。
 * 故：有码 → 只看码（在族内 true，否则 false，**不回落文本**）；
 * 无缝可依（非 AppError：旧副本 / 底层库）才用文本。
 *
 * @param err 捕获到的未知错误。
 */
export function isTaskAlreadyExistsError(err: unknown): boolean {
  // ① 首选：稳定错误码（本仓自己的抛出形态，与语言无关）。
  const code = (err as { errorCode?: unknown } | null | undefined)?.errorCode;
  if (typeof code === "string" && code !== "") {
    // 有码即**以此为准**——绝不回落文本（回落会误吞真故障，见上方说明）。
    return TASK_ALREADY_EXISTS_CODES.includes(code);
  }
  // ② 兜底：**仅**无码路径（旧副本 / 底层库）走中英并列文本匹配。
  const msg = err instanceof Error ? err.message : String(err);
  return TEXT_FALLBACK_PATTERNS.some((p) => msg.includes(p));
}
