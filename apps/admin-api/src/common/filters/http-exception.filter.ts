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

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = "Internal server error";
    let errors: string[] | null = null;

    if (exception instanceof HttpException) {
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
          message =
            errors.length > 0
              ? `Validation failed: ${errors.join("; ")}`
              : "Validation failed";
        }
      }
    } else if (exception instanceof QueryFailedError) {
      // Handle TypeORM database constraint errors
      const pgError = exception as QueryFailedError & { code?: string };
      if (pgError.code === "23505") {
        // Unique constraint violation
        status = HttpStatus.CONFLICT;
        message = "Resource already exists";
      } else if (pgError.code === "23503") {
        // Foreign key violation
        status = HttpStatus.UNPROCESSABLE_ENTITY;
        message = "Related resource not found";
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
      message,
      data: errors,
      timestamp: new Date().toISOString(),
      path: request.url,
    });
  }
}
