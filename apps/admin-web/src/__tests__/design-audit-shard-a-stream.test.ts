/**
 * D-P2-04（设计审计 2026-09-22 分片A）：Dashboard SSE 连接状态点色。
 *
 * 旧实现硬编码 #22c55e / #f59e0b / #94a3b8。改从 theme/tokens.ts 的
 * SEMANTIC_COLORS 语义色单源取值——返回值必须与 tokens 同源，双主题成立。
 */
import { describe, it, expect } from 'vitest';
import { streamStatusBadge } from '../pages/DashboardPage';
import { SEMANTIC_COLORS } from '../theme/tokens';

describe('D-P2-04: streamStatusBadge 颜色走 SEMANTIC_COLORS 单源', () => {
  it('live → success 语义色', () => {
    expect(streamStatusBadge('live').color).toBe(SEMANTIC_COLORS.success);
    expect(streamStatusBadge('live').labelKey).toBe('dashboard.stream.live');
  });

  it('reconnecting → warning 语义色', () => {
    expect(streamStatusBadge('reconnecting').color).toBe(SEMANTIC_COLORS.warning);
    expect(streamStatusBadge('reconnecting').labelKey).toBe('dashboard.stream.reconnecting');
  });

  it('connecting（默认）→ neutral 中性灰', () => {
    expect(streamStatusBadge('connecting').color).toBe(SEMANTIC_COLORS.neutral);
    expect(streamStatusBadge('connecting').labelKey).toBe('dashboard.stream.connecting');
  });

  it('三态颜色互不相同（可区分健康/重连/未连接）', () => {
    const colors = ['live', 'reconnecting', 'connecting'].map(
      (s) => streamStatusBadge(s as 'live').color,
    );
    expect(new Set(colors).size).toBe(3);
  });
});
