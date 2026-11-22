const detailTabs = ['steps', 'tools', 'approvals', 'children', 'meta'] as const;
export type AgentSessionTab = (typeof detailTabs)[number];

export function agentSessionTab(value: string | null): AgentSessionTab {
  return detailTabs.find((tab) => tab === value) ?? 'steps';
}

/** Session IDs are opaque to the UI, but a URL value must remain a single API path segment. */
export function isSessionPathSegment(id: string): boolean {
  return /^[a-z\d_-]{1,128}$/i.test(id);
}

export function agentSessionUrl(id: string, options: { tab?: AgentSessionTab; approvalKey?: string; status?: string; stalled?: boolean } = {}): string {
  const params = new URLSearchParams({ session: id });
  if (options.tab && options.tab !== 'steps') params.set('tab', options.tab);
  if (options.tab === 'approvals' && options.approvalKey) params.set('approvalKey', options.approvalKey);
  if (options.status) params.set('status', options.status);
  if (options.stalled) params.set('stalled', '1');
  return `/agent-sessions?${params}`;
}
