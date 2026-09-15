import { Module } from "@nestjs/common";
import { RegistryController } from "./registry.controller";
// A7：上传面收敛需要落审计（投毒面可追溯），AuditModule 已 exports AuditService。
import { AuditModule } from "../audit/audit.module";

@Module({
  imports: [AuditModule],
  controllers: [RegistryController],
})
export class RegistryModule {}
