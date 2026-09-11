/**
 * ARCH-25: 任务 runtime 注册表模块。
 *
 * @Global：后续表单选项/文档/校验消费方无需逐模块 import（与 DomainEventModule
 * 同形态）。本阶段只提供注册表本身，不改任何既有链路。
 */
import { Global, Module } from "@nestjs/common";
import { TaskRuntimeRegistry } from "./task-runtime-registry.service";

@Global()
@Module({
  providers: [TaskRuntimeRegistry],
  exports: [TaskRuntimeRegistry],
})
export class RuntimeModule {}
