import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { AuditModule } from "../audit/audit.module";
import { UsersModule } from "../users/users.module";
import { ProjectsModule } from "../project/projects.module";
import { ImIdentity } from "./entities/im-identity.entity";
import { ImIdentityService } from "./im-identity.service";
import { ImIntakeService } from "./im-intake.service";
import { ImIdentityController } from "./im-identity.controller";

/**
 * N6：IM 身份绑定 + Intake 编排模块。依赖单向：本表 repo + UsersService（校验
 * 绑定目标真实存在）+ AuditService（写面落证）+ ProjectsModule（Intake 的
 * ProjectAccessService）。AuditService 在 service 内 @Optional，缺席时 fail-open
 * （单测内存替身无需装配审计）。Workbench 只以纯函数 preview-validator 复用，
 * 不 import WorkbenchModule（workbench 不反向依赖本模块，无循环）。
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([ImIdentity]),
    UsersModule,
    AuditModule,
    ProjectsModule,
  ],
  controllers: [ImIdentityController],
  providers: [ImIdentityService, ImIntakeService],
  exports: [ImIdentityService, ImIntakeService],
})
export class ImIdentityModule {}
