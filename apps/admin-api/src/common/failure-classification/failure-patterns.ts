import { ExecutionFailureReason } from "../../modules/task/entities/task-execution.entity";
import { ERROR_CODE_FAILURE_REASON } from "../../common/errors/error-code-failure-reason";
import { classify as classifyByProtocol } from "./generated/failure-classifier";

/**
 * 失败归因 wrapper（**两条失败路径的唯一入口**）。
 *
 * ## 本模块的三层结构（与旧版的区别）
 *
 *   ① **文本判据**已迁到协议生成物
 *      `./generated/failure-classifier.ts::classify(parts, 'admin')`——规则表、顺序、
 *      归一、sentinel 全部由 `protocol.json` 的 `failureReason.classifiers` 段生成，
 *      本文件的裁决链**不再使用任何手写正则**（下方兼容导出仅服务既有 import）。
 *   ② **非文本判据**仍在本 wrapper 内，且保持原优先级：errorCode 码化优先 →
 *      no-matching-executor → 生成物文本分支 → exitCode 非零 → unknown 兜底。
 *   ③ `classifyFailure` 是派发失败路径与回调失败路径共用的裁决入口。
 *
 * ## 为什么文本分支和非文本分支分开
 *
 * 文本规则要跨 node / python / admin 三端逐字等价，必须由契约生成物统一提供；
 * 而 errorCode（中台自产失败码）、exitCode（子进程退出状态）、no-matching-executor
 * （协议规则表刻意不收的派发族）都不是「文本」，硬塞进生成物会破坏其纯文本契约。
 * 因此 wrapper 只做**非文本判据 + 生成物调用**，不做文本模式匹配（唯一例外是
 * no-matching-executor，见其常量注释）。
 *
 * ## 顺序为什么敏感（**改顺序 = 改语义**）
 *
 *   · `errorCode` 必须最先：码化归因与文案长度/措辞彻底解耦（历史事故：pinned
 *     离线文案「执行器→离线」间隔随 appName 变化，正则容差追不上）。
 *   · `no-matching-executor` 必须在生成物文本分支之前：派发失败栈首
 *     `ServiceUnavailableException` 的 `exception` 令牌会被生成物的 script_error
 *     规则吞成 `script_error`（D-1 实测现场），且该族刻意不进 executor_offline
 *     （避免互斥组无限排队）。
 *   · `exitCode` 必须在生成物文本分支之后：更具体的文本规则（如 timeout、
 *     package_fetch_failed）优先于「非零退出码 ⇒ script_error」的充分证据。
 */

// ── 兼容导出（**不参与裁决**）───────────────────────────────────────────────
//
// 以下 7 个正则常量是**旧手写规则表的遗存**：`task.service.ts` 的 re-export 与若干
// 既有 spec 仍从本模块 import 它们（写域不含那些消费方，故不能删 export）。
// 自本次切换起，`classifyFailure` 的**文本判据全部走协议生成物**，这些常量仅保留
// 为外部可见契约面，**不得**在新代码里作为裁决入口使用；要改文本规则请改 protocol.json。
//
// 保留原正则逐字不变，因此依赖它们的 spec（长度、CJK、词边界等断言）继续有效。

/** `interpreter_unavailable` 的旧判据（兼容导出；裁决已走生成物）。 */
export const INTERPRETER_UNAVAILABLE_PATTERN = new RegExp(
  [
    "no interpreter found",
    "no download found",
    "python downloads are set to",
    "interpreter[^\\n]{0,40}?(?:unavailable|not found|missing|unable)",
    "(?:unavailable|not found|missing|unable)[^\\n]{0,40}?interpreter",
    "interpreter[^\\n]{0,40}?(?:download|install)[^\\n]{0,40}?(?:fail|timeout|timed out)",
    "(?:download|install)[^\\n]{0,40}?(?:fail|timeout|timed out)[^\\n]{0,40}?interpreter",
    "解释器[^\\n]{0,20}?(?:无法获取|不可用|不可获得|缺失|找不到)",
    "解释器[^\\n]{0,20}?下载[^\\n]{0,20}?(?:失败|超时)",
  ].join("|"),
);

/** `executor_offline` 的旧判据（兼容导出；裁决已走生成物）。 */
export const EXECUTOR_OFFLINE_PATTERN =
  /executor.*(offline|unavailable)|no available executor|\beconnrefused\b|\benotfound\b|network error|socket hang up|无可用执行器|没有可用(?:的)?执行器|执行器[^\n]{0,120}?(?:离线|不可用|不可达)/i;

/** `sandbox_unavailable` 的旧判据（兼容导出；裁决已走生成物）。 */
export const SANDBOX_UNAVAILABLE_PATTERN =
  /sandbox_unavailable|task_sandbox|task sandbox|sandbox (?:is )?(?:unavailable|not available|disabled|missing)|bwrap|沙箱/i;

/** `application_missing` 的旧判据（兼容导出；裁决已走生成物）。 */
export const APPLICATION_MISSING_PATTERN =
  /cannot resolve packageurl|application\s+\S+\s+not found|无法解析\s*packageurl|应用\s*\S*\s*不存在|找不到应用/i;

/** `timeout` 的旧判据（兼容导出；裁决已走生成物）。 */
export const TIMEOUT_PATTERN =
  /timeout|timed out|etimedout|execution timed|超时|执行已超时/i;

/** `package_fetch_failed` 的旧判据（兼容导出；裁决已走生成物）。 */
export const PACKAGE_FETCH_PATTERN =
  /git clone|package fetch|pull package|download package|npm install|pip install|requirements|dependency|module not found|cannot find module|modulenotfounderror|no module named|拉取(?:应用包|依赖|代码)|克隆代码|下载(?:应用包|依赖|包)|依赖安装|安装依赖|代码拉取/i;

/** `script_error` 的旧判据（兼容导出；裁决已走生成物）。 */
export const SCRIPT_ERROR_PATTERN =
  /traceback|syntaxerror|referenceerror|typeerror|uncaught|exception|command failed|exit code|脚本(?:错误|异常)|命令执行失败/i;

/**
 * 「无匹配过滤器的在线执行器」判据（码化通道之外，服务旧执行器与裸 Error）。
 *
 * 协议 `failureReason.classifiers` 的文本规则表**刻意不含**本族：它与
 * `executor_offline` 的 `no available executor` 族刻意分开：
 *   · `no available executor`（整机队下线/离线，可自愈）→ `executor_offline`；
 *   · `no online executor matches …filters`（group/tags/runtime 无匹配，可能是永久
 *     配置错误）→ `UNKNOWN`，不进互斥 WAITING 回队门。
 * 有结构化码时 `NO_EXECUTOR_MATCHING_FILTERS` 由 ① 码化直判；本正则只兜底裸 Error。
 */
export const NO_MATCHING_EXECUTOR_PATTERN =
  /no online executors? matches? the requested|没有在线执行器匹配所请求的|没有执行器匹配所请求/i;

/** 分类入参（两条路径共用同一形状）。 */
export interface ClassifyFailureInput {
  /** 错误文案（`err.message` 或回调的 `errorMessage`）。 */
  errorMessage?: string | null;
  /** 日志正文（回调路径有；派发路径传 `err.stack`）。 */
  logs?: string | null;
  /** 进程退出码（回调路径有；非 0 且无其它命中时兜底判 SCRIPT_ERROR）。 */
  exitCode?: number;
  /**
   * 中台自产失败码（`AppError.errorCode`）——**码化优先**通道。
   *
   * 传了且码表里有映射 ⇒ **直接归因，不看文案**（根治文案漂移的那一层）。
   */
  errorCode?: string | null;
}

/**
 * 生成物返回的码 → `ExecutionFailureReason`。
 *
 * 生成物的码取自 `protocol.json` 的 `failureReason.all`，与枚举逐字同源；这里只做
 * 一次运行时白名单校验，避免生成物未来多返回一个未知 token 时静默落 undefined。
 */
function toFailureReason(code: string | null): ExecutionFailureReason | null {
  if (code === null) return null;
  const valid = Object.values(ExecutionFailureReason) as string[];
  return valid.includes(code) ? (code as unknown as ExecutionFailureReason) : null;
}

/**
 * 裁决失败原因（**两条失败路径的唯一入口**）。
 *
 * @param input 失败上下文（两条路径统一形状）
 * @returns 失败原因枚举值
 */
export function classifyFailure(
  input: ClassifyFailureInput,
): ExecutionFailureReason {
  // ① **码化优先**：中台自产失败 → 直接映射，**完全跳过文案**。
  //    这是根治「文案改写导致分类静默失效」的那一层。
  if (input.errorCode) {
    const mapped = ERROR_CODE_FAILURE_REASON[input.errorCode];
    if (mapped) {
      return mapped;
    }
  }

  const parts = [input.errorMessage, input.logs].filter(
    (p): p is string => typeof p === "string" && p !== "",
  );
  const text = parts.join("\n").toLowerCase();

  // ② no-matching-executor：协议文本规则表不收本族，必须在生成物 script_error
  //    之前拦截（栈首 `ServiceUnavailableException` 的 `exception` 令牌会误吞）。
  if (NO_MATCHING_EXECUTOR_PATTERN.test(text)) {
    return ExecutionFailureReason.UNKNOWN;
  }

  // ③ **文本分支**：协议生成物的 admin 阶段（永远返回一个码）。
  const fromText = toFailureReason(classifyByProtocol(parts, "admin"));
  // `admin` 阶段未命中时生成物返回兜底码 `unknown`；它不是具体文本规则，不能
  // 抢在 exitCode 之前吃掉「非零退出码 ⇒ script_error」这条契约外判据。
  if (
    fromText !== null &&
    fromText !== ExecutionFailureReason.UNKNOWN
  ) {
    return fromText;
  }

  // ④ exitCode 非零是**充分**证据，但必须在更具体的文本规则之后（见顶部注释）。
  if (typeof input.exitCode === "number" && input.exitCode !== 0) {
    return ExecutionFailureReason.SCRIPT_ERROR;
  }

  // ⑤ 文本生成物的兜底码（unknown）或最终兜底。
  return fromText ?? ExecutionFailureReason.UNKNOWN;
}
