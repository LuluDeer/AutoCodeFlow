import type { ErrorCodeDef } from "../error-code-def";

/** LANG-ERR-01 · 执行器域错误码分片（executor / executor-package / agent）。 */
export const EXECUTOR_CODES = {
  EXECUTOR_NOT_FOUND: {
    status: 404,
    zh: "执行器不存在",
    en: "Executor not found",
  },
  /**
   * R178：状态 **503**（此前 409）。
   *
   * 本码是「**执行器此刻离线**」这一语义的**非 pinned** 形态。R178 把
   * 「暂时没有可用执行器」整族统一到 503，而「执行器离线」正是该族最直接的
   * 成员之一：离线是**暂时性**的（下一次心跳即回到在线），处置是「等一会儿
   * 重试」。
   *
   * ⚠️ 与 pinned 形态 `PINNED_EXECUTOR_OFFLINE`（同族，503）必须同状态 ——
   * 两者说的是同一件事（「某台执行器现在不可用」），只是定位方式不同
   * （按 address / 按 pinned 目标）。状态分叉会让消费方无法用状态判断
   * 「可重试与否」。
   *
   * ⚠️ **本码当前无生产抛点**（0 处，见 R178 回执的事实清单）⇒ 本次状态
   * 变更**零运行时效果**，纯粹是把口径对齐到同族。保留它而不删除，是因为
   * 删除码会连带删掉前端词条与 CLI 分类基线（收益不足、风险不小）。
   */
  EXECUTOR_OFFLINE: {
    status: 503,
    zh: "执行器「{{address}}」当前离线",
    en: 'Executor "{{address}}" is offline',
  },
  /**
   * R178：状态 **503**（此前 409）——本码是「**无可用执行器**」这一语义的
   * **名字担当**（码表里唯一以此为名的码）。
   *
   * 口径统一到 503 的理由与同族一致：没有可用执行器是**暂时性容量问题**，
   * 503（Service Unavailable）的 HTTP 语义正是「服务暂时不可用、稍后重试」。
   * 409（Conflict）表达的是「资源当前处于冲突态、与本次请求不能共存」，
   * 与「等一会儿就有空位」不是一回事。
   *
   * ⚠️ **本码当前无生产抛点**（0 处；仅 CLI 侧的分类基线按码名引用它）⇒
   * 本次状态变更**零运行时效果**，纯粹是把口径对齐到同族。
   *
   * ⚠️ 已知遗留（**不在本轮写域内**，如实登记）：`packages/acf-cli/src/error-code.ts`
   * 与其 spec 的注释仍写「409 的 NO_AVAILABLE_EXECUTOR / EXECUTOR_OFFLINE」——
   * 那些是**注释与合成夹具**，不读码表状态，故测试仍绿，但注释已过时。
   */
  NO_AVAILABLE_EXECUTOR: {
    status: 503,
    zh: "无可用执行器",
    en: "No available executor",
  },
  EXECUTOR_ADDRESS_TAKEN: {
    status: 409,
    zh: "执行器地址「{{address}}」已被占用",
    en: 'Executor address "{{address}}" is already in use',
  },
  /**
   * EXE-VER-1 最低版本门禁：上报的 `version` 低于 `EXECUTOR_MIN_VERSION`。
   *
   * ⚠️ 状态码 **403**（不是 409）。旧实现是
   * `throw new ForbiddenException("Executor version … is below the required minimum …")`
   * （见 `git show HEAD:…/executor/service/…executor.service.ts`）。「版本过低」
   * 在本仓语义里是**策略性拒绝**（运维设了下限，这台不允许注册），不是资源冲突。
   *
   * 迁移时误取 409，被 `executor.service.spec.ts` 的「门禁开：version 低于下限 →
   * 403，不落库不发 token」抓红——该用例不只断言状态码，还断言「不落库、不发
   * token」，说明 403 与回滚姿态是绑定契约，不能按"看起来更像冲突"去猜。
   */
  EXECUTOR_VERSION_TOO_LOW: {
    status: 403,
    zh: "执行器版本 {{version}} 低于要求的最低版本 {{minVersion}}（EXECUTOR_MIN_VERSION）",
    en: "Executor version {{version}} is below the required minimum {{minVersion}} (EXECUTOR_MIN_VERSION)",
  },
  EXECUTOR_PACKAGE_NOT_FOUND: {
    status: 404,
    zh: "执行器包不存在",
    en: "Executor package not found",
  },
  /**
   * 未配置执行器共享令牌，却收到未认证的执行器访问 → 401（**fail-closed**）。
   *
   * ⚠️ 与下面的 `INVALID_EXECUTOR_TOKEN` **不是同一个码**，别看都是 401 就合并：
   *   · 本码 = 「服务端**没配**令牌」——是**部署/配置缺失**，运维要做的是去配置
   *     页填上共享令牌（或设 `EXECUTOR_SHARED_TOKEN` 环境变量）；
   *   · `INVALID_EXECUTOR_TOKEN` = 「令牌**不匹配**」——是**调用方**的凭据错了，
   *     运维要做的是重新签发/更新执行器侧令牌。
   * 两者的**处置动作不同**，合并会让排障时无法区分"我没配"与"你配错了"。
   *
   * 之所以在这里补这个码（而不是留着硬编码中文）：它此前是
   * `UnauthorizedException("未配置执行器共享令牌；拒绝未认证的执行器访问")`，
   * 属**执行器/运维面**的失败。虽然不直接渲染在浏览器里，但它会出现在 API
   * 响应与运维用 admin-web 排障时的提示中——码化之后这些面才能跟随界面语言。
   * 中文文案与旧实现**逐字一致**（既有 spec 逐字断言它）。
   */
  EXECUTOR_SHARED_TOKEN_UNCONFIGURED: {
    status: 401,
    zh: "未配置执行器共享令牌；拒绝未认证的执行器访问",
    en: "No executor shared token is configured; rejecting unauthenticated executor access",
  },
  INVALID_EXECUTOR_TOKEN: {
    status: 401,
    zh: "执行器令牌无效",
    en: "Invalid executor token",
  },
  // ── 执行器管理面（executor.controller）────────────────────────────────
  EXECUTOR_METADATA_FORBIDDEN: {
    status: 403,
    zh: "执行器管理需要 ADMIN 角色，或该执行器所属项目的 editor 及以上角色",
    en: "Managing executors requires the ADMIN role, or editor or above on the executor's project",
  },
  EXECUTOR_OFFLINE_CONFIG_PUSH: {
    status: 503,
    zh: "执行器处于离线状态：必须在线的执行器才能接收配置推送。请等待下一次心跳将其带回在线，或排查该执行器为何停止上报。",
    en: "The executor is offline: only an online executor can accept a config push. Wait for the next heartbeat to bring it back online, or investigate why it stopped reporting.",
  },
  EXECUTOR_CONFIG_PUSH_UNREACHABLE: {
    status: 503,
    zh: "无法触达执行器：配置推送未能送达（执行器不可达、超时或拒收请求）。请确认执行器正在运行且 admin-api 可访问它，然后重试。",
    en: "Cannot reach the executor: the config push was not delivered (unreachable, timed out, or the request was rejected). Make sure the executor is running and reachable from admin-api, then retry.",
  },
  EXECUTOR_CONFIG_PUSH_REJECTED: {
    status: 502,
    zh: "执行器「{{address}}」在重签令牌重试后仍以 401 拒收配置推送：其持有的令牌与签发的令牌持续不一致。请等待一个心跳让执行器侧的外发自愈收敛，或使用 POST /executors/{{executorId}}/rotate-token 后重新配置该执行器。",
    en: 'Executor "{{address}}" still rejected the config push with 401 after a token re-issue retry: the token it holds remains inconsistent with the issued one. Wait one heartbeat for the executor-side self-heal to converge, or use POST /executors/{{executorId}}/rotate-token and configure the executor again.',
  },
  EXECUTOR_CONFIG_PUSH_REJECTED_FIRST: {
    status: 502,
    zh: "执行器「{{address}}」首次尝试即以 401 拒收配置推送（执行器持有的令牌与签发的不一致，例如 admin-api 重启后签发缓存冷）；随后的一次重签重试以非鉴权错误失败。请等待一个心跳让执行器侧的外发自愈重新对齐，然后重试推送；若持续失败，请使用 POST /executors/{{executorId}}/rotate-token。",
    en: 'Executor "{{address}}" rejected the config push with 401 on the first attempt (the token it holds is inconsistent with the issued one — e.g. a cold issuance cache after an admin-api restart); the subsequent re-issue retry then failed with a non-auth error. Wait one heartbeat for the executor-side self-heal to realign, then retry the push; if it keeps failing, use POST /executors/{{executorId}}/rotate-token.',
  },
  /**
   * pull 派发通道未装配（`ExecutorPullService` 为 null，属装配期缺陷）。
   *
   * 文案保持旧的「**拉取**派发不可用」而非改写成「pull 派发不可用」：
   * `executor.service.spec.ts` 用 `rejects.toThrow("拉取派发不可用")` 做**子串**
   * 断言，而该用例同时断言 `mockedAxios.post` 未被调用——即它守的是
   * 「pull 分支不可用时**绝不静默退回 push**」这条安全性质。改掉这个词就等于
   * 让断言失效或被迫改测试，而原措辞本身没有问题（「拉取」才是面向用户的中文）。
   * 迁移纪律：**能保持原文案就保持**，翻译/改写留给确有必要时。
   */
  EXECUTOR_PULL_UNAVAILABLE: {
    status: 503,
    zh: "拉取派发不可用：ExecutorPullService 未装配",
    en: "Pull dispatch unavailable: ExecutorPullService is not wired",
  },
  EXECUTOR_COMMAND_RESULT_INVALID: {
    status: 400,
    zh: "commandId 与 type 为必填",
    en: "commandId and type are required",
  },
  /**
   * P2-4（2026-10-26 第三轮审计）：命令结果上报的**归属不匹配**——acf:cmdmeta
   * 记录的命令目标行（executorId）与本次上报的定位行不一致（或同址多行歧义态
   * 下无法定位到行）。任意执行器可对任意 commandId 回报是纵深缺口：一条伪造的
   * ok=false 会把别人的部署行收成 FAILED。状态码 403（permission 档）：
   * 凭据有效但「这条命令不是你的」——与 INVALID_EXECUTOR_TOKEN（凭据本身错，
   * 401）区分开。
   */
  EXECUTOR_COMMAND_RESULT_NOT_OWNED: {
    status: 403,
    zh: "命令「{{commandId}}」不属于该执行器，拒绝其结果上报",
    en: 'Command "{{commandId}}" is not owned by this executor; result report rejected',
  },
  EXECUTOR_ARTIFACT_MISSING: {
    status: 404,
    zh: "未找到 executor-node.tar.gz；请运行 scripts/bundle-executor-artifact.sh 并把产物放到 EXECUTOR_ARTIFACT_DIR（默认 <cwd>/artifacts）下",
    en: "executor-node.tar.gz not found; run scripts/bundle-executor-artifact.sh and place the artifact under EXECUTOR_ARTIFACT_DIR (default <cwd>/artifacts)",
  },
  // ── 执行器容量/元数据校验（executor.service）──────────────────────────
  EXECUTOR_MAX_CONCURRENT_INVALID: {
    status: 400,
    zh: "maxConcurrentTasks 必须是 1..10000 范围内的整数，或为 null 以清除上限（当前值 {{value}}）",
    en: "maxConcurrentTasks must be an integer in 1..10000, or null to clear the limit (current value {{value}})",
  },
  /**
   * E-4（2026-10-26 执行器域审计）：register 身份键校验（appName/address/type/
   * capabilities/tags/description）。此前这些字段零校验直落库——appName 超长
   * 撞 varchar 上限是**裸 500**（PG 22001 经全局过滤器透出，无稳定码）；
   * capabilities/tags 是 simple-array 列，元素含逗号会在读回时被静默劈裂
   * （"gpu,a100" → ["gpu","a100"]，调度侧按标签 AND 子集匹配永远匹配不到，
   * 与任务域 create-task.dto.ts 的 executorTags F-7 先例同型）。
   *
   * 单码统一 400、按 {{field}}/{{reason}} 区分字段与原因——机器面调用方
   * （执行器/安装脚本）只需要「哪个字段、为什么」两级信息；逐字段拆码会让
   * 目录膨胀而消费方并不分支处理（对齐 EXECUTOR_COMMAND_RESULT_INVALID
   * 的单码形态）。
   */
  EXECUTOR_REGISTER_FIELD_INVALID: {
    status: 400,
    zh: "注册字段「{{field}}」非法：{{reason}}",
    en: 'Invalid registration field "{{field}}": {{reason}}',
  },
  /**
   * E-6（2026-10-26 执行器域审计）：POST /executors/token 此前对缺 appName 的
   * 请求兜底 "executor"（controller），可被反复以不同 address 制造无主行
   * （共享 token 的持有边界即行扩张边界，行治理脏）。仓内三个执行器来源
   * （executor-node middleware/auth.ts:254、executor-python auth.py:203、
   * scripts/install.sh:27 生成的 .env APP_NAME）**总是**携带非空 appName，
   * 收紧无存量兼容风险（controller.spec 里「缺 appName 兜底」用例已随本修复
   * 改写）。复用 register 字段校验码：同一「注册字段非法」语义。
   */
  EXECUTOR_TOKEN_APP_NAME_REQUIRED: {
    status: 400,
    zh: "appName 为必填（不能为空白）：执行器换取令牌时必须上报应用名称",
    en: "appName is required (must not be blank): executors must report their app name when fetching a token",
  },
  EXECUTOR_AGENT_CAPABILITY_UNSUPPORTED: {
    status: 400,
    zh: "Agent capabilities 含不支持的能力域",
    en: "Agent capabilities contains an unsupported capability domain",
  },
  NO_AVAILABLE_EXECUTOR_FOR_SELECTION: {
    status: 503,
    zh: "没有可用的在线执行器",
    en: "No online executor is available",
  },
  NO_EXECUTOR_MATCHING_FILTERS: {
    status: 503,
    zh: "没有在线执行器匹配所请求的 group/tags/runtime",
    en: "No online executor matches the requested group/tags/runtime",
  },
  NO_EXECUTOR_CAPACITY_AVAILABLE: {
    status: 503,
    zh: "没有可用的执行器 —— 所有在线执行器都已达到最大并发容量",
    en: "No executor available — every online executor has reached its maximum concurrent capacity",
  },
  NO_EXECUTOR_INTERPRETER_MISMATCH: {
    status: 503,
    zh: "没有执行器缓存了所请求的解释器版本：{{detail}}",
    en: "No executor has the requested interpreter version cached: {{detail}}",
  },
  // ── 派发/广播（executor.service · 原为裸 Error，对外 500）──────────────
  TASK_SECRET_DECRYPT_FAILED: {
    status: 500,
    zh: "任务密钥解密失败，无法派发：{{detail}}",
    en: "Failed to decrypt task secrets, cannot dispatch: {{detail}}",
  },
  /**
   * R178：**刻意保持 500，不动**。
   *
   * 本码的语义是「pinned 的目标行**根本不存在**」——那是**永久性**的
   * （调用方给错了 `executorId`，或那行已被删除），重试**永远不会**成功。
   * 把永久性错误报成 503「服务暂时不可用、稍后重试」会让调用方**无限重试**
   * ⇒ 反而制造噪声。故它**不属于**「暂时无可用执行器」这一族，不参与本轮
   * 的 503 统一。
   *
   * ⚠️ 它仍是 500，**不是**本轮遗留的「口径分叉」——分叉的定义是「同一语义
   * 多状态」，而本码与同族的 `PINNED_EXECUTOR_OFFLINE`（503，暂时）语义**不同**
   * （不存在 ≠ 此刻不可用）。把两者混同会丢掉「永久 vs 暂时」这个关键区分。
   *
   * ⚠️ R169 审计曾建议把它改成 4xx（404/422）。**本轮不采纳**：那条建议会把
   * 「永久性」这一性质编码进状态码，但会命中前端 `isNotFoundError` 的
   * 「回列表」分支（`apps/admin-web/src/utils/error.ts:195`），且需要同步改 UI
   * 判定——超出本轮写域（且 4xx 会被当作「调用方问题」，同样不会重试）。留作
   * 独立立项。
   */
  PINNED_EXECUTOR_NOT_FOUND: {
    status: 500,
    zh: "指定的固定执行器 {{executorId}} 不存在",
    en: "The pinned executor {{executorId}} does not exist",
  },
  /**
   * R178：状态 **503**（此前 500）——「指定的固定执行器**当前离线**」。
   *
   * 离线是**暂时性**的：执行器下一次心跳（`EXECUTOR_HEARTBEAT_INTERVAL_MS` 量级）
   * 就会把它带回在线 ⇒ 处置是「等一会儿重试」，不是「服务端有 bug」。
   * 同族的 `PINNED_EXECUTOR_AT_CAPACITY`（满载）等价同口径 ⇒ 同为 503。
   *
   * ⚠️ 与 `PINNED_EXECUTOR_NOT_FOUND`（500，见下）**刻意不同**：那个是「目标行
   * 根本不存在」（永久，调用方给错了 id），这个是「目标存在但此刻不可用」
   * （暂时）。两者必须分开——把永久性错误报成「稍后重试」会让用户无限重试。
   *
   * ⚠️ **不改 `failureReason` 映射**：`error-code-failure-reason.ts:69` 已把本码
   * 映射到 `EXECUTOR_OFFLINE`，那条映射与 HTTP 状态**完全无关**（分类链读
   * `errorCode`/文案，不读状态码）⇒ 本次状态变更对 worker 侧的重试/排队语义
   * **零影响**。
   */
  PINNED_EXECUTOR_OFFLINE: {
    status: 503,
    zh: '指定的固定执行器 "{{appName}}" ({{executorId}}) 已离线',
    en: 'The pinned executor "{{appName}}" ({{executorId}}) is offline',
  },
  /**
   * D-1（R1 审计 F-13）：pinned 执行器**已满**（`runningTaskCount >= maxConcurrentTasks`）。
   *
   * 为什么必须有专属码：pinning 的候选池只有 1 台，若落通用
   * `NO_DISPATCHABLE_EXECUTOR`（「所有候选执行器都已离线或达到容量上限」），
   * 用户会误判**整个机队**不可用，而实情是「我钉的那台满了」。而同方法里
   * pinned 的另外两种失败（不存在 / 离线）都已有专属码 ⇒ 三种必须同形。
   *
   * R178：状态 **503**（此前 500）——「我钉的那台满了」是**容量暂时耗尽**，
   * 处置是「等它释放槽位」，与同族的 `NO_DISPATCHABLE_EXECUTOR` 同口径
   * （R178 回执见 `artifacts/autonomy/R178/impl-no-executor-status.md`）。
   *
   * 为什么**不**映射 `failureReason`（见 `error-code-failure-reason.ts` 注释）：
   * 现有枚举没有「容量已满」这一档；硬塞 `executor_offline` 是说谎（它在线）。
   * 沿 `PINNED_EXECUTOR_NOT_FOUND` 的先例，留 UNKNOWN。
   */
  PINNED_EXECUTOR_AT_CAPACITY: {
    status: 503,
    zh: '指定的固定执行器 "{{appName}}" ({{executorId}}) 已达到并发上限 {{running}}/{{max}}；pinning 不会回退到其他执行器，请等待其释放槽位',
    en: 'The pinned executor "{{appName}}" ({{executorId}}) is at capacity {{running}}/{{max}}; pinning does not fall back to another executor, please wait for a free slot',
  },
  /**
   * R178：状态 **503**（此前 500）——「按 appName 点名的执行器此刻不可用」
   * 与 `NO_DISPATCHABLE_EXECUTOR` 是同一语义（候选机暂时全离线/满载），
   * 处置同样是「等一会儿重试」，不是服务端故障。
   */
  EXECUTOR_APP_NAME_NOT_FOUND: {
    status: 503,
    zh: "没有 appName 为 {{appName}} 的可用执行器",
    en: "No available executor with appName {{appName}}",
  },
  /**
   * R178：「暂时没有可用执行器」这一族失败的 HTTP 语义**统一为 503**。
   *
   * ## 为什么这一族从 500 改成 503（对外行为变更，见 R178 回执）
   *
   * 这五条码的语义都是**「现在派不出去，等一下就行」**——机队容量暂时耗尽 /
   * 候选机暂时全离线 / 目标机暂时满载。它们**不是**「服务端有 bug」。
   *
   * 500 的代价是**实打实的**（三条后果，均可复核）：
   *   ① **前端不重试**：`admin-web/src/api/client.ts:474` 的瞬时重试集只有
   *      `502/503/504`（+无响应的网络错误），500 被当成「确定性故障」——而这
   *      一族恰恰是**可重试**的容量问题；
   *   ② **误入服务端故障告警**：`docs/observability/alerting-rules.yml:252` 的
   *      `AUTOFLOW_HTTP_5XX_RATE_HIGH` 按 `status_class="5xx"` 聚合
   *      （`prometheus-metrics.service.ts:857` 的 `classifyHttpStatus` 把
   *      500~599 **一律**归 "5xx"，503 亦在内）⇒ 容量不足会直接推高「服务端
   *      错误率」并触发那条告警。
   *      ✅ **R183 已把它真正分开**（此前这里写的是「属独立立项，不在本轮写域内」，
   *      那条登记**已过时**——留着会误导读者以为告警面还没分开）：
   *      `prometheus-metrics.service.ts` 的 `classifyHttpStatus` 现在把 **503**
   *      单独归为 `"5xx-temporary"`（`"5xx"` 桶的判定不变、仍是 500~599 里
   *      除 503 之外的部分）⇒ **容量不足不再推高「服务端故障率」**；并新增
   *      `AUTOFLOW_HTTP_TEMPORARY_UNAVAILABLE_RATE_HIGH`（2% / 15m）单独兜住它。
   *      ⇒ 改成 503 的收益是**双份的**：① 告警面真的分开（容量问题不冒充服务端故障）；
   *      ② 响应体与日志里带稳定码 `NO_DISPATCHABLE_EXECUTOR`、语义明确的文案，
   *      值班人在现场按 `errorCode` 就能分辨「容量不足」与「真服务端 bug」。
   *   ③ **处置建议错位**：`admin-web` 的 `http.error.500` 文案是「服务器内部
   *      错误」（引导人报障），`http.error.503` 是「服务暂时不可用，请稍后重试」
   *      （引导人等待）。
   *
   * 503 的 HTTP 语义正是「服务暂时不可用、稍后重试」，与「容量不足」精确对应。
   *
   * ## 为什么**不**新建码、而是改既有码的状态
   *
   * R171 方法学 339（兜底码要复用已有语义）：码表里已有**语义完全吻合**的
   * 503 族——`NO_AVAILABLE_EXECUTOR_FOR_SELECTION` / `NO_EXECUTOR_MATCHING_FILTERS`
   * / `NO_EXECUTOR_CAPACITY_AVAILABLE` / `NO_EXECUTOR_INTERPRETER_MISMATCH`
   * （均在 `catalog/executor.ts` 的「执行器容量/元数据校验」段）。这五条 500 码
   * 与它们是**同一语义的不同细分**（通用 vs 细分），细分码的存在有实义（文案
   * 各自精确：pinned 满载 ≠ 全队满载；广播无目标 ≠ 单发无目标），故保留码、
   * 只把**状态**对齐到 503。
   *
   * ⚠️ **不改文案**：`catalog/executor.ts:100-107` 的既有纪律「能保持原文案就
   * 保持」在本段继续适用——文案被 `executor.service.spec.ts` 的子串断言钉住
   * （`:5991` / `:6222` / `:5830`），改文案会同时改掉既有断言。
   */
  NO_DISPATCHABLE_EXECUTOR: {
    status: 503,
    zh: "没有可用的执行器（所有候选执行器都已离线或达到容量上限）",
    en: "No executor available (every candidate executor is offline or at capacity)",
  },
  NO_BROADCAST_EXECUTOR: {
    status: 503,
    zh: "没有可用于广播派发的执行器",
    en: "No executor available for broadcast dispatch",
  },
  BROADCAST_DISPATCH_ALL_FAILED: {
    status: 500,
    zh: "广播派发在全部 {{count}} 台执行器上均失败：{{failures}}",
    en: "Broadcast dispatch failed on all {{count}} executors: {{failures}}",
  },
  PACKAGE_URL_APPLICATION_ID_MISSING: {
    status: 500,
    zh: '任务 "{{taskName}}" ({{taskId}}) 的 codeSource=application_zip 但缺少 applicationId；无法解析派发所需的 packageUrl',
    en: 'Task "{{taskName}}" ({{taskId}}) has codeSource=application_zip but no applicationId; cannot resolve the packageUrl required for dispatch',
  },
  PACKAGE_URL_REPO_UNAVAILABLE: {
    status: 500,
    zh: '无法解析任务 "{{taskName}}"（{{taskId}}）的 packageUrl：应用仓库未接入 ExecutorService',
    en: 'Cannot resolve packageUrl for task "{{taskName}}" ({{taskId}}): the application repository is not wired into ExecutorService',
  },
  PACKAGE_URL_APPLICATION_NOT_FOUND: {
    status: 500,
    zh: '无法解析任务 "{{taskName}}"（{{taskId}}）的 packageUrl：应用 {{applicationId}} 不存在',
    en: 'Cannot resolve packageUrl for task "{{taskName}}" ({{taskId}}): application {{applicationId}} does not exist',
  },
  PACKAGE_URL_NOT_CONFIGURED: {
    status: 500,
    zh: '无法解析任务 "{{taskName}}"（{{taskId}}）的 packageUrl：应用 "{{appName}}"（{{applicationId}}）未配置 packageUrl',
    en: 'Cannot resolve packageUrl for task "{{taskName}}" ({{taskId}}): application "{{appName}}" ({{applicationId}}) has no packageUrl configured',
  },
  /**
   * R183：**503 → 500**。
   *
   * ## 为什么必须改（这是 R178 那次「503 口径统一」的**副作用**）
   * 本码的 zh 是「**未配置 ADMIN_API_URL**，无法生成安装命令」——这是
   * **服务端配置缺失**，**重试永远不会成功**（要改部署配置才行）。
   * 而 R178 把 503 确立为「**暂时不可用、稍后重试**」（容量/维护），
   * R183 又让 503 单列 `status_class="5xx-temporary"` ⇒ **不进「服务端故障率」告警**。
   * ⇒ 若它继续是 503，就会**被新口径错误豁免**：一个**真的配错了**的状态
   * **永远不告警**，而且前端会**自动重试一次**（对配置错误是纯浪费）。
   *
   * ## 判据（可复用）
   * 「**重试能不能好**」：能 → 503；不能 → 500。本码属于后者。
   */
  EXECUTOR_INSTALL_CMD_NOT_CONFIGURED: {
    status: 500,
    zh: "未配置 ADMIN_API_URL，无法生成安装命令",
    en: "ADMIN_API_URL is not configured; cannot generate the install command",
  },
  // ── 执行器包（executor-package）──────────────────────────────────────
  EXECUTOR_PACKAGE_FILE_REQUIRED: {
    status: 400,
    zh: "必须提供包文件",
    en: "A package file is required",
  },
  EXECUTOR_PACKAGE_UPLOAD_CONTENT_MISSING: {
    status: 400,
    zh: "上传文件内容缺失（期望 multer diskStorage 上传）",
    en: "The uploaded file content is missing (multer diskStorage upload expected)",
  },
  EXECUTOR_PACKAGE_EXISTS: {
    status: 409,
    zh: "包 {{name}}@{{version}}（{{type}}）已存在",
    en: "Package {{name}}@{{version}} ({{type}}) already exists",
  },
  EXECUTOR_PACKAGE_EXT_UNSUPPORTED: {
    status: 400,
    zh: '不支持的包扩展名 "{{ext}}"。允许的扩展名：.zip、.whl、.tar.gz、.tgz',
    en: 'Unsupported package extension "{{ext}}". Allowed extensions: .zip, .whl, .tar.gz, .tgz',
  },
  EXECUTOR_PACKAGE_NOT_ARCHIVE: {
    status: 400,
    zh: "包内容不是 zip/wheel/gzip 归档文件",
    en: "The package content is not a zip/wheel/gzip archive",
  },
  EXECUTOR_PACKAGE_ZIP_GUARD_REJECTED: {
    status: 400,
    zh: "包被 zip 炸弹防护拒绝（{{violation}}）",
    en: "The package was rejected by the zip-bomb guard ({{violation}})",
  },
  EXECUTOR_PACKAGE_VIRUS_DETECTED: {
    status: 400,
    zh: "包被拒绝：病毒扫描检出威胁",
    en: "Package rejected: the virus scan detected a threat",
  },
  EXECUTOR_PACKAGE_SCANNER_UNAVAILABLE: {
    status: 503,
    zh: "包被拒绝：病毒扫描不可用（fail-closed）",
    en: "Package rejected: the virus scanner is unavailable (fail-closed)",
  },
  EXECUTOR_PACKAGE_FILE_MISSING: {
    status: 404,
    zh: "ExecutorPackage {{packageId}} 对应的文件在磁盘上不存在",
    en: "The file for ExecutorPackage {{packageId}} does not exist on disk",
  },
  /**
   * P2-2（2026-10-25 审计）：包文件路径越界——filePath（PATCH 写入面或 DB
   * 历史脏行）resolve 后不在上传根（uploads/executor-packages）内。读/删原语
   * 的包含性闸（update/openPackageFile 硬 400；remove 的 unlink 跳过只告警）。
   * 命名对齐 sop-media 的 SOP_MEDIA_STORAGE_PATH_ESCAPED 先例。
   */
  EXECUTOR_PACKAGE_STORAGE_PATH_ESCAPED: {
    status: 400,
    zh: "包文件路径越界：filePath 必须位于执行器包上传目录内",
    en: "Package file path escaped: filePath must stay inside the executor package upload directory",
  },
  /**
   * R178：状态 **503**（此前 500）——「没有在线执行器可以接收这个包」。
   *
   * 这是本族里**唯一一个真正经 HTTP 返回给调用方的**「无可用执行器」失败点
   * （`POST /executor-packages/:id/push`；其余「无可用执行器」产生点都在
   * BullMQ worker 里，异常被 `task.processor.ts:340` 的 catch 吃掉，**不产生
   * HTTP 响应**）。故本条的状态变更**直接改变前端行为**：
   *   · 500 → 前端**不重试**（`admin-web/src/api/client.ts:474` 的瞬时集只有
   *     502/503/504），且文案是 `http.error.500`「服务器内部错误」（引导报障）；
   *   · 503 → 前端**会重试**（安全方法 + 1s 退避），文案是
   *     `http.error.503`「服务暂时不可用，请稍后重试」（引导等待）。
   * 「没有在线执行器」是**暂时性**的（执行器下次心跳即上线）⇒ 503 才是对的。
   *
   * ⚠️ 「显式点名 executorIds 但那台不存在/不在线」也落这条码——那种情形是
   * **调用方点错了机器**，但处置同样是「改选一台重试」，故仍用 503（不改成
   * 404：那会让前端跳回列表，用户拿不到「换一台重试」的指引）。
   */
  EXECUTOR_PACKAGE_PUSH_NO_TARGETS: {
    status: 503,
    zh: "没有找到可推送的目标执行器",
    en: "No target executor was found to push to",
  },
  EXECUTOR_PACKAGE_PUSH_URL_NOT_CONFIGURED: {
    status: 503,
    zh: "未配置 ADMIN_API_URL，无法推送执行器包",
    en: "ADMIN_API_URL is not configured; cannot push the executor package",
  },
  EXECUTOR_PACKAGE_PUSH_URL_INVALID: {
    status: 503,
    zh: "ADMIN_API_URL 必须是不含查询串与片段（fragment）的绝对 HTTP(S) 基础 URL",
    en: "ADMIN_API_URL must be an absolute HTTP(S) base URL without a query string or fragment",
  },
  // ── registry（npm/pypi 上游代理）────────────────────────────────────
  REGISTRY_UPSTREAM_TIMEOUT: {
    status: 504,
    zh: "{{upstream}} 请求超时",
    en: "{{upstream}} request timed out",
  },
  REGISTRY_UPSTREAM_FAILED: {
    status: 502,
    zh: "{{upstream}} 请求失败：{{detail}}",
    en: "{{upstream}} request failed: {{detail}}",
  },
  REGISTRY_UPLOAD_FIELDS_REQUIRED: {
    status: 400,
    zh: "name、version 与 file 为必填",
    en: "name, version and file are required",
  },
  REGISTRY_PACKAGE_NAME_INVALID: {
    status: 400,
    zh: "非法的包名：必须符合 PEP 508（字母、数字、. _ -）",
    en: "Invalid package name: it must conform to PEP 508 (letters, digits, . _ -)",
  },
  REGISTRY_PACKAGE_VERSION_INVALID: {
    status: 400,
    zh: "非法的版本号：必须符合 PEP 440（字母、数字、. _ + -）",
    en: "Invalid version: it must conform to PEP 440 (letters, digits, . _ + -)",
  },
  REGISTRY_FILE_TYPE_UNSUPPORTED: {
    status: 400,
    zh: "不支持的文件类型。允许的扩展名：{{extensions}}",
    en: "Unsupported file type. Allowed extensions: {{extensions}}",
  },
  REGISTRY_UPLOAD_TIMEOUT: {
    status: 504,
    zh: "上游 registry 上传超时",
    en: "Upstream registry upload timed out",
  },
  REGISTRY_UPLOAD_REDIRECTED: {
    status: 502,
    zh: "上传失败：上游重定向（HTTP {{status}}）——请求从未到达上传端点",
    en: "Upload failed: upstream redirected (HTTP {{status}}) — the request never reached the upload endpoint",
  },
  REGISTRY_UPLOAD_CONFLICT: {
    status: 409,
    zh: "版本已存在或内容冲突（同 filename 不同 sha256，禁止覆盖已发布制品）: {{detail}}",
    en: "Version already exists or content conflicts (same filename, different sha256; overwriting a published artifact is forbidden): {{detail}}",
  },
  REGISTRY_UPLOAD_TOO_LARGE: {
    status: 413,
    zh: "包体积过大：{{detail}}",
    en: "Package is too large: {{detail}}",
  },
  REGISTRY_UPLOAD_FAILED: {
    status: 502,
    zh: "上传失败：{{detail}}",
    en: "Upload failed: {{detail}}",
  },
  REGISTRY_CONNECTION_CLOSED: {
    status: 502,
    zh: "上游 registry 在响应前关闭了连接",
    en: "The upstream registry closed the connection before responding",
  },
  // ── agent（Agent 会话与工具绑定）─────────────────────────────────────
  /**
   * R202：**积压对账不可用**（装配缺失 —— 只可能发生在测试装配里）。
   *
   * 为什么需要这个码而不是用内置 `ServiceUnavailableException`：
   * 裸内置异常**没有 `errorCode`** ⇒ 前端只能渲染服务端中文兜底文案
   * （`check:error-migration` 直接判红）。
   * 为什么必须**显式**报错、而不是返回「0 条积压」：后者是**假事实** ——
   * 「没读到」被渲染成「没有」正是本仓主导缺陷类（R188–R201 修了 8+ 例）。
   */
  AGENT_BACKLOG_CHECK_UNAVAILABLE: {
    status: 503,
    zh: "积压对账服务不可用（装配缺失）——**这不代表没有积压**",
    en: "Backlog reconciliation is unavailable (wiring missing) — this does NOT mean there is no backlog",
  },
  AGENT_SESSION_NOT_FOUND: {
    status: 404,
    zh: "Agent 会话 {{sessionId}} 不存在",
    en: "Agent session {{sessionId}} not found",
  },
  AGENT_SESSION_ALREADY_RUNNING: {
    status: 409,
    zh: "会话仍在运行中——重复入队会产生双份推理循环副作用，无需恢复",
    en: "The session is still running — re-enqueueing would duplicate the reasoning loop and its side effects; no recovery needed",
  },
  AGENT_SESSION_PENDING_APPROVAL: {
    status: 409,
    zh: "会话 {{sessionId}} 仍有未处置的审批单——请先在会话详情页批准或拒绝，再恢复会话",
    en: "Session {{sessionId}} still has pending approval requests — approve or deny them in the session detail page before resuming",
  },
  AGENT_APPROVAL_NOT_FOUND: {
    status: 404,
    zh: "审批单 {{approvalKey}} 不存在",
    en: "Approval request {{approvalKey}} not found",
  },
  AGENT_APPROVAL_SELF_DENIED: {
    status: 403,
    zh: "不能批准自己发起的 Agent 会话的审批单（四眼原则）；请由另一位管理员处置",
    en: "You cannot approve an approval of an Agent session you initiated (four-eyes policy); ask another admin",
  },
  AGENT_APPROVAL_ALREADY_DECIDED: {
    status: 409,
    zh: "审批单 {{approvalKey}} 已被处置（当前状态：{{status}}）——审批结论只能有一个",
    en: "Approval request {{approvalKey}} has already been decided (current status: {{status}}) — an approval can only be decided once",
  },
  AGENT_APPROVAL_SESSION_MISMATCH: {
    status: 409,
    zh: "审批单不属于会话 {{sessionId}}——请从会话详情页发起处置",
    en: "The approval request does not belong to session {{sessionId}} — decide it from the session detail page",
  },
  AGENT_TOOL_EXECUTOR_NOT_FOUND: {
    status: 404,
    zh: "执行器 {{address}} 不存在",
    en: "Executor {{address}} not found",
  },
  AGENT_TOOL_EXECUTOR_TARGET_REQUIRED: {
    status: 400,
    zh: "executorId 与 executorAddress 必须提供其一",
    en: "Either executorId or executorAddress must be provided",
  },
  AGENT_TOOL_MUTEX_GROUP_PATCH_EMPTY: {
    status: 400,
    zh: "update_mutex_group: 至少需要一个可改字段（name / maxConcurrentPerDevice / scope / description）",
    en: "update_mutex_group: at least one editable field is required (name / maxConcurrentPerDevice / scope / description)",
  },
} as const satisfies Record<string, ErrorCodeDef>;
