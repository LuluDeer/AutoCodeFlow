/**
 * 发布失败一键重试按钮（组件级第 2 级，AGENTS §4.4）。
 *
 * 判据：白名单闸门、点击调 API 的参数、成功/失败 toast 与 onDone、
 * loading 禁用，以及审计详情 Modal 仅在 release_failed + detail 齐全时挂按钮。
 * HTTP 边界由 vi.mock 拦在 api/audit 层（内存替身，不触网、不落库）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  act,
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

import RetryReleaseButton from '../components/audit/RetryReleaseButton';
import { auditApi } from '../api/audit';
import { message } from '../utils/toast';
import AuditLogPage from '../pages/audit';
import { client } from '../api/client';

vi.mock('../api/audit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/audit')>()),
  auditApi: { retryRelease: vi.fn() },
  retryRelease: vi.fn(),
}));
vi.mock('../utils/toast', () => ({
  message: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));
vi.mock('../api/client', () => ({
  client: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

const mockedAudit = vi.mocked(auditApi, true);
const mockedMessage = vi.mocked(message, true);
const mockedClient = vi.mocked(client, true);

const g = globalThis as Record<string, unknown>;
if (!g.ResizeObserver) {
  g.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
if (!window.matchMedia) {
  window.matchMedia = ((q: string) => ({
    matches: false,
    media: q,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

const APPROVAL_KEY = 'apr-e2e-retry-0001';
const WHITELIST = [
  'dependency_unavailable',
  'policy_fingerprint_unavailable',
  'sop_not_found',
  'content_changed',
  'approval_not_consumed',
] as const;

function renderButton(reason: string, onDone: () => void = vi.fn()) {
  return render(
    <RetryReleaseButton approvalKey={APPROVAL_KEY} reason={reason} onDone={onDone} />,
  );
}

const button = () => screen.queryByTestId('retry-release-button') as HTMLButtonElement | null;

beforeEach(() => {
  mockedAudit.retryRelease.mockReset().mockResolvedValue({
    retried: true,
    published: true,
  } as never);
  mockedMessage.success.mockReset();
  mockedMessage.error.mockReset();
  mockedClient.get.mockReset().mockResolvedValue({ data: [], total: 0 } as never);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('RetryReleaseButton 白名单闸门与点击路径', () => {
  it('① 白名单内 reason ⇒ 按钮渲染（data-testid 契约）', () => {
    renderButton('policy_fingerprint_unavailable');
    expect(button()).toBeTruthy();
    expect(button()!.getAttribute('data-testid')).toBe('retry-release-button');
  });

  it('② 五个白名单 reason 全部可见，不漏一个', () => {
    for (const reason of WHITELIST) {
      const view = renderButton(reason);
      expect(button(), `reason=${reason} 必须渲染按钮`).toBeTruthy();
      view.unmount();
      cleanup();
    }
    expect(mockedAudit.retryRelease).not.toHaveBeenCalled();
  });

  it('③ 点击 ⇒ auditApi.retryRelease(approvalKey, reason)：参数逐位正确且只调一次', async () => {
    renderButton('dependency_unavailable');
    fireEvent.click(button()!);
    await waitFor(() => {
      expect(mockedAudit.retryRelease).toHaveBeenCalledTimes(1);
    });
    expect(mockedAudit.retryRelease).toHaveBeenCalledWith(
      APPROVAL_KEY,
      'dependency_unavailable',
    );
  });

  it('④ published=true ⇒ message.success + onDone，且不再重复调用 API', async () => {
    const onDone = vi.fn();
    renderButton('sop_not_found', onDone);
    fireEvent.click(button()!);
    await waitFor(() => {
      expect(mockedMessage.success).toHaveBeenCalledTimes(1);
      expect(onDone).toHaveBeenCalledTimes(1);
    });
    expect(mockedAudit.retryRelease).toHaveBeenCalledTimes(1);
    expect(mockedMessage.error).not.toHaveBeenCalled();
  });

  it('⑤ published=false（业务失败，非抛错）⇒ 同样 success + onDone 收口', async () => {
    mockedAudit.retryRelease.mockResolvedValue({
      retried: true,
      published: false,
      reason: 'content_changed',
    } as never);
    const onDone = vi.fn();
    renderButton('content_changed', onDone);
    fireEvent.click(button()!);
    await waitFor(() => {
      expect(mockedMessage.success).toHaveBeenCalledTimes(1);
      expect(onDone).toHaveBeenCalledTimes(1);
    });
    expect(mockedMessage.error).not.toHaveBeenCalled();
  });

  it('⑥ loading 中按钮禁用，重复点击不再发第二个请求', async () => {
    let resolve!: (value: unknown) => void;
    mockedAudit.retryRelease.mockImplementation(
      () => new Promise((r) => { resolve = r; }) as never,
    );
    const onDone = vi.fn();
    renderButton('approval_not_consumed', onDone);
    fireEvent.click(button()!);

    await waitFor(() => {
      expect(mockedAudit.retryRelease).toHaveBeenCalledTimes(1);
      expect(button()!.disabled).toBe(true);
    });
    fireEvent.click(button()!);
    expect(mockedAudit.retryRelease).toHaveBeenCalledTimes(1);
    expect(onDone).not.toHaveBeenCalled();

    await act(async () => {
      resolve({ retried: true, published: true });
    });
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
  });

  it('⑦ 400/403 ⇒ message.error、组件不崩、onDone 不误报成功', async () => {
    const onDone = vi.fn();
    mockedAudit.retryRelease.mockRejectedValue({ response: { status: 400 } });
    renderButton('dependency_unavailable', onDone);
    expect(() => fireEvent.click(button()!)).not.toThrow();
    await waitFor(() => expect(mockedMessage.error).toHaveBeenCalledTimes(1));
    expect(mockedMessage.success).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
    expect(button()).toBeTruthy();
    expect(button()!.disabled).toBe(false);
  });

  it('⑧ 白名单外 publish_failed ⇒ 组件返回 null，根本不渲染按钮', () => {
    const view = renderButton('publish_failed');
    expect(button()).toBeNull();
    expect(view.container.innerHTML).toBe('');
    expect(mockedAudit.retryRelease).not.toHaveBeenCalled();
  });

  it('⑨ 未知 reason 同样返回 null', () => {
    const view = renderButton('totally_unknown_reason');
    expect(button()).toBeNull();
    expect(view.container.innerHTML).toBe('');
  });
});

describe('审计详情 Modal 挂载闸门（第 2 级，页面组件）', () => {
  const auditLog = (over: Record<string, unknown> = {}) => ({
    id: 1,
    action: 'sop_publish.release_failed',
    resource: 'agent_approval',
    resourceId: APPROVAL_KEY,
    userId: 1,
    username: 'root',
    ip: '10.0.0.1',
    result: 'failure',
    detail: { approvalKey: APPROVAL_KEY, reason: 'policy_fingerprint_unavailable' },
    createdAt: '2026-09-07T10:00:00Z',
    ...over,
  });

  function renderAuditPage(logs: unknown[]) {
    mockedClient.get.mockReset().mockResolvedValue({
      data: logs,
      total: logs.length,
    } as never);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/']}>
          <AuditLogPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  async function openDetail() {
    // 审计页把 action 翻成本地化标签，不能用原始 action 文本定位；
    // 直接找唯一「查看」按钮（与 audit-page.test.tsx 同口径）。
    await waitFor(() => {
      const buttons = (Array.from(document.querySelectorAll('button')) as HTMLButtonElement[])
        .filter((b) => (b.textContent ?? '').replace(/\s/g, '') === '查看');
      expect(buttons.length).toBe(1);
    });
    const viewButton = (Array.from(document.querySelectorAll('button')) as HTMLButtonElement[])
      .find((b) => (b.textContent ?? '').replace(/\s/g, '') === '查看')!;
    fireEvent.click(viewButton);
    await waitFor(() =>
      expect(document.querySelector('.ant-modal-title')).toBeTruthy(),
    );
  }

  it('⑩ action=release_failed 且 detail 齐全 ⇒ Modal 内挂按钮', async () => {
    renderAuditPage([auditLog()]);
    await openDetail();
    await waitFor(() => expect(screen.getByTestId('retry-release-button')).toBeTruthy());
  });

  it('⑪ 非 release_failed（即便 detail 齐全）⇒ Modal 不挂按钮', async () => {
    renderAuditPage([auditLog({ action: 'task.create', result: 'success' })]);
    await openDetail();
    expect(screen.queryByTestId('retry-release-button')).toBeNull();
  });

  it('⑫ release_failed 但 detail 缺 approvalKey/reason ⇒ Modal 不挂按钮', async () => {
    renderAuditPage([auditLog({ detail: { reason: 'policy_fingerprint_unavailable' } })]);
    await openDetail();
    expect(screen.queryByTestId('retry-release-button')).toBeNull();
  });
});
