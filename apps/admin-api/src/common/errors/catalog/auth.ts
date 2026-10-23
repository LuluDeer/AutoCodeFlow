import type { ErrorCodeDef } from "../error-code-def";

/** LANG-ERR-01 · 认证/用户域错误码分片（auth / users / api-keys / OIDC）。 */
export const AUTH_CODES = {
  INVALID_CREDENTIALS: {
    status: 401,
    zh: "凭据无效",
    en: "Invalid credentials",
  },
  ACCOUNT_DISABLED: {
    status: 403,
    zh: "账号已被禁用",
    en: "Account is disabled",
  },
  ACCOUNT_LOCKED: {
    status: 423,
    zh: "账号已锁定，请在 {{minutes}} 分钟后重试",
    en: "Account locked. Try again in {{minutes}} minute(s).",
  },
  USER_NOT_FOUND: {
    status: 404,
    zh: "用户不存在",
    en: "User not found",
  },
  /**
   * 运维面按 id 寻址用户却取不到行——**文案必须带 id**。
   *
   * ⚠️ 与无参数的 `USER_NOT_FOUND` 分开，不是冗余：旧实现是
   * `NotFoundException(\`User #${id} not found\`)`，**id 是文案的一部分**，
   * `users.service.spec.ts` 逐字断言「用户 #42 不存在」。迁码时若图省事复用
   * 无参数的 `USER_NOT_FOUND`，id 会被**静默丢掉**——实测就是这样红的（该用例
   * 直接抓出）。带 id 的价值是排障：调用方拿到 404 时能立刻确认"服务端理解的
   * 是我点名的那个 id 吗"，还是"我传错了 id / 它已被删"。
   *
   * 与 `TOKEN_USER_NOT_FOUND`（401，刻意不带 id）的区别：那条路径上调用方持有
   * 的是**令牌**，回显 id 会构成存在性预言机；本条是**已认证的运维/管理动作**
   * 按 id 寻址，回显 id 不泄露任何它本来不知道的信息。
   */
  USER_ID_NOT_FOUND: {
    status: 404,
    zh: "用户 #{{id}} 不存在",
    en: "User #{{id}} not found",
  },
  /**
   * R-04：**令牌指向已删除用户**（JWT 校验链）——401 而**不是** 404。
   *
   * 为什么单列一个码而不是复用上面的 `USER_NOT_FOUND`（两者中文文案相同）：
   * 状态码是**对外语义**的一部分。这条路径上，调用方已持有一个**看似有效**的
   * 令牌；若回 404，就等于告诉持有者「这个 sub 曾经存在、现在没了」——把
   * 「令牌无效」与「用户存在性」区分开，构成**存在性预言机**（可用于枚举/确认
   * 某 id 是否注册过）。故旧实现刻意用 `UnauthorizedException("用户不存在")`
   * （401），与「令牌本身无效」归为同一类不可区分的结果。
   *
   * 该约束由 `jwt.strategy.spec.ts` 明文守着（"R-04: 已删除用户 … 401 User not
   * found，不走 404 的 findById"），故不能用 404 的码替代——那会让
   * `instanceof UnauthorizedException` 失效、状态码从 401 变 404，把防枚举设计
   * 反转。这也是「按码迁移」里最容易丢的一类信息：**文案相同不等于语义相同**。
   */
  TOKEN_USER_NOT_FOUND: {
    status: 401,
    zh: "用户不存在",
    en: "User not found",
  },
  USER_EXISTS: {
    status: 409,
    zh: "用户名或邮箱已存在",
    en: "Username or email already exists",
  },
  USER_LAST_ADMIN: {
    status: 409,
    zh: "不能降级或删除最后一个管理员",
    en: "Cannot demote or delete the last administrator",
  },
  USER_SELF_DELETE: {
    status: 409,
    zh: "不能删除自己的账号",
    en: "Cannot delete your own account",
  },
  INVALID_TOTP_CODE: {
    status: 401,
    zh: "TOTP 验证码错误",
    en: "Invalid TOTP code",
  },
  TOTP_NOT_ENABLED: {
    status: 409,
    zh: "该账号未启用 TOTP",
    en: "TOTP is not enabled for this account",
  },
  TOTP_ALREADY_ENABLED: {
    status: 409,
    zh: "TOTP 已启用",
    en: "TOTP is already enabled",
  },
  TOTP_SECRET_NOT_STAGED: {
    status: 409,
    zh: "尚未暂存 TOTP 密钥，请先调用 /auth/totp/setup",
    en: "No TOTP secret staged — call /auth/totp/setup first",
  },
  REFRESH_TOKEN_INVALID: {
    status: 401,
    zh: "刷新令牌无效",
    en: "Invalid refresh token",
  },
  REFRESH_TOKEN_REVOKED: {
    status: 401,
    zh: "刷新令牌已被吊销",
    en: "Refresh token has been revoked",
  },
  SESSION_REVOKED: {
    status: 401,
    zh: "会话已被吊销",
    en: "Session has been revoked",
  },
  API_KEY_INVALID: {
    status: 401,
    zh: "API Key 无效或已过期",
    en: "Invalid or expired API key",
  },
  API_KEY_QUOTA_REACHED: {
    status: 429,
    zh: "API Key 数量已达上限（每用户 {{max}} 个），请先吊销不再使用的 Key",
    en: "API Key quota reached (max {{max}} active keys per user); revoke unused keys first",
  },
  /** api-keys.service 的配额闸（旧异常是 409 ConflictException，非 429）。 */
  API_KEY_QUOTA_CONFLICT: {
    status: 409,
    zh: "API Key 数量已达配额（{{max}} 个有效 Key）；请先吊销不再使用的 Key",
    en: "API Key quota reached ({{max}} active keys); revoke unused keys first",
  },
  OIDC_NOT_CONFIGURED: {
    status: 409,
    zh: "OIDC 已启用但配置不完整；缺少环境变量：{{keys}}",
    en: "OIDC is enabled but misconfigured; missing env: {{keys}}",
  },
  OIDC_STATE_INVALID: {
    status: 401,
    zh: "OIDC 登录状态无效或已过期",
    en: "OIDC state is invalid or expired",
  },
  OIDC_NONCE_INVALID: {
    status: 401,
    zh: "OIDC id_token nonce 不匹配",
    en: "OIDC id_token nonce mismatch",
  },
  OIDC_SIGNATURE_INVALID: {
    status: 401,
    zh: "OIDC id_token 签名校验失败",
    en: "OIDC id_token signature verification failed",
  },
  /**
   * OIDC 身份未绑定到任何平台账号（`autoProvision=false` 且三级定位全未命中）。
   *
   * ⚠️ **状态码是 401，不是 403**——这里踩过一次坑，记录清楚：
   * `oidc.service.ts` 的旧**代码注释**写着「autoProvision=false 且无匹配 → 403」，
   * 迁移时按注释取了 403；但 `git show HEAD:…/oidc.service.ts` 里那一行实际是
   * `throw new UnauthorizedException("OIDC identity not linked to any platform
   * account …")` = **401**，且 `oidc.service.spec.ts` 逐字断言
   * `rejects.toBeInstanceOf(UnauthorizedException)`。
   *
   * 教训：**注释是陈述，代码才是事实**。迁移「按码定状态」时必须以旧代码为准，
   * 不能以注释为准——注释可以腐烂，状态码是对外契约的一部分（401 = 你的凭据
   * 不被接受，403 = 身份成立但无权访问；此处调用方尚未取得平台会话，属前者）。
   */
  OIDC_ACCOUNT_NOT_LINKED: {
    status: 401,
    zh: "OIDC 身份未绑定到任何平台账号（请管理员创建同名用户，或启用 OIDC_AUTO_PROVISION）",
    en: "OIDC identity not linked to any platform account (ask an administrator to create a matching username, or enable OIDC_AUTO_PROVISION)",
  },
  // ── 登录/锁定（auth.service）── 旧异常状态码：锁定时 401 ─────────────
  LOGIN_LOCKED: {
    status: 401,
    zh: "账号已锁定，请在 {{minutes}} 分钟后重试。",
    en: "Account locked. Try again in {{minutes}} minute(s).",
  },
  /**
   * TOTP 自助管理面（/auth/totp/*）的四个校验失败。
   *
   * 为什么与上面的 `TOTP_NOT_ENABLED` / `TOTP_ALREADY_ENABLED` /
   * `TOTP_SECRET_NOT_STAGED`（**409**）并存而不复用：`auth.service.ts` 的这三处
   * 旧异常是 **400**（`BadRequestException`），而上面的 409 组是给「资源状态
   * 冲突」语义的调用点准备的。状态码是**对外契约**（`http-exception.filter`
   * 把它写进响应体既有的数字 `code`，mcp-server / acf-cli 消费），迁移不得
   * 改变它——故按旧状态码另立同名语义的码，而不是改旧码的 status（那会波及其
   * 他调用点）。
   */
  TOTP_SETUP_ALREADY_ENABLED: {
    status: 400,
    zh: "TOTP 已启用",
    en: "TOTP is already enabled",
  },
  TOTP_SECRET_MISSING: {
    status: 400,
    zh: "尚未暂存 TOTP 密钥 — 请先调用 /auth/totp/setup",
    en: "No TOTP secret staged — call /auth/totp/setup first",
  },
  TOTP_ENABLE_CODE_INVALID: {
    status: 400,
    zh: "TOTP 验证码错误",
    en: "Invalid TOTP code",
  },
  TOTP_DISABLE_CONFIRMATION_REQUIRED: {
    status: 401,
    zh: "关闭 TOTP 需要提供有效的密码或 TOTP 验证码",
    en: "Disabling TOTP requires a valid password or TOTP code",
  },
  INVALID_USERNAME_OR_PASSWORD: {
    status: 401,
    zh: "用户名或密码错误",
    en: "Incorrect username or password",
  },
  /**
   * 停用账号（`user.isActive === false`）在**登录链与令牌校验链**上的 401。
   *
   * ⚠️ 与 403 的 `ACCOUNT_DISABLED` **不是同一个码**，别看文案像就合并：
   *   · 本码 401：发生在「登录 / 校验一个看似有效的令牌」时——调用方**尚未**
   *     取得平台会话，401 是「你的凭据不被接受」的正确语义（旧实现为
   *     `UnauthorizedException("Account is disabled")`）；
   *   · `ACCOUNT_DISABLED` 403：发生在「已认证用户访问受限资源」时——身份是
   *     成立的，是**授权**被拒（见其注释）。
   * 两者状态码不同、可触发的调用方不同、前端提示语也应不同，故分列。合并会
   * 把 401 变 403，直接破坏 `jwt.strategy.spec.ts` 与登录链的既有契约。
   *
   * 中文文案用「禁用」而非「停用」：与 `ACCOUNT_DISABLED` 的措辞统一（同一
   * 字段 `isActive=false` 造成的结果，不该出现两种中文说法），且 spec 逐字断言
   * 「账号已被禁用」。
   */
  ACCOUNT_INACTIVE: {
    status: 401,
    zh: "账号已被禁用",
    en: "Account is disabled",
  },
  REFRESH_TOKEN_TYPE_INVALID: {
    status: 401,
    zh: "令牌类型无效",
    en: "Invalid token type",
  },
  /** jwt.strategy 的 access 侧类型门（`type` 既非 access 也非 sse_ticket）。 */
  ACCESS_TOKEN_TYPE_INVALID: {
    status: 401,
    zh: "令牌类型非法",
    en: "Illegal token type",
  },
  REFRESH_TOKEN_MISSING_JTI: {
    status: 401,
    zh: "刷新令牌缺少 jti 声明",
    en: "Refresh token is missing the jti claim",
  },
  SESSION_NOT_FOUND: {
    status: 401,
    zh: "会话不存在或已被吊销",
    en: "Session does not exist or has been revoked",
  },
  // ── OIDC（oidc.service）──────────────────────────────────────────────
  OIDC_CONFIG_INCOMPLETE: {
    status: 400,
    zh: "OIDC 已启用但配置有误；缺少环境变量：{{keys}}",
    en: "OIDC is enabled but misconfigured; missing environment variables: {{keys}}",
  },
  OIDC_DISCOVERY_INCOMPLETE: {
    status: 400,
    zh: "OIDC discovery 文档缺少 {{key}}",
    en: "The OIDC discovery document is missing {{key}}",
  },
  OIDC_DISCOVERY_FAILED: {
    status: 400,
    zh: "从 {{url}} 获取 OIDC discovery 失败：{{detail}}",
    en: "Failed to fetch the OIDC discovery document from {{url}}: {{detail}}",
  },
  OIDC_TOKEN_NO_ID_TOKEN: {
    status: 401,
    zh: "OIDC 令牌端点未返回 id_token",
    en: "The OIDC token endpoint did not return an id_token",
  },
  OIDC_CODE_EXCHANGE_FAILED: {
    status: 401,
    zh: "OIDC 授权码换取令牌失败：{{detail}}",
    en: "OIDC authorization-code exchange failed: {{detail}}",
  },
  OIDC_JWKS_EMPTY: {
    status: 401,
    zh: "OIDC JWKS 端点未返回任何密钥",
    en: "The OIDC JWKS endpoint returned no keys",
  },
  OIDC_ID_TOKEN_MALFORMED: {
    status: 401,
    zh: "OIDC id_token 格式错误",
    en: "OIDC id_token is malformed",
  },
  OIDC_ALG_UNSUPPORTED: {
    status: 401,
    zh: "OIDC id_token 算法 {{alg}} 不受支持（仅支持 RS256）",
    en: "OIDC id_token algorithm {{alg}} is unsupported (RS256 only)",
  },
  OIDC_KID_NOT_FOUND: {
    status: 401,
    zh: "OIDC id_token 的 kid 未在 JWKS 中找到",
    en: "The OIDC id_token kid was not found in the JWKS",
  },
  OIDC_ISSUER_MISMATCH: {
    status: 401,
    zh: "OIDC id_token 的 issuer 不匹配",
    en: "OIDC id_token issuer mismatch",
  },
  OIDC_AUDIENCE_MISMATCH: {
    status: 401,
    zh: "OIDC id_token 的 audience 不匹配",
    en: "OIDC id_token audience mismatch",
  },
  OIDC_ID_TOKEN_EXPIRED: {
    status: 401,
    zh: "OIDC id_token 已过期",
    en: "OIDC id_token has expired",
  },
  OIDC_ID_TOKEN_IAT_FUTURE: {
    status: 401,
    zh: "OIDC id_token 的签发时间在未来",
    en: "OIDC id_token was issued in the future",
  },
  OIDC_CLAIMS_INCOMPLETE: {
    status: 401,
    zh: "OIDC id_token 缺少 sub 或用户名声明 '{{claim}}'",
    en: "OIDC id_token is missing the sub or username claim '{{claim}}'",
  },
  OIDC_AUTOBIND_DENIED: {
    status: 403,
    zh: "OIDC 身份无法自动关联到该平台账号",
    en: "The OIDC identity cannot be automatically linked to this platform account",
  },
  OIDC_SUB_ALREADY_BOUND: {
    status: 401,
    zh: "OIDC 身份已绑定到其他账号",
    en: "The OIDC identity is already bound to another account",
  },
  /**
   * OIDC 账号被禁用。**401 而非 AUTH_CODES.ACCOUNT_DISABLED 的 403**：OIDC 链路
   * 抛出的是 `UnauthorizedException("账号已被禁用 [oidc_account_disabled]")`，
   * 状态码必须与旧异常一致（禁用发生在 SSO 回调里，用户尚未取得平台会话）。
   */
  OIDC_ACCOUNT_DISABLED: {
    status: 401,
    zh: "账号已被禁用",
    en: "Account is disabled",
  },
  OIDC_STATE_MISMATCH: {
    status: 401,
    zh: "OIDC 登录状态在查询参数与 cookie 之间不一致",
    en: "OIDC state differs between the query parameter and the cookie",
  },
  // ── 用户（users）─────────────────────────────────────────────────────
  USER_VIEW_SELF_ONLY: {
    status: 403,
    zh: "只能查看自己的账号",
    en: "You may only view your own account",
  },
  /**
   * 「用户不存在」的 **403 变体**（`users.controller.findOne`）。
   *
   * 刻意不是 404：该端点用 `ForbiddenException` **隐藏存在性**（H-3，
   * 非管理员不能靠 404/403 区分「该 id 不存在」与「存在但无权看」）。
   * 复用 404 的 `USER_NOT_FOUND` 会把这个防枚举设计**反转**成存在性预言机。
   */
  USER_NOT_VISIBLE: {
    status: 403,
    zh: "用户不存在",
    en: "User not found",
  },
  USER_UPDATE_SELF_ONLY: {
    status: 403,
    zh: "只能更新自己的账号",
    en: "You may only update your own account",
  },
  USER_ROLE_ADMIN_ONLY: {
    status: 403,
    zh: "只有管理员可以变更用户角色",
    en: "Only administrators may change user roles",
  },
  /**
   * 「最后一个管理员」与「自删」的**400 变体**。
   *
   * 与上面的 `USER_LAST_ADMIN` / `USER_SELF_DELETE`（**409**）并存而不复用：
   * `users.service.ts` 这三处旧异常是 **400**（`BadRequestException`），而 409
   * 那组是给「资源状态冲突」语义的调用点准备的。状态码是对外契约（既有响应体
   * 数字 `code` 字段，mcp-server / acf-cli 消费），迁移不得改变它。
   */
  USER_LAST_ADMIN_CANNOT_DEMOTE: {
    status: 400,
    zh: "不能降级最后一个管理员",
    en: "Cannot demote the last administrator",
  },
  USER_LAST_ADMIN_CANNOT_DELETE: {
    status: 400,
    zh: "不能删除最后一个管理员",
    en: "Cannot delete the last administrator",
  },
  USER_SELF_DELETE_FORBIDDEN: {
    status: 400,
    zh: "不能删除自己的账号",
    en: "Cannot delete your own account",
  },
  USERNAME_TAKEN: {
    status: 409,
    zh: "用户名已被占用",
    en: "Username is already taken",
  },
  EMAIL_TAKEN: {
    status: 409,
    zh: "邮箱已被占用",
    en: "Email is already taken",
  },
  CURRENT_PASSWORD_REQUIRED: {
    status: 400,
    zh: "修改密码时必须提供 currentPassword",
    en: "currentPassword is required when changing the password",
  },
  /**
   * 「用户不存在」的 **400 变体**（`users.controller.update` 的改密分支）。
   * 旧异常是 `BadRequestException`，状态码不得改变；与 404 的 `USER_NOT_FOUND`
   * 及 403 的 `USER_NOT_VISIBLE` 语义不同（此处是「已登录者的改密请求指向了
   * 已被删除的自己」，属请求态错误而非寻址失败）。
   */
  USER_NOT_FOUND_FOR_PASSWORD_CHANGE: {
    status: 400,
    zh: "用户不存在",
    en: "User not found",
  },
  CURRENT_PASSWORD_INCORRECT: {
    status: 400,
    zh: "currentPassword 不正确",
    en: "currentPassword is incorrect",
  },
  PASSWORD_TOO_SHORT: {
    status: 400,
    zh: "密码长度至少为 8 个字符",
    en: "The password must be at least 8 characters long",
  },
  PASSWORD_NEEDS_UPPERCASE: {
    status: 400,
    zh: "密码必须包含至少一个大写字母",
    en: "The password must contain at least one uppercase letter",
  },
  PASSWORD_NEEDS_DIGIT: {
    status: 400,
    zh: "密码必须包含至少一个数字",
    en: "The password must contain at least one digit",
  },
  PASSWORD_NEEDS_SPECIAL: {
    status: 400,
    zh: "密码必须包含至少一个特殊字符",
    en: "The password must contain at least one special character",
  },
  // ── API Keys ─────────────────────────────────────────────────────────
  API_KEY_NOT_FOUND: {
    status: 404,
    zh: "API Key {{apiKeyId}} 不存在",
    en: "API Key {{apiKeyId}} not found",
  },
  /**
   * 永久删除只对**已失效**的 key 开放（已吊销 / 已过期）。活跃 key 必须先吊销：
   * 吊销留下 `apikey.revoke` 审计行，删除只清理不再有活性的行——避免一次点击
   * 静默抹掉在用凭据，也保住「谁在什么时候杀掉了哪把 key」的证据链。
   */
  API_KEY_DELETE_ACTIVE_FORBIDDEN: {
    status: 409,
    zh: "API Key {{apiKeyId}} 仍在生效，请先吊销再删除",
    en: "API Key {{apiKeyId}} is still active; revoke it before deleting",
  },
  API_KEY_JWT_ONLY_SURFACE: {
    status: 401,
    zh: "凭证管理端点不接受 API Key，请使用用户 JWT",
    en: "Credential-management endpoints do not accept API keys; use a user JWT",
  },
  API_KEY_SCOPE_DENIED: {
    status: 403,
    zh: "API Key 权限不足：{{reason}}",
    en: "Insufficient API key scope: {{reason}}",
  },
} as const satisfies Record<string, ErrorCodeDef>;
