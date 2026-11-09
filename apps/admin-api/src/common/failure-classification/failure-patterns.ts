import { ExecutionFailureReason } from "../../modules/task/entities/task-execution.entity";

/**
 * 失败分类判据（**单一事实源**）——派发失败路径与回调失败路径共用一份。
 *
 * ## 为什么必须共用一份
 *
 * 失败归因（`failureReason`）决定三件事：**是否烧重试预算**、**用户看到什么**、
 * **运维往哪个方向排障**。而它此前在两条路径上各抄了一份正则链：
 *
 *   · `task.service.ts::inferFailureReason`（**回调路径**）
 *   · `task.processor.ts`（**派发失败路径**）
 *
 * 于是同一个缺陷要修两遍——LANG-ERR-01 复查时就是这个现场：先只修了 service
 * 侧，CI 的 e2e 用例 27 仍红（它走 processor 侧）。更糟的是两处的**规则顺序
 * 不一致**：回调路径没有 `SANDBOX_UNAVAILABLE` / `APPLICATION_MISSING` 两条规则，
 * 派发路径有 ⇒ 同一条失败文案在两条路径上归因不同。
 *
 * 更深一层的漂移源是**文案**：分类判据是**正则匹配用户可见文案**，而文案在
 * 中文化过程中被改写（`执行器→离线` 的间隔从 20 字符涨到 63 字符），于是
 * 「正则容差 < 自家文案长度」这条静默失效。只有当判据与文案**解耦**才不会复发。
 *
 * ## 本模块的三层结构
 *
 *   ① `FAILURE_PATTERNS` —— 判据**常量**（正则），唯一一份。
 *   ② `classifyFailure` —— 唯一的分类**裁决**入口（顺序敏感，注释即规格）。
 *   ③ `classifyFailureByCode` —— **码化优先**：中台自己抛的 `AppError` 走码表，
 *      完全不依赖文案（这是根治文案漂移的那一层）。
 *
 * ## 顺序为什么敏感（**改顺序 = 改语义**，请先读 `classifyFailure` 的注释）
 *
 * 大体规律：**先具体、后笼统**。
 *   · `INTERPRETER_UNAVAILABLE` 必须最先——它的文案天然含 `timeout`
 *     （`interpreter download timeout`）且调用栈含 `ExecutorService...Unavailable`，
 *     先跑 timeout / offline 规则会分别误判成 TIMEOUT / EXECUTOR_OFFLINE。
 *   · `SANDBOX_UNAVAILABLE` 必须在 `EXECUTOR_OFFLINE` 之前——沙箱文案带
 *     `unavailable`，会被 offline 规则吞掉。
 *   · `APPLICATION_MISSING` 必须在 `PACKAGE_FETCH_FAILED` 之前——「应用已删除」
 *     的文案含 `packageUrl`，会被拉包规则吞掉。
 */

/**
 * `interpreter_unavailable` 的判据。
 *
 * 与两侧执行器的分类器（node `prepareFailureReason`、python
 * `_refine_failure_reason`）同源，英中并列（存量未升级执行器发英文、中文化后
 * 的文案发中文；两侧独立发版，滚动升级必然新旧并存）。
 *
 * 覆盖的实测文案（桌面端内置 uv 由 0.8.17 升到 0.13.4 后**逐条复测**）：
 *   `No interpreter found for Python 3.7 in managed installations or search
 *    path`（`uv venv --python 3.7`，exit 2）
 *     ⚠️ 0.8.17 原文案尾部还有 `, or registry`，0.13.4 去掉了。判据只匹配
 *     前缀 `no interpreter found`，故版本差异不影响分类。
 *   `No download found for request: cpython-3.7-<platform>`（`uv python
 *    install 3.7`，exit 2）——0.8.17 与 0.13.4 逐字节一致
 *   `python downloads are set to 'manual'`（`UV_PYTHON_DOWNLOADS=manual`
 *    阻断隐式下载时的提示——该特性刻意设置该 env，故必然出现）
 *
 * 输入已 `.toLowerCase()`；`[^\n]` 容差刻意不跨行，避免把日志里相隔很远的
 * 两个词误判为同一条失败。
 */
export const INTERPRETER_UNAVAILABLE_PATTERN = new RegExp(
  [
    // ① uv 的两条原始文案（措辞固定，最可靠）
    "no interpreter found",
    "no download found",
    "python downloads are set to",
    // ② 解释器词与"不可用/缺失"词相邻（英文；≤40 字符容差覆盖
    //    "interpreter 3.7 unavailable (cache miss + download failed)"）
    "interpreter[^\\n]{0,40}?(?:unavailable|not found|missing|unable)",
    "(?:unavailable|not found|missing|unable)[^\\n]{0,40}?interpreter",
    // ③ 解释器下载/安装失败（含 timeout 措辞）
    "interpreter[^\\n]{0,40}?(?:download|install)[^\\n]{0,40}?(?:fail|timeout|timed out)",
    "(?:download|install)[^\\n]{0,40}?(?:fail|timeout|timed out)[^\\n]{0,40}?interpreter",
    // ④ 中文：解释器 + 无法获取/不可用/缺失/找不到，或 解释器+下载+失败/超时
    "解释器[^\\n]{0,20}?(?:无法获取|不可用|不可获得|缺失|找不到)",
    "解释器[^\\n]{0,20}?下载[^\\n]{0,20}?(?:失败|超时)",
  ].join("|"),
);

/**
 * `executor_offline` 的判据（**单一事实源**）。
 *
 * ## 容差为什么是 120 而不是 20（真实缺陷记录）
 *
 * 中文支原为 `执行器[^\n]{0,20}?…`，而中台自己产出的 pinned 离线文案是
 * `指定的固定执行器 "{{appName}}" ({{executorId}}) 已离线`——「执行器→离线」
 * 间隔实测 **63 字符**（44 + appName 19；executorId 是 36 位 uuid）。20 的容差
 * **短于自家文案** → 规则不命中 → 归因落到 SCRIPT_ERROR：
 *   ① 用户在执行详情页看到「脚本错误」而非「执行器离线」，排障方向被带偏；
 *   ② SCRIPT_ERROR 在**默认重试集**里，白白消耗重试预算。
 *
 * 英文支 `executor.*(offline|unavailable)` 用无界 `.*` 故无此问题——中英容差
 * 不一致本身就是隐患。这里统一取**单行**足够大的界：`[^\n]` 才是真正的精度
 * 护栏（不跨行 ⇒ 不会把日志里相隔很远的两个词连起来，同上方解释器规则的理由）；
 * 同一行内同时出现「执行器」与「离线」几乎必然是离线归因。120 可覆盖 appName
 * 长达 ~56 字符，远超 appName 列宽。
 *
 * ⚠️ 中台自产的 pinned 离线**现已由 `classifyFailureByCode` 直接码化归因**
 * （见 `catalog/executor.ts` 的 `failureReason` 映射），本正则退化为**兜底**
 * （服务旧执行器与无码文案）。
 *
 * ## 为什么 `econnrefused` / `enotfound` 要加 `\b` 词边界（R1 阶段 1 实修）
 *
 * 表驱动测试抓到的**存量缺陷**：原写法 `|enotfound|` 是**裸子串**匹配，而
 * Python 的 `ModuleNotFoundError` 小写后是 `modulenotfounderror`——其中
 * `...lenotfound...`（第 5 字符起）**恰好含 `enotfound`**。于是「依赖没装上」
 * 这类失败被误判成 `executor_offline`：
 *   ① 用户看到「执行器离线」，而真实处置是装依赖/修 requirements，排障方向被带偏；
 *   ② `executor_offline` **不在**不可重试门禁（只有 TIMEOUT / INTERPRETER_UNAVAILABLE /
 *      SANDBOX_UNAVAILABLE 在）⇒ 白白烧重试预算；
 *   ③ 它还会**先于** `PACKAGE_FETCH_PATTERN` 命中，让 `module not found` 那句
 *      判据形同虚设（那条规则本意就是接住这一类）。
 * 加 `\b` 后 `modulenotfounderror` 不再命中（`e` 前是字母 `l`，非词边界），
 * 而真实 DNS 错误 `getaddrinfo ENOTFOUND` / `connect ECONNREFUSED` 仍然命中。
 */
export const EXECUTOR_OFFLINE_PATTERN =
  /executor.*(offline|unavailable)|no available executor|\beconnrefused\b|\benotfound\b|network error|socket hang up|无可用执行器|没有可用(?:的)?执行器|执行器[^\n]{0,120}?(?:离线|不可用|不可达)/i;

/**
 * `sandbox_unavailable` 的判据——与两侧执行器的沙箱分类器同源，英中并列。
 *
 * 主路径其实不靠本规则：执行器在**执行期** fail-closed 时，经回调结构化上报
 * `failureReason=sandbox_unavailable`，回调路径直接采信 `cb.failureReason`。
 * 本规则服务的是**派发失败路径**——旧执行器的 prepare 失败曾以同步 HTTP 错误
 * 反馈（node execute.ts 自述「原实现经 HTTP 500 反馈，现已 accepted」），以及
 * 被包装过的异常文案。没有这条，`bwrap` / `TASK_SANDBOX` 文案会落到 UNKNOWN，
 * 而 UNKNOWN 在默认口径下**可重试**，于是「环境类失败不烧重试预算」的门禁永远
 * 不会触发。
 *
 * 位置：紧接 TIMEOUT 之后、EXECUTOR_OFFLINE 之前（理由见 `classifyFailure`）。
 *
 * 判据为什么**不写成 `/sandbox/i` 或 `\bsandbox\b`**：本规则的输入是
 * `failureText = errMsg + "\n" + errStack`，而 `\bsandbox\b` 会命中**栈里的模块
 * 路径**（`.../sandbox.ts:12` 这类，`.` 是词边界）。一次瞬时的派发失败若恰好
 * 从名字带 sandbox 的模块抛出，就会被判成「环境类不可重试」——方向上是把
 * **可恢复**的失败拒掉，比漏判更贵（静默少一次重试 = 静默少一次成功）。
 * 故只认能指认「任务沙箱这一件事」的令牌：结构化 token、环境变量名、英文整词
 * 短语、二进制名、中文词。**若将来新增沙箱类文案，先确认它带这些令牌**。
 */
export const SANDBOX_UNAVAILABLE_PATTERN =
  /sandbox_unavailable|task_sandbox|task sandbox|sandbox (?:is )?(?:unavailable|not available|disabled|missing)|bwrap|沙箱/i;

/**
 * `application_missing` 的判据——「引用了已被删除的应用」。
 *
 * 必须在 PACKAGE_FETCH 规则**之前**：此前该错误落 UNKNOWN（消息是
 * `Cannot resolve packageUrl ... application <uuid> not found`，不含
 * package fetch / download package 等关键词），用户看到「未知原因，去翻执行
 * 日志」——而原因是 100% 已知且可行动的（引用了一个已被删除的应用）。
 */
export const APPLICATION_MISSING_PATTERN =
  /cannot resolve packageurl|application\s+\S+\s+not found|无法解析\s*packageurl|应用\s*\S*\s*不存在|找不到应用/i;

/** `timeout` 判据（英中并列）。 */
export const TIMEOUT_PATTERN =
  /timeout|timed out|etimedout|execution timed|超时|执行已超时/i;

/**
 * `package_fetch_failed` 判据（英中并列）。
 *
 * ⚠️ `module not found` / `cannot find module` **必须**在列：它们是 Python 侧的
 * 依赖缺失原文（`ModuleNotFoundError: No module named 'xxx'`）。此前**回调路径**
 * 有这两条、**派发路径**没有 ⇒ 同一条「依赖没装上」的失败在两条路径上归因不同
 * （回调落 PACKAGE_FETCH_FAILED，派发落 SCRIPT_ERROR）。
 *
 * ⚠️ `modulenotfounderror` / `no module named` **也必须在列**（R1 阶段 1 实修）：
 * 节点原文案是 `ModuleNotFoundError: No module named 'x'`，它**不含空格分隔的**
 * `module not found`（是连写的 `modulenotfounderror`），故只写 `module not found`
 * **根本接不住这一类**。此前它靠 `EXECUTOR_OFFLINE_PATTERN` 里的裸子串
 * `enotfound` **误打误撞**命中，归成 `executor_offline`（可重试，烧预算）。
 * 那边加了 `\b` 词边界修掉误判后，这一类必须由**本条**正式接住，否则会落到
 * `script_error`（同样可重试，且把用户引向"查自己脚本"的错误方向）。
 */
export const PACKAGE_FETCH_PATTERN =
  /git clone|package fetch|pull package|download package|npm install|pip install|requirements|dependency|module not found|cannot find module|modulenotfounderror|no module named|拉取(?:应用包|依赖|代码)|克隆代码|下载(?:应用包|依赖|包)|依赖安装|安装依赖|代码拉取/i;

/** `script_error` 判据（英中并列）。 */
export const SCRIPT_ERROR_PATTERN =
  /traceback|syntaxerror|referenceerror|typeerror|uncaught|exception|command failed|exit code|脚本(?:错误|异常)|命令执行失败/i;

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
 * 中台错误码 → 失败原因（**码化优先**）。
 *
 * 为什么需要这张表：分类判据是**正则匹配用户可见文案**，而文案在改写（中文化、
 * 措辞优化）时会**静默**让正则失效——本仓已因此发生过两次真实误报
 * （`EXECUTOR_OFFLINE_PATTERN` 中文支容差 20 < 自家文案 63 → pinned 离线被
 * 归成 `script_error`，且 `script_error` 在默认重试集里 → 白白烧重试预算）。
 *
 * 中台自己抛的失败（`AppError`）**知道自己的业务码**，不该再经过文案二次
 * 猜测。故：码表命中的走**确定性归因**，文案正则退化为兜底。
 *
 * 码表本身放在 `common/errors/catalog/executor.ts`（与错误码目录同处一地），
 * 本模块只读它——**双向都要有**，但**本表是唯一裁决入口**。
 */
import { ERROR_CODE_FAILURE_REASON } from "../../common/errors/error-code-failure-reason";

/**
 * 裁决失败原因（**两条失败路径的唯一入口**）。
 *
 * 规则顺序是**规格的一部分**，改顺序 = 改语义。理由逐条写在各分支注释里。
 *
 * @param input 失败上下文（两条路径统一形状）
 * @returns 失败原因枚举值
 */
export function classifyFailure(
  input: ClassifyFailureInput,
): ExecutionFailureReason {
  // ① **码化优先**：中台自产失败 → 直接映射，**完全跳过文案正则**。
  //    这是根治「文案改写导致分类静默失效」的那一层。
  if (input.errorCode) {
    const mapped = ERROR_CODE_FAILURE_REASON[input.errorCode];
    if (mapped) {
      return mapped;
    }
  }

  const text = [input.errorMessage, input.logs]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();

  // ② `interpreter_unavailable` 必须是**第一条**规则（兜底分类）。
  //
  //    为什么必须最先：解释器不可获取的文案天然含 `timeout`
  //    （`interpreter download timeout`），且调用栈含
  //    `ExecutorService.failInterpreterUnavailable`——`/executor.*(offline|
  //    unavailable)/i` 会从 `ExecutorService...Unavailable` 命中并把本类失败
  //    误判成 EXECUTOR_OFFLINE，后果是：① D14 明确 interpreter_unavailable
  //    不进默认重试集，误判后却触发重试（解释器不会凭空出现，白白烧重试预算）；
  //    ② failureReason 记成 executor_offline，误导运维排查方向（以为是执行器
  //    离线，实际是解释器缺失）。同时必须先于 timeout 规则。
  if (INTERPRETER_UNAVAILABLE_PATTERN.test(text)) {
    return ExecutionFailureReason.INTERPRETER_UNAVAILABLE;
  }

  // ③ `application_missing` 必须在 PACKAGE_FETCH 规则**之前**（见常量注释）。
  if (APPLICATION_MISSING_PATTERN.test(text)) {
    return ExecutionFailureReason.APPLICATION_MISSING;
  }

  // ④ TIMEOUT。
  if (TIMEOUT_PATTERN.test(text)) {
    return ExecutionFailureReason.TIMEOUT;
  }

  // ⑤ `sandbox_unavailable`——必须在 EXECUTOR_OFFLINE 之前（沙箱文案带
  //    `unavailable`，会被离线规则吞掉）。
  if (SANDBOX_UNAVAILABLE_PATTERN.test(text)) {
    return ExecutionFailureReason.SANDBOX_UNAVAILABLE;
  }

  // ⑥ `executor_offline`（兜底；中台自产的已由 ① 码化直判）。
  if (EXECUTOR_OFFLINE_PATTERN.test(text)) {
    return ExecutionFailureReason.EXECUTOR_OFFLINE;
  }

  // ⑦ `package_fetch_failed`（含 `module not found` / `cannot find module`）。
  if (PACKAGE_FETCH_PATTERN.test(text)) {
    return ExecutionFailureReason.PACKAGE_FETCH_FAILED;
  }

  // ⑧ `script_error`：退出码非 0 是**充分**证据（无 exitCode 时才看文案）。
  if (typeof input.exitCode === "number" && input.exitCode !== 0) {
    return ExecutionFailureReason.SCRIPT_ERROR;
  }
  if (SCRIPT_ERROR_PATTERN.test(text)) {
    return ExecutionFailureReason.SCRIPT_ERROR;
  }

  // ⑨ 兜底。
  return ExecutionFailureReason.UNKNOWN;
}
