import * as fs from "fs";
import * as path from "path";
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
  "project-role",
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

/**
 * A2-B：落证方扫描。
 *
 * `ownership` / `project-role` 的运行时强制靠 service 里的
 * `recordOwnershipAssertion(resource, kind)` 落证。声明与落证是两处代码，
 * 必须互相咬合：声明了一个 resource 却没人落证 = 该端点上线即 500；落证被删
 * 而声明还在 = 同。故在此做静态对账（与 A6/A5 同款「扫描型守卫必须自带规模
 * 下界」纪律——扫不到东西时不能变成永真断言）。
 */
const SRC_ROOT = path.resolve(__dirname, "../../..");

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      collectSourceFiles(full, out);
    } else if (
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".spec.ts") &&
      !entry.name.endsWith(".d.ts")
    ) {
      out.push(full);
    }
  }
  return out;
}

const RECORDER_RE =
  /recordOwnershipAssertion\(\s*"([^"]+)"\s*,\s*"([^"]+)"\s*\)/g;

function collectRecorders(): Set<string> {
  const out = new Set<string>();
  for (const file of collectSourceFiles(SRC_ROOT)) {
    const text = fs.readFileSync(file, "utf8");
    for (const m of text.matchAll(RECORDER_RE)) {
      out.add(`${m[1]}:${m[2]}`);
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

      // A2-B: ownership 与 project-role 的区分是**语义**区分，不是改名游戏——
      // project-role 只拒绝项目 viewer（ADR-013：属主收紧待产品拍板），把它
      // 标成 ownership 会让「已做属主校验」变成假声明。故要求给出 reason 说明。
      if (g.scope === "project-role" && !g.reason?.trim()) {
        violations.push(
          `${e.id}: scope='project-role' 必须给出 reason（说明为何此处只做项目角色校验）`,
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
        // RT-LOG：执行中日志的增量上报（机器面，非用户会话）。与 callback 同源
        // 鉴权：per-execution `v1.` HMAC 令牌 / per-address 令牌 / 共享令牌三层，
        // 且令牌必须**绑定到路径上的 executionId**（单执行端点，比批量的逐项
        // 比对更严——否则任一执行器都能往别人的执行里写日志）。
        "ExecutionCallbackController.appendLogChunk",
        "ExecutorController.getToken",
        "ExecutorController.heartbeat",
        "ExecutorController.offline",
        "ExecutorController.pullDispatch",
        "ExecutorController.register",
        // ARCH-33（ADR-016）：pull 控制命令的执行结果上报（机器面，非用户会话）。
        // 与 pullDispatch 同属执行器长轮询通道的写面：执行器只持有自己的令牌，
        // 端点内以 validateTokenByAddress(address, token) 自证身份。
        "ExecutorController.reportCommandResult",
        "ExecutorPackageController.pushResult",
      ].sort(),
    );
  });

  it("ownership 端点清单钉死（A2-B：这些端点被运行时强制，改动须显式复核）", () => {
    // A2-B 起，scope='ownership' 不再只是文档——WriteGuardEnforcementInterceptor
    // 会要求端点真的落过属主断言证据（缺证据直接 500）。因此「某个端点是不是
    // ownership」变成了一个**行为开关**，不再允许顺手改：清单变更必须同时改
    // 这里，并说明属主校验由谁执行。
    const ids = endpoints
      .filter((e) => e.writeGuard?.scope === "ownership")
      .map((e) => e.id)
      .sort();

    expect(ids).toEqual(
      [
        "EventSubscriptionController.remove",
        "EventSubscriptionController.replay",
        "EventSubscriptionController.update",
        "TaskBatchController.batchDelete",
        "TaskController.analyzeExecution",
        "TaskController.batchDelete",
        "TaskController.killExecution",
        "TaskController.remove",
        "TaskController.rollback",
        "TaskController.rollbackToVersion",
        "TaskController.suggestSchedule",
        "TaskController.update",
        "TaskController.updateGlue",
      ].sort(),
    );
  });

  it("声明与落证对账：每个受强制的 resource 都真的有对应种类的落证方", () => {
    // A2-B: 声明 ownership 却没人落 'write' 证 → 该端点上线即 500；反向删掉
    // service 里的落证调用而保留声明 → 同样 500。本断言让这两种漂移在 CI 就红。
    const recorders = collectRecorders();
    // 规模下界：扫描器一旦失效（路径/正则写错）会静默变永真断言
    expect(recorders.size).toBeGreaterThanOrEqual(4);
    expect([...recorders].sort()).toEqual(
      expect.arrayContaining([
        "application:write",
        "event-subscription:write",
        "task:operate",
        "task:write",
      ]),
    );

    const missing = endpoints
      .filter((e) => e.writeGuard?.scope === "ownership")
      .filter((e) => !recorders.has(`${e.writeGuard!.resource}:write`))
      .map(
        (e) =>
          `${e.id}: 声明 ownership(resource='${e.writeGuard!.resource}') 但源码中无对应的 write 落证方`,
      )
      .concat(
        endpoints
          .filter((e) => e.writeGuard?.scope === "project-role")
          .filter((e) => !recorders.has(`${e.writeGuard!.resource}:operate`))
          .map(
            (e) =>
              `${e.id}: 声明 project-role(resource='${e.writeGuard!.resource}') 但源码中无对应的 operate 落证方`,
          ),
      );

    expect(missing).toEqual([]);
  });

  it("project-role 端点清单钉死（弱于 ownership：只拒 viewer，不校验属主）", () => {
    // 与上一断言同源：这里登记的是「已确认**没有**属主校验」的执行类写面
    // （ADR-013：trigger/pause/resume 的宽松语义待产品拍板后收紧）。新端点
    // 挂上 project-role 会让本断言红，强制说明为什么此处不做属主校验。
    const ids = endpoints
      .filter((e) => e.writeGuard?.scope === "project-role")
      .map((e) => e.id)
      .sort();

    expect(ids).toEqual(
      [
        "TaskBatchController.batchPause",
        "TaskBatchController.batchResume",
        "TaskBatchController.batchTrigger",
        "TaskController.batchPause",
        "TaskController.batchResume",
        "TaskController.batchTrigger",
        "TaskController.pause",
        "TaskController.resume",
        "TaskController.trigger",
      ].sort(),
    );
  });
});
