import { Test } from "@nestjs/testing";
import { APP_GUARD } from "@nestjs/core";
import { ThrottlerGuard } from "@nestjs/throttler";
import { ConfigService } from "@nestjs/config";
import { AUTH_THROTTLE, OPS_THROTTLE } from "../../../config/throttle-profiles";
import { AppModule } from "../../../app.module";
import { AuthController } from "../../../modules/auth/auth.controller";
import { TaskController } from "../../../modules/task/task.controller";
import { TaskBatchController } from "../../../modules/task/task-batch.controller";
import { AppDeploymentController } from "../../../modules/application/app-deployment.controller";
import { ApplicationController } from "../../../modules/application/application.controller";
import { MetricsStreamController } from "../../../modules/metrics/metrics-stream.controller";

/**
 * SEC-09: 分域档位元数据绑定 spec——断言各路由 @Throttle({ default: ... })
 * / @SkipThrottle() 落到 @nestjs/throttler 的真实元数据键
 * （THROTTLER:LIMITdefault / THROTTLER:TTLdefault / THROTTLER:SKIPdefault），
 * 即 ThrottlerGuard.canActivate 实际读取的位置（guard 全链路计数行为由
 * throttle-domains.spec.ts 覆盖）。
 */

const LIMIT_KEY = "THROTTLER:LIMITdefault";
const TTL_KEY = "THROTTLER:TTLdefault";
const SKIP_KEY = "THROTTLER:SKIPdefault";

const meta = (target: object, prop: string) => {
  const handler = Object.getOwnPropertyDescriptor(target, prop)?.value as object;
  return {
    limit: Reflect.getMetadata(LIMIT_KEY, handler),
    ttl: Reflect.getMetadata(TTL_KEY, handler),
    skip: Reflect.getMetadata(SKIP_KEY, handler),
  };
};

describe("SEC-09 分域档位元数据绑定", () => {
  it("auth 严格档：refresh + totp/*（setup/enable/disable/verify）= AUTH_THROTTLE（缺省 10/60s）", () => {
    const proto = AuthController.prototype;
    for (const m of ["refreshToken", "totpSetup", "totpEnable", "totpDisable", "totpVerifyLogin"]) {
      const { limit, ttl, skip } = meta(proto, m);
      expect(limit).toBe(AUTH_THROTTLE.limit);
      expect(ttl).toBe(AUTH_THROTTLE.ttl);
      expect(skip).toBeUndefined();
    }
  });

  it("login 保留既有 LOGIN_THROTTLE_LIMIT=20 契约（SEC-09 不收紧 login，e2e/文档依赖）", () => {
    const { limit, ttl } = meta(AuthController.prototype, "login");
    expect(limit).toBe(20);
    expect(ttl).toBe(60_000);
  });

  it("task 中档：trigger/kill/rollback/rollbackToVersion/pause/resume/batchTrigger = OPS_THROTTLE（缺省 30/60s）", () => {
    const proto = TaskController.prototype;
    for (const m of [
      "trigger",
      "killExecution",
      "rollback",
      "rollbackToVersion",
      "pause",
      "resume",
      "batchTrigger",
    ]) {
      const { limit, ttl, skip } = meta(proto, m);
      expect(limit).toBe(OPS_THROTTLE.limit);
      expect(ttl).toBe(OPS_THROTTLE.ttl);
      expect(skip).toBeUndefined();
    }
  });

  it("tasks-batch 中档：batchTrigger = OPS_THROTTLE", () => {
    const { limit, ttl } = meta(TaskBatchController.prototype, "batchTrigger");
    expect(limit).toBe(OPS_THROTTLE.limit);
    expect(ttl).toBe(OPS_THROTTLE.ttl);
  });

  it("部署干预面中档：deploy/approve/reject/cancel/upgrade/stop/upgradeAll/rollback = OPS_THROTTLE", () => {
    const deployProto = AppDeploymentController.prototype;
    for (const m of ["deploy", "approve", "reject", "cancel", "upgrade", "stop"]) {
      const { limit, skip } = meta(deployProto, m);
      expect(limit).toBe(OPS_THROTTLE.limit);
      expect(skip).toBeUndefined();
    }
    const appProto = ApplicationController.prototype;
    for (const m of ["upgradeAll", "rollback"]) {
      const { limit, skip } = meta(appProto, m);
      expect(limit).toBe(OPS_THROTTLE.limit);
      expect(skip).toBeUndefined();
    }
  });

  it("SSE 豁免档：task logs/stream 与 metrics stream 挂 @SkipThrottle（SKIPdefault=true）", () => {
    const logs = meta(TaskController.prototype, "streamLogs");
    expect(logs.skip).toBe(true);
    const metrics = meta(MetricsStreamController.prototype, "stream");
    expect(metrics.skip).toBe(true);
  });

  it("非分域路由不受影响：task findAll（读面）无档位元数据（走全局默认 60/min）", () => {
    const { limit, ttl, skip } = meta(TaskController.prototype, "findAll");
    expect(limit).toBeUndefined();
    expect(ttl).toBeUndefined();
    expect(skip).toBeUndefined();
  });

  it("全局挂载形态不变：AppModule 仍以 APP_GUARD 注册 ThrottlerGuard，且 ThrottlerModule 工厂带 skipIf 旁路开关", () => {
    const providers = Reflect.getMetadata("providers", AppModule) as Array<{
      provide?: unknown;
      useClass?: unknown;
    }>;
    expect(
      providers.some((p) => p?.provide === APP_GUARD && p?.useClass === ThrottlerGuard),
    ).toBe(true);

    // forRootAsync 工厂形状（复刻 app.module.spec 的 Bull 根配置检查法）
    const imports = Reflect.getMetadata("imports", AppModule) as Array<{
      module?: { name?: string };
      providers?: Array<{ useFactory?: (...args: unknown[]) => unknown; inject?: unknown[] }>;
    }>;
    const throttlerRoot = imports.find(
      (m) =>
        typeof m === "object" &&
        m !== null &&
        (m as { module?: { name?: string } }).module?.name === "ThrottlerModule" &&
        Array.isArray((m as { providers?: unknown[] }).providers),
    );
    expect(throttlerRoot).toBeDefined();
    const factory = throttlerRoot!.providers!.find((p) => typeof p?.useFactory === "function");
    expect(factory).toBeDefined();
    expect(factory!.inject).toEqual([ConfigService]);

    // 工厂产出：THROTTLE_ENABLED=false → skipIf()=true（全局旁路）；默认产出 ttl/limit 档位
    const cfgOff = { get: (k: string) => (k === "throttle.enabled" ? false : 60) };
    const optsOff = factory!.useFactory!(cfgOff) as { skipIf: () => boolean; throttlers: unknown[] };
    expect(optsOff.skipIf()).toBe(true);
    const cfgOn = { get: (k: string) => (k === "throttle.enabled" ? true : 60) };
    const optsOn = factory!.useFactory!(cfgOn) as { skipIf: () => boolean; throttlers: unknown[] };
    expect(optsOn.skipIf()).toBe(false);
    expect(optsOn.throttlers).toEqual([{ ttl: 60, limit: 60 }]);
  });
});
