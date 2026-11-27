import { client } from './client';

/** 业务侧频率（界面只呈现中文标签，这里保留后端契约的英文枚举值）。 */
export type WorkbenchCadence = 'daily' | 'weekly' | 'monthly';

export interface PreviewPlanInput {
  goal: string;
  cadence: WorkbenchCadence;
  params?: Record<string, string>;
}

export interface PreviewCard {
  title: string;
  triggerText: string;
  capabilityHints: string[];
  acceptanceText: string;
  budget: { maxTurns: number };
}

export type PreviewCheckStatus = 'ok' | 'warn' | 'fail';

export interface PreviewCheck {
  field: string;
  status: PreviewCheckStatus;
  message: string;
}

export interface PreviewPlanResult {
  card: PreviewCard;
  checks: PreviewCheck[];
  eligible: boolean;
  cardHash: string;
  /** 方案卡当前的策略代际（16 hex）：commit 必须原样回填，作为策略未被改动的校验锚点。 */
  policyGeneration: string;
}

/**
 * POST /api/workbench/commit 入参（对齐 admin-api CommitPlanCardRequestDto）。
 *
 * 刻意不带 card 内容：服务端只用 goal/cadence/params 重建 card 并重算 hash，
 * 再与 expectedCardHash 比对；同时重算当前策略代际并与 expectedPolicyGeneration 比对，
 * 两者任一失配服务端都会拒绝（表单被改 / 策略在预览后变更）。
 * 前端必须把 preview 返回的 cardHash 与 policyGeneration 原样回填，
 * 且 goal/cadence/params 与预览时逐字一致。
 */
export interface CommitPlanInput {
  goal: string;
  cadence: WorkbenchCadence;
  params?: Record<string, string>;
  expectedCardHash: string;
  expectedPolicyGeneration: string;
}

/** POST /api/workbench/commit 响应（对齐 CommitResultDto）：只落 draft，不自动发布。 */
export interface CommitResult {
  sopId: string;
  slug: string;
  status: 'draft';
  /**
   * ADR-045 发布审批发起状态（稳定码，后端必填）：
   * submitted=已发起且带 approvalKey；failed=发起异常但 draft 已落；
   * not_requested=端口缺席/非 USER 上下文，本就未发起（非异常）。
   * 页面按此三态给出诚实提示，绝不用 approvalKey 缺席去猜「不需要审批」。
   */
  approvalStatus: 'submitted' | 'failed' | 'not_requested';
  /**
   * @deprecated 后端不再返回硬编码中文；界面改由 approvalStatus + i18n 文案驱动。
   * 仅为兼容旧客户端/fixture 保留为可选，新代码不得读取。
   */
  next?: string;
  /** 本次提交放行的策略代际（16 位 hex），供下游会话继承以做在途失效比对。 */
  policyGeneration?: string;
  /**
   * ADR-045：发布审批单 key（业务人员提交后由主管四眼批准、系统代理发布）。
   * 与后端 `CommitResultDto.approvalKey` 同源（`required: false`）——
   * **仅 approvalStatus==='submitted' 时有**；failed/not_requested 一律缺席。
   * 页面必须「有则渲染、无则整块不渲染」，绝不在缺席时编造「已提交审批」。
   */
  approvalKey?: string;
}

/**
 * 方案预览：client 的 baseURL 已含 /api（见 api/client.ts:14-29），
 * 因此这里只写相对路径，实际请求为 POST /api/workbench/preview。
 */
export function previewPlan(input: PreviewPlanInput): Promise<PreviewPlanResult> {
  return client.post<PreviewPlanResult>('/workbench/preview', input);
}

/**
 * 确认方案并落 SOP 草稿：相对路径 → POST /api/workbench/commit。
 * 失败由调用方 catch（拦截器已按错误码弹过 toast 的会去重，页面侧给内联兜底）。
 */
export function commitPlan(input: CommitPlanInput): Promise<CommitResult> {
  return client.post<CommitResult>('/workbench/commit', input);
}

export const workbenchApi = { preview: previewPlan, commit: commitPlan };
