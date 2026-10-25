import type { ErrorCodeDef } from "../error-code-def";

/**
 * LANG-ERR-01 · 通用域错误码分片。
 *
 * 这一片承载**跨域共用**的码（框架级兜底、校验、DB 约束映射）。各业务域
 * （task / executor / auth / project）各有自己的分片文件，见同目录。
 *
 * ⚠️ 新增码时**只改自己域的分片**，不要动合并点 `error-codes.ts`——那是并发
 * 迁移的冲突点（详见 `error-code-def.ts` 的分片理由）。
 */
export const COMMON_CODES = {
  INTERNAL_ERROR: {
    status: 500,
    zh: "服务器内部错误",
    en: "Internal server error",
  },
  VALIDATION_FAILED: {
    status: 400,
    zh: "参数校验失败：{{detail}}",
    en: "Validation failed: {{detail}}",
  },
  /**
   * 校验失败但**没有字段级原因**（class-validator 给了空数组）。
   *
   * 为什么单列一个码而不是复用 `VALIDATION_FAILED` + 空 detail：后者会渲染出
   * 「参数校验失败：」这个**悬空冒号**。本仓既有用例明确守着"空数组不得产生
   * 悬空冒号"这条体验约束（HttpExceptionFilter 的校验可达性 spec），故用两个码
   * 把两种形态分开——翻译侧也因此能各自给出自然措辞。
   */
  VALIDATION_FAILED_NO_DETAIL: {
    status: 400,
    zh: "参数校验失败",
    en: "Validation failed",
  },
  /**
   * F-40（UIUX 审计 P1-1）：跨域 Origin 不在 CORS 白名单。
   *
   * 旧实现 `callback(new Error("Origin ... not allowed by CORS"))` 冒泡到
   * HttpExceptionFilter 被兜成 **500「服务器内部错误」（errorCode:null）**——
   * dev 端口 / 新前端域名接入时的第一现场与真实服务器故障完全不可区分，
   * 排障方向被误导（真机证据：登录 POST 500，后端日志 "Unhandled exception:
   * Origin http://127.0.0.1:5176 not allowed by CORS"）。403 + 稳定码：拒绝是
   * **配置面**的预期结果，不是故障——调用方该做的是把来源加进
   * CORS_ALLOWED_ORIGINS，而不是重试。
   *
   * 文案刻意**不插值** {{origin}}：origin 是请求方可控头，前端 toast 会按
   * errorCode 渲染本词条（escapeValue:false 的插值面，见 admin-web
   * utils/error.ts translateByErrorCode），把请求方可控值原样拼进用户可见文案
   * 没有必要；被拒来源经 `params.origin` 透出（错误封套独立字段 + 服务端日志），
   * 供排障/工单直接定位。
   */
  CORS_ORIGIN_NOT_ALLOWED: {
    status: 403,
    zh: "请求来源未被 API 跨域白名单放行（CORS_ALLOWED_ORIGINS）",
    en: "Request origin is not allowed by the API CORS whitelist (CORS_ALLOWED_ORIGINS)",
  },
  // PG 23505 / 23503 的全局兜底（原先散落在 filter 里的硬编码英文）
  RESOURCE_EXISTS: {
    status: 409,
    zh: "资源已存在",
    en: "Resource already exists",
  },
  RELATED_RESOURCE_NOT_FOUND: {
    status: 422,
    zh: "关联资源不存在",
    en: "Related resource not found",
  },
  /**
   * METRICS：Prometheus 指标端点被运维关闭（`METRICS_PROMETHEUS_ENABLED=false`）。
   *
   * 404 而**不是** 503：端点被有意关闭时，对抓取方而言它"不存在"是最准确的语义
   * （Prometheus 对 404 会停止抓取，对 503 会持续重试并记为 target down →
   * 在关闭期间持续刷告警）。旧实现就是 `NotFoundException`，状态码不得变。
   */
  METRICS_ENDPOINT_DISABLED: {
    status: 404,
    zh: "Prometheus 指标端点已禁用（METRICS_PROMETHEUS_ENABLED=false）",
    en: "The Prometheus metrics endpoint is disabled (METRICS_PROMETHEUS_ENABLED=false)",
  },
  /**
   * METRICS：并发指标流（SSE）超过上限。
   *
   * 503 而非 429：这是**服务端容量**约束（每个流占一个长连接与一份快照），
   * 不是调用方频率超限——429 会让客户端按 Retry-After 重试得更凶，而正确处置是
   * 关掉多余的面板/降低并发。旧实现是 `ServiceUnavailableException`。
   */
  METRICS_STREAM_LIMIT_REACHED: {
    status: 503,
    zh: "并发指标流过多（上限 {{max}}）",
    en: "Too many concurrent metrics streams (limit {{max}})",
  },
  /**
   * EXECUTOR-PACKAGE：下载执行器包需要 access JWT 或执行器令牌（401）。
   *
   * 与执行器域的 `INVALID_EXECUTOR_TOKEN`（令牌**无效**）不同：本码是
   * 「**没有提供**任何可用凭据」。旧实现文案是
   * `UnauthorizedException("未授权：下载执行器包需要有效的 access JWT 或执行器令牌")`，
   * 逐字保留。
   */
  EXECUTOR_PACKAGE_DOWNLOAD_UNAUTHORIZED: {
    status: 401,
    zh: "未授权：下载执行器包需要有效的 access JWT 或执行器令牌",
    en: "Unauthorized: downloading executor packages requires a valid access JWT or executor token",
  },
  /**
   * 通用 503：**判定所依赖的服务不可用**（依赖查询抛错/连接抖动）。
   *
   * 为什么需要一条通用码：本仓既有 503 全是**域专用**码
   * （`METRICS_STREAM_LIMIT_REACHED` / `EXECUTOR_PULL_UNAVAILABLE` /
   * `PROJECT_ROLE_UNAVAILABLE` …），语义都是"这个功能此刻不可用"；而有一类
   * 场景要表达的恰恰是**与业务无关的第三个答案**——「我没能判定」，既不是
   * 「存在」，也不是「不存在」。
   *
   * 首个使用点（R32-C2 / L6）：project-access 的成员授予前目标用户存在性校验。
   * 查询失败时**不能**当成"用户不存在"（那会把一次抖动报成 404，用户以为账号
   * 被删）更不能 warn 后放行（project_members.userId 无 FK，放行即写出无主
   * 成员行 = 幽灵授权）。fail-closed 才是正确姿态：让调用方重试。
   *
   * 文案自足（见 `error-codes.ts` 的 zh 契约）：裸 API/CLI/日志消费者只读
   * `message`，故两行文案都不含未替换占位符，也不指向任何具体依赖名。
   */
  DEPENDENCY_UNAVAILABLE: {
    status: 503,
    zh: "依赖服务暂不可用，请稍后重试",
    en: "A dependency is temporarily unavailable. Please retry later.",
  },
} as const satisfies Record<string, ErrorCodeDef>;
