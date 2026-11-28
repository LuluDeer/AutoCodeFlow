/**
 * WEBUX-TURNAROUND：SSE 首次建连失败进入轮询时，降级横幅不得依赖 detail 已落地。
 * 验收级别：单测 / 内存替身（hook 被 mock，不触网）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { setLanguage } from '../i18n';
import WorkbenchPage from '../pages/WorkbenchPage';

const formFixture = vi.hoisted(() => ({
  goal: '',
  setGoal: vi.fn(),
  cadence: 'once' as const,
  setCadence: vi.fn(),
  paramText: '',
  setParamText: vi.fn(),
  result: null,
  canConfirm: false,
  committing: false,
  commitError: null,
  handleConfirm: vi.fn(),
  commitResult: null,
  approvalStatus: 'none',
  approvalKey: '',
  isAdmin: false,
  error: null,
  previewing: false,
  handlePreview: vi.fn(),
  records: [],
}));

vi.mock('../hooks/workbench-form', () => ({
  useWorkbenchForm: () => formFixture,
}));

vi.mock('../hooks/useWorkbenchSession', () => ({
  readWorkbenchAnchor: () => null,
  sessionAnchor: () => null,
  useWorkbenchSession: () => ({
    sessions: [],
    sessionsState: 'ready',
    sessionsError: null,
    reset: vi.fn(),
    startChat: vi.fn(),
    sendMessage: vi.fn(),
    detail: null,
    streamStatus: 'polling',
    sessionId: null,
    startingChat: false,
    decideApproval: vi.fn(),
    cancel: vi.fn(),
    error: null,
    actionError: null,
    starting: false,
    session: null,
    restore: vi.fn(),
    reloadSessions: vi.fn(),
  }),
}));

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
    matches: false, media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

beforeEach(async () => {
  await setLanguage('zh');
});

afterEach(async () => {
  cleanup();
  await setLanguage('zh');
});

describe('工作台降级横幅', () => {
  it('polling + detail=null 仍显示降级横幅；LegacyFlow 默认折叠并标注 Advanced', () => {
    // 切片 E1 后 WorkbenchPage 依赖 Router 上下文（useNavigate），渲染需包 MemoryRouter。
    render(<MemoryRouter><WorkbenchPage /></MemoryRouter>);
    expect(screen.getByText('实时连接暂不可用，已切换为定时刷新。')).toBeTruthy();
    expect(screen.getByText('旧版草稿入口 / Advanced')).toBeTruthy();
    expect(screen.getByText(/仅需要旧版方案预览\/确认流程时展开此处/)).toBeTruthy();
  });
});
