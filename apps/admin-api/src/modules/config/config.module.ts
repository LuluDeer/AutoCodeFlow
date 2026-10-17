import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { SystemConfig } from "./entities/system-config.entity";
import { ConfigHistory } from "./entities/config-history.entity";
import { SystemConfigService } from "./config.service";
// §4.2（跨实例缓存失效）：pub/sub 广播服务。提供姿态与 executor.module.ts 的
// ExecutorTokenCacheSyncService 逐条一致——在本模块 providers 声明；它只依赖
// 全局 ConfigModule 的 ConfigService 取 Redis 连接参数，故无需额外 imports。
import { ConfigCacheSyncService } from "./config-cache-sync.service";
import { ConfigController } from "./config.controller";

@Module({
  imports: [TypeOrmModule.forFeature([SystemConfig, ConfigHistory])],
  controllers: [ConfigController],
  providers: [SystemConfigService, ConfigCacheSyncService],
  exports: [SystemConfigService],
})
export class SystemConfigModule {}
