import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { TaskModule } from "../task/task.module";
import { TaskTemplate } from "./entities/task-template.entity";
import { TaskTemplateService } from "./task-template.service";
import { TaskTemplateController } from "./task-template.controller";

/**
 * CORE-03：任务模板模块（新独占模块）。
 *
 * 依赖方向单向：本模块 import TaskModule 取其导出的 TaskService，用于
 * 「从模板创建」(POST /task-templates/:id/instantiate) 复用既有建任务路径
 * （校验/落库/版本快照/调度注册一体化）。TaskModule 不反向 import 本模块，
 * 故无循环。本模块除 TaskModule 外不依赖任何其他业务模块。
 */
@Module({
  imports: [TypeOrmModule.forFeature([TaskTemplate]), TaskModule],
  controllers: [TaskTemplateController],
  providers: [TaskTemplateService],
  exports: [TaskTemplateService],
})
export class TaskTemplateModule {}
