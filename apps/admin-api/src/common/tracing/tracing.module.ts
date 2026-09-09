import { Global, Module } from "@nestjs/common";
import { TracingService } from "./tracing.service";

/**
 * OBS-01: tracing 模块（@Global——埋点遍布 task/scheduler/executor 三模块，
 * 各模块无需逐一 import）。provider 恒提供；开关语义在 TracingService 内部
 * （OTEL_ENABLED=false 时全方法短路），既有单测装配零破坏。
 */
@Global()
@Module({
  providers: [TracingService],
  exports: [TracingService],
})
export class TracingModule {}
