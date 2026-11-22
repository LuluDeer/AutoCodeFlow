/**
 * Agent 会话详情「工具调用」表的列定义（从 AgentSessionsPage.tsx 外提）。
 *
 * ## 为什么外提
 *
 * 原列数组内联在 AgentSessionsPage 主函数里，而该文件 nonCommentLines / functionLines
 * 已顶到 size-caps 基线（1024 / 1025）——本轮要给台账补「结果」列、把入参与异常从
 * `.slice(0, 160)` 改为可展开全文，就地新增必然破顶。列定义是纯声明（无 state /
 * effect），依赖只有 `t`，外提后页面只留一行 `buildToolColumns(t)`（先例：
 * `pages/task-list-columns.tsx`）。
 *
 * ## 口径（与审批 preview 的诚实性对齐）
 *
 * - 结果：只读结构化视图（`ToolArgsView` 的键值形态，文案按结果语义另给）；
 *   `resultTruncated=true` 挂橙色 Tag，明确「你看到的不全」；null / 空对象显示
 *   「未记录结果（旧调用）」，不留一片空白让人误以为「这次没有结果」。
 * - 入参 / 异常：全文留在 DOM，用与审批理由同形的 `Paragraph.ellipsis.expandable`
 *   折叠（rows=3、expandable=collapsible、复用 agents.approval.expand/collapse），
 *   不再在数据层截 160 字；异常保持 danger 色。
 */
import { Space, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { AgentToolCall } from '../../api/agent';
import { agentToolStatusLabel, agentToolTierLabel } from '../../utils/agent-label';
import { AGENT_TOOL_STATUS_COLOR } from '../../utils/status-color';
import { argsEntries } from '../../utils/toolArgs';
import ToolArgsView from '../../components/ToolArgsView';

const { Text, Paragraph } = Typography;

/**
 * 长文本单元格：折叠而非截断（全文始终在 DOM，展开/收起只改可见行数）。
 * 形态逐项对齐审批理由列与审批 preview 的兜底正文。
 */
function expandableCellText(
  text: string,
  t: import('i18next').TFunction,
  danger = false,
) {
  return (
    <Paragraph
      type={danger ? 'danger' : 'secondary'}
      style={{ marginBottom: 0, fontSize: 12, maxWidth: 420, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}
      ellipsis={{
        rows: 3,
        expandable: 'collapsible',
        symbol: (expanded) =>
          expanded ? t('agents.approval.collapse') : t('agents.approval.expand'),
      }}
    >
      {text}
    </Paragraph>
  );
}

/** 结果列单元格：结构化结果 + 显式截断标记 + 旧调用兜底文案。 */
function toolResultCell(call: AgentToolCall, t: import('i18next').TFunction) {
  const hasResult = argsEntries(call.resultJson).length > 0;
  return (
    <div>
      {hasResult ? (
        <ToolArgsView args={call.resultJson} />
      ) : (
        <Text type="secondary" style={{ fontSize: 12 }}>
          {t('agents.toolResult.empty')}
        </Text>
      )}
      {call.resultTruncated && (
        <Tag color="orange" style={{ marginTop: 4 }}>
          {t('agents.toolResult.truncated')}
        </Tag>
      )}
    </div>
  );
}

/** 每次调用返回一份新列数组，与搬迁前「渲染时内联构造」行为一致。 */
export function buildToolColumns(t: import('i18next').TFunction): ColumnsType<AgentToolCall> {
  return [
    {
      title: t('agents.col.tool'),
      dataIndex: 'toolName',
      width: 180,
      render: (v: string, c) => (
        <Space size={4}>
          <Tag color={AGENT_TOOL_STATUS_COLOR[c.status] ?? 'default'}>
            {agentToolStatusLabel(c.status, t)}
          </Tag>
          <Text style={{ fontSize: 12 }}>{v}</Text>
        </Space>
      ),
    },
    {
      title: t('agents.col.tier'),
      dataIndex: 'tier',
      width: 90,
      render: (v: string) => agentToolTierLabel(v, t),
    },
    {
      title: t('agents.col.args'),
      // 不设 ellipsis:true——rc-table 的 ellipsis 只把同一串塞进 title，全文仍被
      // 数据层截掉；这里改由 Paragraph 折叠承载（理由见本文件头注）。
      render: (_, c) => expandableCellText(JSON.stringify(c.argsJson ?? {}), t),
    },
    {
      title: t('agents.col.result'),
      width: 260,
      render: (_, c) => toolResultCell(c, t),
    },
    { title: t('agents.col.duration'), dataIndex: 'durationMs', width: 80 },
    {
      title: t('agents.col.error'),
      render: (_, c) =>
        c.errorMessage ? expandableCellText(c.errorMessage, t, true) : null,
    },
  ];
}
