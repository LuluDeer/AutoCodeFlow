import type { ErrorCodeDef } from "../error-code-def";

/**
 * LANG-ERR-01 · 应用/部署域错误码分片。
 *
 * 覆盖 `modules/application/**`（应用 CRUD / 部署 / 发布追溯 / 审批 / 灰度 /
 * 互斥组）与 `modules/artifacts/**`（执行产物）。
 *
 * ⚠️ 新增码时**只改本片**，不要动合并点 `error-codes.ts`——那是并发迁移的
 * 冲突点（详见 `error-code-def.ts` 的分片理由）。
 */
export const APPLICATION_CODES = {
  // ── 应用（ApplicationService）─────────────────────────────────────
  APPLICATION_NOT_FOUND: {
    status: 404,
    zh: "应用 {{id}} 不存在",
    en: "Application {{id}} not found",
  },
  APPLICATION_NAME_EXISTS: {
    status: 409,
    zh: '应用 "{{name}}" 已存在',
    en: 'Application "{{name}}" already exists',
  },
  APPLICATION_NOT_OWNER: {
    status: 403,
    zh: "你不拥有该应用",
    en: "You do not own this application",
  },
  APPLICATION_HAS_NO_OWNER: {
    status: 403,
    zh: "该应用没有归属人（历史数据行），只有管理员可以修改",
    en: "This application has no owner (legacy row); only administrators can modify it",
  },
  APPLICATION_HAS_IN_FLIGHT_DEPLOYMENT: {
    status: 409,
    zh: "应用 {{name}} 仍有进行中的部署{{detail}}。请先取消该部署或等待其进入终态，再删除应用。",
    en: "Application {{name}} still has an in-flight deployment{{detail}}. Cancel it or wait for a terminal state before deleting the application.",
  },
  MUTEX_GROUP_NOT_FOUND: {
    status: 404,
    zh: "互斥组 {{groupId}} 不存在",
    en: "Mutex group {{groupId}} not found",
  },
  /**
   * MUTEX-01：组名唯一（`unique(name)`）。
   *
   * 三个抛点共用一个码：create 的同名预检查、create 落库撞 23505 的 TOCTOU 兜底、
   * update 的改名撞名——**用户看到的处置动作是同一个**（换个名字），故不按抛点
   * 分码（分码会让翻译侧出现三条措辞相同、仅位置不同的词条）。
   */
  MUTEX_GROUP_NAME_EXISTS: {
    status: 409,
    zh: '互斥组 "{{name}}" 已存在',
    en: 'Mutex group "{{name}}" already exists',
  },
  /**
   * MUTEX-01：组上仍挂着应用且未显式 force。
   *
   * 这条 409 是**有意的破坏性操作闸**：删除组会让 `applications.mutexGroupId`
   * 经 FK ON DELETE SET NULL 静默解组（一批应用从此不再互斥）。文案必须说清
   * 「会造成什么」+「怎么继续」，否则用户只会看到一句拒绝而无从下手。
   */
  MUTEX_GROUP_HAS_APPLICATIONS: {
    status: 409,
    zh: "仍有 {{count}} 个应用挂在该组上；删除将解除它们的互斥约束，请确认后带 force=true 重试",
    en: "{{count}} application(s) are still attached to this mutex group; deleting it releases their mutual-exclusion constraint. Re-run with force=true to confirm",
  },

  // ── 应用包上传（application.controller 的 /applications/upload）──────
  APP_UPLOAD_FILE_MISSING: {
    status: 400,
    zh: "未上传文件",
    en: "No file was uploaded",
  },
  APP_UPLOAD_NAME_REQUIRED: {
    status: 400,
    zh: "应用名称必填",
    en: "The application name is required",
  },
  APP_UPLOAD_PAYLOAD_MISSING: {
    status: 400,
    zh: "缺少上传文件载荷（应为 multer diskStorage 上传）",
    en: "Missing the uploaded file payload (expected a multer diskStorage upload)",
  },
  APP_UPLOAD_NOT_ZIP: {
    status: 400,
    zh: "应用包必须是 .zip 文件",
    en: "The application package must be a .zip file",
  },
  APP_UPLOAD_NOT_ZIP_ARCHIVE: {
    status: 400,
    zh: "文件不是合法的 ZIP 归档",
    en: "The file is not a valid ZIP archive",
  },
  APP_UPLOAD_ZIP_GUARD_REJECTED: {
    status: 400,
    zh: "包被 zip-bomb 防护拒绝（{{violation}}）",
    en: "The package was rejected by the zip-bomb guard ({{violation}})",
  },
  APP_UPLOAD_MALWARE_DETECTED: {
    status: 400,
    zh: "包被拒绝：病毒扫描检出威胁",
    en: "Package rejected: the virus scan detected a threat",
  },
  APP_UPLOAD_SCANNER_UNAVAILABLE: {
    status: 503,
    zh: "包被拒绝：病毒扫描不可用（故障关闭）",
    en: "Package rejected: the virus scanner is unavailable (fail-closed)",
  },
  APP_UPLOAD_BASE_URL_NOT_CONFIGURED: {
    status: 500,
    zh: "未配置 API_BASE_URL，无法构造包下载 URL",
    en: "API_BASE_URL is not configured; a package download URL cannot be built",
  },
  /**
   * APP-001：CI webhook 的所有鉴权失败**必须返回完全相同的响应**（应用不存在 /
   * secret 未配置 / 签名缺失或无效 / 时间戳过期 / raw body 缺失），否则响应差异
   * 会成为应用名枚举的判定依据。故单列一码，各分支共用——具体原因只进服务端日志。
   */
  APP_WEBHOOK_AUTH_FAILED: {
    status: 401,
    zh: "Webhook 鉴权失败",
    en: "Webhook authentication failed",
  },
  /**
   * `deployFromGit` 的 git 分支名/仓库 URL 形状闸（防命令注入）。
   *
   * status=400 与最终落库的失败面一致：这两条在 `deployFromGit` 里以普通
   * `Error` 抛出（异步部署链，非 HTTP 请求帧），落到应用行 status=failed 与
   * 审计/日志；迁到 `AppError(400)` 后 `instanceof BadRequestException` 成立，
   * 前端按用户语言渲染同一含义。
   */
  GIT_BRANCH_NAME_INVALID: {
    status: 400,
    zh: "git 分支名非法：{{branch}}",
    en: "Invalid git branch name: {{branch}}",
  },
  GIT_REPO_URL_FORMAT_INVALID: {
    status: 400,
    zh: "git 仓库 URL 非法：{{repo}}",
    en: "Invalid git repository URL: {{repo}}",
  },
  GIT_REV_PARSE_FAILED: {
    status: 400,
    zh: "git rev-parse HEAD 执行失败",
    en: "git rev-parse HEAD failed",
  },

  // ── 部署行（AppDeploymentService）─────────────────────────────────
  APP_DEPLOYMENT_NOT_FOUND: {
    status: 404,
    zh: "部署 {{deploymentId}} 不存在",
    en: "Deployment {{deploymentId}} not found",
  },
  APP_DEPLOYMENT_CONCURRENT_MODIFICATION: {
    status: 409,
    zh: "部署 {{deploymentId}} 已被并发修改；请重新加载后重试",
    en: "Deployment {{deploymentId}} was modified concurrently; reload and retry",
  },
  APP_DEPLOYMENT_ALREADY_IN_FLIGHT: {
    status: 409,
    zh: "应用 {{name}} 已有进行中的部署{{detail}}。请等待其完成或先取消。",
    en: "Application {{name}} already has an in-flight deployment{{detail}}. Wait for it to finish or cancel it first.",
  },
  APP_DEPLOYMENT_ALREADY_HANDLED: {
    status: 409,
    zh: "部署 {{deploymentId}} 已被并发操作处理",
    en: "Deployment {{deploymentId}} was already handled by a concurrent request",
  },
  APP_DEPLOYMENT_NOT_PENDING_APPROVAL: {
    status: 409,
    zh: "部署 {{deploymentId}} 未处于待审批状态（approvalStatus={{approvalStatus}}）",
    en: "Deployment {{deploymentId}} is not pending approval (approvalStatus={{approvalStatus}})",
  },
  APP_DEPLOYMENT_AWAITING_APPROVAL: {
    status: 409,
    zh: "部署正在等待审批；请先审批通过或拒绝",
    en: "The deployment is awaiting approval; approve or reject it first",
  },
  APP_DEPLOYMENT_AWAITING_APPROVAL_DELETE: {
    status: 409,
    zh: "部署正在等待审批；请改为拒绝或取消，而不是删除",
    en: "The deployment is awaiting approval; reject or cancel it instead of deleting",
  },
  APP_DEPLOYMENT_SECOND_PERSON_REQUIRED: {
    status: 403,
    zh: "第二人规则：申请人不能自行裁决自己的部署审批",
    en: "Second-person rule: the requester cannot decide their own deployment approval",
  },
  APP_DEPLOYMENT_CANCEL_NOT_REQUESTER: {
    status: 403,
    zh: "只有申请人可以取消待审批的部署审批；请改用 reject 接口",
    en: "Only the requester can cancel a pending deployment approval; use the reject endpoint instead",
  },
  APP_DEPLOYMENT_STILL_IN_FLIGHT: {
    status: 409,
    zh: "部署 {{deploymentId}} 正在进行中 (status={{status}})；请等待其完成后再删除记录",
    en: "Deployment {{deploymentId}} is in progress (status={{status}}); wait for it to finish before deleting the record",
  },
  /**
   * P2-1（2026-10-25 审计）：对在途行（pending/deploying/upgrading）调 stop。
   * 与上方 APP_DEPLOYMENT_STILL_IN_FLIGHT（删除面）**不共用**：两者的处置
   * 动作不同（「等完成后再停止」≠「等完成后再删除」），合并会让词条替另一
   * 个端点说话——MUTEX-01 分码判据的镜像运用。
   */
  APP_DEPLOYMENT_STOP_IN_FLIGHT: {
    status: 409,
    zh: "部署 {{deploymentId}} 正在进行中 (status={{status}})；请等待其完成后再停止",
    en: "Deployment {{deploymentId}} is in progress (status={{status}}); wait for it to finish before stopping it",
  },
  APP_DEPLOYMENT_STILL_RUNNING: {
    status: 409,
    zh: "部署 {{deploymentId}} 仍在运行；请先停止，再删除记录",
    en: "Deployment {{deploymentId}} is still running; stop it before deleting the record",
  },
  APP_ROLLBACK_VERSION_OTHER_APP: {
    status: 400,
    zh: "指定的版本不属于该应用",
    en: "The specified version does not belong to this application",
  },
  APP_ROLLBACK_VERSION_NO_NUMBER: {
    status: 400,
    zh: "指定的版本没有版本号",
    en: "The specified version has no version number",
  },
  APP_ROLLBACK_VERSION_NOT_RELEASED: {
    status: 400,
    zh: "只有已发布的应用版本可以回滚",
    en: "Only released application versions can be rolled back to",
  },
  APP_ROLLBACK_DEPLOYMENT_OTHER_APP: {
    status: 400,
    zh: "指定的部署不属于该应用",
    en: "The specified deployment does not belong to this application",
  },
  APP_ROLLBACK_DEPLOYMENT_NO_VERSION: {
    status: 400,
    zh: "指定的部署没有已部署版本",
    en: "The specified deployment has no deployed version",
  },
  // R1（2026-10-24 部署模型评审 §4.2）：set-current-version / deploy-version
  // 只收版本快照主键，查无即 404（不象旧 rollback 那样隐式落到 legacy 部署行）。
  APP_VERSION_NOT_FOUND: {
    status: 404,
    zh: "指定的版本快照不存在",
    en: "The specified version snapshot was not found",
  },
  APP_ROLLOUT_VERSION_NOT_FOUND: {
    status: 400,
    zh: '该应用下未找到版本 "{{version}}"',
    en: 'Version "{{version}}" was not found for this application',
  },
  APP_ROLLOUT_VERSION_NOT_RELEASED: {
    status: 400,
    zh: "只有已发布的应用版本可以作为灰度发布目标",
    en: "Only released application versions can be used as a canary rollout target",
  },

  // ── 执行器地址（推送到执行器前的形状校验）──────────────────────────
  EXECUTOR_ADDRESS_FORMAT_INVALID: {
    status: 400,
    zh: '执行器地址格式无效："{{address}}"',
    en: 'Invalid executor address format: "{{address}}"',
  },
  EXECUTOR_ADDRESS_PORT_OUT_OF_RANGE: {
    status: 400,
    zh: "执行器地址端口超出范围：{{port}}",
    en: "Executor address port out of range: {{port}}",
  },

  // ── 执行器心跳回调鉴权（app-deployment.controller 的 @Public 机器面）──
  EXECUTOR_HEARTBEAT_TOKEN_MISSING: {
    status: 401,
    zh: "缺少 X-Executor-Token 请求头",
    en: "Missing the X-Executor-Token header",
  },
  /**
   * P3-5（2026-10-25 审计）：心跳路由已不再抛本码——「查无行/行无执行器/
   * 令牌无效」三种失败收敛为同一个 401 EXECUTOR_HEARTBEAT_TOKEN_INVALID
   * （消 404/401 oracle，部署存在性不可被未鉴权探测）。词条保留：admin-web
   * 的生成 i18n 表仍含该键（该侧由另一轮维护），删码会让键变成孤儿。
   */
  EXECUTOR_HEARTBEAT_NO_EXECUTOR: {
    status: 401,
    zh: "无法校验令牌：该部署没有关联的执行器",
    en: "Cannot verify the token: this deployment has no associated executor",
  },
  EXECUTOR_HEARTBEAT_TOKEN_INVALID: {
    status: 401,
    zh: "执行器令牌无效",
    en: "Invalid executor token",
  },

  // ── 产物（ArtifactsService / ArtifactsController）──────────────────
  ARTIFACT_EXECUTION_ID_INVALID: {
    status: 400,
    zh: "执行 ID 非法",
    en: "Invalid execution ID",
  },
  ARTIFACT_NAME_INVALID: {
    status: 400,
    zh: "产物名称非法",
    en: "Invalid artifact name",
  },
  ARTIFACT_PATH_INVALID: {
    status: 400,
    zh: "产物路径非法",
    en: "Invalid artifact path",
  },
  ARTIFACT_COUNT_LIMIT_REACHED: {
    status: 400,
    zh: "本次执行的产物数量已达上限（{{max}}）",
    en: "This execution has reached the artifact count limit ({{max}})",
  },
  ARTIFACT_TOO_LARGE: {
    status: 400,
    zh: "产物超出大小上限",
    en: "Artifact exceeds the size limit",
  },
  ARTIFACT_SHA256_MISMATCH: {
    status: 400,
    zh: "产物 sha256 与上传内容不一致",
    en: "Artifact sha256 does not match the uploaded content",
  },
  ARTIFACT_NOT_FOUND: {
    status: 404,
    zh: "产物不存在",
    en: "Artifact not found",
  },
  ARTIFACT_FILE_MISSING: {
    status: 400,
    zh: "未上传产物文件",
    en: "No artifact file was uploaded",
  },
  /** 产物上传面的机器鉴权失败（执行器凭证无效，机器对机器）。 */
  EXECUTOR_CREDENTIAL_INVALID: {
    status: 401,
    zh: "执行器凭证无效",
    en: "Invalid executor credential",
  },

  // ── 通知（notification/**）───────────────────────────────────────
  NOTIFICATION_CHANNEL_UNKNOWN: {
    status: 400,
    zh: "未知的通知渠道：{{key}}。有效渠道：{{validKeys}}",
    en: "Unknown notification channel: {{key}}. Valid channels: {{validKeys}}",
  },
  NOTIFICATION_ALERT_WEBHOOK_NOT_CONFIGURED: {
    status: 503,
    zh: "告警 Webhook 已禁用：未配置 ALERT_WEBHOOK_SECRET",
    en: "Alert webhook is disabled: ALERT_WEBHOOK_SECRET is not configured",
  },
  NOTIFICATION_ALERT_AUTH_FAILED: {
    status: 401,
    zh: "告警 Webhook 鉴权失败",
    en: "Alert webhook authentication failed",
  },
  NOTIFICATION_ALERT_PAYLOAD_EMPTY: {
    status: 400,
    zh: "Alertmanager 载荷中没有 alerts 数组（或数组为空）",
    en: "The Alertmanager payload has no alerts array (or it is empty)",
  },
  NOTIFICATION_ALERT_PAYLOAD_UNMAPPED: {
    status: 400,
    zh: "Alertmanager 载荷未映射到任何内容",
    en: "The Alertmanager payload did not map to any notification content",
  },
  /**
   * OBS-02：告警收到了，但**一个渠道都没投出去**（全 skipped = 没人会知道）。
   *
   * 为什么是 502 而不是 200：Alertmanager 只在非 2xx 时重试——返回 200 会让
   * 告警彻底静默丢失（"发成功了但没人收到"是最坏的形态）。旧实现即
   * `BadGatewayException`，故 status 逐字保持 502。
   *
   * 逐渠道结果经 `params.results` 透出：旧实现把 `results` 塞在异常的响应对象里，
   * 而全局 filter 只取 `message`（其余键被丢弃），**它从未真正到达客户端**——
   * 走 `params` 是让这份排障信息第一次真的可见（纯增量，不改任何既有字段）。
   */
  NOTIFICATION_ALERT_NOT_DELIVERED: {
    status: 502,
    zh: "已收到告警，但没有任何通知渠道投递成功",
    en: "Alert received but not delivered to any notification channel",
  },
  NOTIFICATION_SILENCE_TOO_MANY: {
    status: 400,
    zh: "告警静默规则过多（上限 {{max}}）。请先删除已过期的规则。",
    en: "Too many alert silence rules (max {{max}}). Delete expired rules first.",
  },
  NOTIFICATION_SILENCE_SCOPE_INVALID: {
    status: 400,
    zh: "scope 非法：{{scope}}；应为以下之一：{{validScopes}}",
    en: "Invalid scope: {{scope}}; expected one of: {{validScopes}}",
  },
  NOTIFICATION_SILENCE_TASK_ID_REQUIRED: {
    status: 400,
    zh: "scope=task 需要提供 taskId",
    en: "scope=task requires a taskId",
  },
  NOTIFICATION_SILENCE_APPLICATION_ID_REQUIRED: {
    status: 400,
    zh: "scope=application 需要提供 applicationId",
    en: "scope=application requires an applicationId",
  },
  NOTIFICATION_SILENCE_LEVEL_INVALID: {
    status: 400,
    zh: "level 非法：{{level}}；应为以下之一：{{validLevels}}",
    en: "Invalid level: {{level}}; expected one of: {{validLevels}}",
  },
  NOTIFICATION_SILENCE_DURATION_INVALID: {
    status: 400,
    zh: "durationMinutes 非法：{{durationMinutes}}；应为正数",
    en: "Invalid durationMinutes: {{durationMinutes}}; expected a positive number",
  },
  NOTIFICATION_SILENCE_CHANNEL_TYPE_INVALID: {
    status: 400,
    zh: "channelType 非法：{{channelType}}",
    en: "Invalid channelType: {{channelType}}",
  },
  NOTIFICATION_WEBHOOK_BLOCKED: {
    status: 400,
    zh: "Webhook URL 被 SSRF 策略拒绝（不允许指向 private/loopback/link-local/benchmark/CGNAT 目标）：{{url}}",
    en: "The webhook URL was refused by the SSRF policy (private/loopback/link-local/benchmark/CGNAT targets are not allowed): {{url}}",
  },

  // ── 事件订阅（event-subscriptions/**）─────────────────────────────
  EVENT_SUBSCRIPTION_NOT_FOUND: {
    status: 404,
    zh: "订阅 {{id}} 不存在",
    en: "Subscription {{id}} not found",
  },
  EVENT_SUBSCRIPTION_NOT_OWNER: {
    status: 403,
    zh: "你不拥有该订阅",
    en: "You do not own this subscription",
  },
  EVENT_SUBSCRIPTION_PRIVATE_NETWORK_REQUIRES_ADMIN: {
    status: 403,
    zh: "当 EVENT_WEBHOOK_ALLOW_PRIVATE_NETWORK=true 时，创建或更新事件订阅需要 ADMIN 权限",
    en: "When EVENT_WEBHOOK_ALLOW_PRIVATE_NETWORK=true, creating or updating an event subscription requires ADMIN",
  },
  EVENT_SUBSCRIPTION_TOO_MANY: {
    status: 400,
    zh: "事件订阅数量过多（上限 {{max}}）。请先删除不再使用的订阅。",
    en: "Too many event subscriptions (max {{max}}). Delete subscriptions you no longer use first.",
  },
  EVENT_SUBSCRIPTION_EVENT_TYPE_UNKNOWN: {
    status: 400,
    zh: "未知的事件类型：{{eventType}}",
    en: "Unknown event type: {{eventType}}",
  },
  EVENT_SUBSCRIPTION_DEAD_LETTER_NOT_FOUND: {
    status: 404,
    zh: "死信 {{deadLetterId}} 不存在",
    en: "Dead letter {{deadLetterId}} not found",
  },

  // ── SOP（sop/**）─────────────────────────────────────────────────
  SOP_NOT_FOUND: {
    status: 404,
    zh: "SOP {{sopId}} 不存在",
    en: "SOP {{sopId}} not found",
  },
  SOP_SLUG_INVALID: {
    status: 400,
    zh: "slug 必须是小写字母/数字/连字符，1..128 位",
    en: "slug must be lowercase letters/digits/hyphens, 1..128 characters",
  },
  SOP_CONTENT_MISSING: {
    status: 400,
    zh: "SOP 缺 front-matter 或正文，无法发布",
    en: "The SOP is missing its front-matter or body and cannot be published",
  },
  SOP_CONTENT_UNCHANGED: {
    status: 400,
    zh: "内容与当前版本完全一致，无需发布新版本（修订必须真的改了什么）",
    en: "The content is identical to the current version; a new version must actually change something",
  },
  SOP_VERSION_NOT_SEMVER: {
    status: 400,
    zh: "既有版本 {{version}} 不是 semver，无法递增",
    en: "Existing version {{version}} is not semver and cannot be incremented",
  },
  SOP_NOT_PUBLISHED: {
    status: 400,
    zh: "SOP 尚未发布，无法指派（先 publish）",
    en: "The SOP is not published yet and cannot be assigned (publish it first)",
  },
  /**
   * 归档（2026-10-23）：`deprecated` 此前是**死状态**——枚举里有、DTO 里有，
   * 但全仓没有任何代码能写进去，于是 SOP 只增不减（实测 19 条里 16 条是
   * 测试残留，无法下线）。
   */
  SOP_ALREADY_DEPRECATED: {
    status: 409,
    zh: "SOP {{slug}} 已是归档状态",
    en: "SOP {{slug}} is already archived",
  },
  SOP_ARCHIVE_HAS_ACTIVE_ASSIGNMENTS: {
    status: 409,
    zh: "SOP {{slug}} 还有 {{count}} 个未结束的指派，先处理完再归档",
    en: "SOP {{slug}} still has {{count}} unfinished assignments; finish them before archiving",
  },
  SOP_NOT_DEPRECATED: {
    status: 409,
    zh: "SOP {{slug}} 不是归档状态，无需恢复",
    en: "SOP {{slug}} is not archived, nothing to restore",
  },
  SOP_VERSION_NOT_FOUND: {
    status: 404,
    zh: "SOP {{slug}} 无版本 {{version}}",
    en: "SOP {{slug}} has no version {{version}}",
  },
  SOP_ASSIGNMENT_NOT_FOUND: {
    status: 404,
    zh: "指派 {{assignmentId}} 不存在",
    en: "Assignment {{assignmentId}} not found",
  },
  SOP_ASSIGNMENT_NOT_OWNED_BY_EXECUTOR: {
    status: 403,
    zh: "指派不属于该执行器",
    en: "The assignment does not belong to this executor",
  },
  SOP_ASSIGNMENT_TERMINAL: {
    status: 400,
    zh: "指派已是终态（{{status}}）",
    en: "The assignment is already in a terminal state ({{status}})",
  },
  SOP_ASSIGNMENT_TERMINAL_CLARIFICATION: {
    status: 400,
    zh: "指派已是终态（{{status}}），不接受澄清",
    en: "The assignment is already in a terminal state ({{status}}) and accepts no clarifications",
  },
  SOP_EXECUTOR_CAPABILITY_MISSING: {
    status: 403,
    zh: "执行器未声明 SOP 所需的有效 Agent 能力",
    en: "The executor has not declared the Agent capabilities this SOP requires",
  },
  SOP_CLARIFICATION_NOT_FOUND: {
    status: 404,
    zh: "澄清 {{clarificationId}} 不存在",
    en: "Clarification {{clarificationId}} not found",
  },
  SOP_CLARIFICATION_NOT_IN_ASSIGNMENT: {
    status: 404,
    zh: "澄清不存在或不属于该指派",
    en: "The clarification does not exist or does not belong to this assignment",
  },
  SOP_CLARIFICATION_NOT_REPLIED: {
    status: 400,
    zh: "该澄清尚未回复，无可确认",
    en: "This clarification has not been replied to yet; nothing to acknowledge",
  },
  SOP_CLARIFICATION_QUESTION_REQUIRED: {
    status: 400,
    zh: "question 不能为空",
    en: "question must not be empty",
  },
  SOP_CLARIFICATION_ROUND_CONFLICT: {
    status: 409,
    zh: "澄清轮次并发冲突（多次重试后仍失败），请稍后重试",
    en: "Concurrent clarification-round conflict (still failing after retries); retry later",
  },
  SOP_CLARIFICATION_RESOLUTION_INVALID: {
    status: 400,
    zh: "resolution 必须是 {{validResolutions}}",
    en: "resolution must be one of {{validResolutions}}",
  },
  SOP_CLARIFICATION_AMENDMENT_MISSING: {
    status: 400,
    zh: "sop_amended 必须提供修订内容（front-matter 或正文）",
    en: "sop_amended requires the revised content (front-matter or body)",
  },
  SOP_ASSIGNMENT_NOT_FOUND_FOR_CLARIFICATION: {
    status: 404,
    zh: "澄清所属指派不存在",
    en: "The assignment this clarification belongs to does not exist",
  },
  SOP_MEDIA_REFS_TOO_MANY: {
    status: 400,
    zh: "mediaRefs 最多 4 条",
    en: "mediaRefs accepts at most 4 entries",
  },
  SOP_MEDIA_REF_INVALID: {
    status: 400,
    zh: "mediaRefs[{{index}}] 非法",
    en: "mediaRefs[{{index}}] is invalid",
  },
  SOP_MEDIA_REF_KIND_INVALID: {
    status: 400,
    zh: "mediaRefs[{{index}}].kind 必须是 video | screenshot | other",
    en: "mediaRefs[{{index}}].kind must be video | screenshot | other",
  },
  SOP_MEDIA_REF_URL_NOT_PLATFORM: {
    status: 400,
    zh: "mediaRefs[{{index}}].url 必须是平台 artifacts 路径（/api/...）——不接受外网 URL（SSRF 转嫁面，11 §5.2）",
    en: "mediaRefs[{{index}}].url must be a platform artifacts path (/api/...); external URLs are not accepted",
  },
  SOP_MEDIA_REF_URL_TOO_LONG: {
    status: 400,
    zh: "mediaRefs[{{index}}].url 超长",
    en: "mediaRefs[{{index}}].url is too long",
  },
  SOP_JSON_FIELD_TOO_LARGE: {
    status: 400,
    zh: "{{label}} 超过 {{max}} 字节上限",
    en: "{{label}} exceeds the {{max}}-byte limit",
  },
  SOP_CLARIFICATION_NOT_IN_ASSIGNMENT_FORBIDDEN: {
    status: 403,
    zh: "澄清不属于该指派",
    en: "The clarification does not belong to this assignment",
  },
  SOP_EXECUTOR_NOT_FOUND_BY_ADDRESS: {
    status: 403,
    zh: "执行器 {{address}} 不存在",
    en: "Executor {{address}} does not exist",
  },
  SOP_ASSIGN_EXECUTOR_REQUIRED: {
    status: 403,
    zh: "executorId 与 executorAddress 必须提供其一",
    en: "Either executorId or executorAddress must be provided",
  },
  SOP_COLLAB_CAPABILITIES_INVALID: {
    status: 400,
    zh: "capabilities 必须是 ≤32 个、每个 ≤64 字符的字符串",
    en: "capabilities must be at most 32 strings of at most 64 characters each",
  },
  SOP_COLLAB_ASSIGNMENT_ID_AND_QUESTION_REQUIRED: {
    status: 400,
    zh: "assignmentId 与 question 必填",
    en: "assignmentId and question are required",
  },
  SOP_COLLAB_STATUS_INVALID: {
    status: 400,
    zh: "status 必须是 completed | failed",
    en: "status must be completed | failed",
  },
  SOP_COLLAB_CLARIFICATION_ID_REQUIRED: {
    status: 400,
    zh: "clarificationId 必填",
    en: "clarificationId is required",
  },
  SOP_COLLAB_MESSAGES_COUNT_INVALID: {
    status: 400,
    zh: "messages 必须是 1..64 条",
    en: "messages must contain 1..64 entries",
  },
  SOP_COLLAB_MESSAGE_ROLE_INVALID: {
    status: 400,
    zh: "messages[{{index}}].role 必须是 system | user | assistant",
    en: "messages[{{index}}].role must be system | user | assistant",
  },
  SOP_COLLAB_MESSAGE_CONTENT_REQUIRED: {
    status: 400,
    zh: "messages[{{index}}].content 必须是非空字符串",
    en: "messages[{{index}}].content must be a non-empty string",
  },
  SOP_COLLAB_MESSAGE_CONTENT_TOO_LARGE: {
    status: 400,
    zh: "messages[{{index}}].content 超过 100KB 上限",
    en: "messages[{{index}}].content exceeds the 100KB limit",
  },
  SOP_COLLAB_TOOLS_TOO_MANY: {
    status: 400,
    zh: "tools 最多 32 个",
    en: "tools accepts at most 32 entries",
  },
  SOP_COLLAB_FILE_FIELD_MISSING: {
    status: 400,
    zh: "缺少 file 字段（multipart）",
    en: "Missing the file field (multipart)",
  },
  SOP_COLLAB_ADDRESS_REQUIRED: {
    status: 400,
    zh: "address 必填",
    en: "address is required",
  },
  SOP_COLLAB_EXECUTOR_TOKEN_INVALID: {
    status: 401,
    zh: "执行器令牌无效",
    en: "Invalid executor token",
  },
  SOP_COLLAB_EXECUTOR_NOT_FOUND: {
    status: 404,
    zh: "执行器不存在",
    en: "Executor not found",
  },
  SOP_COLLAB_AGENT_SOP_CAPABILITY_MISSING: {
    status: 403,
    zh: "该执行器未声明 agent:sop 能力——SOP 协作面只对显式声明的机器开放（空能力 ≠ 通用）",
    en: "This executor has not declared the agent:sop capability; the SOP collaboration surface is only open to machines that declare it explicitly",
  },
  SOP_MEDIA_NAME_INVALID: {
    status: 400,
    zh: "媒体名必须是 1..255 的 [A-Za-z0-9._-]（不含路径语义）",
    en: "The media name must be 1..255 characters of [A-Za-z0-9._-] (no path semantics)",
  },
  SOP_MEDIA_EMPTY: {
    status: 400,
    zh: "空媒体文件",
    en: "Empty media file",
  },
  SOP_MEDIA_TOO_LARGE: {
    status: 400,
    zh: "媒体超过 {{max}} 字节上限",
    en: "Media exceeds the {{max}}-byte limit",
  },
  SOP_MEDIA_ASSIGNMENT_ID_INVALID: {
    status: 400,
    zh: "assignmentId 必须是 UUID",
    en: "assignmentId must be a UUID",
  },
  SOP_MEDIA_STORAGE_PATH_ESCAPED: {
    status: 400,
    zh: "存储路径越界",
    en: "Storage path escapes the media root",
  },
  SOP_MEDIA_NOT_FOUND: {
    status: 404,
    zh: "媒体 {{id}} 不存在",
    en: "Media {{id}} not found",
  },
  SOP_MEDIA_FILE_MISSING: {
    status: 404,
    zh: "媒体文件缺失（可能已被保留期清理）",
    en: "The media file is missing (it may have been removed by the retention policy)",
  },

  // ── 通用工具 / 守卫 / 后台服务 ────────────────────────────────────
  WRITE_GUARD_ASSERTION_MISSING: {
    status: 500,
    zh: "写端点缺少授权断言（服务端配置错误）",
    en: "Write endpoint is missing its authorization assertion (server misconfiguration)",
  },

  // ── SSRF 出站守卫（common/utils/safe-http.util.ts）──────────────────
  //
  // ⚠️ 这里是**出站请求的唯一咽喉**（webhook/AI/执行器/git 克隆共用）。zh 文案
  // 与迁移前逐字一致，且两处 spec（safe-http.util.spec / ssrf-deny-matrix.spec）
  // 按文本断言（/拒绝名单/、/已拒绝克隆/ 等）——改措辞即改契约，务必先读 spec。
  //
  // 同一逻辑失败在多形态守卫间复用**同一个码**；仅当措辞真正不同（如 pinned
  // 变体追加「— 已拒绝对外请求」）才另立一码。
  SSRF_URL_INVALID: {
    status: 400,
    zh: "URL 无效：{{url}}",
    en: "Invalid URL: {{url}}",
  },
  SSRF_PROTOCOL_NOT_HTTP: {
    status: 400,
    zh: "URL 必须使用 http(s)；实际为 '{{protocol}}'",
    en: "URL must use http(s); got '{{protocol}}'",
  },
  SSRF_HOST_MISSING: {
    status: 400,
    zh: "URL 缺少主机名",
    en: "URL is missing a hostname",
  },
  SSRF_CREDENTIALS_IN_URL: {
    status: 400,
    zh: "URL 不得内嵌凭据：{{url}}",
    en: "URL must not embed credentials: {{url}}",
  },
  SSRF_HOST_UNRESOLVABLE: {
    status: 400,
    zh: "URL 主机 {{host}} 无法解析",
    en: "URL host {{host}} could not be resolved",
  },
  SSRF_HOST_DNS_LOOKUP_FAILED: {
    status: 400,
    zh: "解析 URL 主机 {{host}} 失败：{{message}}",
    en: "Failed to resolve URL host {{host}}: {{message}}",
  },
  /** 主机是 IP 字面量且落在拒绝名单内（`assertSafeHttpUrl` 形态）。 */
  SSRF_HOST_DENIED: {
    status: 400,
    zh: "URL host {{host}} 在拒绝名单内（私有/回环/链路本地/基准测试/CGNAT）",
    en: "URL host {{host}} is on the deny list (private/loopback/link-local/benchmark/CGNAT)",
  },
  /** 同上，但 `assertAndPinHttpUrl` 变体在末尾追加了「— 已拒绝对外请求」。 */
  SSRF_HOST_DENIED_PINNED: {
    status: 400,
    zh: "URL host {{host}} 在拒绝名单内（私有/回环/链路本地/基准测试/CGNAT）— 已拒绝对外请求",
    en: "URL host {{host}} is on the deny list (private/loopback/link-local/benchmark/CGNAT) — outbound request refused",
  },
  /** 域名解析到被阻断地址（`assertSafeHttpUrl` 形态）。 */
  SSRF_RESOLVED_TO_BLOCKED_ADDRESS: {
    status: 400,
    zh: "URL host {{host}} 解析到被阻断的地址（{{address}}）",
    en: "URL host {{host}} resolved to a blocked address ({{address}})",
  },
  /** 同上，但 `assertAndPinHttpUrl` 变体追加了「— 已拒绝对外请求」。 */
  SSRF_RESOLVED_TO_BLOCKED_ADDRESS_PINNED: {
    status: 400,
    zh: "URL host {{host}} 解析到被阻断的地址（{{address}}）— 已拒绝对外请求",
    en: "URL host {{host}} resolved to a blocked address ({{address}}) — outbound request refused",
  },

  // git 仓库 URL 形态（assertSafeGitRepoUrl）
  GIT_REPO_URL_INVALID: {
    status: 400,
    zh: "Git 仓库 URL 无效：{{url}}",
    en: "Invalid Git repository URL: {{url}}",
  },
  GIT_REPO_URL_CREDENTIALS: {
    status: 400,
    zh: "Git 仓库 URL 不得内嵌凭据 — use GIT_ASKPASS / a credential helper instead: {{url}}",
    en: "Git repository URL must not embed credentials — use GIT_ASKPASS / a credential helper instead: {{url}}",
  },
  GIT_REPO_URL_PASSWORD: {
    status: 400,
    zh: "Git 仓库 URL 不得内嵌密码 — use an SSH key / GIT_ASKPASS instead: {{url}}",
    en: "Git repository URL must not embed a password — use an SSH key / GIT_ASKPASS instead: {{url}}",
  },
  GIT_REPO_URL_FORM_UNSUPPORTED: {
    status: 400,
    zh: "不支持的 Git 仓库 URL 形式：{{url}}",
    en: "Unsupported Git repository URL form: {{url}}",
  },
  GIT_REPO_HOST_MISSING: {
    status: 400,
    zh: "Git 仓库 URL 缺少主机：{{url}}",
    en: "Git repository URL is missing its host: {{url}}",
  },
  GIT_REPO_HOST_DNS_LOOKUP_FAILED: {
    status: 400,
    zh: "解析 Git 仓库主机 {{host}} 失败：{{message}}",
    en: "Failed to resolve Git repository host {{host}}: {{message}}",
  },
  GIT_REPO_HOST_UNRESOLVABLE: {
    status: 400,
    zh: "Git 仓库主机 {{host}} 无法解析 — 已拒绝克隆",
    en: "Git repository host {{host}} could not be resolved — clone refused",
  },
  GIT_REPO_HOST_BLOCKED: {
    status: 400,
    zh: "Git 仓库主机 {{host}} 解析到 {{address}}（{{risk}}）— 已拒绝克隆（SSRF 防护）",
    en: "Git repository host {{host}} resolved to {{address}} ({{risk}}) — clone refused (SSRF protection)",
  },

  // 执行器 URL 形态（assertSafeExecutorUrl）
  EXECUTOR_URL_INVALID: {
    status: 400,
    zh: "执行器 URL 无效：{{url}}",
    en: "Invalid executor URL: {{url}}",
  },
  EXECUTOR_URL_PROTOCOL_NOT_HTTP: {
    status: 400,
    zh: "执行器 URL 必须使用 http(s)；实际为 '{{protocol}}'",
    en: "Executor URL must use http(s); got '{{protocol}}'",
  },
  EXECUTOR_URL_HOST_MISSING: {
    status: 400,
    zh: "执行器 URL 缺少主机名",
    en: "Executor URL is missing a hostname",
  },
  EXECUTOR_URL_CREDENTIALS: {
    status: 400,
    zh: "执行器 URL 不得内嵌凭据",
    en: "Executor URL must not embed credentials",
  },
  EXECUTOR_HOST_DNS_LOOKUP_FAILED: {
    status: 400,
    zh: "解析执行器主机 {{host}} 失败：{{message}}",
    en: "Failed to resolve executor host {{host}}: {{message}}",
  },
  EXECUTOR_HOST_UNRESOLVABLE: {
    status: 400,
    zh: "执行器主机 {{host}} 无法解析",
    en: "Executor host {{host}} could not be resolved",
  },
  EXECUTOR_HOST_BLOCKED: {
    status: 400,
    zh: "执行器地址 {{host}} 解析到 {{address}}（{{risk}}）— 已拒绝对外请求",
    en: "Executor address {{host}} resolved to {{address}} ({{risk}}) — outbound request refused",
  },

  // ── 系统配置（modules/config/**）────────────────────────────────────
  //
  // ⚠️ 为什么 config 域的码记在本片（而不是新开 `catalog/config.ts`）：分片是
  // **并发迁移的写入边界**，不是领域模型的镜像——本轮 config/event-subscriptions/
  // ai/runtime 四域由同一个迁移者负责，故收在同一片里，避免多开文件造成的合并面。
  // 合并点 `error-codes.ts` 只按片 spread，键无前缀语义依赖（见该文件说明）。
  CONFIG_ITEM_NOT_FOUND: {
    status: 404,
    zh: '配置项 "{{key}}" 不存在',
    en: 'Config key "{{key}}" not found',
  },
  CONFIG_HISTORY_NOT_FOUND: {
    status: 404,
    zh: '历史记录 "{{historyId}}" 不存在',
    en: 'History record "{{historyId}}" not found',
  },
  /**
   * FEAT-08 回滚：action=update 但历史行没有 oldValue（无可回滚目标）。
   *
   * 与 `CONFIG_HISTORY_SECRET_MASK_ROLLBACK` 分开：那条是**掩码数据破坏防护**
   * （继续下去会把 '***' 写成真实密钥），这条只是"这条历史没东西可回滚"。
   * 处置动作不同（换一条历史 vs 认命），故不共用一个码。
   */
  CONFIG_HISTORY_NO_ROLLBACK_VALUE: {
    status: 400,
    zh: '历史记录 "{{historyId}}" 没有可回滚的 oldValue',
    en: 'History record "{{historyId}}" has no oldValue to roll back to',
  },
  /**
   * S3 回滚版镜像：历史行只存了 '***' 掩码（S3 修复前的旧行），而该键是密钥
   * ——继续回滚等于**把掩码当真实值写回**，是数据破坏。故 fail-closed 拒绝。
   *
   * zh 用到双引号包字面量、又含单引号包住的掩码，故整体用双引号 + `\"` 转义
   * （另一侧 `'***'` 保持字面）——分片解析器两种引号都认（见 error-catalog.mjs）。
   */
  CONFIG_HISTORY_SECRET_MASK_ROLLBACK: {
    status: 400,
    zh: '历史记录 "{{historyId}}" 对密钥 "{{configKey}}" 只保存了 \'***\' 掩码；拒绝把掩码当作真实值写回',
    en: 'History record "{{historyId}}" only holds the \'***\' mask for secret key "{{configKey}}"; refusing to write the mask back as a real value',
  },
  CONFIG_VALUE_TYPE_INVALID: {
    status: 400,
    zh: "valueType 非法：{{valueType}}。允许的类型：{{allowedTypes}}",
    en: "Invalid valueType: {{valueType}}. Allowed types: {{allowedTypes}}",
  },
  CONFIG_JSON_VALUE_INVALID: {
    status: 400,
    zh: "JSON 值非法",
    en: "Invalid JSON value",
  },
  CONFIG_BOOLEAN_VALUE_INVALID: {
    status: 400,
    zh: '布尔值必须为 "true" 或 "false"',
    en: 'Boolean value must be "true" or "false"',
  },
  CONFIG_NUMBER_VALUE_INVALID: {
    status: 400,
    zh: "数字值非法",
    en: "Invalid number value",
  },

  // ── 出站事件派发（modules/event-subscriptions/**）────────────────────
  //
  // 两条原为**裸 Error**（非 HttpException）：旧行为经全局 filter 落 500。迁到
  // 码表后 status 取 500，**保持对外状态码逐字不变**（"原为裸 Error，对外 500"
  // 的同款先例见 catalog/executor.ts 的派发组头注）。
  /** 订阅 url 被 SSRF 守卫拒绝（确定性失败，重试无意义）。 */
  EVENT_OUTBOUND_SSRF_BLOCKED: {
    status: 500,
    zh: "URL 被 SSRF 策略拒绝：{{message}}",
    en: "URL rejected by SSRF policy: {{message}}",
  },
  /** 补投面加载订阅快照失败（DB 抖动等）——由 outbox 侧行退避重试。 */
  EVENT_OUTBOUND_SUBSCRIPTIONS_LOAD_FAILED: {
    status: 500,
    zh: '外发重投 "{{eventName}}"：加载订阅失败：{{message}}',
    en: 'Outbound redeliver "{{eventName}}": failed to load subscriptions: {{message}}',
  },

  // ── AI 多模态（modules/ai/**）────────────────────────────────────────
  /**
   * P1 安全：媒体 URL 由**执行器 Agent 上报**（不可信），原样转给 DashScope 就是
   * SSRF 转嫁面。非 http(s) 一律拒绝。
   *
   * status=500 与旧行为一致（原为裸 Error，经全局 filter 落 500）——本条不是
   * 用户在表单里填错了什么，而是**上游上报了平台不允许的协议**，属平台侧拒绝。
   */
  AI_MEDIA_URL_SCHEME_NOT_ALLOWED: {
    status: 500,
    zh: "拒绝非 http(s) 的媒体 URL（协议不被允许）：{{url}}",
    en: "Refusing non-http(s) media URL (scheme not allowed): {{url}}",
  },

  // ── 任务运行时注册表（modules/runtime/**）───────────────────────────
  /**
   * ARCH-25：重复注册同名 runtime（未显式声明 override）——防止插件静默改写
   * 内置（python/node/shell）语义。
   *
   * status=500 与旧行为一致（原为裸 Error）。含义是**注册方（代码/插件）写错
   * 了**，不是终端用户在界面上填错了什么。
   */
  TASK_RUNTIME_ALREADY_REGISTERED: {
    status: 500,
    zh: '任务运行时 "{{runtime}}" 已注册；如需替换请传入 { override: true }',
    en: 'Task runtime "{{runtime}}" is already registered; pass { override: true } to replace it',
  },
} as const satisfies Record<string, ErrorCodeDef>;
