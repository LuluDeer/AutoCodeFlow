/**
 * 执行器域的 file 级常量（单一事实源）。
 *
 * ## 为什么单独成文件（B0 拆分的第 1 步）
 *
 * `executor.service.ts` 曾同时承载「行为实现」与「跨文件共享的常量/白名单」。
 * 后者是**其它文件直接 import 的公共契约**（executor.controller.ts 的对账窗口
 * 与 picker 上限、若干 spec 的口径断言），把它埋在 8000 行 service 的中部让
 * 「谁定义、谁消费」要靠全文搜索才能确认。本文件把这类**纯值**集中，行为
 * 实现留在 service。
 *
 * ## 不变量（搬移时必须逐字保持）
 *
 * - **值一律不变**：任何改值都是行为变更，不属本次搬移的范围。
 * - **导出的可见性不变**：搬之前 `export` 的搬之后仍 `export`（外部 import
 *   路径由 `executor.service.ts` 继续 re-export，见该文件顶部的 re-export 块）。
 * - **注释一并搬运**：每条常量的推导依据（为什么是 5 分钟而不是 0、为什么
 *   picker 上限比 list 上限宽）写在注释里，丢掉注释等于丢掉决策依据。
 *
 * ## 刻意留在 service 的东西
 *
 * - `HEARTBEAT_OWNED_COLUMNS` / `REGISTER_OWNED_COLUMNS`：它们是**写面白名单**，
 *   与 `pickOwnedColumns` 的类型 `HeartbeatOwnedColumn` / `RegisterOwnedColumn`
 *   构成一对（`typeof` 推导），搬开会割裂这对类型关系；且它们的消费方全在
 *   service 内部（register / heartbeat 两个写面），不是跨文件契约。
 * - `lastTruncationWarn` / `lastMissingFingerprintWarn` /
 *   `lastConflictSelfReportSuppressedWarn`：**模块级可变状态**（跨心跳共享的
 *   节流表），不是常量；且它们的 `__reset*ForTest` 测试出口被 4 个 spec import，
 *   搬动会破坏测试契约（模块级 Map 跨用例残留会形成隐性顺序依赖）。
 */

/**
 * A6（DEEP_REVIEW §七）：死信对账窗口的上界。
 *
 * 对账是**执行器主动拉**的：一台执行器在死信堆积时会反复来问。若不设上界，
 * 一个写坏的 since（或一台时钟错乱的执行器）就能让 admin 去扫整张
 * task_executions。30 天足够覆盖最长场景——死信文件本身会被执行器侧 TTL
 * 清理（node: removeOlderThan；python: _cleanup_dead_letter_files），活不过
 * 30 天。超过上界的 since 被**钳到**上界（不是报错）：对账是尽力而为的
 * 后台动作，因为参数写错就让整个对账停摆比多扫一点更糟。
 */
export const TERMINAL_STATES_MAX_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
/** 单页默认/最大条数。hasMore=true 时执行器下一轮继续取。 */
export const TERMINAL_STATES_DEFAULT_LIMIT = 500;
export const TERMINAL_STATES_MAX_LIMIT = 2000;
/**
 * since 缺省/非法时的回退窗口。取 24h 是为了与 E-05 的重发预算同量级：比一个
 * 预算期更早终态的执行，其死信文件在执行器侧早已被 TTL 清理（node
 * removeOlderThan / python _cleanup_dead_letter_files），对账它没有意义。
 */
export const TERMINAL_STATES_DEFAULT_LOOKBACK_MS = 24 * 60 * 60 * 1000;

/**
 * Executor lifecycle audit（P3-9）：findAll() 的硬上限。管理台列表的筛选/
 * 搜索/计数全部在客户端对返回数组做，超过该上限的行会被**静默截断**——
 * 因此该值同时经 GET /executors/runtime-config 暴露给前端，让 UI 能给出
 * "仅显示前 N / 共 M 台"的提示，而不是把子集说成全量。需要更多行时应做
 * 服务端分页（见 findAll 注释）。
 */
export const EXECUTOR_LIST_LIMIT = 500;

/**
 * P1-A（2026-10-25 真机审计）：push 地址「死行接管」所需的静默窗（毫秒）。
 *
 * 场景：容器化执行器重建后安装身份漂移（指纹盐/容器 MAC 不落卷），新指纹
 * 撞上同地址的旧真实指纹行 → register/token 恒 409（旧判定把「同机重装」
 * 误判成「另一份安装占用」），执行器永远拿不回自己的行。接管的前置是占位行
 * 已被 stale sweep 判死（status=OFFLINE，自身约需判死窗 = 心跳超时 × 确认
 * 轮数 ≈ 3 分钟）——本静默窗在其上再加一段，双保险覆盖「容器重启耗时 +
 * 判死后短暂网络分区恢复」两类边界：静默不足 5 分钟不许接管。
 *
 * 可经 `executor.addressTakeoverSilenceMs` 覆盖（非法值回退本缺省，与
 * `executor.staleOfflineConfirmations` 同款纪律）。测试无需等待——用例把
 * 行的 lastHeartbeat/updatedAt 回拨即可立即命中。
 *
 * ⚠️ E-8（2026-10-26 执行器域审计）：**不要把覆盖值配成 0**。0 是合法值
 * （resolveAddressTakeoverSilenceMs 的 `>= 0` 判定）= 静默窗退化为零——
 * 接管的剩余前置只剩 `status=OFFLINE` 单闸，而 stale sweep 的判死只代表
 * 「两个心跳超时窗无心跳」：一次约 3 分钟的网络分区（两台机器、NAT 表项
 * 更替、VPN 重连）就足以让活安装被判死并立即被同地址的新安装（或攻击者
 * 的注册请求）接管，旧进程回来后进入 401 自愈风暴（与 P1-A 的 789 次重试
 * 同形）。建议 ≥60_000（1 分钟，覆盖「判死后立即重启」的正常重装节奏，
 * 又不至于让自愈明显变慢）；默认 5 分钟是「正常重装 < 5min 完成的概率
 * 极低」与「攻击者窗口最小化」的折中。
 */
export const EXECUTOR_ADDRESS_TAKEOVER_SILENCE_MS = 5 * 60_000;

/**
 * 执行器选择器（executor picker，GET /executors/picker）的硬上限。
 *
 * 为什么与 EXECUTOR_LIST_LIMIT 不是同一个值：findAll() 回**全列实体投影**
 * （interpreters / runningExecutionIds ≤10000 条的数组列 / tags / 心跳元数据…），
 * 单行重，500 是它的载荷护栏；picker 只回部署下拉（AppDeploymentPage 部署
 * 模态 / ApplicationListPage 快速部署）实际消费的 6 个轻列（见
 * findPickerOptions），单行轻一个数量级以上，2000 行的总载荷仍小于 findAll
 * 的 500 行全列——上限据此放宽。
 *
 * 超限**绝不静默**：findPickerOptions() 以 `truncated: true` + 全量 `total`
 * 显式上报，前端在选择器里展示「共 total 台，仅显示前 limit 台」告警（复用
 * execList.truncated 文案）。选择器的搜索是前端对返回数组做的客户端过滤——
 * 静默截断等于对被截掉的执行器假阴性（搜不到真实存在的机器），这正是本端点
 * 要修的缺陷形态，故截断必须可见。
 */
export const EXECUTOR_PICKER_LIMIT = 2000;
/** AgentHost 每 30 秒续报；两分钟无续报则撤去全部协作能力。 */
export const AGENT_CAPABILITIES_LEASE_MS = 2 * 60 * 1000;

/**
 * ⚠️ **刻意不搬走的常量（源码文本契约闸）**：`MAX_RUNNING_EXECUTION_IDS`。
 *
 * `apps/admin-api/src/modules/executor/__tests__/protocol-version-consistency.spec.ts`
 * 的 `readTsCap()` 用正则 `/MAX_RUNNING_EXECUTION_IDS\s*=\s*([\d_]+)/` **直接读
 * `executor.service.ts` 的源文本**并与 executor-node / executor-python 的同名
 * 常量比对（三端一致性闸，防止 python 侧再退回 200 而导致 admin 的 stale sweep
 * 误判活性）。
 * ⇒ 该常量**必须留在 `executor.service.ts` 里保持字面量声明形态**
 * （`const MAX_RUNNING_EXECUTION_IDS = 10_000;`），搬走会让那条 spec 因
 * 「找不到该常量」而红——那是一条**故意的源码级契约闸**，不是可绕过的实现细节。
 */
