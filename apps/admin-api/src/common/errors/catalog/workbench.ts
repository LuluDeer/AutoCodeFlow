import type { ErrorCodeDef } from "../error-code-def";

/**
 * LANG-ERR-01 · 工作台域错误码分片。
 *
 * 这一片承载 workbench/**（方案卡 preview/commit、运行我的草稿、convert-to-sop）
 * 的业务码。此前工作台只复用 common/executor/application 的码（VALIDATION_FAILED、
 * AGENT_SESSION_NOT_FOUND、SOP_* 等）；切片 E1（workbench→SOP 直连）新增了
 * 三个只属于工作台会话转写语义的 409 码，按「各业务域各有自己分片」的纪律落在本文件。
 */
export const WORKBENCH_CODES = {
  /**
   * convert-to-sop 闸②（commit 已成功）：会话 contextJson 缺 goal/sopId/cardHash
   * 任一锚点。prompt-first 会话与 ops/incident 等非方案卡会话都会命中此码——
   * 它们本就没有 commit 落库路径，语义上属于「不可转写」而非 404。
   */
  WORKBENCH_CONVERT_NO_COMMIT: {
    status: 409,
    zh: "该工作台会话还没有提交成功的方案卡（缺少 commit 锚点），不能转为 SOP 草稿",
    en: "This workbench session has no committed plan card (missing commit anchors); it cannot be converted into a SOP draft",
  },
  /**
   * convert-to-sop 闸③（卡未漂移）：按入参 goal/cadence/params 重建的 cardHash
   * 与会话 context 里 commit 时的锚点不一致。与 commit 第三/五闸同型：入参被改
   * 或策略代际变化后，旧卡不得继续流转。
   */
  WORKBENCH_CONVERT_CARD_DRIFT: {
    status: 409,
    zh: "方案卡与提交锚点不一致（goal/cadence/params 与 commit 时不符），请重新预览并提交后再转换",
    en: "The plan card no longer matches the commit anchor (goal/cadence/params differ); re-preview and commit before converting",
  },
  /**
   * convert-to-sop 闸④（审批已 consumed）：该 SOP 的 sop_publish 审批单不存在、
   * 尚在 pending/granted、或已被拒绝/过期——四眼闸未走完，不得转写。
   */
  WORKBENCH_CONVERT_APPROVAL_NOT_CONSUMED: {
    status: 409,
    zh: "发布审批尚未完成（未批准或未执行），完成主管四眼审批后才能转为 SOP 草稿",
    en: "The release approval has not been consumed yet; complete the four-eyes approval before converting into a SOP draft",
  },
  /**
   * 审批决策权限（grant/deny 仅限管理员）：USER 对非 withdraw 决策动手时命中。
   * withdraw（创建者撤回自己的单）走 owner 校验，不会落进这里。
   */
  WORKBENCH_APPROVAL_DECISION_ADMIN_ONLY: {
    status: 403,
    zh: "只有管理员可以批准或拒绝审批单",
    en: "Only admins can approve or deny an approval request",
  },
  /**
   * 运行草稿（run-draft）归属闸②：SOP 草稿只允许创建者本人或 ADMIN 代跑。
   * createdBy 口径见 sop.entity.ts（user:<id> / agent:<sessionId>）。
   */
  WORKBENCH_RUN_DRAFT_FORBIDDEN: {
    status: 403,
    zh: "无权运行他人的 SOP 草稿",
    en: "You are not allowed to run another user's SOP draft",
  },
} as const satisfies Record<string, ErrorCodeDef>;
