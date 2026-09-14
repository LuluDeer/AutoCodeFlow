import { RequestMethod } from "@nestjs/common";
import { METHOD_METADATA } from "@nestjs/common/constants";
import { ROLES_KEY } from "../../decorators/roles.decorator";
import { IS_PUBLIC_KEY } from "../../decorators/public.decorator";
import {
  WRITE_GUARD_KEY,
  WriteGuardMetadata,
  WriteScope,
} from "../../decorators/write-guard.decorator";
import { UserRole } from "../../../modules/users/entities/user.entity";

import { AiController } from "../../../modules/ai/ai.controller";
import { ApiKeysController } from "../../../modules/api-keys/api-keys.controller";
import { AppDeploymentController } from "../../../modules/application/app-deployment.controller";
import { ApplicationController } from "../../../modules/application/application.controller";
import { ArtifactsController } from "../../../modules/artifacts/artifacts.controller";
import { AuditController } from "../../../modules/audit/audit.controller";
import { AuthController } from "../../../modules/auth/auth.controller";
import { OidcController } from "../../../modules/auth/oidc.controller";
import { ConfigController } from "../../../modules/config/config.controller";
import { EventSubscriptionController } from "../../../modules/event-subscriptions/event-subscription.controller";
import { ExecutorPackageController } from "../../../modules/executor-package/executor-package.controller";
import { ExecutorController } from "../../../modules/executor/executor.controller";
import { HealthController } from "../../../modules/health/health.controller";
import { ExecutionsStreamController } from "../../../modules/metrics/executions-stream.controller";
import { MetricsStreamController } from "../../../modules/metrics/metrics-stream.controller";
import { MetricsController } from "../../../modules/metrics/metrics.controller";
import { AlertsController } from "../../../modules/notification/alerts.controller";
import { NotificationConfigController } from "../../../modules/notification/notification-config.controller";
import { ProjectsController } from "../../../modules/project/projects.controller";
import { RegistryController } from "../../../modules/registry/registry.controller";
import { TaskTemplateController } from "../../../modules/task-template/task-template.controller";
import { ExecutionCallbackController } from "../../../modules/task/execution-callback.controller";
import { TaskBatchController } from "../../../modules/task/task-batch.controller";
import { TaskController } from "../../../modules/task/task.controller";
import { UsersController } from "../../../modules/users/users.controller";

/**
 * A2（DEEP_REVIEW 0ef3bbe §七）：写面守卫**穷举**扫描。
 *
 * 与 throttle-domain-metadata.spec.ts（手挑路由列表）不同，本 spec 遍历全部
 * 控制器实例方法，按 Nest 的真实元数据键（METHOD_METADATA / PATH_METADATA）
 * 判定哪些是写端点，再逐个断言其授权形态已被显式声明——新增写端点若忘记声明，
 * 无需任何人记得改测试，CI 直接红。
 *
 * 规则（与 write-guard.decorator.ts 头注一一对应）：
 *   写端点必须满足其一：① 非空 @Roles(...)；② @WriteGuard(resource, {scope})。
 *   且 scope 与 @Public() 必须自洽：
 *     - token / public  → 必须 @Public() 且 reason 非空；
 *     - ownership / authenticated → 不得 @Public()。
 */

/** 控制器类：只需能读 metadata 与 prototype，故收成 object 而非 `Function`
 *  （`Function` 触发 @typescript-eslint/no-unsafe-function-type）。 */
type ControllerCtor = object;

const CONTROLLERS: ReadonlyArray<readonly [string, ControllerCtor]> = [
  ["AiController", AiController],
  ["ApiKeysController", ApiKeysController],
  ["AppDeploymentController", AppDeploymentController],
  ["ApplicationController", ApplicationController],
  ["ArtifactsController", ArtifactsController],
  ["AuditController", AuditController],
  ["AuthController", AuthController],
  ["OidcController", OidcController],
  ["ConfigController", ConfigController],
  ["EventSubscriptionController", EventSubscriptionController],
  ["ExecutorPackageController", ExecutorPackageController],
  ["ExecutorController", ExecutorController],
  ["HealthController", HealthController],
  ["ExecutionsStreamController", ExecutionsStreamController],
  ["MetricsStreamController", MetricsStreamController],
  ["MetricsController", MetricsController],
  ["AlertsController", AlertsController],
  ["NotificationConfigController", NotificationConfigController],
  ["ProjectsController", ProjectsController],
  ["RegistryController", RegistryController],
  ["TaskTemplateController", TaskTemplateController],
  ["ExecutionCallbackController", ExecutionCallbackController],
  ["TaskBatchController", TaskBatchController],
  ["TaskController", TaskController],
  ["UsersController", UsersController],
];

const WRITE_METHODS: ReadonlySet<RequestMethod> = new Set([
  RequestMethod.POST,
  RequestMethod.PUT,
  RequestMethod.PATCH,
  RequestMethod.DELETE,
]);

const VALID_SCOPES: ReadonlySet<WriteScope> = new Set<WriteScope>([
  "ownership",
  "authenticated",
  "token",
  "public",
]);

interface WriteEndpoint {
  /** 稳定标识：Controller.method */
  id: string;
  handler: object;
  method: RequestMethod;
  /** 该端点最终生效的角色（handler 优先于 class，与 RolesGuard 同序）。 */
  roles: UserRole[] | undefined;
  isPublic: boolean;
  writeGuard: WriteGuardMetadata | undefined;
}

function collectWriteEndpoints(): WriteEndpoint[] {
  const out: WriteEndpoint[] = [];
  for (const [name, ctor] of CONTROLLERS) {
    const proto = (ctor as { prototype: Record<string, unknown> }).prototype;
    // class 级 @Roles / @Public 与 handler 级同键（getAllAndOverride 语义）
    const classRoles = Reflect.getMetadata(ROLES_KEY, ctor) as
      UserRole[] | undefined;
    const classPublic = Reflect.getMetadata(IS_PUBLIC_KEY, ctor) as
      boolean | undefined;

    for (const prop of Object.getOwnPropertyNames(proto)) {
      if (prop === "constructor") continue;
      // 只取「数据属性且值为函数」——prototype 上的 getter（如
      // ExecutionsStreamController.idlePingMs）在原型上访问会因 this 上无
      // 依赖而抛错，且 HTTP 方法装饰器只会落在数据属性上。
      const desc = Object.getOwnPropertyDescriptor(proto, prop);
      if (!desc || typeof desc.value !== "function") continue;
      const handler = desc.value as object;

      const method = Reflect.getMetadata(METHOD_METADATA, handler) as
        RequestMethod | undefined;
      if (method === undefined || !WRITE_METHODS.has(method)) continue;

      out.push({
        id: `${name}.${prop}`,
        handler,
        method,
        roles:
          (Reflect.getMetadata(ROLES_KEY, handler) as UserRole[] | undefined) ??
          classRoles,
        isPublic:
          (Reflect.getMetadata(IS_PUBLIC_KEY, handler) as
            boolean | undefined) ??
          classPublic ??
          false,
        writeGuard: Reflect.getMetadata(WRITE_GUARD_KEY, handler) as
          WriteGuardMetadata | undefined,
      });
    }
  }
  return out;
}

const METHOD_NAME: Record<number, string> = {
  [RequestMethod.POST]: "POST",
  [RequestMethod.PUT]: "PUT",
  [RequestMethod.PATCH]: "PATCH",
  [RequestMethod.DELETE]: "DELETE",
};

describe("A2 写面守卫穷举扫描（write-guard-coverage）", () => {
  const endpoints = collectWriteEndpoints();

  it("扫描面非空——控制器清单与装饰器常量键正确接线（防扫描器静默失效）", () => {
    // 扫描器一旦因为元数据键写错/控制器漏登记而「扫不到东西」，本 spec 会
    // 变成永真断言——先钉住规模下界。
    expect(endpoints.length).toBeGreaterThanOrEqual(90);
    // 抽样确认元数据键确实能读出（POST /tasks/:id/kill 为已知写端点）
    const kill = endpoints.find((e) => e.id === "TaskController.killExecution");
    expect(kill).toBeDefined();
    expect(kill!.method).toBe(RequestMethod.POST);
  });

  it("每个写端点都显式声明了授权形态（@Roles 或 @WriteGuard）", () => {
    const undeclared = endpoints
      .filter(
        (e) => !(e.roles && e.roles.length > 0) && e.writeGuard === undefined,
      )
      .map((e) => `${e.id} [${METHOD_NAME[e.method]}]`);

    expect(undeclared).toEqual([]);
  });

  it("@WriteGuard 元数据形状合法：resource 非空、scope 取值受控", () => {
    const bad = endpoints
      .filter((e) => e.writeGuard !== undefined)
      .filter((e) => {
        const g = e.writeGuard!;
        return (
          typeof g.resource !== "string" ||
          g.resource.trim() === "" ||
          !VALID_SCOPES.has(g.scope)
        );
      })
      .map((e) => `${e.id}: ${JSON.stringify(e.writeGuard)}`);

    expect(bad).toEqual([]);
  });

  it("scope 与 @Public() 自洽：token/public 必须 @Public() 且给 reason；ownership/authenticated 不得 @Public()", () => {
    const violations: string[] = [];
    for (const e of endpoints) {
      const g = e.writeGuard;
      if (!g) continue;

      if (g.scope === "token" || g.scope === "public") {
        if (!e.isPublic) {
          violations.push(
            `${e.id}: scope='${g.scope}' 必须同时 @Public()（JWT 守卫需旁路）`,
          );
        }
        if (!g.reason || g.reason.trim() === "") {
          violations.push(`${e.id}: scope='${g.scope}' 必须给出 reason`);
        }
      } else if (e.isPublic) {
        violations.push(
          `${e.id}: scope='${g.scope}' 不得是 @Public()（应为 token/public 之一）`,
        );
      }
    }
    expect(violations).toEqual([]);
  });

  it("声明不得冗余或冲突：@WriteGuard 与 @Roles 不共存（角色门控直接写 @Roles 即可）", () => {
    const both = endpoints
      .filter(
        (e) => e.writeGuard !== undefined && e.roles && e.roles.length > 0,
      )
      .map((e) => `${e.id}: 同时有 @Roles 与 @WriteGuard`);
    expect(both).toEqual([]);
  });

  it("token/public 类声明必须集中在可审计的窄面上（回归守卫：这类端点数量与清单钉死）", () => {
    // 价值：任何「新开一个免 JWT 写端点」的改动都会让本断言红，强制走显式
    // 复核（而不是悄悄加个 @Public() 就过去了）。清单变更时请同步更新本表。
    const openIds = endpoints
      .filter(
        (e) =>
          e.writeGuard?.scope === "token" || e.writeGuard?.scope === "public",
      )
      .map((e) => e.id)
      .sort();

    // A2 落地时实测 98 个写端点。总数下界钉死：新增写端点会推高它（正常），
    // 但任何**减少**（删端点/改方法名）都必须显式更新这里——防止有人靠删
    // 声明来「修」红灯。
    expect(openIds).toEqual(
      [
        "AlertsController.webhook",
        "AppDeploymentController.heartbeat",
        "ApplicationController.webhook",
        "ArtifactsController.upload",
        "AuthController.login",
        "AuthController.refreshToken",
        "AuthController.totpVerifyLogin",
        "ExecutionCallbackController.callback",
        "ExecutorController.getToken",
        "ExecutorController.heartbeat",
        "ExecutorController.offline",
        "ExecutorController.pullDispatch",
        "ExecutorController.register",
        "ExecutorPackageController.pushResult",
      ].sort(),
    );
  });
});
