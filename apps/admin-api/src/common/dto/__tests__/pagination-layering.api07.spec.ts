/**
 * API-07（本轮体验审查）：`GET /users` 契约上公示了它**不消费**的过滤参数。
 *
 * 根因不在 users 端点本身，而在分层：`PaginationDto` 历史上把三个**任务专用**
 * 过滤字段（`name` / `status` / `runtime`）混进了"分页"这个通用概念，于是它们
 * 被 6 个 DTO 继承、出现在**所有**分页端点的 OpenAPI 参数表上——包括根本不读
 * 它们的端点。最典型的是 `GET /users`：契约写着
 *   `name` —— "Fuzzy search by task name"
 * 而 `usersService.findAll` 只取 page/pageSize，**完全忽略 name**。
 *
 * 危害不是"多几个无用参数"：`?name=alice` 会**静默返回未过滤的全量用户列表**
 * 且 HTTP 200。调用方（acf-cli / mcp-server / 手工调 API 的运维）无法分辨
 * "没有匹配"与"过滤没生效"，会据此得出错误结论；整个响应没有任何信号说明参数
 * 被忽略了。这类"契约承诺了、实现没做"的缺陷不会让任何测试变红。
 *
 * 修法：分页与业务过滤分层——`PageQueryDto`（只有 page/pageSize）作纯分页基类，
 * `PaginationDto` 继承它并保留任务过滤字段（既有 6 个 DTO 行为不变）；不消费
 * 这些过滤器的端点（users / config-history）改继承 `PageQueryDto`。
 * 这是**纯契约收窄**：被移除的字段本来就被忽略，删掉不改变任何运行时行为。
 *
 * 反证：把 users 的 `PageQueryDto` 改回 `PaginationDto`（或把三个字段加回纯分页
 * 基类），本文件立即变红。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PageQueryDto, PaginationDto } from "../pagination.dto";

// 注：本仓 admin-api 跑 Jest，`expect(x, message)` 是 vitest 专有形态——
// Jest 的 expect 只接受一个参数，故断言消息一律走注释表达。
// __dirname = apps/admin-api/src/common/dto/__tests__ → 上溯 6 级到仓库根。
const ROOT = join(__dirname, "..", "..", "..", "..", "..", "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf-8");
const PAGINATION_DTO = "apps/admin-api/src/common/dto/pagination.dto.ts";

/**
 * 取某个类**在源码里声明过**的属性名。
 *
 * 不能用 `Object.keys(new Cls())`：`@IsOptional()` 字段在实例上值是 undefined，
 * 而 TS 的 `name?: string` 不产生自有属性——那样三个过滤字段都会被漏掉，断言
 * 退化成空洞通过（"基类没有 name" 会永远为真）。读声明才是有效判据。
 */
function declaredProps(relPath: string, className: string): string[] {
  const src = read(relPath);
  const start = src.indexOf(`class ${className} `);
  if (start === -1) throw new Error(`找不到 class ${className}`);
  const open = src.indexOf("{", start);
  let depth = 0;
  let end = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const body = src.slice(open, end);
  return [...body.matchAll(/^\s{2}(\w+)\??\s*[:=]/gm)].map((m) => m[1]);
}

describe("API-07 契约分层：纯分页基类不得携带业务过滤字段", () => {
  it("PageQueryDto 只有 page / pageSize", () => {
    expect(declaredProps(PAGINATION_DTO, "PageQueryDto").sort()).toEqual([
      "page",
      "pageSize",
    ]);
  });

  it("PaginationDto 仍保留任务过滤字段（既有 6 个 DTO 行为不变）", () => {
    const props = declaredProps(PAGINATION_DTO, "PaginationDto");
    for (const f of ["name", "status", "runtime"]) {
      expect(props).toContain(f);
    }
  });

  it("PaginationDto 继承自 PageQueryDto（分层而非复制）", () => {
    expect(new PaginationDto()).toBeInstanceOf(PageQueryDto);
    // 继承关系必须写在源码里（运行时 instanceof 也可能来自复制粘贴的同名字段）
    expect(read(PAGINATION_DTO)).toMatch(
      /class PaginationDto extends PageQueryDto/,
    );
  });

  it("任务过滤字段只在子类上声明一次（不是两边各写一份）", () => {
    // 若基类也有 name/status/runtime，说明分层被回退成"复制粘贴"，
    // 那种写法会让"纯分页基类"重新变得不纯，契约又会重新长出幽灵参数。
    const base = declaredProps(PAGINATION_DTO, "PageQueryDto");
    for (const f of ["name", "status", "runtime"]) {
      expect(base).not.toContain(f);
    }
  });
});

describe("API-07 受影响端点：契约参数表与实际消费的过滤器一致", () => {
  it("GET /users 的参数表不再含 name / status / runtime", () => {
    const openapi = JSON.parse(read("apps/admin-api/openapi.json")) as {
      paths: Record<string, { get?: { parameters?: { name: string }[] } }>;
    };
    const names = (openapi.paths["/users"]?.get?.parameters ?? []).map(
      (p) => p.name,
    );
    expect(names.length).toBeGreaterThanOrEqual(2); // 有齿：参数表不能被清空
    for (const ghost of ["name", "status", "runtime"]) {
      expect(names).not.toContain(ghost);
    }
    expect(names).toContain("page");
    expect(names).toContain("pageSize");
  });

  it("GET /config/history 只公示它真正消费的 key 过滤", () => {
    const openapi = JSON.parse(read("apps/admin-api/openapi.json")) as {
      paths: Record<string, { get?: { parameters?: { name: string }[] } }>;
    };
    const names = (openapi.paths["/config/history"]?.get?.parameters ?? []).map(
      (p) => p.name,
    );
    expect(names).toContain("key");
    for (const ghost of ["name", "status", "runtime"]) {
      expect(names).not.toContain(ghost);
    }
  });

  it("仍在消费任务过滤的端点**保留**了它们（没有一刀切砍掉）", () => {
    // 反向守卫：本修复只应"删掉不生效的"，不应把真正在用的也删了。
    const openapi = JSON.parse(read("apps/admin-api/openapi.json")) as {
      paths: Record<string, { get?: { parameters?: { name: string }[] } }>;
    };
    const taskNames = (openapi.paths["/tasks"]?.get?.parameters ?? []).map(
      (p) => p.name,
    );
    expect(taskNames).toContain("name");
    expect(taskNames).toContain("status");
  });
});

describe("API-07 源码层：users 端点与服务签名都已收窄", () => {
  it("users.controller 的 findAll 收 PageQueryDto", () => {
    const src = read("apps/admin-api/src/modules/users/users.controller.ts");
    expect(src).toMatch(/findAll\(@Query\(\)\s*pagination:\s*PageQueryDto\)/);
    // 且不再 import PaginationDto（那是"改了一半"的典型形态）
    expect(src).not.toMatch(/import\s*\{\s*PaginationDto\s*\}/);
  });

  it("users.service 的 findAll 签名同步收窄", () => {
    const src = read("apps/admin-api/src/modules/users/users.service.ts");
    expect(src).toMatch(/async findAll\(pagination:\s*PageQueryDto\)/);
    expect(src).not.toMatch(/import\s*\{[^}]*\bPaginationDto\b[^}]*\}/);
  });

  it("config-history DTO 收 PageQueryDto", () => {
    const src = read(
      "apps/admin-api/src/modules/config/dto/config-history-query.dto.ts",
    );
    expect(src).toMatch(/class ConfigHistoryQueryDto extends PageQueryDto/);
  });
});
