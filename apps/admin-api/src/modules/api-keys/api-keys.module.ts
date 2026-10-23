import { Global, Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { ApiKey } from "./entities/api-key.entity";
import { ApiKeysService } from "./api-keys.service";
import { ApiKeysController } from "./api-keys.controller";
import { ApiKeyAuth } from "./api-key-auth.helper";
import { API_KEY_AUTH_FACADE } from "../../common/guards/jwt-auth.guard";
import { AuditModule } from "../audit/audit.module";
// R32-A4: 认证面复核 key 属主的账号状态（禁用/删除即失效）——只读依赖，
// UsersModule 导出 UsersService 且不反向依赖本模块，无循环。
import { UsersModule } from "../users/users.module";

/**
 * AUTH-03: limited API Keys — entity, CRUD service/controller and the
 * ApiKeyAuth branch consumed by the global JwtAuthGuard (guard stays in
 * common/guards with the single APP_GUARD registration; the branch is
 * bound to the API_KEY_AUTH_FACADE token, @Optional in the guard, and
 * exported for testing).
 *
 * ⚠️ 为什么必须是 @Global（2026-10-23 真机实测抓出，勿摘）：
 * 不少 controller 除了全局 APP_GUARD，还各自写了 `@UseGuards(JwtAuthGuard)`。
 * 这种**模块内实例**在自己的模块注入器里解析构造参数——若本模块不是全局的，
 * `API_KEY_AUTH_FACADE` 在 TaskModule / ExecutorModule 等处不可见，`@Optional()`
 * 把它吞成 undefined，于是该实例**跳过 API Key 分支**、回落到 passport-jwt，
 * 对 `acf_…` 凭据一律 401「Invalid or expired token」。症状很隐蔽：全局实例
 * 已经认证成功（会写 lastUsedAt）、紧接着模块内实例再判一次失败。
 * 实测矩阵（修复前）：/api/tasks、/api/executors、/api/projects、
 * /api/applications → 401；/api/api-keys（本模块内实例可见 facade）→ 正常。
 * 回归锁见 __tests__/api-keys.module.spec.ts。
 */
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([ApiKey]), AuditModule, UsersModule],
  controllers: [ApiKeysController],
  providers: [
    ApiKeysService,
    ApiKeyAuth,
    { provide: API_KEY_AUTH_FACADE, useExisting: ApiKeyAuth },
  ],
  exports: [ApiKeysService, ApiKeyAuth, API_KEY_AUTH_FACADE],
})
export class ApiKeysModule {}
