import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bull';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import configuration from './config/configuration';
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { TaskModule } from './modules/task/task.module';
import { ExecutorModule } from './modules/executor/executor.module';
import { SchedulerModule } from './modules/scheduler/scheduler.module';
import { NotificationModule } from './modules/notification/notification.module';
import { AiModule } from './modules/ai/ai.module';
import { MetricsModule } from './modules/metrics/metrics.module';
import { SystemConfigModule } from './modules/config/config.module';
import { AuditModule } from './modules/audit/audit.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      envFilePath: '.env',
    }),

    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (cfg: ConfigService) => ({
        type: 'postgres',
        host: cfg.get('database.host'),
        port: cfg.get<number>('database.port'),
        username: cfg.get('database.username'),
        password: cfg.get('database.password'),
        database: cfg.get('database.database'),
        entities: [__dirname + '/**/*.entity{.ts,.js}'],
        migrations: [__dirname + '/migrations/*{.ts,.js}'],
        migrationsRun: cfg.get('app.nodeEnv') !== 'development',
        synchronize: cfg.get('app.nodeEnv') === 'development',
        logging: cfg.get('app.nodeEnv') === 'development',
      }),
      inject: [ConfigService],
    }),

    BullModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (cfg: ConfigService) => ({
        redis: {
          host: cfg.get('redis.host'),
          port: cfg.get<number>('redis.port'),
          password: cfg.get('redis.password'),
        },
      }),
      inject: [ConfigService],
    }),

    AuthModule,
    UsersModule,
    TaskModule,
    ExecutorModule,
    SchedulerModule,
    NotificationModule,
    AiModule,
    MetricsModule,
    SystemConfigModule,
    AuditModule,
  ],
  providers: [
    // A-02: apply ThrottlerGuard globally
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
