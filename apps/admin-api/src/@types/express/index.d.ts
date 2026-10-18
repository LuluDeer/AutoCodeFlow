// Extend Express Request to include traceId attached by TraceIdMiddleware
// (applied for all routes in app.module.ts's configure()).
declare namespace Express {
  interface Request {
    traceId?: string;
  }
}
