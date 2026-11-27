/**
 * WEBUX-TURNAROUND：chat-session 请求体不再携带已删除的 kind 字段。
 * 验收级别：单测 / 内存替身（axios client 被 mock，不触网）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { client } from '../api/client';
import { createWorkbenchChatSession } from '../api/workbench';

vi.mock('../api/client', () => ({
  client: { post: vi.fn() },
  getApiBaseUrl: vi.fn(() => ''),
}));

beforeEach(() => {
  vi.mocked(client.post).mockReset().mockResolvedValue({ sessionId: 's-1' });
});

describe('chat-session 请求契约', () => {
  it('即使旧调用方硬塞 kind，请求体也只发 prompt/title/context 三个白名单字段', async () => {
    await createWorkbenchChatSession({
      prompt: '总结当前进展',
      title: '周报',
      context: { cadence: 'once' },
      kind: 'plan',
    } as never);

    expect(client.post).toHaveBeenCalledWith('/workbench/chat-sessions', {
      prompt: '总结当前进展',
      title: '周报',
      context: { cadence: 'once' },
    });
    const body = vi.mocked(client.post).mock.calls[0][1] as Record<string, unknown>;
    expect('kind' in body).toBe(false);
  });

  it('WorkbenchPage 源码不再把 starter.kind 写进 startChat 请求', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/pages/WorkbenchPage.tsx'),
      'utf8',
    );
    expect(source).not.toContain('kind: starter.kind');
    expect(source).not.toMatch(/startChat\(\{[\s\S]*?kind:/);
  });
});
