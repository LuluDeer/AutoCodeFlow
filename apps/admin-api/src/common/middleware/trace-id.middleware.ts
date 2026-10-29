import { Injectable, NestMiddleware } from "@nestjs/common";
import { Request, Response, NextFunction } from "express";
import { randomUUID } from "crypto";

/**
 * OPS-03 / OBS3-07：给每个请求生成 `X-Trace-Id` 并回显到响应头，同时写入
 * `req.traceId`——**异常过滤器**用它给 5xx/22P02 日志行做请求关联（一次抓包/
 * 一条告警能被对到具体请求）。
 *
 * 边界（OBS3-07 审计后如实声明）：这是**请求域**关联，不是跨服务追踪——
 * 出站 HTTP 不携带该头，曾经配套的 `TraceService`/`TraceModule` 从未被任何
 * 模块 import（死代码，已删除）。客户端可用响应头的 id 与服务端日志对照。
 */
@Injectable()
export class TraceIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    const traceId = (req.headers["x-trace-id"] as string) || randomUUID();
    req.traceId = traceId;
    res.setHeader("X-Trace-Id", traceId);
    next();
  }
}
