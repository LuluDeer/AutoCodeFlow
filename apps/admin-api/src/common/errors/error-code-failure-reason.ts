import { ExecutionFailureReason } from "../../modules/task/entities/task-execution.entity";

/**
 * 中台错误码 → 失败原因（**码化优先**的事实源）。
 *
 * ## 为什么需要这张表
 *
 * 失败归因的判据此前是**正则匹配用户可见文案**。文案是会变的（中文化、措辞
 * 优化、i18n 改写），而正则的容差是**手调的魔数**——两者一旦漂移，分类就会
 * **静默**失效。本仓已因此发生过两次真实误报：
 *
 *   ① `EXECUTOR_OFFLINE_PATTERN` 的中文支容差是 20 字符，而中台自己产出的
 *      pinned 离线文案里「执行器→离线」实测间隔 **63 字符** → 规则不命中 →
 *      归因落到 `script_error`。后果有二：用户在执行详情页看到「脚本错误」而
 *      不是「执行器离线」，排障方向被带偏；`script_error` 又在**默认重试集**
 *      里，白白烧掉重试预算。
 *   ② `INTERPRETER_UNAVAILABLE_PATTERN` 曾在两个分类器里各抄了一份，一处
 *      改了另一处没改 → 解释器缺失被误判成 `executor_offline`。
 *
 * 中台自己抛的失败**知道自己是什么**（`AppError.errorCode`），不该再经过文案
 * 二次猜测。故：命中本表的码走**确定性归因**（不看文案），未命中的码继续走
 * 文案兜底。
 *
 * ## 收录判据（**刻意从严**，这是本表能被信任的前提）
 *
 * 一条码进本表，必须**同时**满足三条：
 *
 *   1. **是「执行」的失败**，不是请求校验/权限/资源不存在类的失败（后者根本
 *      不会走到失败分类，收进来只是噪音）。
 *   2. **归因结论不依赖文案**：换一种语言、换一句措辞，结论不变。
 *   3. **不改变重试/排队语义**——或改变是明确想要的。
 *
 * 第 3 条最容易踩坑：`failureReason` 不只是给人看的标签，它还决定
 *   · 是否进 `UnrecoverableError` 门禁（不烧重试预算）；
 *   · 互斥组任务是否**回 WAITING 等唤醒**而不是烧预算后落死（见
 *     `task.processor.ts` 的互斥回队门）。
 * 所以「映射得更准」不等于「可以随便映射」。
 *
 * ## 已知候选与**刻意不收录**的理由（评审时勿误判为漏项）
 *
 * | 码 | 为什么不进表 |
 * |---|---|
 * | `PINNED_EXECUTOR_NOT_FOUND` | 语义是「pin 的目标行已不存在」，**没有**对应的 `failureReason` 枚举值；原实现刻意留 UNKNOWN（`executor.service.ts` 有注释：归 `EXECUTOR_OFFLINE` 是**说谎**——它从未注册过）。硬塞进本表会制造一个新的错误归因。 |
 * | `NO_EXECUTOR_MATCHING_FILTERS` | 归 `executor_offline` 看似更准，但它会**静默改变互斥组任务的语义**：互斥任务命中 `executor_offline` 即回 WAITING 等唤醒（每 10s 重试），而「没有执行器匹配 group/tags/runtime」可能是**永久性**配置错误（永远不会自愈）⇒ 执行会无限排队而不是落死。要改这条必须同时设计「排队超时」，属独立立项。 |
 * | `BROADCAST_DISPATCH_ALL_FAILED` / `NO_BROADCAST_EXECUTOR` | 同上：广播任务的失败语义与重试门禁耦合，改归因需同步评审。 |
 * | `TASK_SECRET_DECRYPT_FAILED` | 是**凭据配置**问题（人工重新加密），与本次执行的代码/环境无关。归 `script_error` 会污染「脚本错误」这个面向用户的类别，归 UNKNOWN 则维持现状——两者都不是好答案，应另立一个 `config_error` 类枚举（需产品拍板）。 |

 * ## 维护约定
 *
 * · 新增映射**必须**在 `catalog/executor.ts` 的对应码注释里回指本表，让两处能
 *   互相追溯（改码表时不会漏）。
 * · 新增映射**必须**配一条表驱动单测（码 → 原因），并**同时**补一条「文案
 *   被改写后结论不变」的用例（这正是码化优先的价值所在）。
 */
export const ERROR_CODE_FAILURE_REASON: Readonly<
  Record<string, ExecutionFailureReason>
> = {
  /**
   * 指定的固定执行器**已离线** → `executor_offline`。
   *
   * 这条映射是**码化优先的样板**，也是本表当前唯一一条：文案里
   * 「执行器→离线」的间隔随 appName 长度变化（实测 63 字符），任何手调容差
   * 都会在 appName 更长时**再次**失效；而码是稳定的，与文案长度**完全解耦**。
   *
   * 语义确认（满足收录判据第 3 条）：映射前后都归 `executor_offline`，
   * **重试/排队语义逐字不变**——变的只是「不再依赖正则命中」。故这是纯粹的
   * 健壮性提升，零行为变更。
   */
  PINNED_EXECUTOR_OFFLINE: ExecutionFailureReason.EXECUTOR_OFFLINE,
};
