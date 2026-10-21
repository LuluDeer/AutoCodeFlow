import * as fs from "fs";
import * as path from "path";
import { RequestMethod } from "@nestjs/common";
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from "@nestjs/common/constants";
import { ROLES_KEY } from "../../decorators/roles.decorator";
import { IS_PUBLIC_KEY } from "../../decorators/public.decorator";
import {
  WRITE_GUARD_KEY,
  WriteGuardMetadata,
  WriteScope,
} from "../../decorators/write-guard.decorator";
import { UserRole } from "../../../modules/users/entities/user.entity";

/**
 * R203-A1：**全路由鉴权矩阵**穷举扫描（读面 + 写面 + 机器面 + 公开面）。
 *
 * ## 为什么需要这份扫描（与 write-guard-coverage 的分工）
 *
 * A2 建立的 write-guard-coverage.spec.ts 只扫 **写** 方法（POST/PUT/PATCH/
 * DELETE），断言「每个写端点都显式声明了 @Roles 或 @WriteGuard」。它刻意没覆盖
 * 读面，于是留下三处结构性盲区——本 spec 就是来补读面这一半的：
 *
 *   ① **读面完全没人扫**：103 条 GET 路由里，「@Public() 一贴就公开」没有任何
 *      机械约束。写面新开一个免 JWT 端点会被 A2 拦下，读面新开一个直接过——
 *      而**公开即泄露**在读面同样成立（/metrics/failures 曾把失败详情与执行器
 *      内网地址摆在无鉴权面上）。
 *   ② **控制器清单靠手写**：write-guard-coverage 的 CONTROLLERS 是 26 项的手写
 *      数组，实际 30 个控制器文件——AgentController / MutexGroupController /
 *      SopController / SopCollabController 从未进入扫描面。手写清单一定会漂移，
 *      而漂移是静默的（少扫 = 更少断言 = 更容易绿）。本 spec **从文件系统发现**
 *      控制器，清单不可能过期。
 *   ③ **写面上的「声明」到读面就断了**：GET /executors/config 与
 *      GET /executors/:address/terminal-states 明明挂着 @WriteGuard(scope:'token')，
 *      却因为方法不是写方法而落在任何扫描之外——声明写了，没人核对。
 *
 * ## 判据（每条路由都必须落进一个**有名字**的鉴权形态）
 *
 *   role-gated     @Roles 非空（JwtAuthGuard 之后由 RolesGuard 强制）
 *   declared-*     @WriteGuard 显式声明（scope 见 WRITE_GUARD_KEY 头注）
 *   delegated      @Public() + **补偿守卫**（如 MetricsScraperAuthGuard 自己走
 *                  真 JWT 校验）——补偿守卫必须登记在 COMPENSATING_GUARDS
 *   open-registered @Public() 且既无声明也无补偿守卫 ⇒ **必须**在
 *                  OPEN_ROUTE_REGISTRY 里逐条写明「为什么这里可以不鉴权」
 *   jwt            仅全局 JwtAuthGuard（登录即可）
 *
 * 未登记的 @Public() 读路由 = 红灯。这正是「新增控制器忘加守卫」的机械拦截点。
 *
 * ## 规模下界（扫描器坏了不能永远绿）
 *
 * 断言 30 个控制器 / >=220 条路由 / 各方法桶下界；控制器数必须与磁盘上的
 * *.controller.ts 文件数一致（发现逻辑失效时立刻红，而不是静默少扫）。
 */

const SRC_ROOT = path.resolve(__dirname, "../../..");

/** 控制器构造器：只读 metadata 与 prototype，故收成 object。 */
type ControllerCtor = object;

const METHOD_NAME: Record<number, string> = {
  [RequestMethod.GET]: "GET",
  [RequestMethod.POST]: "POST",
  [RequestMethod.PUT]: "PUT",
  [RequestMethod.PATCH]: "PATCH",
  [RequestMethod.DELETE]: "DELETE",
  [RequestMethod.OPTIONS]: "OPTIONS",
  [RequestMethod.HEAD]: "HEAD",
  [RequestMethod.ALL]: "ALL",
};

/** 全局注册的两个守卫（app.module 的 APP_GUARD）：它们不构成「补偿鉴权」。 */
const GLOBAL_GUARD_NAMES: ReadonlySet<string> = new Set([
  "JwtAuthGuard",
  "RolesGuard",
]);

/**
 * 允许顶替全局 JwtAuthGuard 的**补偿守卫**白名单（name -> 它到底做了什么）。
 * 新出现一个 @Public() + @UseGuards(X) 而 X 不在本表 -> 红灯：否则随便挂一个
 * 空守卫就能把「公开」洗成「委托鉴权」。
 */
const COMPENSATING_GUARDS: Readonly<Record<string, string>> = {
  MetricsScraperAuthGuard:
    "Prometheus 抓取专用守卫：共享令牌仅放行 GET /api/metrics，其余路径回落真 JWT（内部用 NonPublicReflector 屏蔽 IS_PUBLIC）",
};

/**
 * @Public() 且**没有任何替代鉴权**的路由登记表（key = Controller.method）。
 * 每条都必须写清「为什么可以不鉴权」；新增一条 = 必须显式复核。
 *
 * 不含：(a) 已带 @WriteGuard(scope:'token'|'public') 的路由——那是 A2 的显式
 * 声明面；(b) 带补偿守卫的路由——见 COMPENSATING_GUARDS；(c) 9 条
 * /agent-collab/* 机器面写路由——R203-A1 已补 @WriteGuard(scope:'token')。
 */
const OPEN_ROUTE_REGISTRY: Readonly<Record<string, string>> = {
  "OidcController.status":
    "SSO 可用性探测：登录页在未认证状态下必须先知道 IdP 是否启用",
  "OidcController.login": "SSO 登录入口本身（重定向到 IdP，尚无会话可校验）",
  "OidcController.callback":
    "IdP 授权码回调，凭 code+state+PKCE 换会话；此时必然无会话",
  "HealthController.health":
    "存活探针：k8s/LB 无凭据可带，返回内容不含内部拓扑",
  "HealthController.live":
    "存活探针：仅返回进程是否存活，不触达任何依赖，响应体不含内部拓扑",
  "HealthController.ready":
    "就绪探针：仅返回依赖就绪位（布尔聚合），不返回连接串/版本/主机名",
  "ExecutorController.getInstallScript":
    "执行器一键安装脚本文本；脚本本身不含密钥（--secret 由调用方以参数传入）",
  "ExecutorController.getExecutorArtifact":
    "执行器安装包静态 artifact 下载（内网分发通道，内容为公开二进制）",
  "ExecutorPackageController.download":
    "执行器包下载：控制器内**手搓双凭据**校验（verifyExecutorToken 执行器令牌 / access JWT），失败即 401——鉴权在 handler 里而不在守卫里，故登记在此",
};

const WRITE_METHODS: ReadonlySet<string> = new Set([
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
]);

const VALID_SCOPES: ReadonlySet<WriteScope> = new Set<WriteScope>([
  "ownership",
  "project-role",
  "authenticated",
  "token",
  "public",
]);

interface RouteRow {
  /** 稳定标识：Controller.method（唯一键，用于登记表对账）。 */
  id: string;
  controller: string;
  file: string;
  controllerPath: string;
  method: string;
  property: string;
  handlerPath: string;
  /** handler 级 @Roles（null = 未声明；[] = 显式 @Roles() 覆写）。 */
  roles: UserRole[] | null;
  classRoles: UserRole[] | null;
  /** handler ?? class ?? false（与 JwtAuthGuard 的 getAllAndOverride 同序）。 */
  isPublic: boolean;
  writeGuard: WriteGuardMetadata | undefined;
  /** handler + class 的 @UseGuards 类名并集。 */
  guards: string[];
}

type RouteShape =
  | "role-gated"
  | "declared-token"
  | "declared-public"
  | "declared-owner"
  | "delegated"
  | "open-registered"
  | "jwt"
  /** @Public() 且无声明、无补偿守卫、未登记 —— 缺陷形态。 */
  | "undeclared-open";

interface ClassifiedRoute extends RouteRow {
  shape: RouteShape;
  /** 补偿守卫类名（仅 delegated 有值）。 */
  compensating: string[];
}

// —— 发现与枚举 ————————————————————————————————————————

function collectControllerFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      collectControllerFiles(full, out);
    } else if (entry.name.endsWith(".controller.ts")) {
      out.push(full);
    }
  }
  return out;
}

/** 从模块导出里挑出带 @Controller() 元数据的类（PATH_METADATA 存在即控制器）。 */
function loadControllers(): Array<{
  name: string;
  ctor: ControllerCtor;
  file: string;
}> {
  const found: Array<{ name: string; ctor: ControllerCtor; file: string }> = [];
  for (const file of collectControllerFiles(SRC_ROOT)) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require(file) as Record<string, unknown>;
    for (const key of Object.keys(mod)) {
      const candidate = mod[key];
      if (typeof candidate !== "function") continue;
      if (Reflect.getMetadata(PATH_METADATA, candidate) === undefined) continue;
      found.push({ name: key, ctor: candidate as ControllerCtor, file });
    }
  }
  return found;
}

function guardNames(ctor: object | undefined): string[] {
  if (!ctor) return [];
  const list = Reflect.getMetadata(GUARDS_METADATA, ctor) as
    Array<{ name?: string }> | undefined;
  if (!Array.isArray(list)) return [];
  return list.map((g) =>
    typeof g === "function" ? g.name : String(g?.name ?? g),
  );
}

const asPath = (p: unknown): string =>
  Array.isArray(p)
    ? p.map(asPath).join("|")
    : p === undefined || p === null
      ? ""
      : String(p);

function collectRoutes(
  controllers: Array<{ name: string; ctor: ControllerCtor; file: string }>,
): RouteRow[] {
  const out: RouteRow[] = [];
  for (const { name, ctor, file } of controllers) {
    const proto = (ctor as { prototype: Record<string, unknown> }).prototype;
    const ctrlPath = asPath(Reflect.getMetadata(PATH_METADATA, ctor));
    const classRoles =
      (Reflect.getMetadata(ROLES_KEY, ctor) as UserRole[] | undefined) ?? null;
    const classPublic =
      (Reflect.getMetadata(IS_PUBLIC_KEY, ctor) as boolean | undefined) ??
      false;
    const classGuards = guardNames(ctor);

    for (const prop of Object.getOwnPropertyNames(proto)) {
      if (prop === "constructor") continue;
      // 只取「数据属性且值为函数」：原型上的 getter 会在读取时求值并抛错，
      // 且 HTTP 方法装饰器只会落在数据属性上。
      const desc = Object.getOwnPropertyDescriptor(proto, prop);
      if (!desc || typeof desc.value !== "function") continue;
      const handler = desc.value as object;

      const method = Reflect.getMetadata(METHOD_METADATA, handler) as
        RequestMethod | undefined;
      if (method === undefined) continue;

      out.push({
        id: name + "." + prop,
        controller: name,
        file: path.basename(file),
        controllerPath: ctrlPath,
        method: METHOD_NAME[method] ?? String(method),
        property: prop,
        handlerPath: asPath(Reflect.getMetadata(PATH_METADATA, handler)),
        roles:
          (Reflect.getMetadata(ROLES_KEY, handler) as UserRole[] | undefined) ??
          null,
        classRoles,
        isPublic:
          (Reflect.getMetadata(IS_PUBLIC_KEY, handler) as
            boolean | undefined) ?? classPublic,
        writeGuard: Reflect.getMetadata(WRITE_GUARD_KEY, handler) as
          WriteGuardMetadata | undefined,
        // handler 与 class 的 @UseGuards 取并集：宁可多看一个补偿守卫也不漏。
        guards: [...new Set([...classGuards, ...guardNames(handler)])],
      });
    }
  }
  return out;
}

// —— 分类与判定 ————————————————————————————————————————

function classify(
  route: RouteRow,
  registry: Readonly<Record<string, string>> = OPEN_ROUTE_REGISTRY,
): ClassifiedRoute {
  const roles = route.roles ?? route.classRoles;
  const compensating = route.guards.filter((g) => !GLOBAL_GUARD_NAMES.has(g));
  const base = { ...route, compensating };

  if (route.writeGuard) {
    const scope = route.writeGuard.scope;
    return {
      ...base,
      shape:
        scope === "token"
          ? "declared-token"
          : scope === "public"
            ? "declared-public"
            : "declared-owner",
    };
  }
  if (!route.isPublic) {
    return {
      ...base,
      shape: roles && roles.length > 0 ? "role-gated" : "jwt",
    };
  }
  if (compensating.length > 0) return { ...base, shape: "delegated" };
  if (registry[route.id] !== undefined) {
    return { ...base, shape: "open-registered" };
  }
  return { ...base, shape: "undeclared-open" };
}

interface Violation {
  id: string;
  kind: string;
  detail: string;
}

function audit(
  routes: RouteRow[],
  registry: Readonly<Record<string, string>> = OPEN_ROUTE_REGISTRY,
): { classified: ClassifiedRoute[]; violations: Violation[] } {
  const classified = routes.map((r) => classify(r, registry));
  const violations: Violation[] = [];
  const seen = new Set<string>();

  for (const r of classified) {
    if (seen.has(r.id)) {
      violations.push({
        id: r.id,
        kind: "duplicate-route-id",
        detail: "同一 handler 被枚举两次（发现逻辑有重复登记）",
      });
    }
    seen.add(r.id);

    const roles = r.roles ?? r.classRoles;

    // (1) @Public() 与 @Roles(非空) 共存：JwtAuthGuard 先跳过，@Roles 形同虚设。
    //     这是「看起来很安全、实际全公开」的最隐蔽形态。
    if (r.isPublic && roles && roles.length > 0) {
      violations.push({
        id: r.id,
        kind: "public-overrides-roles",
        detail:
          "@Public() 让 JwtAuthGuard 短路，@Roles(" +
          roles.join(",") +
          ") 永不生效",
      });
    }

    // (2) @WriteGuard 与 @Roles 不共存（角色门控直接写 @Roles 即可）。
    if (r.writeGuard && roles && roles.length > 0) {
      violations.push({
        id: r.id,
        kind: "declaration-conflict",
        detail: "同时有 @Roles 与 @WriteGuard",
      });
    }

    // (3) scope 与 @Public() 自洽（读面同样适用）。
    if (r.writeGuard) {
      const g = r.writeGuard;
      if (!VALID_SCOPES.has(g.scope)) {
        violations.push({
          id: r.id,
          kind: "invalid-scope",
          detail: "scope=" + String(g.scope) + " 不在受控取值内",
        });
      }
      if ((g.scope === "token" || g.scope === "public") && !r.isPublic) {
        violations.push({
          id: r.id,
          kind: "scope-public-mismatch",
          detail:
            "scope=" +
            g.scope +
            " 必须同时 @Public()（否则 JWT 守卫挡住机器面）",
        });
      }
      if (g.scope !== "token" && g.scope !== "public" && r.isPublic) {
        violations.push({
          id: r.id,
          kind: "scope-public-mismatch",
          detail: "scope=" + g.scope + " 不得是 @Public()",
        });
      }
      if (
        (g.scope === "token" ||
          g.scope === "public" ||
          g.scope === "project-role") &&
        !g.reason?.trim()
      ) {
        violations.push({
          id: r.id,
          kind: "missing-reason",
          detail: "scope=" + g.scope + " 必须给出 reason",
        });
      }
    }

    // (4) 兜底：@Public() 且既无声明、无补偿守卫、又未登记 = 缺陷。
    if (r.shape === "undeclared-open") {
      violations.push({
        id: r.id,
        kind: "undeclared-open",
        detail:
          r.method +
          " /" +
          r.controllerPath +
          "/" +
          r.handlerPath +
          " 绕过了全局 JwtAuthGuard，且既无 @WriteGuard 声明、无补偿守卫、也未登记在 OPEN_ROUTE_REGISTRY",
      });
    }

    // (5) 补偿守卫必须在白名单里（否则挂个空守卫即可洗白「公开」）。
    //     只对 delegated 形态强制：已用 @WriteGuard 显式声明的路由上额外再挂
    //     一个专用守卫（如 pushResult 的 ExecutorSharedTokenGuard）属于纵深，
    //     不承担「顶替全局 JWT 守卫」的举证责任。
    for (const g of r.shape === "delegated" ? r.compensating : []) {
      if (COMPENSATING_GUARDS[g] === undefined) {
        violations.push({
          id: r.id,
          kind: "unregistered-compensating-guard",
          detail:
            "@UseGuards(" +
            g +
            ") 不在 COMPENSATING_GUARDS 白名单——请说明它做了什么鉴权",
        });
      }
    }

    // (6) 空 @Roles() 覆写 class 级 ADMIN：角色校验被静默关掉，必须显式登记。
    if (
      r.roles &&
      r.roles.length === 0 &&
      r.classRoles &&
      r.classRoles.length > 0
    ) {
      violations.push({
        id: r.id,
        kind: "empty-roles-override",
        detail:
          "class 级 @Roles(" +
          r.classRoles.join(",") +
          ") 被 handler 级 @Roles() 静默关掉（须登记并说明替代鉴权）",
      });
    }
  }

  // (7) 登记表不得过期：登记的 id 必须仍然存在、且仍然真的是「无替代鉴权的公开面」。
  //     只增不减的登记表会随时间变成一张假清单。
  const byId = new Map(classified.map((r) => [r.id, r]));
  const openIds = new Set(
    classified.filter((r) => r.shape === "open-registered").map((r) => r.id),
  );
  for (const id of Object.keys(registry)) {
    const route = byId.get(id);
    if (!route) {
      violations.push({
        id,
        kind: "stale-registry-entry",
        detail: "OPEN_ROUTE_REGISTRY 里的路由已不存在（改名/删除后未同步）",
      });
    } else if (!openIds.has(id)) {
      violations.push({
        id,
        kind: "stale-registry-entry",
        detail:
          "已不再是「无替代鉴权的公开面」（现在的形态=" +
          classify(route, registry).shape +
          "）——请从 OPEN_ROUTE_REGISTRY 移除，避免登记表变成假清单",
      });
    }
  }

  return { classified, violations };
}

// —— 断言的公共件 ——————————————————————————————————————

const CONTROLLER_FILES = collectControllerFiles(SRC_ROOT);
const CONTROLLERS = loadControllers();
const ROUTES = collectRoutes(CONTROLLERS);
const MATRIX = audit(ROUTES);
const classified = MATRIX.classified;
const violations = MATRIX.violations;

const kindOf = (k: string): Violation[] =>
  violations.filter((v) => v.kind === k);
const shapeOf = (s: RouteShape): ClassifiedRoute[] =>
  classified.filter((r) => r.shape === s);

/** 空 @Roles() 覆写 class 级 ADMIN 的显式登记（替代鉴权说明）。 */
const EMPTY_ROLES_OPT_OUT: Readonly<Record<string, string>> = {
  "ExecutorPackageController.pushResult":
    "机器回调面：@Public + @WriteGuard(scope:'token')，执行器共享令牌校验，无 req.user",
  "ExecutorPackageController.download":
    "下载面：handler 内手搓双凭据（执行器令牌 / access JWT），无 req.user",
};

describe("R203-A1 全路由鉴权矩阵（route-authz-matrix）", () => {
  it("规模下界：控制器 30 个、路由 >=220 条、各方法桶齐全（扫描器失效即红）", () => {
    // 扫描器一旦因为路径写错 / 元数据键改名而「扫不到东西」，下面所有
    // toEqual([]) 都会变成永真断言。先把扫描面钉住。
    expect(CONTROLLER_FILES.length).toBeGreaterThanOrEqual(30);
    expect(CONTROLLERS.length).toBeGreaterThanOrEqual(30);
    expect(ROUTES.length).toBeGreaterThanOrEqual(220);

    const bucket = (m: string) => ROUTES.filter((r) => r.method === m).length;
    expect(bucket("GET")).toBeGreaterThanOrEqual(95);
    expect(bucket("POST")).toBeGreaterThanOrEqual(90);
    expect(bucket("PATCH")).toBeGreaterThanOrEqual(10);
    expect(bucket("DELETE")).toBeGreaterThanOrEqual(14);
    expect(bucket("PUT")).toBeGreaterThanOrEqual(4);

    // 发现逻辑自洽：每个 *.controller.ts 至少贡献一个 @Controller 类。
    expect(CONTROLLERS.length).toBe(CONTROLLER_FILES.length);
  });

  it("分类完备：每条路由都落进一个具名鉴权形态，且形态计数守恒", () => {
    const shapes: RouteShape[] = [
      "role-gated",
      "declared-token",
      "declared-public",
      "declared-owner",
      "delegated",
      "open-registered",
      "jwt",
      "undeclared-open",
    ];
    const total = shapes.reduce((n, s) => n + shapeOf(s).length, 0);
    expect(total).toBe(ROUTES.length);

    // 形态分布下界：防止「所有路由都被算成 jwt」这种退化分类。
    // 实测基线（R203-A1，229 条）：role-gated 91 / declared-token 22 /
    // declared-public 6 / declared-owner 43 / delegated 6 / open-registered 9 /
    // jwt 52。下界取基线附近，任何形态被整体误分类都会红。
    expect(shapeOf("jwt").length).toBeGreaterThanOrEqual(50);
    expect(shapeOf("role-gated").length).toBeGreaterThanOrEqual(88);
    expect(shapeOf("declared-token").length).toBeGreaterThanOrEqual(20);
    expect(shapeOf("declared-owner").length).toBeGreaterThanOrEqual(40);
    expect(shapeOf("delegated").length).toBeGreaterThanOrEqual(6);
  });

  it("矩阵无违规（@Public 未登记 / 矛盾声明 / 过期登记项）", () => {
    // empty-roles-override 单独在下一个用例里对账（它有一张显式登记表），
    // 这里只断言它之外再无违规。
    const remaining = violations.filter(
      (v) => v.kind !== "empty-roles-override",
    );
    expect(
      remaining.map((v) => v.kind + ": " + v.id + " — " + v.detail),
    ).toEqual([]);
  });

  it("免鉴权读面收敛在可审计的窄清单上（条数钉死，新增必须显式复核）", () => {
    // 关键回归位：任何「新开一个 @Public 读端点」的改动都会让本断言红。
    expect(Object.keys(OPEN_ROUTE_REGISTRY).sort()).toEqual(
      [
        "ExecutorController.getExecutorArtifact",
        "ExecutorController.getInstallScript",
        "ExecutorPackageController.download",
        "HealthController.health",
        "HealthController.live",
        "HealthController.ready",
        "OidcController.callback",
        "OidcController.login",
        "OidcController.status",
      ].sort(),
    );
    // 登记表每条都要有非空理由（空字符串等于没写）。
    for (const [id, reason] of Object.entries(OPEN_ROUTE_REGISTRY)) {
      expect(reason.trim().length).toBeGreaterThan(12);
      expect(id.split(".").length).toBe(2);
    }
    expect(kindOf("undeclared-open")).toEqual([]);
  });

  it("补偿守卫白名单：@Public + 自定义守卫 必须登记该守卫做了什么", () => {
    expect(Object.keys(COMPENSATING_GUARDS).sort()).toEqual([
      "MetricsScraperAuthGuard",
    ]);
    // 白名单里的守卫必须真的还在被某个控制器使用（防止白名单腐化成死登记）。
    const used = new Set(classified.flatMap((r) => r.compensating));
    for (const name of Object.keys(COMPENSATING_GUARDS)) {
      expect(used.has(name)).toBe(true);
    }
    expect(kindOf("unregistered-compensating-guard")).toEqual([]);
  });

  it("空 @Roles() 覆写 class 级 ADMIN 的清单钉死（每处都给替代鉴权理由）", () => {
    const optOuts = classified
      .filter(
        (r) =>
          r.roles &&
          r.roles.length === 0 &&
          r.classRoles &&
          r.classRoles.length > 0,
      )
      .map((r) => r.id)
      .sort();
    expect(optOuts).toEqual(Object.keys(EMPTY_ROLES_OPT_OUT).sort());
    for (const reason of Object.values(EMPTY_ROLES_OPT_OUT)) {
      expect(reason.trim().length).toBeGreaterThan(12);
    }
    // 这些必然被 audit() 报出来（否则就是形态根本没被识别），登记表即其
    // 显式豁免清单——两边必须一一对应。
    expect(
      kindOf("empty-roles-override")
        .map((v) => v.id)
        .sort(),
    ).toEqual(Object.keys(EMPTY_ROLES_OPT_OUT).sort());
  });

  it("机器面（token 声明）路由清单钉死——读面与写面同权对待", () => {
    // write-guard-coverage 只扫写方法，故 GET /executors/config 这类
    // 「机器面读」此前无人核对。这里把 token 面整体钉住（读写一把抓）。
    const tokenRoutes = classified.filter(
      (r) => r.writeGuard?.scope === "token",
    );
    expect(tokenRoutes.length).toBeGreaterThanOrEqual(22);
    const tokenIds = tokenRoutes.map((r) => r.id).sort();
    // 必须包含两条「读面机器凭据」——它们是本 spec 存在的直接理由。
    expect(tokenIds).toEqual(
      expect.arrayContaining([
        "ExecutorController.pullExecutorConfig",
        "ExecutorController.getTerminalStates",
      ]),
    );
    // 反向：机器面端点必须是 @Public（JWT 守卫得让路）且不得带 @Roles。
    for (const r of tokenRoutes) {
      expect(r.isPublic).toBe(true);
      expect((r.roles ?? []).length).toBe(0);
    }
  });

  it("管理面读路由不得出现在免鉴权面上（公开即泄露的机械拦截）", () => {
    // 这些前缀下的任何路由，只要绕过全局 JwtAuthGuard 就必须是「已声明」的。
    const ADMIN_PREFIXES = [
      "users",
      "config",
      "audit",
      "api-keys",
      "notification",
      "sop",
      "agent",
      "event-subscriptions",
      "mutex-groups",
      "executor-packages",
    ];
    const offenders = classified
      .filter((r) => ADMIN_PREFIXES.includes(r.controllerPath))
      .filter((r) => r.isPublic)
      .filter(
        (r) => r.shape !== "declared-token" && r.shape !== "declared-public",
      )
      // 唯一豁免：执行器包下载（handler 内双凭据校验，已在 OPEN_ROUTE_REGISTRY
      // 登记理由，见该表）。
      .filter(
        (r) =>
          !(
            r.controllerPath === "executor-packages" &&
            r.id === "ExecutorPackageController.download"
          ),
      )
      .map((r) => r.id + " (" + r.shape + ")");
    expect(offenders).toEqual([]);
  });

  it("写方法一律不得落在「未声明」形态（读面 spec 也守写面这条底线）", () => {
    const undeclared = classified
      .filter((r) => WRITE_METHODS.has(r.method))
      .filter((r) => r.shape === "undeclared-open")
      .map((r) => r.id + " [" + r.method + "]");
    expect(undeclared).toEqual([]);
  });

  it("自检：检测器对 4 类缺陷形态能红、对合规形态不误报（防「永真断言」）", () => {
    // 一个守卫最怕的不是漏报，而是**根本没有红的能力**。这里用合成路由
    // 把 4 类缺陷形态各喂一遍，断言 audit() 真的报出来；再喂两条合规路由，
    // 断言不误报。
    const base: RouteRow = {
      id: "SyntheticController.probe",
      controller: "SyntheticController",
      file: "synthetic.controller.ts",
      controllerPath: "synthetic",
      method: "GET",
      property: "probe",
      handlerPath: ":id",
      roles: null,
      classRoles: null,
      isPublic: false,
      writeGuard: undefined,
      guards: [],
    };

    const badOpen = audit([{ ...base, isPublic: true }], {});
    expect(badOpen.violations.map((v) => v.kind)).toContain("undeclared-open");

    const badContradiction = audit(
      [{ ...base, isPublic: true, roles: [UserRole.ADMIN] }],
      {},
    );
    expect(badContradiction.violations.map((v) => v.kind)).toContain(
      "public-overrides-roles",
    );

    const badGuard = audit(
      [{ ...base, isPublic: true, guards: ["LooksLikeAGuardButIsNot"] }],
      {},
    );
    expect(badGuard.violations.map((v) => v.kind)).toContain(
      "unregistered-compensating-guard",
    );

    const badEmptyRoles = audit(
      [{ ...base, roles: [], classRoles: [UserRole.ADMIN] }],
      {},
    );
    expect(badEmptyRoles.violations.map((v) => v.kind)).toContain(
      "empty-roles-override",
    );

    // 合规形态：已声明的机器面读端点（token + @Public + reason）不应报错。
    const goodMachine = audit(
      [
        {
          ...base,
          id: "SyntheticController.machine",
          isPublic: true,
          writeGuard: {
            resource: "synthetic",
            scope: "token",
            reason: "机器凭据",
          },
        },
      ],
      {},
    );
    expect(goodMachine.violations).toEqual([]);
    expect(goodMachine.classified[0].shape).toBe("declared-token");

    // 合规形态：@Roles(ADMIN) 的读路由。
    const goodAdmin = audit([{ ...base, roles: [UserRole.ADMIN] }], {});
    expect(goodAdmin.violations).toEqual([]);
    expect(goodAdmin.classified[0].shape).toBe("role-gated");

    // 打印标记：scripts/check-route-authz-matrix.mjs --selftest 据此确认
    // 「jest -> spec -> 检测器 -> 能红」这条链路真的跑通了（不是只看退出码）。
    const dist: Record<string, number> = {};
    for (const s of [
      "role-gated",
      "declared-token",
      "declared-public",
      "declared-owner",
      "delegated",
      "open-registered",
      "jwt",
    ]) {
      dist[s] = shapeOf(s as RouteShape).length;
    }
    console.log(
      "ROUTE_AUTHZ_SELFTEST_OK routes=" +
        ROUTES.length +
        " controllers=" +
        CONTROLLERS.length +
        " shapes=" +
        JSON.stringify(dist),
    );
  });
});
