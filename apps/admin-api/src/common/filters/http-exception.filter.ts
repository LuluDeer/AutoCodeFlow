import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from "@nestjs/common";
import { Request, Response } from "express";
import { QueryFailedError } from "typeorm";
import { AppError } from "../errors/app-error";
import { renderZh } from "../errors/error-codes";

/**
 * LANG-ERR-01：全局异常过滤器。
 *
 * 响应体现在多出两个**新增**字段（`errorCode` / `params`），用于「后端抛码、
 * 前端翻译」：
 *
 * ```json
 * { "code": 404, "errorCode": "EXECUTOR_NOT_FOUND", "message": "执行器不存在",
 *   "params": null, "data": null, "timestamp": "…", "path": "/api/…" }
 * ```
 *
 * ⚠️ **`code` 是数字 HTTP 状态码，不是业务码**（`errorCode` 才是）。它被
 * `mcp-server` / `acf-cli` 消费，`check-consumer-routes.mjs` 守着这条契约——
 * 本机制对线上协议是**纯增量**：老调用方读 `code`/`message` 行为逐字节不变。
 *
 * `message` 保留为**中文兜底**（服务裸 API / CLI / MCP / 日志 / 落库字段等
 * 不翻译的消费者）；浏览器侧由前端按 `errorCode` 查 i18n 表，查不到才回落它。
 * 详见 `error-codes.ts` 的 `zh` 说明。
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = renderZh("INTERNAL_ERROR");
    let errors: string[] | null = null;
    // 业务码与插值参数：非本机制抛出的异常保持 null（**不为它编造码**——
    // 编造会让前端用错误的词条去渲染，比回落服务端文案更糟）。
    let errorCode: string | null = null;
    let params: Record<string, unknown> | null = null;
    // OBS3-04（P2）：5xx 日志行里要写进「异常自己的那一句」。响应体的
    // `message` 对未捕获异常是**中文兜底**（`renderZh("INTERNAL_ERROR")`），
    // 把兜底文案写进日志等于丢掉根因，故两者必须分开：`message` 给客户端，
    // `logDetail` 给日志。
    let logDetail: string | null = null;

    if (exception instanceof AppError) {
      // 主路径：带码异常，码与参数直接透出。
      status = exception.getStatus();
      errorCode = exception.errorCode;
      params = exception.params;
      message = exception.message;
      const resp = exception.getResponse();
      if (typeof resp === "object" && resp !== null) {
        const r = resp as Record<string, unknown>;
        if (Array.isArray(r["message"])) errors = r["message"] as string[];
      }
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const exceptionResponse = exception.getResponse();

      // P3-4（UIAUDIT4）：429 统一映射 RATE_LIMITED——ThrottlerException 的
      // 英文裸文（"ThrottlerException: Too Many Requests"）此前经下一分支
      // 直出 message（errorCode:null），前端把异常类名渲染给用户。限流拒绝
      // 是调用方频率问题，有稳定码后前端按词条渲染且可与其他 4xx 同构处理。
      if (status === HttpStatus.TOO_MANY_REQUESTS) {
        errorCode = "RATE_LIMITED";
        message = renderZh("RATE_LIMITED");
      } else if (typeof exceptionResponse === "string") {
        message = exceptionResponse;
      } else if (
        typeof exceptionResponse === "object" &&
        exceptionResponse !== null
      ) {
        const resp = exceptionResponse as Record<string, unknown>;
        message =
          (typeof resp["message"] === "string" ? resp["message"] : null) ||
          exception.message;
        // 非 AppError 的异常若自带 errorCode/params（例如经管道包装后透传），
        // 一并透出；缺失就保持 null。
        if (typeof resp["errorCode"] === "string")
          errorCode = resp["errorCode"];
        if (typeof resp["params"] === "object" && resp["params"] !== null) {
          params = resp["params"] as Record<string, unknown>;
        }
        if (Array.isArray(resp["message"])) {
          errors = resp["message"] as string[];
          // 字段级原因必须进 message，不能只塞进 data。
          //
          // 背景（本轮体验审查）：main.ts 开了 whitelist +
          // forbidNonWhitelisted，任何多余/非法字段都 400，而 admin-web 的
          // getErrMsg（utils/error.ts）与 axios 拦截器（api/client.ts）**都只
          // 读 message**，从不读 data。于是用户在任务表单/配置编辑里填错一个
          // 字段，看到的是一句裸英文 "Validation failed"——没有字段名、没有
          // 原因，无从下手。这里把数组拼进 message（保留 data 里的原始数组，
          // 兼容既有按数组消费的调用方）。
          //
          // LANG-ERR-01：同时给出**可翻译**的码 + 参数——前端据此产出本地化的
          // 「参数校验失败：…」，而不是永远读到这句中文兜底。
          //
          // 空数组单列一个码：复用带 detail 的模板会渲染出「参数校验失败：」这个
          // 悬空冒号（本仓既有 spec 明确守着这条体验约束）。
          const detail = errors.length > 0 ? errors.join("; ") : "";
          if (detail) {
            errorCode = "VALIDATION_FAILED";
            params = { detail };
            message = renderZh("VALIDATION_FAILED", { detail });
          } else {
            errorCode = "VALIDATION_FAILED_NO_DETAIL";
            params = null;
            message = renderZh("VALIDATION_FAILED_NO_DETAIL");
          }
        }
      }

      // F-52 自查（UIAUDIT 后端轮，2026-10-25）：管道类 400 的兜底赋码。
      //
      // 根因：NestJS 内建管道（ParseIntPipe / ParseUUIDPipe / ParseBoolPipe /
      // ParseArrayPipe…）拒绝时经 HttpErrorByCode 抛
      // `BadRequestException({ message: "Validation failed (xxx is expected)",
      // error: "Bad Request", … })`——message 是字符串（非数组）不进上面的
      // VALIDATION_FAILED 分支，errorCode 只能保持 null，前端按 errorCode 查
      // i18n 的机制失效、回落裸英文。df08597c（F-41）已给 UUID 侧换
      // ParseUuidShapePipe、本轮（F-52）给 users/task-templates 换了形态管道
      // （管道层显式抛 AppError，永远优先命中第一个分支），但仍有约 7 个模块
      // 的路由挂着原生管道（config / api-keys / executor-package /
      // event-subscriptions / mutex-group / app-deployment / projects 的
      // :userId 等），逐个换管道改动面更大且防不住未来漏挂——在 filter 层按
      // **消息形态**统一兜底："Validation failed (" 是 @nestjs/common 内建
      // 管道 exceptionFactory 的固定前缀（框架契约，业务代码不会手工拼这个
      // 形态），普通业务字符串 message 的 400 不受影响（不为它编造码，保持
      // 本文件「非本机制抛出的异常不赋码」纪律——管道消息本就是本机制
      // （路由形态校验）的第一现场，赋 INVALID_VALUE_FORMAT 不是编造）。
      if (
        errorCode === null &&
        status === HttpStatus.BAD_REQUEST &&
        typeof message === "string" &&
        message.startsWith("Validation failed (")
      ) {
        errorCode = "INVALID_VALUE_FORMAT";
        message = renderZh("INVALID_VALUE_FORMAT");
      }
    } else if (exception instanceof QueryFailedError) {
      // Handle TypeORM database constraint errors
      const pgError = exception as QueryFailedError & { code?: string };
      if (pgError.code === "23505") {
        // Unique constraint violation
        status = HttpStatus.CONFLICT;
        errorCode = "RESOURCE_EXISTS";
        message = renderZh("RESOURCE_EXISTS");
      } else if (pgError.code === "23503") {
        // Foreign key violation
        status = HttpStatus.UNPROCESSABLE_ENTITY;
        errorCode = "RELATED_RESOURCE_NOT_FOUND";
        message = renderZh("RELATED_RESOURCE_NOT_FOUND");
      } else if (pgError.code === "22P02") {
        // F-41（UIUX 审计 P1-2）：值形态与列类型不匹配（invalid_text_representation
        // ——主流场景：UUID 主键列收到非 UUID 值，如深链 /tasks/999999）。这是
        // 请求方输入错误而非服务器故障：旧实现冒泡 500（errorCode:null），第
        // 一现场与真实故障不可区分。路由参数管道（ParseUuidShapePipe）是第一道
        // 防线，这里兜住绕过管道直达 DB 的路径，统一 400（见 catalog 注释）。
        // 原始报错（含值）只落服务端日志，不回传客户端。
        status = HttpStatus.BAD_REQUEST;
        errorCode = "INVALID_VALUE_FORMAT";
        message = renderZh("INVALID_VALUE_FORMAT");
        // 4xx（请求方值形态错误）不是故障，保持 warn；OBS3-04 起同样带
        // method/path/trace，便于与 5xx 行按同一条链路对照（path 去 query）。
        const at = this.requestLocation(request);
        this.logger.warn(
          `DB query failed [22P02] ${at.method} ${at.path} trace=${at.traceId}: ${exception.message}`,
          exception.stack,
        );
      } else {
        // 非映射面内的 PG 错误 → 500。PG 码（42P01 等）是排障第一现场，
        // 拼进 detail 后仍由**唯一 5xx 出口**统一成一行（见 logServerError）。
        logDetail = `DB query failed [${pgError.code ?? "unknown"}]: ${exception.message}`;
      }
    } else if (exception instanceof Error) {
      // Do not leak internal error details to clients
      logDetail = exception.message;
    }

    // OBS3-04（P2 观测审计）：**5xx 的唯一日志出口**。
    //
    // 修的是什么：告警 AUTOFLOW_HTTP_5XX_RATE_HIGH 的 description 第一步要求
    // 「按该 route 过滤 admin-api 结构化日志」，而旧日志行只有
    // `Unhandled exception: <message>`——没有 method、没有 path、没有 errorCode、
    // 没有 traceId，`context` 又恒为类名 `HttpExceptionFilter`。并发下值班人
    // 无法把一条 5xx 日志对到「哪个接口的哪次请求」，runbook 第一步物理上做不到。
    //
    // 为什么收在一个出口而不是各分支各写一行：本 filter 里能产出 5xx 的路径有
    // 三条（未映射的 QueryFailedError、非 HttpException 的 Error，以及
    // AppError/HttpException 自带 5xx 状态码——后两者此前**一行日志都没有**）。
    // 分散写必然漂移成三种格式，收在一处才能保证「一个 grep 前缀 + 四个字段」
    // 这条运维契约。4xx 不进这里（调用方错误不是故障，不制造 error 级噪声），
    // 22P02 的 400 由上面分支按 warn 记录。
    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logServerError(
        request,
        errorCode,
        logDetail ?? message,
        exception instanceof Error ? exception.stack : undefined,
      );
    }

    response.status(status).json({
      code: status,
      errorCode,
      message,
      params,
      data: errors,
      timestamp: new Date().toISOString(),
      path: request.url,
    });
  }

  /**
   * OBS3-04（P2）：5xx 的唯一日志行。
   *
   * 固定格式（告警 runbook 与 Loki 查询都按这一个形状写）：
   *
   * ```text
   * Unhandled exception: POST /api/tasks [TASK_NOT_FOUND] trace=9f2c…: boom
   * ```
   *
   * 三个字段的来源与取舍：
   *  · **path 只取 url 的 path 部分（等价 `url.pathname`，去 query）**。SSE 凭据走 query
   *    (`?ticket=…`，见 JwtStrategy 的 path-binding 注释），把整条 `request.url`
   *    写进日志等于把一次性票据抄进 Loki——日志的读取面比请求日志宽得多
   *    （值班人、看板、导出）。同时 raw URL 里的具体 id 会让按 path 聚合失效。
   *  · **errorCode 用 AppError 的稳定码；没有就写 `NO_CODE`**，绝不编造
   *    （与响应体「非本机制抛出的异常不赋码」同一纪律）。占位值让
   *    `[NO_CODE]` 可被 grep 成「有一批 5xx 还没归码」的度量，而不是空字符串。
   *  · **traceId 取 `req.traceId`**——真实来源是
   *    `common/middleware/trace-id.middleware.ts`（app.module.ts:773 以
   *    `consumer.apply(TraceIdMiddleware).forRoutes("*")` 全量接线，读入站
   *    `x-trace-id`、否则 randomUUID，并回写同名响应头）。OBS3-07 记录过它
   *    「全仓无人读」；本行是它的**第一个消费者**，字段名沿用现状
   *    （`req.traceId`），不另造第二个上下文字段。未接线/缺失时写 `-`。
   */
  private logServerError(
    request: Request | undefined,
    errorCode: string | null,
    detail: string,
    stack?: string,
  ): void {
    const at = this.requestLocation(request);
    this.logger.error(
      `Unhandled exception: ${at.method} ${at.path} ` +
        `[${errorCode ?? "NO_CODE"}] trace=${at.traceId}: ${detail}`,
      stack,
    );
  }

  /**
   * OBS3-04：日志用的请求定位三元组。
   *
   * `path` 一律 `url.split("?")[0]`——**不要换成 `request.url`**：SSE 票据
   * （`?ticket=…`）会随 query 泄漏进日志，且 raw URL 带具体 id、无法聚合。
   * 缺字段时回落 `-`（单测的伪 host 只给 url，生产链路四个字段恒在）。
   */
  private requestLocation(request: Request | undefined): {
    method: string;
    path: string;
    traceId: string;
  } {
    const rawUrl = typeof request?.url === "string" ? request.url : "";
    const path = rawUrl.split("?")[0] || "-";
    const method =
      typeof request?.method === "string" && request.method.length > 0
        ? request.method
        : "-";
    const traceId =
      typeof request?.traceId === "string" && request.traceId.length > 0
        ? request.traceId
        : "-";
    return { method, path, traceId };
  }
}
