/**
 * 项目域只读工具组（3 个工具）：list_projects / get_project_members / get_my_project_roles。
 *
 * R6「工具清单化」第 1 批从 `tools.ts` **整体搬出**：`server.tool` 调用块逐字节未改
 * （name / description / 入参 schema / 注解都保持原样），只是换了个文件。
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  JSON_CONTENT,
  UUID_PATH_ID,
} from "./shared";
import type { ApiCall } from "./shared";

// ---------------------------------------------------------------------------
// Projects (AUTH-02-B read-side): list/members/my-roles
// ---------------------------------------------------------------------------

/**
 * AUTH-02-B（R18）：项目域只读工具组。GET /projects 为按主体过滤的读面
 * （ADMIN 全量；普通用户「默认项目 ∪ 成员项目」，每行带 myRole）；成员
 * 读面要求成员身份；成员写面为 ADMIN-only 且不在自动化工具面暴露——
 * 避免自动化链路误改授权（需要时走管理台/REST 显式操作）。
 */
export function registerProjectTools(server: McpServer, call: ApiCall): void {
  // ---- list_projects --------------------------------------------------------
  server.tool(
    "list_projects",
    "List projects visible to the current credential. Admins see all projects; other credentials see the default project plus projects they are a member of. Each row carries myRole (viewer/editor/admin or null) for capability checks before writes.",
    {}, { readOnlyHint: true, idempotentHint: true },
    async () => {
      const data = await call<unknown>("GET", "/projects");
      return JSON_CONTENT(data);
    },
  );

  // ---- get_project_members --------------------------------------------------
  server.tool(
    "get_project_members",
    "List members (userId + role) of one project. Admins can read any project; other credentials only projects they belong to (the default project is always readable).",
    {
      projectId: UUID_PATH_ID.describe("Project ID (UUID); use list_projects to resolve"),
    }, { readOnlyHint: true },
    async ({ projectId }) => {
      const data = await call<unknown>("GET", `/projects/${projectId}/members`);
      return JSON_CONTENT(data);
    },
  );

  // ---- get_my_project_roles -------------------------------------------------
  server.tool(
    "get_my_project_roles",
    "Return the caller's project memberships: { userId, isAdmin, memberships: [{ projectId, role }] }. Use it to plan capability-aware automation (e.g. skip writes on projects where myRole is viewer).",
    {}, { readOnlyHint: true },
    async () => {
      const data = await call<unknown>("GET", "/projects/me/roles");
      return JSON_CONTENT(data);
    },
  );
}
