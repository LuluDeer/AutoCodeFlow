import type { ErrorCodeDef } from "../error-code-def";

/** LANG-ERR-01 · 执行器域错误码分片（executor / executor-package / agent）。 */
export const EXECUTOR_CODES = {
  EXECUTOR_NOT_FOUND: {
    status: 404,
    zh: "执行器不存在",
    en: "Executor not found",
  },
  EXECUTOR_OFFLINE: {
    status: 409,
    zh: "执行器「{{address}}」当前离线",
    en: 'Executor "{{address}}" is offline',
  },
  NO_AVAILABLE_EXECUTOR: {
    status: 409,
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
  PINNED_EXECUTOR_NOT_FOUND: {
    status: 500,
    zh: "指定的固定执行器 {{executorId}} 不存在",
    en: "The pinned executor {{executorId}} does not exist",
  },
  PINNED_EXECUTOR_OFFLINE: {
    status: 500,
    zh: '指定的固定执行器 "{{appName}}" ({{executorId}}) 已离线',
    en: 'The pinned executor "{{appName}}" ({{executorId}}) is offline',
  },
  EXECUTOR_APP_NAME_NOT_FOUND: {
    status: 500,
    zh: "没有 appName 为 {{appName}} 的可用执行器",
    en: "No available executor with appName {{appName}}",
  },
  NO_DISPATCHABLE_EXECUTOR: {
    status: 500,
    zh: "没有可用的执行器（所有候选执行器都已离线或达到容量上限）",
    en: "No executor available (every candidate executor is offline or at capacity)",
  },
  NO_BROADCAST_EXECUTOR: {
    status: 500,
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
  EXECUTOR_INSTALL_CMD_NOT_CONFIGURED: {
    status: 503,
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
  EXECUTOR_PACKAGE_PUSH_NO_TARGETS: {
    status: 500,
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
