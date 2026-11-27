import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { setLanguage } from '../i18n';
import { normalizeAgentEvent } from '../api/desktop-bridge';
import DesktopAgentStrip from '../components/workbench/DesktopAgentStrip';

const g = globalThis as Record<string, unknown>;
if (!g.ResizeObserver) {
  g.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

type Emit = (payload: unknown) => void;

function installBridge(options: {
  emit?: Emit;
  unsubscribe?: () => void;
  getRecentAgentEvents?: () => unknown;
} = {}) {
  const unsubscribe = options.unsubscribe ?? vi.fn();
  const bridge = {
    pickLocalFiles: vi.fn(async () => []),
    getDesktopContext: vi.fn(async () => ({
      executorName: '本机A',
      agentEnabled: true,
      platformConfigured: true,
      token: 'SECRET_TOKEN_SHOULD_NOT_RENDER',
      workDir: '/tmp/secret/path',
    })),
    getRecentAgentEvents: vi.fn(options.getRecentAgentEvents ?? (async () => [
      {
        assignmentId: '',
        type: 'status',
        summary: '非法事件',
        timestamp: 't0',
      },
      {
        assignmentId: 'a-1',
        type: 'status',
        summary: '开始处理指派',
        detail: '准备中',
        timestamp: 't1',
        extra: 'IGNORED_REPLAY_FIELD',
      },
    ])),
    onAgentEvent: vi.fn((listener: Emit) => {
      emitRef.current = listener;
      return unsubscribe;
    }),
    cancelAgentAssignment: vi.fn(async () => ({ ok: true })),
  };
  (window as unknown as { workbenchApi?: unknown }).workbenchApi = bridge;
  return { bridge, unsubscribe };
}

const emitRef: { current: Emit | null } = { current: null };

function clearBridge() {
  delete (window as unknown as { workbenchApi?: unknown }).workbenchApi;
  emitRef.current = null;
}

beforeEach(async () => {
  await setLanguage('zh');
});

afterEach(() => {
  cleanup();
  clearBridge();
  vi.restoreAllMocks();
});

describe('桌面 Agent 状态条', () => {
  it('无桥时不渲染任何桌面状态条', () => {
    clearBridge();
    const { container } = render(<DesktopAgentStrip />);
    expect(container.querySelector('[data-testid="desktop-agent-strip"]')).toBeNull();
  });

  it('有桥时读取上下文/回放/订阅，事件白名单后以纯文本展示，取消后卸载退订', async () => {
    const unsubscribe = vi.fn();
    const { bridge } = installBridge({ unsubscribe });
    const { container, unmount } = render(<DesktopAgentStrip />);

    await waitFor(() => expect(screen.getByTestId('desktop-agent-executor').textContent).toContain('本机A'));
    expect(bridge.getDesktopContext).toHaveBeenCalledTimes(1);
    expect(bridge.getRecentAgentEvents).toHaveBeenCalledTimes(1);
    expect(bridge.onAgentEvent).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('desktop-agent-enabled').textContent).toContain('Agent 已启用');
    expect(screen.getByTestId('desktop-agent-platform').textContent).toContain('平台已配置');
    expect(screen.getByTestId('desktop-agent-events').textContent).toContain('开始处理指派');
    expect(container.textContent).not.toContain('SECRET_TOKEN_SHOULD_NOT_RENDER');
    expect(container.textContent).not.toContain('/tmp/secret/path');
    expect(container.textContent).not.toContain('IGNORED_REPLAY_FIELD');
    expect(screen.queryByText('非法事件')).toBeNull();

    expect(emitRef.current).toBeTypeOf('function');
    await act(async () => {
      emitRef.current?.({
        assignmentId: 'a-1',
        type: 'phase',
        summary: '<script>alert(1)</script>',
        detail: '<img src=x onerror=alert(1)>',
        timestamp: 't2',
        malicious: 'IGNORED_LIVE_FIELD',
      });
    });

    const eventsText = screen.getByTestId('desktop-agent-events').textContent ?? '';
    expect(eventsText).toContain('<script>alert(1)</script>');
    expect(eventsText).toContain('<img src=x onerror=alert(1)>');
    expect(eventsText).not.toContain('IGNORED_LIVE_FIELD');
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();

    const cancel = screen.getByTestId('desktop-agent-cancel');
    fireEvent.click(cancel);
    await waitFor(() => expect(bridge.cancelAgentAssignment).toHaveBeenCalledWith('a-1'));
    await waitFor(() => expect(screen.queryByTestId('desktop-agent-cancel')).toBeNull());

    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('没有运行中事件时不显示取消本机指派', async () => {
    installBridge({
      getRecentAgentEvents: async () => [{
        assignmentId: 'a-1',
        type: 'status',
        summary: '指派处理结束：succeeded',
        timestamp: 't1',
      }],
    });
    render(<DesktopAgentStrip />);
    await waitFor(() => expect(screen.getByTestId('desktop-agent-events').textContent).toContain('指派处理结束'));
    expect(screen.queryByTestId('desktop-agent-cancel')).toBeNull();
  });

  it('事件 payload 仅保留白名单字段，非法类型/字段直接丢弃', () => {
    const valid = {
      assignmentId: 'a-1',
      type: 'status',
      summary: '开始处理指派',
      detail: '细节',
      timestamp: 't1',
      extra: 'IGNORED',
      __proto__: { polluted: true },
    };
    expect(normalizeAgentEvent(valid)).toEqual({
      assignmentId: 'a-1',
      type: 'status',
      summary: '开始处理指派',
      detail: '细节',
      timestamp: 't1',
    });
    expect(normalizeAgentEvent({ ...valid, type: 'exec' })).toBeNull();
    expect(normalizeAgentEvent({ ...valid, detail: { nested: true } })).toBeNull();
    expect(normalizeAgentEvent({ ...valid, summary: 42 })).toBeNull();
    expect(normalizeAgentEvent(null)).toBeNull();
  });
});
