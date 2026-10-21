import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { Project } from "./project.entity";
import { ProjectMember } from "./entities/project-member.entity";
import { ProjectsService } from "./projects.service";
import { ProjectAccessService } from "./project-access.service";
import { ProjectsController } from "./projects.controller";
// D3-B-P1-1: 项目/成员写路由审计落证（与 executor/user 落证同构）。
import { AuditModule } from "../audit/audit.module";
// PROJECT-IMPACT-01（删除影响面预览）：统计「该项目下有多少任务」需要读 tasks 表。
// 与 task.module 的 TASK-PROJ-01 同款**跨模块 forFeature**——只取连接与元数据，
// 无运行时依赖环（本模块不 import TaskModule，TaskModule 也不 import 本模块；
// 两端各自 forFeature 同一实体是 TypeORM 的受支持用法）。
import { Task } from "../task/entities/task.entity";
// R32-A5：成员授予前的目标用户存在性校验要读 users 表（ProjectAccessService
// 的 @Optional UsersService）。UsersModule 不反向依赖本模块，无循环。
import { UsersModule } from "../users/users.module";

@Module({
  imports: [
    TypeOrmModule.forFeature([Project, ProjectMember, Task]),
    AuditModule,
    UsersModule,
  ],
  controllers: [ProjectsController],
  providers: [ProjectsService, ProjectAccessService],
  exports: [ProjectsService, ProjectAccessService],
})
export class ProjectsModule {}
