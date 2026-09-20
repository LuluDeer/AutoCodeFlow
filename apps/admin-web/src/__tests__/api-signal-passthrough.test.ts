import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../api/client', () => ({
  client: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

import { client } from '../api/client';
import { authApi } from '../api/auth';
import { configApi } from '../api/config';
import { aiApi } from '../api/ai';
import { eventSubscriptionsApi } from '../api/event-subscriptions';
import { notificationsApi, silencesApi } from '../api/notifications';
import { apiKeysApi } from '../api/api-keys';

const mockGet = client.get as unknown as ReturnType<typeof vi.fn>;

// NETOPT-E P2-2: 10 处设置页 queryFn 接 signal 的守护面——api 层方法必须
// 把 signal 透传给 client.get（页面 queryFn 是内联 `({ signal }) => api.x(signal)`，
// 无法 renderHook，这里钉 api 层契约；页面层接线由 tsc 强类型 + 代码审查兜底）。
describe('NETOPT-E P2-2: settings-page api methods forward AbortSignal', () => {
  beforeEach(() => vi.clearAllMocks());

  it('authApi.listSessions forwards the signal', () => {
    const ac = new AbortController();
    authApi.listSessions(ac.signal);
    expect(mockGet).toHaveBeenCalledWith('/auth/sessions', { signal: ac.signal });
  });

  it('configApi.getExecutorToken forwards the signal', () => {
    const ac = new AbortController();
    configApi.getExecutorToken(ac.signal);
    expect(mockGet).toHaveBeenCalledWith('/config/executor-shared-token', {
      signal: ac.signal,
    });
  });

  it('configApi.findAll forwards params + signal', () => {
    const ac = new AbortController();
    configApi.findAll({ prefix: 'x' }, ac.signal);
    expect(mockGet).toHaveBeenCalledWith('/config', {
      params: { prefix: 'x' },
      signal: ac.signal,
    });
  });

  it('configApi.getHistory forwards params + signal', () => {
    const ac = new AbortController();
    configApi.getHistory({ key: 'k' }, ac.signal);
    expect(mockGet).toHaveBeenCalledWith('/config/history', {
      params: { key: 'k' },
      signal: ac.signal,
    });
  });

  it('aiApi.getConfig forwards the signal', () => {
    const ac = new AbortController();
    aiApi.getConfig(ac.signal);
    expect(mockGet).toHaveBeenCalledWith('/ai/config', { signal: ac.signal });
  });

  it('eventSubscriptionsApi.list forwards the signal', () => {
    const ac = new AbortController();
    eventSubscriptionsApi.list(ac.signal);
    expect(mockGet).toHaveBeenCalledWith('/event-subscriptions', {
      signal: ac.signal,
    });
  });

  it('eventSubscriptionsApi.listDeadLetters forwards params + signal', () => {
    const ac = new AbortController();
    eventSubscriptionsApi.listDeadLetters('sub-1', 1, 20, ac.signal);
    expect(mockGet).toHaveBeenCalledWith('/event-subscriptions/sub-1/dead-letters', {
      params: { page: 1, limit: 20 },
      signal: ac.signal,
    });
  });

  it('notificationsApi.getChannels forwards the signal', () => {
    const ac = new AbortController();
    notificationsApi.getChannels(ac.signal);
    expect(mockGet).toHaveBeenCalledWith('/notification/channels', {
      signal: ac.signal,
    });
  });

  it('silencesApi.list forwards the signal', () => {
    const ac = new AbortController();
    silencesApi.list(ac.signal);
    expect(mockGet).toHaveBeenCalledWith('/notification/silences', {
      signal: ac.signal,
    });
  });

  it('apiKeysApi.list forwards the signal', () => {
    const ac = new AbortController();
    apiKeysApi.list(ac.signal);
    expect(mockGet).toHaveBeenCalledWith('/api-keys', { signal: ac.signal });
  });

  it('omits the signal option when not provided (backward-compatible call sites)', () => {
    configApi.getExecutorToken();
    expect(mockGet).toHaveBeenCalledWith('/config/executor-shared-token');
    configApi.findAll();
    expect(mockGet).toHaveBeenCalledWith('/config', { params: undefined });
  });
});
