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

      if (typeof exceptionResponse === "string") {
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
        this.logger.warn(
          `DB query failed [22P02]: ${exception.message}`,
          exception.stack,
        );
      } else {
        this.logger.error(
          `DB query failed [${pgError.code ?? "unknown"}]: ${exception.message}`,
          exception.stack,
        );
      }
    } else if (exception instanceof Error) {
      // Do not leak internal error details to clients
      this.logger.error(
        `Unhandled exception: ${exception.message}`,
        exception.stack,
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
}
