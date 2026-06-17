// Extend Express Request to include traceId attached by TraceMiddleware / TraceIdMiddleware
declare namespace Express {
  interface Request {
    traceId?: string;
  }
}
