import type { InboxSectionKey } from '../../api/inbox';

/** 收件箱三大类：把 10 个小节压成三层决策优先级。 */
export type InboxGroupKey = 'approvals' | 'needsInput' | 'signals';

export const INBOX_GROUPS: ReadonlyArray<{
  key: InboxGroupKey;
  /** 复用既有小节文案作为分组标题，避免引入未翻译的新 key。 */
  labelKey: string;
  sections: readonly InboxSectionKey[];
}> = [
  {
    key: 'approvals',
    labelKey: 'inbox.section.agentApprovals',
    sections: ['deployments', 'agentApprovals'],
  },
  {
    key: 'needsInput',
    labelKey: 'inbox.section.agentWaiting',
    sections: ['agentWaiting', 'sopClarifications', 'sopBlocked'],
  },
  {
    key: 'signals',
    labelKey: 'inbox.section.recentFailures',
    sections: ['agentFailures', 'stalled', 'backlogged', 'queueStall', 'recentFailures'],
  },
];

/**
 * 搜索只匹配用户读到的文本（标题/副标题/工具名），不改任何后端语义。
 * 返回 true 表示该行应保留；空关键词全部保留。
 */
export function matchesInboxQuery(item: {
  title: string;
  subtitle?: string;
  approval?: { toolName?: string; reason?: string };
}, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return true;
  return [item.title, item.subtitle, item.approval?.toolName, item.approval?.reason]
    .filter((value): value is string => !!value)
    .some((value) => value.toLocaleLowerCase().includes(needle));
}
