/**
 * DEP-04 审批闭环（4 个工具）：list_pending_approvals / approve_deployment /
 * reject_deployment / cancel_deployment。
 *
 * R6「工具清单化」第 3 批（2026-11-04）从 `tools.ts` 的 `registerDeploymentTools`
 * **整体搬出**：`server.tool` 调用块逐字节未改（name / description / 入参 schema /
 * 注解 / handler 都保持原样），只是换了个文件。搬迁纪律：**块逐字节搬移**，
 * 不重排、不改写、不「顺手优化」。
 *
 * ## ⚠️ DEP-04 审批语义链（跨两个文件 —— 读一边必须读另一边）
 *
 * 本文件是这条链的**闭环侧**：部署请求在**产生侧**（`./deployment-deploy.ts` 的
 * `deploy_application` / `deploy_app`）被冻结成 `approvalStatus=pending_approval`
 * 之后，由这四个工具把它处理完：
 *   · `list_pending_approvals` —— 队列（`GET /app-deployments/approvals/pending`），
 *     行里的 id 喂给下面三个动作；
 *   · `approve_deployment` —— 通过即**当场下发**（这是唯一会真正派发的出口）；
 *   · `reject_deployment` —— 拒绝，永不派发；
 *   · `cancel_deployment` —— 发起人撤回自己的请求（后端路由 `@Roles(ADMIN)`）。
 * **第二人规则**（审批人 ≠ 发起人）由后端强制，本层只透传 reason（≤200，进审计）。
 * 四个工具共用同一组 `approvalStatus` 字符串与 `/approval/*` 路由 ⇒
 * **改任一侧前先读产生侧**（那里的 handler 也依赖 `data.approvalStatus` 与
 * `data.id` 的形状）。
 *
 * 审批语义的**不变量**：审批未通过 ⇒ 绝不会下发。任何让 `approve` 之外的工具产生
 * 派发副作用的改动都是缺陷。
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  JSON_CONTENT,
  UUID_PATH_ID,
} from "./shared";
import type { ApiCall } from "./shared";

export function registerDeploymentApprovalTools(
  server: McpServer,
  call: ApiCall,
): void {
  // ---- DEP-04 approval workflow --------------------------------------------
  // deploy_application/deploy_app can freeze a deployment at
  // approvalStatus=pending_approval (nothing dispatched). These tools close
  // the loop so an MCP user can list the queue and act on a pending row
  // without leaving the agent (second-person rule enforced server-side).

  server.tool(
    "list_pending_approvals",
    "List deployments awaiting approval (DEP-04 queue, ADMIN only). Returns rows with approvalStatus=pending_approval; each row's id feeds approve_deployment / reject_deployment / cancel_deployment.",
    {
      applicationId: UUID_PATH_ID.optional().describe("Filter by application ID"),
      page: z
        .number()
        .int()
        .min(1)
        .default(1)
        .describe("Page number (default 1)"),
      pageSize: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(20)
        .describe("Items per page (default 20)"),
    }, { readOnlyHint: true },
    async ({ applicationId, page, pageSize }) => {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(pageSize),
        ...(applicationId ? { applicationId } : {}),
      });
      const data = await call<unknown>(
        "GET",
        `/app-deployments/approvals/pending?${params}`,
      );
      return JSON_CONTENT(data);
    },
  );

  server.tool(
    "approve_deployment",
    "ADMIN only. Approve a pending deployment (DEP-04). Approving dispatches it to the executor. Second-person rule: the approver must differ from the requester, otherwise the API returns an error.",
    {
      deploymentId: UUID_PATH_ID.describe("Pending deployment ID to approve"),
      reason: z
        .string()
        .max(200)
        .optional()
        .describe("Optional decision reason (≤200 chars), recorded in audit"),
    }, { destructiveHint: true },
    async ({ deploymentId, reason }) => {
      const body = reason !== undefined ? { reason } : undefined;
      const data = await call<unknown>(
        "POST",
        `/app-deployments/${deploymentId}/approval/approve`,
        body,
      );
      return JSON_CONTENT(data);
    },
  );

  server.tool(
    "reject_deployment",
    "ADMIN only. Reject a pending deployment (DEP-04). The deployment is never dispatched. Second-person rule applies.",
    {
      deploymentId: UUID_PATH_ID.describe("Pending deployment ID to reject"),
      reason: z
        .string()
        .max(200)
        .optional()
        .describe("Optional decision reason (≤200 chars), recorded in audit"),
    }, { destructiveHint: true },
    async ({ deploymentId, reason }) => {
      const body = reason !== undefined ? { reason } : undefined;
      const data = await call<unknown>(
        "POST",
        `/app-deployments/${deploymentId}/approval/reject`,
        body,
      );
      return JSON_CONTENT(data);
    },
  );

  server.tool(
    "cancel_deployment",
    "ADMIN only. Cancel own pending deployment request (DEP-04). Requester-only exit: the user who triggered the deployment may withdraw it before anyone approves — note the backend route POST /app-deployments/:id/approval/cancel is @Roles(ADMIN), so a non-admin requester cannot withdraw it through this endpoint.",
    {
      deploymentId: UUID_PATH_ID.describe("Pending deployment ID to cancel"),
    }, { destructiveHint: true },
    async ({ deploymentId }) => {
      const data = await call<unknown>(
        "POST",
        `/app-deployments/${deploymentId}/approval/cancel`,
      );
      return JSON_CONTENT(data);
    },
  );
}
