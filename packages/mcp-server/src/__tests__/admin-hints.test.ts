import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * SDK-DX-08（2026-10-29 SDK/DX 审计）：**ADMIN-only 工具的 description 必须
 * 带 `ADMIN only.` 前缀**——这是非管理员 agent 唯一能提前看到权限要求的地方
 * （MCP 规范没有 permission 字段，description 前缀 + 守卫是当下唯一可靠做法）。
 *
 * 由来：2026-10-08 的 MCP 审计给 6 个 SOP/agent 工具补了前缀，随后新增的
 * MUTEX-01 三工具与 `update_application`（同样 ADMIN-only）没跟上——`tools.ts`
 * 里描述一个字都没提权限，VIEWER/OPERATOR 的 agent 只有撞到 403 才知道，
 * 于是会重试、换参数、误判「工具坏了」，甚至改走另一个同样 ADMIN-only 的
 * `update_application` 再撞一次 403。
 *
 * 判据（**以控制器为事实源**，不维护手抄名单）：
 *   1. 从 `tools.ts` 抽每个工具的 `call("METHOD", "/path")` 与 description；
 *   2. 从 `apps/admin-api/src/**` 的 `*.controller.ts` 抽 `@Controller("x")` +
 *      方法级 `@Get/@Post/@Put/@Patch/@Delete` + 其 `@Roles(...)`；
 *   3. 路由按 `:param` 归一后 join；命中「roles 恰好 = {ADMIN}」而 description
 *      不含 `ADMIN only` → 失败（报 tools.ts 的行号与工具名）。
 * 解析不到的（路径对不上 / 动态拼装）一律跳过——本判据宁可漏，不可误报。
 *
 * 反证：把 `create_mutex_group` 的描述前缀删掉，本用例必须红。
 */

const HERE = dirname(fileURLToPath(import.meta.url));
// packages/mcp-server/src/__tests__ → 仓库根是四级向上
const REPO_ROOT = resolve(HERE, "..", "..", "..", "..");
const TOOLS_TS = join(REPO_ROOT, "packages/mcp-server/src/tools.ts");
const ADMIN_API_SRC = join(REPO_ROOT, "apps/admin-api/src");

/** 抽工具：{ name, description, line, method, path }。 */
export function parseTools(text: string) {
  const lines = text.split(/\r?\n/);
  const tools: Array<{
    name: string;
    description: string;
    line: number;
    method?: string;
    path?: string;
  }> = [];

  const starts: number[] = [];
  lines.forEach((l, i) => {
    if (l.includes("server.tool(")) starts.push(i);
  });

  starts.forEach((start, idx) => {
    const end = idx + 1 < starts.length ? starts[idx + 1] : lines.length;
    const block = lines.slice(start, end).join("\n");
    const nameMatch = /server\.tool\(\s*\n?\s*["']([a-z0-9_]+)["']/.exec(block);
    if (!nameMatch) return;
    // description：工具名之后再出现的前若干个字符串字面量（可能用 + 跨行拼接）
    const afterName = block.slice(block.indexOf(nameMatch[0]) + nameMatch[0].length);
    const literals = [
      ...afterName.matchAll(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g),
    ]
      .slice(0, 8)
      .map((m) => m[1] ?? m[2] ?? "");
    const description = literals.join(" ");
    // 路由：call<...>("METHOD", "/path" | `/path/${x}`)
    const route = /call<[^>]*>\(\s*["']([A-Z]+)["']\s*,\s*[`"']([^`"']+)[`"']/.exec(block);
    tools.push({
      name: nameMatch[1],
      description,
      line: start + 1,
      method: route?.[1],
      path: route?.[2],
    });
  });
  return tools;
}

/** 把 `/mutex-groups/${groupId}` 这类模板归一成 `/mutex-groups/:p`。 */
export function normalizeRoutePath(raw: string): string {
  return raw
    .replace(/\$\{[^}]*\}/g, ":p")
    .replace(/:[A-Za-z_][\w]*/g, ":p")
    .replace(/\/+$/, "")
    .replace(/\/:p/g, "/:p")
    .toLowerCase();
}

/**
 * 把文本切成**装饰器 span**（`@Name` + 可选的平衡括号参数列表），并记录每个
 * span 的起止位置。用平衡扫描而不是逐行正则，是因为：
 * - 装饰器参数可跨多行（`@ApiOperation({\n …\n})`）；
 * - 不能按行判「以 @ 开头」，否则多行装饰器的续行会被当成代码。
 */
function decoratorSpans(text: string) {
  const spans: Array<{ start: number; end: number; name: string; text: string }> = [];
  let i = 0;
  let depth = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "(" || ch === "{" || ch === "[") {
      depth++;
      i++;
      continue;
    }
    if (ch === ")" || ch === "}" || ch === "]") {
      depth--;
      i++;
      continue;
    }
    // 只把**行首（允许缩进）**的 `@` 当装饰器起点：import 语句里的
    // `from "@nestjs/common"` 也是深度 0 的 `@`，若一并当成装饰器，会把
    // import 段与后面的真实装饰器栈粘成一组、把角色归属打乱。
    if (
      depth === 0 &&
      ch === "@" &&
      /(^|\n)[ \t]*$/.test(text.slice(Math.max(0, i - 200), i))
    ) {
      const start = i;
      const m = /^@([A-Za-z_$][\w$.]*)/.exec(text.slice(i));
      if (!m) {
        i++;
        continue;
      }
      i += m[0].length;
      let j = i;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === "(") {
        let d = 0;
        for (; j < text.length; j++) {
          if (text[j] === "(") d++;
          else if (text[j] === ")") {
            d--;
            if (d === 0) {
              j++;
              break;
            }
          }
        }
        i = j;
      }
      spans.push({ start, end: i, name: m[1], text: text.slice(start, i) });
      continue;
    }
    i++;
  }
  return spans;
}

/** 连续（中间只有空白）的装饰器 span 归为同一个成员的装饰器栈。 */
function decoratorGroups(text: string, spans: ReturnType<typeof decoratorSpans>) {
  const groups: Array<ReturnType<typeof decoratorSpans>> = [];
  let cur: ReturnType<typeof decoratorSpans> = [];
  for (const span of spans) {
    const prev = cur[cur.length - 1];
    if (prev && text.slice(prev.end, span.start).trim() !== "") {
      groups.push(cur);
      cur = [];
    }
    cur.push(span);
  }
  if (cur.length) groups.push(cur);
  return groups;
}

/**
 * 取每个 `export class` 的**类体**（不含 class 的那对花括号）。
 *
 * 为什么必须切类体：装饰器扫描用括号深度判「顶层」。类的 `{` 一旦算进深度，
 * 类体内所有装饰器都处于 depth≥1，会被整体跳过——第一版就是这样解析出 0 条
 * 路由（只在 import 段找到 4 个 span）。切出类体后深度从 0 重新起算。
 */
function classBodies(text: string) {
  const bodies: Array<{ start: number; body: string }> = [];
  const classRe = /^export class /gm;
  let m: RegExpExecArray | null;
  while ((m = classRe.exec(text))) {
    const openBrace = text.indexOf("{", m.index);
    if (openBrace < 0) continue;
    let depth = 0;
    let end = -1;
    for (let i = openBrace; i < text.length; i++) {
      const c = text[i];
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end < 0) continue;
    bodies.push({ start: openBrace + 1, body: text.slice(openBrace + 1, end) });
  }
  return bodies;
}

/**
 * 抽控制器：{ base, routes: [{ method, path, roles }] }[]。
 *
 * **三个必须踩过的坑**（本用例的第一版全踩了，全部记在这里防止下次重写）：
 * 1. 先剥注释——控制器源码的大段注释会**引用**装饰器原文（`见上方
 *    @Get(":id") 在 603 行`、正文解释「这里为什么没有 @Roles(ADMIN)」），
 *    不剥就会把注释里的引用当成真装饰器，误报 8 个只读工具；
 * 2. 装饰器必须是**行首** `@`——import 段的 `from "@nestjs/common"` 也是
 *    depth 0 的 `@`，会被当成装饰器，把 import 与真实装饰器栈粘成一组；
 * 3. 必须在**类体**里扫描（见 classBodies）——否则类的 `{` 让深度恒 ≥1，
 *    一条路由都找不到。
 *
 * 另外 `@Roles` 未必写在路由装饰器**之后**：本仓既有写法是
 * `@UseGuards(RolesGuard)` / `@Roles(UserRole.ADMIN)` / `@Post(":id/members")`
 * （刻意前置）。所以角色按**成员的装饰器栈**取（同一栈内的 @Roles 属于该成员），
 * 与书写顺序无关。
 */
export function parseControllers(rawText: string) {
  const text = rawText
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  const controllers: Array<{
    base: string;
    routes: Array<{ method: string; path: string; roles: string[] }>;
  }> = [];

  // 每个类：先找它前面最近的 @Controller（在类头区域）
  const bodies = classBodies(text);
  const classStarts = [...text.matchAll(/^export class /gm)].map((m) => m.index!);
  bodies.forEach((b, idx) => {
    const headerStart = idx === 0 ? 0 : classStarts[idx - 1];
    const header = text.slice(headerStart, b.start);
    // 取最后一个 @Controller（类头可能很长）
    const ctrlSpans = decoratorSpans(header).filter((sp) => sp.name === "Controller");
    const ctrl = ctrlSpans[ctrlSpans.length - 1];
    if (!ctrl) return;
    const cmd = /^@Controller\(\s*["'`]?([^"'`)]*)["'`]?\s*\)/.exec(ctrl.text);
    const base = normalizeRoutePath("/" + (cmd?.[1] ?? "").replace(/^\/+/, ""));
    const routes: Array<{ method: string; path: string; roles: string[] }> = [];
    for (const group of decoratorGroups(b.body, decoratorSpans(b.body))) {
      const routeSpan = group.find((g) => /^(Get|Post|Put|Patch|Delete)$/.test(g.name));
      if (!routeSpan) continue;
      const params =
        /^@(?:Get|Post|Put|Patch|Delete)\(\s*["'`]?([^"'`)]*)["'`]?\s*\)/.exec(
          routeSpan.text,
        );
      const rolesSpan = group.find((g) => g.name === "Roles");
      const roles = rolesSpan
        ? rolesSpan.text
            .replace(/^@Roles\(/, "")
            .replace(/\)\s*$/, "")
            .split(",")
            .map((r) => r.trim().replace(/^UserRole\./, ""))
            .filter(Boolean)
        : [];
      routes.push({
        method: routeSpan.name.toUpperCase(),
        path: normalizeRoutePath("/" + base.slice(1) + "/" + (params?.[1] ?? "")),
        roles,
      });
    }
    controllers.push({ base, routes });
  });
  return controllers;
}

function collectControllerFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      collectControllerFiles(p, out);
    } else if (entry.name.endsWith(".controller.ts")) {
      out.push(p);
    }
  }
  return out;
}

describe("ADMIN-only MCP 工具的描述必须带 `ADMIN only.`（SDK-DX-08）", () => {
  const tools = parseTools(readFileSync(TOOLS_TS, "utf8"));
  const controllers = collectControllerFiles(ADMIN_API_SRC).flatMap((f) =>
    parseControllers(readFileSync(f, "utf8")),
  );
  const adminOnlyRoutes = controllers.flatMap((c) =>
    c.routes
      .filter((r) => r.roles.length === 1 && r.roles[0] === "ADMIN")
      .map((r) => ({ method: r.method, path: r.path })),
  );

  it("解析出了工具与控制器的 ADMIN-only 路由（守卫自身不许静默空转）", () => {
    expect(tools.length).toBeGreaterThan(40);
    expect(tools.every((t) => t.name.length > 0)).toBe(true);
    expect(adminOnlyRoutes.length).toBeGreaterThan(5);
    // 至少有一条路由能被工具命中，否则下面的 join 判据等于没跑
    expect(
      tools.some((t) =>
        t.method && t.path
          ? adminOnlyRoutes.some(
              (r) => r.method === t.method && r.path === normalizeRoutePath(t.path!),
            )
          : false,
      ),
    ).toBe(true);
  });

  it("四个 MUTEX/application 写工具已带前缀（本轮修复的钉子）", () => {
    for (const name of [
      "create_mutex_group",
      "update_mutex_group",
      "delete_mutex_group",
      "update_application",
    ]) {
      const tool = tools.find((t) => t.name === name);
      expect(tool, `工具 ${name} 不存在`).toBeTruthy();
      expect(tool!.description.startsWith("ADMIN only"), `${name} 的描述必须以 "ADMIN only." 开头`).toBe(
        true,
      );
    }
  });

  it("凡路由 roles 恰好为 {ADMIN} 而又缺 `ADMIN only` 的工具，逐条报出", () => {
    const missing = tools.filter((tool) => {
      if (!tool.method || !tool.path) return false;
      const target = normalizeRoutePath(tool.path);
      const hit = adminOnlyRoutes.find(
        (r) => r.method === tool.method && r.path === target,
      );
      // 判据是**前缀**（`ADMIN only. ...`），不是「文末提一句」——前缀是列表
      // 视图里唯一一定能看到的位置，也是上一轮 6 个 SOP 工具的统一格式。
      return Boolean(hit) && !tool.description.startsWith("ADMIN only");
    });
    expect(
      missing.map((m) => `tools.ts:${m.line} ${m.name}（${m.method} ${m.path}）`),
    ).toEqual([]);
  });
});
