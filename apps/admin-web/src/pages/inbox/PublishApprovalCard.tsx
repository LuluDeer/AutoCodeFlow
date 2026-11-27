/**
 * ADR-045 · 发布审批卡（收件箱「Agent 审批单」小节里 `toolName === 'sop_publish'` 的行）。
 *
 * ## 为什么需要它
 *
 * 业务人员提交方案卡后，后端会建一张 `sop_publish` 审批单（`CommitResultDto.approvalKey`）。
 * 主管在「待我审批」里看到的却是**通用行**：标题 = 会话标题、副标题 = 工具名 + 理由、
 * 只有「拒绝」+「查看审批」——**被批的是哪份方案、批下去会发生什么**都看不到。
 * 发布权 = 间接的指令注入权（04 §4.3），这一格不能靠「去详情里翻」。
 *
 * ## 这张卡只说三件事（其余版式与通用行一致）
 *
 * ① **被批对象**：解析审批单自带的 `preview` 信封（`{ truncated, args }`），
 *    `args` 是对象时抽 `sopId` / `cardHash` / `contentHash` / `bump` 的人读摘要；
 *    `preview` 为 `null` / 空串 / 不可解析 ⇒ 显示降级文案，**绝不编造**内容。
 * ② **四眼红线**：批准 = 同意发布；实际发布由系统代理以 `agent:tool-call` 身份执行；
 *    主管不得自批（服务端 `release-four-eyes` 强制，前端提示只是把红线说清楚）。
 * ③ **参数摘要与核对入口**：`argsDigest` 前 16 位供人眼比对（全文在 `title`），
 *    「去审批页核对参数」深链回该会话的审批单页签。
 *
 * ## 刻意不做的事
 *
 * - **没有「直接发布」入口**：卡内不出现「发布 / 立即发布 / 执行」任何按钮——发布只能
 *   经审批（批准 = 同意发布，真正执行的是系统代理）。「批准」是审批动作，不是发布动作。
 * - 权限判定沿用页面注入的 `canWrite`（业务人员只读 ⇒ 连「批准 / 拒绝」都不出现）。
 * - 不复用 `InboxPage` 的 `inboxTitleText` / `inboxSubtitleText` 实现（会反向依赖
 *   页面模块）：标题与时间文案由页面算好传入，卡内不重复实现回落逻辑，也不重复
 *   输出副标题（摘要由本卡承担）。
 */
import { Link } from 'react-router-dom';
import { Button, Space, Tag, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import type { InboxItem } from '../../api/inbox';

const { Text } = Typography;

/**
 * 发布审批的工具名（后端 `tool-registry` 的 `sop_publish`）。
 *
 * 逐工具审批闸：`approvalRequired: true` 且**不随**全局写策略放宽——所以
 * 「这一行是发布」是工具名的函数，不需要（也不该）读会话或策略状态。
 */
export const PUBLISH_TOOL_NAME = 'sop_publish';

export interface PublishApprovalCardProps {
  item: InboxItem;
  /** 行标题（页面 `inboxTitleText` 归一后的结果：缺失时是「（未命名会话）」）。 */
  title: string;
  /** 行时间文案（页面统一格式化；本卡不自己拼时间）。 */
  timeText: string;
  canWrite: boolean;
  actingId: string | null;
  actingAction?: string | null;
  onGrant: (item: InboxItem) => void;
  onDeny: (item: InboxItem) => void;
}

/** 解析后的预览信封：`args` 为对象（结构化参数）或 `null`（没有 / 被截断切断）。 */
export interface PublishPreview {
  args: Record<string, unknown> | null;
  /** 服务端因超 2KB 截断过——必须显式告诉审批人「你看的不是全部」。 */
  truncated: boolean;
}

/**
 * 解析审批单自带的 `preview`；`null` / 空串 / 不可解析 ⇒ `null`（不臆造）。
 *
 * 两种形态都收（都来自后端，只是落库形态不同）：
 *  ① **信封**：`{ truncated, args }`，`args` 是 JSON 文本（`tool-executor` 的
 *     脱敏 + 截断产物，与 `AgentSessionsPage.parseApprovalPreview` 同口径）；
 *  ② **扁平**：参数直接铺在顶层（部分端点只透出摘要时的形态）。
 * 两种都解析不出对象 ⇒ `args: null`，由调用方显示降级文案。
 */
export function parsePublishPreview(preview: string | null | undefined): PublishPreview | null {
  if (typeof preview !== 'string' || preview.trim().length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(preview) as unknown;
  } catch {
    // 信封本身不可解析（未来格式变更）：这是「不知道」，不是「没有参数」。
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const env = parsed as Record<string, unknown>;
  const truncated = env.truncated === true;
  if (!('args' in env)) return { args: env, truncated };
  const raw = env.args;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return { args: raw as Record<string, unknown>, truncated };
  }
  if (typeof raw === 'string' && raw.trim().length > 0) {
    try {
      const inner = JSON.parse(raw) as unknown;
      if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
        return { args: inner as Record<string, unknown>, truncated };
      }
    } catch {
      // 截断把 args 切成半个 JSON：这不是错误，是「部分可见」——args 留 null。
    }
    return { args: null, truncated };
  }
  return { args: null, truncated };
}

/**
 * 摘要里的哈希原样展示（不截断）。
 *
 * 摘要这一格是「我在批哪张卡」的唯一人读证据：`cardHash` / `contentHash` 截断后
 * 就只剩前缀，主管没法与方案卡上的值逐字对上。长串由 CSS 换行兜住。
 */
function hashText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** `bump` 枚举 → 中文档位；未知取值返回 `null`（不编造版本语义）。 */
function bumpLabel(bump: unknown, t: ReturnType<typeof useTranslation>['t']): string | null {
  if (typeof bump !== 'string') return null;
  switch (bump.trim().toLowerCase()) {
    case 'patch':
      return t('inbox.publish.bumpPatch');
    case 'minor':
      return t('inbox.publish.bumpMinor');
    case 'major':
      return t('inbox.publish.bumpMajor');
    default:
      return null;
  }
}

/**
 * 被批对象的人读摘要；一个字段都抽不出 ⇒ `null`（调用方显示降级文案）。
 *
 * 只认契约里真实存在的四个字段（`sop_publish` 的入参 + 方案卡锚点），
 * 不做「猜一个像 id 的字段顶上」的事：摘要错了比没有摘要更危险。
 */
export function summarizePublishArgs(
  args: Record<string, unknown> | null,
  t: ReturnType<typeof useTranslation>['t'],
): string | null {
  if (!args) return null;
  const parts: string[] = [];
  const sopId = typeof args.sopId === 'string' ? args.sopId.trim() : '';
  if (sopId) parts.push(t('inbox.publish.sopId', { sopId }));
  const bump = bumpLabel(args.bump, t);
  if (bump) parts.push(bump);
  const cardHash = hashText(args.cardHash);
  if (cardHash) parts.push(t('inbox.publish.cardHash', { hash: cardHash }));
  const contentHash = hashText(args.contentHash);
  if (contentHash) parts.push(t('inbox.publish.contentHash', { hash: contentHash }));
  return parts.length > 0 ? parts.join(' · ') : null;
}

export default function PublishApprovalCard({
  item,
  title,
  timeText,
  canWrite,
  actingId,
  actingAction,
  onGrant,
  onDeny,
}: PublishApprovalCardProps) {
  const { t } = useTranslation();
  const approval = item.approval;
  const preview = parsePublishPreview(approval?.preview);
  const summary = summarizePublishArgs(preview?.args ?? null, t);
  const digest =
    typeof approval?.argsDigest === 'string' && approval.argsDigest.length > 0
      ? approval.argsDigest
      : null;
  const rowActing = actingId === item.id;

  return (
    <div
      data-testid="inbox-publish-card"
      style={{ padding: '10px 0', borderBottom: '1px solid rgba(0,0,0,0.06)' }}
    >
      <Space orientation="vertical" size={4} style={{ width: '100%' }}>
        <Space size={8} wrap>
          <Tag color="gold">{t('inbox.publish.tag')}</Tag>
          <Text strong style={{ fontSize: 13 }}>
            {title}
          </Text>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {timeText}
          </Text>
        </Space>

        {/* ① 被批对象：摘要抽不出（旧单 / 无参数 / 信封不可解析）⇒ 降级文案，不臆造 */}
        <div data-testid="inbox-publish-preview" style={{ fontSize: 12 }}>
          {summary ? t('inbox.publish.previewWithSummary', { summary }) : t('inbox.publish.previewUnavailable')}
        </div>

        {preview?.truncated ? (
          <div>
            <Tag color="orange">{t('agents.approval.previewTruncated')}</Tag>
          </div>
        ) : null}

        {/* ② 四眼红线：批准 = 同意发布；执行者是系统代理；主管不得自批 */}
        <Text type="secondary" style={{ fontSize: 12 }} data-testid="inbox-publish-four-eyes">
          {t('inbox.publish.fourEyes')}
        </Text>

        {/* ③ 参数摘要（前 16 位供人眼比对，全文在 title）+ 核对入口 */}
        {digest ? (
          <Text
            type="secondary"
            style={{ fontSize: 11, wordBreak: 'break-all' }}
            title={digest}
            data-testid="inbox-publish-digest"
          >
            {t('agents.approval.argsDigest', { digest: `${digest.slice(0, 16)}…` })}
          </Text>
        ) : null}

        <Space size={4} wrap>
          {/* UX-AUDIT：详情深链指向 ADMIN-only 的 /agent-sessions；业务用户不渲染链接避免 403 死路，
              管理员（canWrite）保留原深链（既有测试钉住该行为）。 */}
          {canWrite && item.detailUrl ? (
            <Link to={item.detailUrl} data-testid="inbox-publish-review" style={{ fontSize: 12 }}>
              {t('inbox.publish.review')}
            </Link>
          ) : null}
          {/* 业务人员只读：连「批准 / 拒绝」也不出现（写动作仍由后端 RBAC 兜底）。
              「批准」是审批动作（走二次确认 → grant → 服务端四眼校验），
              卡内**没有**任何「直接发布」按钮——发布由系统代理在批准后执行。 */}
          {canWrite ? (
            <>
              <Button
                size="small"
                type="primary"
                // 关掉 antd 的两字间隔：卡内按钮的可读名必须逐字是「批准」，
                // 否则「按名字找批准按钮」的调用（含 e2e）会退化成点最后一个按钮。
                autoInsertSpace={false}
                disabled={rowActing}
                loading={rowActing && actingAction === 'grant'}
                onClick={() => onGrant(item)}
              >
                {t('inbox.action.approve')}
              </Button>
              <Button
                size="small"
                danger
                autoInsertSpace={false}
                disabled={rowActing}
                loading={rowActing && actingAction === 'deny'}
                onClick={() => onDeny(item)}
              >
                {t('inbox.action.deny')}
              </Button>
            </>
          ) : null}
        </Space>
      </Space>
    </div>
  );
}