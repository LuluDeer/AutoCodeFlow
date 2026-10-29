import type { ErrorCodeDef } from "../error-code-def";

/** LANG-ERR-01 · 任务域错误码分片（task / task-template / scheduler / 执行记录）。 */
export const TASK_CODES = {
  TASK_NOT_FOUND: {
    status: 404,
    zh: "任务 {{taskId}} 不存在",
    en: "Task {{taskId}} not found",
  },
  TASK_ID_EXISTS: {
    status: 409,
    zh: "任务 ID「{{id}}」已存在",
    en: 'Task ID "{{id}}" already exists',
  },
  TASK_NAME_EXISTS: {
    status: 409,
    zh: "任务名「{{name}}」已存在",
    en: 'Task name "{{name}}" already exists',
  },
  /**
   * 改名/并发创建撞 `idx_tasks_name_unique`（任务名全局唯一索引，**含软删除行**）。
   *
   * 为什么不复用 `TASK_NAME_EXISTS`：撞这个索引时用户最需要知道的一件事是
   * 「重名可能来自回收站里的任务」——按普通重名提示会让用户去列表里翻一个
   * 根本看不到（软删）的同名任务，从而卡死在改名上。两者**处置动作不同**
   * （换名 vs 换名+去回收站找），故分列两个码。
   */
  TASK_NAME_TAKEN: {
    status: 409,
    zh: "已存在同名任务「{{name}}」（任务名全局唯一，回收站中的任务同样占用该名称）；请换一个名称",
    en: 'A task named "{{name}}" already exists (task names are globally unique; tasks in the recycle bin also hold the name); please choose another name',
  },
  TASK_EXECUTION_NOT_FOUND: {
    status: 404,
    zh: "执行记录 {{executionId}} 不存在",
    en: "Execution {{executionId}} not found",
  },
  TASK_NOT_OWNER: {
    status: 403,
    zh: "你不是该任务的属主",
    en: "You are not the owner of this task",
  },
  TASK_HAS_NO_OWNER: {
    status: 403,
    zh: "该任务没有属主（历史数据行），仅管理员可修改",
    en: "This task has no owner (legacy row); only administrators can modify it",
  },
  TASK_ALREADY_PAUSED: {
    status: 400,
    zh: "任务已处于暂停状态",
    en: "Task is already paused",
  },
  TASK_NOT_PAUSED: {
    status: 400,
    zh: "任务未暂停，无法恢复",
    en: "Task is not paused and cannot be resumed",
  },
  TASK_CIRCULAR_DEPENDENCY: {
    status: 400,
    zh: "检测到循环依赖：任务 {{taskId}} 依赖了自身或形成了环",
    en: "Circular dependency detected: task {{taskId}} depends on itself or forms a cycle",
  },
  TASK_DEPENDENCY_NOT_FOUND: {
    status: 400,
    zh: "dependencies 的值必须是已存在的任务 id（value = 上游任务 id）；未找到：{{ids}}",
    en: "Dependency values must be existing task ids (value = upstream task id); not found: {{ids}}",
  },
  /** 依赖链深度/广度超过 `MAX_DEPENDENCY_DEPTH`（N+1 查询 DoS 的硬边界）。 */
  TASK_DEPENDENCY_TOO_DEEP: {
    status: 400,
    zh: "依赖链层级过深",
    en: "Dependency chain is too deep",
  },
  TASK_VERSION_NOT_FOUND: {
    status: 404,
    zh: "任务 {{taskId}} 的版本 v{{version}} 不存在",
    en: "Version v{{version}} not found for task {{taskId}}",
  },
  /**
   * 按**版本行 id** 查版本却查不到（`getVersion(taskId, versionId)`）。
   *
   * 与 `TASK_VERSION_NOT_FOUND` 分开的理由：后者的占位符是版本**号**（`v3`），
   * 而本路径的调用方（回滚 / 版本对比）只持有不透明行 id，拿不到版本号——
   * 强行套用会渲染出 `v<uuid>` 这种四不像。失败本身相同，但可用的信息不同。
   */
  TASK_VERSION_ID_NOT_FOUND: {
    status: 404,
    zh: "任务 {{taskId}} 的版本不存在",
    en: "Version not found for task {{taskId}}",
  },
  /**
   * 钉定重放（技术债 A 组·按原版本重放）：job 数据里带的版本行在派发时已查不到
   * ——**fail-closed**，宁可执行失败也不静默改跑当前配置（那正是本功能要防的
   * 「以为重跑的是原版代码」误判）。
   *
   * 与 `TASK_VERSION_ID_NOT_FOUND` 分开：那个是用户在读面/回滚面点名一个版本，
   * 这个是**服务端自己**在派发链上发现快照消失了，消息必须带版本行 id 且明确
   * 「拒绝按当前配置派发」——否则运维无法判断该执行为何没跑起来。
   */
  TASK_PINNED_VERSION_GONE: {
    status: 500,
    zh: "固定版本 {{versionId}} 不存在于任务 {{taskId}}；拒绝按当前配置派发",
    en: "Pinned version {{versionId}} does not exist for task {{taskId}}; refusing to dispatch with the current configuration",
  },
  /** 回滚撞任务名唯一索引：处置是「先给占名任务改名，或改用其它版本」——与改名冲突不同。 */
  TASK_ROLLBACK_NAME_TAKEN: {
    status: 409,
    zh: "无法回滚到版本 {{version}}：该版本的任务名「{{name}}」已被其它任务占用（任务名全局唯一，回收站中的任务同样占用）。请先重命名占用该名称的任务，或改用其它版本。",
    en: 'Cannot roll back to version {{version}}: the task name "{{name}}" in that version is taken by another task (task names are globally unique; tasks in the recycle bin also hold the name). Rename the occupying task first, or pick another version.',
  },
  TASK_BLOCK_STRATEGY_REJECTED: {
    status: 409,
    zh: "任务「{{name}}」已有相同参数的执行在运行（blockStrategy=discard），本次触发被拒绝",
    en: 'Task "{{name}}" already has a running execution with the same params (blockStrategy=discard); this trigger was rejected',
  },
  /** 触发闸门 TOCTOU 锁被占用：同参触发正在处理中，**稍后重试即可成功**（与 discard 的有意抑制不同）。 */
  TASK_TRIGGER_CONCURRENT: {
    status: 409,
    zh: "任务「{{name}}」已有同参数的触发正在处理中，请稍后重试",
    en: 'A trigger with the same params for task "{{name}}" is already being processed; please retry shortly',
  },
  TASK_ENQUEUE_FAILED: {
    status: 500,
    zh: "任务入队失败：{{message}}",
    en: "Failed to enqueue task: {{message}}",
  },
  TASK_EXECUTION_TERMINAL: {
    status: 400,
    zh: "执行处于「{{status}}」终态，无法终止",
    en: 'Execution is in "{{status}}" (a terminal state) and cannot be terminated',
  },
  TASK_LOG_STREAM_LIMIT: {
    status: 429,
    zh: "该执行的并发日志流过多（上限 {{max}}）",
    en: "Too many concurrent log streams for this execution (max {{max}})",
  },
  /** 单执行日志流并发上限（503——与 `TASK_LOG_STREAM_LIMIT` 的 429 不同码不同状态）。 */
  TASK_LOG_STREAM_LIMIT_PER_EXECUTION: {
    status: 503,
    zh: "执行 {{executionId}} 的并发日志流过多（上限 {{max}}）",
    en: "Too many concurrent log streams for execution {{executionId}} (max {{max}})",
  },
  /** 全服日志流并发上限（503）。 */
  TASK_LOG_STREAM_LIMIT_GLOBAL: {
    status: 503,
    zh: "全服并发日志流过多（上限 {{max}}）",
    en: "Too many concurrent log streams service-wide (max {{max}})",
  },
  // ── 写面配对/互斥校验 ───────────────────────────────────────────────────
  /** R7/N17：executorId（钉定）与 executeMode=broadcast 互斥。 */
  TASK_PIN_BROADCAST_EXCLUSIVE: {
    status: 400,
    zh: "executorId（钉定执行器）与 executeMode=broadcast 互斥",
    en: "executorId (pinned executor) and executeMode=broadcast are mutually exclusive",
  },
  /** A-1：broadcast 会扇出到全部在线执行器，无法遵守应用的互斥组并发上限。 */
  TASK_BROADCAST_MUTEX_INCOMPATIBLE: {
    status: 400,
    zh: "executeMode=broadcast 与互斥组不兼容：应用「{{appName}}」({{appId}}) 绑定了互斥组 {{mutexGroupId}}。broadcast 会同时扇出到所有在线执行器，无法遵守该组的并发上限 —— 请把任务改为 executeMode=single，或从应用上移除该互斥组（{{context}}）",
    en: 'executeMode=broadcast is incompatible with a mutex group: application "{{appName}}" ({{appId}}) is bound to mutex group {{mutexGroupId}}. broadcast fans out to every online executor at once and cannot honor that group\'s concurrency limit — switch the task to executeMode=single, or remove the mutex group from the application ({{context}})',
  },
  // ── python_task_multiversion（FR-06 / FR-18 / FR-19）写面校验 ─────────────
  /** AC-06b：runtimeVersion 格式/区间不合法（提示由 runtime-version.util 派生）。 */
  TASK_RUNTIME_VERSION_UNSUPPORTED: {
    status: 400,
    zh: "{{detail}}",
    en: "{{detail}}",
  },
  /** FR-06：runtimeVersion 仅对 runtime=python 有意义。 */
  TASK_RUNTIME_VERSION_REQUIRES_PYTHON: {
    status: 400,
    zh: "runtimeVersion 仅支持 runtime=python（实际 runtime={{runtime}}）",
    en: "runtimeVersion is only supported for runtime=python (actual runtime={{runtime}})",
  },
  /** FR-18 / AC-17b：代码来源必须三选一（gitRepo / glueSource / application_zip）。 */
  TASK_CODE_SOURCE_EXCLUSIVE: {
    status: 400,
    zh: "任务代码来源必须且只能是 gitRepo / glueSource / codeSource=application_zip 之一（实际：{{channels}}）",
    en: "A task's code source must be exactly one of gitRepo / glueSource / codeSource=application_zip (actual: {{channels}})",
  },
  /** FR-18：显式声明的 codeSource 必须与代码来源字段自洽。 */
  TASK_CODE_SOURCE_MISMATCH: {
    status: 400,
    zh: "codeSource={{codeSource}} 与任务的代码来源字段不一致（gitRepo={{hasGit}}, glueSource={{hasGlue}}, applicationId={{hasApplicationId}}）",
    en: "codeSource={{codeSource}} does not match the task's code-source fields (gitRepo={{hasGit}}, glueSource={{hasGlue}}, applicationId={{hasApplicationId}})",
  },
  /** CONTRACT §2.1：codeSource=application_zip 必须同时提供 applicationId。 */
  TASK_CODE_SOURCE_ZIP_REQUIRES_APPLICATION: {
    status: 400,
    zh: "codeSource=application_zip 需要提供 applicationId（{{context}}）",
    en: "codeSource=application_zip requires an applicationId ({{context}})",
  },
  /** FR-19：zip 来源引用的应用不存在（弱引用，早失败成 400）。 */
  TASK_CODE_SOURCE_APPLICATION_NOT_FOUND: {
    status: 400,
    zh: "codeSource=application_zip 引用的应用 #{{applicationId}} 不存在",
    en: "The application #{{applicationId}} referenced by codeSource=application_zip does not exist",
  },
  /** FR-19 / AC-19a：上传包的 runtime 必须与任务的 runtime 一致。 */
  TASK_CODE_SOURCE_RUNTIME_MISMATCH: {
    status: 400,
    zh: "应用「{{appName}}」的 runtime={{appRuntime}} 与任务 runtime={{taskRuntime}} 不一致（AC-19a：上传包的 runtime 必须与任务的 runtime 一致）",
    en: "Application \"{{appName}}\" has runtime={{appRuntime}} but the task has runtime={{taskRuntime}} (AC-19a: an uploaded package's runtime must match the task's runtime)",
  },
  // ── 任务名/依赖项/投影/排序写面校验 ──────────────────────────────────────
  /** FEAT-RENAME：任务名不可用（原因由 task-name.constraint 派生）。 */
  TASK_NAME_UNAVAILABLE: {
    status: 400,
    zh: "任务名称不可用：{{reason}}",
    en: "Task name is not usable: {{reason}}",
  },
  /** W-21：requirements 条目为空/纯空白。 */
  TASK_REQUIREMENT_EMPTY: {
    status: 400,
    zh: "任务依赖项不能为空",
    en: "Task requirements cannot contain an empty entry",
  },
  /** W-21：requirements 条目以 `-` 开头（选项注入：可劫持包索引）。 */
  TASK_REQUIREMENT_OPTION_LIKE: {
    status: 400,
    zh: "任务依赖项非法（不允许带选项）：{{spec}}",
    en: "Invalid task requirement (option-like entries are not allowed): {{spec}}",
  },
  /** cron 写边界：表达式结构不可解析（非 5 段 / 非法字段）。 */
  TASK_CRON_FIELD_INVALID: {
    status: 400,
    zh: "{{field}} 必须是合法的 5 段 cron 表达式（分 时 日 月 周）",
    en: "{{field}} must be a valid 5-field cron expression (minute hour day month weekday)",
  },
  /** FIX-1.3：triggerType 与触发配置配对校验（缺配置 = 任务启用却永不触发）。 */
  TASK_TRIGGER_CRON_CONFIG_REQUIRED: {
    status: 400,
    zh: "triggerType=cron 需要提供 cronExpression（5 段 cron）— 缺失时任务会被登记为启用却永不触发",
    en: "triggerType=cron requires a cronExpression (5-field cron) — without it the task is registered as enabled but never fires",
  },
  TASK_TRIGGER_FIXED_RATE_CONFIG_REQUIRED: {
    status: 400,
    zh: "triggerType=fixed_rate 需要 fixedRate >= 1（秒）— 缺失时任务会被登记为启用却永不触发",
    en: "triggerType=fixed_rate requires fixedRate >= 1 (seconds) — without it the task is registered as enabled but never fires",
  },
  /** F-10：`?fields=` 轻量投影的字段白名单。 */
  TASK_PROJECTION_FIELD_INVALID: {
    status: 400,
    zh: "非法的投影字段：{{fields}}。允许的字段：{{allowed}}",
    en: "Illegal projection field(s): {{fields}}. Allowed fields: {{allowed}}",
  },
  /** F-03：`?sortBy=` 排序字段白名单。 */
  TASK_SORT_FIELD_INVALID: {
    status: 400,
    zh: "非法的 sortBy：{{sortBy}}。允许的值：{{allowed}}",
    en: "Illegal sortBy: {{sortBy}}. Allowed values: {{allowed}}",
  },
  // ── 归属/权限（NF-03 / AUTH-02 / TASK-PROJ-01 / TASK-SCOPE-01） ───────────
  /** TASK-SCOPE-01：`TASK_OPERATE_SCOPE=owner` 档下执行类写面的拒绝。 */
  TASK_OPERATE_SCOPE_OWNER: {
    status: 403,
    zh: "TASK_OPERATE_SCOPE=owner：触发任务或变更调度状态需要是任务属主、所属项目的 editor，或管理员",
    en: "TASK_OPERATE_SCOPE=owner: triggering a task or changing its schedule requires being the task owner, an editor of its project, or an administrator",
  },
  /** AUTH-02：执行类写面的硬约束——项目 viewer 只读。 */
  TASK_OPERATE_VIEWER_READONLY: {
    status: 403,
    zh: "你在该项目中的角色是 viewer（只读）；触发任务或变更调度状态需要 editor 角色",
    en: "Your role in this project is viewer (read-only); triggering a task or changing its schedule requires the editor role",
  },
  /** TASK-PROJ-01：项目仓储缺席的部署（无法校验归属存在性）。 */
  TASK_PROJECT_UNSUPPORTED: {
    status: 400,
    zh: "当前部署不支持任务归属项目",
    en: "This deployment does not support assigning tasks to projects",
  },
  /** TASK-PROJ-01：projectId 指向的项目不存在（早失败，避免 FK 违例变 500）。 */
  TASK_PROJECT_NOT_FOUND: {
    status: 400,
    zh: "项目 #{{projectId}} 不存在",
    en: "Project #{{projectId}} does not exist",
  },
  /** TASK-PROJ-01：改归属需要 ADMIN 或该项目 editor/admin。 */
  TASK_PROJECT_ASSIGN_FORBIDDEN: {
    status: 403,
    zh: "将任务归属到项目需要 ADMIN 或该项目 editor/admin 角色",
    en: "Assigning a task to a project requires the ADMIN role or the editor/admin role on that project",
  },
  /** TASK-PROJ-01：无用户主体（机器调用）时不得改归属；项目权限服务缺席时同样退化为仅 ADMIN。 */
  TASK_PROJECT_ASSIGN_ADMIN_ONLY: {
    status: 403,
    zh: "仅管理员可以将任务归属到项目",
    en: "Only administrators can assign a task to a project",
  },
  /** A2-B：按 executionId 操作的写面拿不到所属任务（悬垂行），保守拒绝。 */
  TASK_EXECUTION_SCOPE_UNKNOWN: {
    status: 403,
    zh: "该执行记录没有所属任务，拒绝写入",
    en: "This execution has no owning task; write refused",
  },
  /** A4：乐观锁——expectedUpdatedAt 与库内行不符（另一个标签页先写）。 */
  TASK_UPDATE_STALE: {
    status: 409,
    zh: "任务已被其他修改抢先更新（数据版本不一致），请刷新后重试",
    en: "The task was already updated by someone else (data version mismatch); please refresh and retry",
  },
  /** P0-1（UX-AUDIT）：拒绝用空/纯空白胶水脚本覆盖已存储脚本。 */
  TASK_GLUE_SOURCE_EMPTY: {
    status: 400,
    zh: "胶水脚本内容不能为空 — 拒绝用空代码覆盖已存储的脚本",
    en: "Glue script content cannot be empty — refusing to overwrite the stored script with empty code",
  },
  // ── E-1：任务定义导入/导出 ───────────────────────────────────────────────
  /** SEC-02：导出物中出现 /secret/i 命中的键（运行时不变量，fail-closed）。 */
  TASK_EXPORT_SECRET_LEAK: {
    status: 409,
    zh: '任务定义导出不变式被破坏："{{path}}" 命中密钥红线（/secret/i）—— 导出内容中绝不能出现密钥（SEC-02）',
    en: 'Task definition export invariant violated: "{{path}}" matches the secret red line (/secret/i) — exported content must never contain secrets (SEC-02)',
  },
  /** E-1：导入物的 `task.name` 缺失/为空。 */
  TASK_IMPORT_NAME_REQUIRED: {
    status: 400,
    zh: '导入内容非法："task.name" 为必填项，且必须是非空字符串',
    en: 'Invalid import content: "task.name" is required and must be a non-empty string',
  },
  // ── 任务模板（CORE-03 / E-P2-S1） ────────────────────────────────────────
  TASK_TEMPLATE_NOT_FOUND: {
    status: 404,
    zh: "任务模板不存在",
    en: "Task template not found",
  },
  TASK_TEMPLATE_KEY_EXISTS: {
    status: 409,
    zh: "模板 key「{{key}}」已存在",
    en: 'Template key "{{key}}" already exists',
  },
  /** A2：实例化产物会与既有任务重名（预检查，先于 DB 唯一索引给出可读文案）。 */
  TASK_TEMPLATE_INSTANTIATE_NAME_TAKEN: {
    status: 409,
    zh: "已存在同名任务「{{name}}」（id={{taskId}}）；如需再次实例化，请在覆盖体中提供新的 name",
    en: 'A task named "{{name}}" already exists (id={{taskId}}); to instantiate again, provide a new name in the override body',
  },
  TASK_TEMPLATE_CONFIG_NOT_OBJECT: {
    status: 400,
    zh: "模板 config 必须是对象",
    en: "Template config must be an object",
  },
  TASK_TEMPLATE_CONFIG_INVALID: {
    status: 400,
    zh: "模板 config 非法：{{detail}}",
    en: "Invalid template config: {{detail}}",
  },
  TASK_TEMPLATE_PAYLOAD_INVALID: {
    status: 400,
    zh: "任务载荷非法：{{detail}}",
    en: "Invalid task payload: {{detail}}",
  },
  TASK_TEMPLATE_OFFICIAL_READONLY: {
    status: 403,
    zh: "官方模板不可删除",
    en: "Official templates cannot be deleted",
  },
  TASK_TEMPLATE_LEGACY_ADMIN_ONLY: {
    status: 403,
    zh: "历史模板仅管理员可删除",
    en: "Legacy templates can only be deleted by administrators",
  },
  TASK_TEMPLATE_NOT_OWNER: {
    status: 403,
    zh: "仅属主或管理员可删除该模板",
    en: "Only the owner or an administrator can delete this template",
  },
  // ── 任务 Webhook（FEAT-07） ──────────────────────────────────────────────
  /**
   * 入站 webhook 鉴权失败——**任务不存在 / 未启用 / 签名无效 / 时间戳过期
   * 共用同一条消息**（反枚举：否则可用 401 文案探测 taskId 是否存在）。
   * 故刻意只有这一个码，任何细分都会重新打开枚举面。
   */
  TASK_WEBHOOK_AUTH_FAILED: {
    status: 401,
    zh: "任务 Webhook 鉴权失败",
    en: "Task webhook authentication failed",
  },
  TASK_WEBHOOK_PARAMS_NOT_OBJECT: {
    status: 400,
    zh: "params 必须是 JSON 对象",
    en: "params must be a JSON object",
  },
  TASK_WEBHOOK_PARAMS_TOO_LARGE: {
    status: 400,
    zh: "params 超过 {{max}} 字节",
    en: "params exceeds {{max}} bytes",
  },
  // ── 执行回调（执行器 → admin-api） ───────────────────────────────────────
  EXECUTION_CALLBACK_BATCH_TOO_LARGE: {
    status: 400,
    zh: "回调批次不能超过 100 条",
    en: "A callback batch cannot exceed 100 items",
  },
  EXECUTION_CALLBACK_BATCH_EMPTY: {
    status: 400,
    zh: "回调批次为空",
    en: "The callback batch is empty",
  },
  EXECUTION_CALLBACK_TOKEN_MISSING: {
    status: 401,
    zh: "缺少执行器令牌",
    en: "Missing executor token",
  },
  EXECUTION_CALLBACK_ADDRESS_REQUIRED: {
    status: 401,
    zh: "每个回调条目都必须带 executorAddress",
    en: "Every callback item must carry an executorAddress",
  },
  EXECUTION_CALLBACK_ADDRESS_TOKEN_INVALID: {
    status: 401,
    zh: "地址 {{address}} 的执行器令牌无效",
    en: "Invalid executor token for address {{address}}",
  },
  EXECUTION_CALLBACK_TOKEN_INVALID: {
    status: 401,
    zh: "执行回调令牌无效或已过期",
    en: "The execution callback token is invalid or expired",
  },
  EXECUTION_CALLBACK_TOKEN_WRONG_EXECUTION: {
    status: 401,
    zh: "该执行回调令牌不适用于本次执行",
    en: "This execution callback token does not apply to this execution",
  },
  EXECUTION_CALLBACK_ADDRESS_NOT_FOUND: {
    status: 401,
    zh: "未找到该执行对应的执行器地址",
    en: "No executor address found for this execution",
  },
  TASK_IDEMPOTENCY_KEY_INVALID: {
    status: 400,
    zh: "Idempotency-Key 非法：需 8-128 个字符，且只含字母/数字/._:-",
    en: "Invalid Idempotency-Key: 8-128 chars of letters/digits/._:-",
  },
  TASK_IDEMPOTENCY_REPLAY: {
    status: 409,
    zh: "该 Idempotency-Key 已用于触发此任务（同一键只触发一次）；如确需再次触发请使用新键",
    en: "This Idempotency-Key was already used to trigger this task (one trigger per key); use a new key to trigger again",
  },
  TASK_IDEMPOTENCY_KEY_REUSED: {
    status: 409,
    zh: "该 Idempotency-Key 已用于不同的触发参数；同一键不能对应两份参数（请换新键或复用原参数）",
    en: "This Idempotency-Key was used with different trigger parameters; one key cannot map to two payloads (use a new key or the original params)",
  },
} as const satisfies Record<string, ErrorCodeDef>;
