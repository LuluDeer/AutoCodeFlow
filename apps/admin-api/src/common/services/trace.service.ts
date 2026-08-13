import { Injectable, Scope } from "@nestjs/common";
import type { InternalAxiosRequestConfig } from "axios";
import { AsyncLocalStorage } from "async_hooks";
import { randomUUID } from "crypto";

/**
 * OPS-03: Trace service for managing request-scoped trace IDs.
 * Uses AsyncLocalStorage to maintain trace context across async operations.
 */
@Injectable({ scope: Scope.REQUEST })
export class TraceService {
  private static storage = new AsyncLocalStorage<string>();

  private _traceId: string;

  constructor() {
    // Try to get from async storage first
    this._traceId = TraceService.storage.getStore() || randomUUID();
  }

  get traceId(): string {
    return this._traceId;
  }

  set traceId(value: string) {
    this._traceId = value;
  }

  /**
   * Run a callback with the given traceId in context.
   */
  static runWithTrace<T>(traceId: string, callback: () => T): T {
    return TraceService.storage.run(traceId, callback);
  }

  /**
   * Get current traceId from async context.
   */
  static getCurrentTraceId(): string | undefined {
    return TraceService.storage.getStore();
  }

  /**
   * Attach traceId to axios request config.
   */
  attachToAxiosConfig(
    config: InternalAxiosRequestConfig,
  ): InternalAxiosRequestConfig {
    config.headers.set("X-Trace-Id", this._traceId);
    return config;
  }

  /**
   * Get headers object with traceId for external service calls.
   */
  getTraceHeaders(): Record<string, string> {
    return { "X-Trace-Id": this._traceId };
  }
}
