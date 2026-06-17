import { Injectable, NestMiddleware } from "@nestjs/common";
import { Request, Response, NextFunction } from "express";
import { randomUUID } from "crypto";

/**
 * OPS-03: Attach a unique X-Trace-Id to every request and echo it in the response.
 * Downstream services and logs can use this ID to correlate a full request flow.
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
