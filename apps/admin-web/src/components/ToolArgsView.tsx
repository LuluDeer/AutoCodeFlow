/**
 * WEB-4（P2，2026-10-29 第 3 轮 web-ux 审计）：审批决策依据——工具入参的**只读**
 * 结构化视图。
 *
 * ## 为什么只读（不提供编辑）
 *
 * 审批单绑定的不是「工具」而是「这一次调用的具体参数组合」：服务端 approvalKey =
 * `apr-<sessionId>-<sha256(toolName|规范化参数) 前 16 位>`（agent-approvals.service.ts
 * `buildKey`），恢复会话后模型重提的调用必须命中**同一个 key** 才会被放行
 * （tool-executor.service.ts：`approvedKey = existingApproval?.status === 'granted'
 * ? approvalKey : null`，`approvalKey` 由本次调用的 `(toolName, args)` 现算）——
 * 换个参数就是换 key，等于要一张新单（旧单原样留 pending）。
 *
 * 所以这里放输入框只会制造「我改过了」的错觉：前端参数改不动落库值，也改不动
 * 服务端据以放行的 key，唯一效果是让审批人以为自己能协商参数。审批人该做且只能
 * 做的是「看清楚 + 决定批不批」，故本视图零可编辑控件。
 *
 * 另注：展示的可能已是**脱敏视图**——落库走 `sanitizeArgs`（键名命中 SECRET_KEYS_RE
 * 的值写成 `[REDACTED]`）。这是刻意的：决策依据要能看到「动了什么资源」，不该顺手
 * 泄露凭据。
 *
 * ## 为什么长值要折叠而不是截断
 *
 * 与 WEB-4 的主诉同源：`.slice(0, 160)` 让审批人看不到「写到哪个地址/改哪个文件」
 * 的后半段。折叠（CSS 行数限制 + 展开）保留全文在 DOM 里，可随时展开；截断则
 * 永久丢失。
 */
import { useTranslation } from 'react-i18next';
import { Typography } from 'antd';

import { argsEntries } from '../utils/toolArgs';

const { Text, Paragraph } = Typography;

interface Props {
  args: Record<string, unknown> | null | undefined;
}

/**
 * 键值列表（`<dl>`：读屏能念出「键→值」的配对关系）。
 *
 * 空值分支是**历史数据**的如实交代：WEB-4 之前落库的审批单（或工具调用行已被
 * 保留策略清掉时）没有 argsJson——这里显示「未记录入参（旧审批单）」，而不是
 * 一片空白让审批人误以为「这次调用没有参数」。
 */
export default function ToolArgsView({ args }: Props) {
  const { t } = useTranslation();
  const entries = argsEntries(args);

  if (entries.length === 0) {
    return (
      <Text type="secondary" style={{ fontSize: 12 }}>
        {t('agents.approval.argsEmpty')}
      </Text>
    );
  }

  return (
    <dl style={{ margin: 0, fontSize: 12 }}>
      {entries.map((e) => (
        <div key={e.key} style={{ marginBottom: 4 }}>
          <dt style={{ display: 'inline' }}>
            <Text code style={{ fontSize: 12 }}>
              {e.key}
            </Text>
          </dt>
          <dd style={{ display: 'block', margin: 0, marginTop: 2 }}>
            {e.long ? (
              <Paragraph
                type="secondary"
                style={{ marginBottom: 0, fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}
                ellipsis={{
                  rows: 2,
                  expandable: 'collapsible',
                  symbol: (expanded) =>
                    expanded ? t('agents.approval.collapse') : t('agents.approval.expand'),
                }}
              >
                {e.text}
              </Paragraph>
            ) : (
              <Text type="secondary" style={{ fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                {e.text}
              </Text>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}
