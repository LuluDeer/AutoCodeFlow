import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { ApiKey } from "./entities/api-key.entity";
import { ApiKeysService } from "./api-keys.service";
import { ApiKeysController } from "./api-keys.controller";
import { ApiKeyAuth } from "./api-key-auth.helper";
import { API_KEY_AUTH_FACADE } from "../../common/guards/jwt-auth.guard";
import { AuditModule } from "../audit/audit.module";

/**
 * AUTH-03: limited API Keys — entity, CRUD service/controller and the
 * ApiKeyAuth branch consumed by the global JwtAuthGuard (guard stays in
 * common/guards with the single APP_GUARD registration; the branch is
 * bound to the API_KEY_AUTH_FACADE token, @Optional in the guard, and
 * exported for testing).
 */
@Module({
  imports: [TypeOrmModule.forFeature([ApiKey]), AuditModule],
  controllers: [ApiKeysController],
  providers: [
    ApiKeysService,
    ApiKeyAuth,
    { provide: API_KEY_AUTH_FACADE, useExisting: ApiKeyAuth },
  ],
  exports: [ApiKeysService, ApiKeyAuth, API_KEY_AUTH_FACADE],
})
export class ApiKeysModule {}
