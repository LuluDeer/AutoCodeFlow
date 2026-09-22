import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { Project } from "./project.entity";
import { ProjectMember } from "./entities/project-member.entity";
import { ProjectsService } from "./projects.service";
import { ProjectAccessService } from "./project-access.service";
import { ProjectsController } from "./projects.controller";
// D3-B-P1-1: 项目/成员写路由审计落证（与 executor/user 落证同构）。
import { AuditModule } from "../audit/audit.module";

@Module({
  imports: [TypeOrmModule.forFeature([Project, ProjectMember]), AuditModule],
  controllers: [ProjectsController],
  providers: [ProjectsService, ProjectAccessService],
  exports: [ProjectsService, ProjectAccessService],
})
export class ProjectsModule {}
