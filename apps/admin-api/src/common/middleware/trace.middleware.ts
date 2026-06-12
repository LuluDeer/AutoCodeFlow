import { Injectable, NestMiddleware, Logger } from "@nestjs/common";
import { Request, Response, NextFunction } from "express";
import { v4 as uuidv4 } from "uuid";

/**
 * OPS-03: Cross-service request tracing middleware.
 * Generates and propagates a traceId through the X-Trace-Id header.
 * This enables correlation of logs across admin-api, executor-python, executor-node, and other services.
 */
@Injectable()
export class TraceMiddleware implements NestMiddleware {
  private readonly logger = new Logger(TraceMiddleware.name);

  use(req: Request, res: Response, next: NextFunction) {
    // Extract existing traceId or generate a new one
    const traceId = (req.headers["x-trace-id"] as string) || uuidv4();

    // Attach traceId to request object for use in services/controllers
    (req as any).traceId = traceId;

    // Set response header so clients can track the trace
    res.setHeader("X-Trace-Id", traceId);

    // Log incoming request with traceId
    this.logger.log(`[${traceId}] ${req.method} ${req.path}`);

    next();
  }
}
