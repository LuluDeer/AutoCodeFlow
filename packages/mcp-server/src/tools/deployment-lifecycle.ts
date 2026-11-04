/**
 * 部署生命周期（2 个工具）：upgrade_deployment / stop_deployment。
 *
 * R6「工具清单化」第 3 批（2026-11-04）从 `tools.ts` 的 `registerDeploymentTools`
 * **整体搬出**：`server.tool` 调用块逐字节未改（name / description / 入参 schema /
 * 注解 / handler 都保持原样），只是换了个文件。搬迁纪律：**块逐字节搬移**，
 * 不重排、不改写、不「顺手优化」。
 *
 * 这两个工具是**已下发部署**的运行动作（overlay 升级 / 停止），与部署触发面
 * （`./deployment-deploy.ts`）和 DEP-04 审批闭环（`./deployment-approval.ts`）
 * 共用 `/app-deployments/:id/*` 路由族；两者的 description 都以 `ADMIN only.` 开头
 * （SDK-DX-08：MCP 没有权限字段，description 前缀是非管理员 agent 唯一的提前信号，
 * 由 `admin-hints.test.ts` 以控制器 `@Roles(ADMIN)` 为事实源守着）。
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  JSON_CONTENT,
  UUID_PATH_ID,
} from "./shared";
import type { ApiCall } from "./shared";

export function registerDeploymentLifecycleTools(
  server: McpServer,
  call: ApiCall,
): void {
  // ---- upgrade_deployment --------------------------------------------------
  server.tool(
    "upgrade_deployment",
    "ADMIN only. Trigger an overlay upgrade for a running deployment so it pulls the latest application version.",
    {
      deploymentId: UUID_PATH_ID.describe("Deployment ID to upgrade"),
    }, { destructiveHint: true },
    async ({ deploymentId }) => {
      const data = await call<unknown>(
        "POST",
        `/app-deployments/${deploymentId}/upgrade`,
      );
      return JSON_CONTENT(data);
    },
  );

  // ---- stop_deployment -----------------------------------------------------
  server.tool(
    "stop_deployment",
    "ADMIN only. Stop a running application deployment.",
    {
      deploymentId: UUID_PATH_ID.describe("Deployment ID to stop"),
    }, { destructiveHint: true, idempotentHint: true },
    async ({ deploymentId }) => {
      const data = await call<unknown>(
        "POST",
        `/app-deployments/${deploymentId}/stop`,
      );
      return JSON_CONTENT(data);
    },
  );
}
