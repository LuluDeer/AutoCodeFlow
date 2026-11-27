/**
 * 工作台审批处置：后端 applied=false ⇒ ok:false 必须如实提示，不再 refresh 成假成功。
 * 验收级别：单测 / 内存替身（api/workbench + live-session hook 被 mock，不触网）。
 */
import { useEffect } from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLanguage } from '../i18n';
import type { WorkbenchSessionDetail } from '../pages/workbench/types-public';
import { useWorkbenchSession } from '../hooks/useWorkbenchSession';
import { decideWorkbenchApproval, getWorkbenchSession, listWorkbenchSessions } from '../api/workbench';
import { useWorkbenchLiveSession } from '../hooks/workbench/useWorkbenchLiveSession';

vi.mock('../api/workbench', () => ({
  decideWorkbenchApproval: vi.fn(),
  getWorkbenchSession: vi.fn(),
  listWorkbenchSessions: vi.fn(),
}));

vi.mock('../hooks/workbench/useWorkbenchLiveSession', () => ({
  useWorkbenchLiveSession: vi.fn(),
}));

const APPROVAL_KEY = 'apr-9f8e7d6c5b4a3210';
const SESSION_ID = 'sess-approval-result';

const detailFixture: WorkbenchSessionDetail = {
  sessionId: SESSION_ID,
  kind: 'sop_authoring',
  status: 'waiting_input',
  stepCount: 0,
  steps: [],
  toolCallCount: 0,
  toolCalls: [],
  approvals: { pending: 1 },
  approvalItems: [{
    approvalKey: APPROVAL_KEY,
    toolName: 'publish',
    status: 'pending',
    reason: null,
    decidedBy: null,
    createdAt: null,
    canDecide: true,
    canWithdraw: false,
    reviewUrl: null,
  }],
  artifacts: [],
};

// 给 hook 一个真实 detail：mock 掉 SSE 协作体，只在挂载时写一次快照。
vi.mocked(useWorkbenchLiveSession).mockImplementation(({ setDetail }) => {
  useEffect(() => { setDetail(detailFixture); }, [setDetail]);
});

function mount() {
  return renderHook(() => useWorkbenchSession(() => null));
}

beforeEach(async () => {
  await setLanguage('zh');
  vi.mocked(listWorkbenchSessions).mockResolvedValue({ items: [], total: 0 });
  // refreshActive 的读回：返回同一个待批快照，只用来数「是否发生刷新」。
  vi.mocked(getWorkbenchSession).mockResolvedValue(detailFixture as Awaited<ReturnType<typeof getWorkbenchSession>>);
});

afterEach(async () => {
  cleanup();
  vi.clearAllMocks();
  await setLanguage('zh');
});

describe('工作台审批处置的 ok 消费', () => {
  it('ok:false（无 reason）→ actionError 出现、不 refresh（不制造假成功）', async () => {
    vi.mocked(decideWorkbenchApproval).mockResolvedValue({ ok: false, sessionId: SESSION_ID });
    const { result } = mount();
    await act(async () => {});
    expect(result.current.detail?.sessionId).toBe(SESSION_ID);
    vi.mocked(getWorkbenchSession).mockClear();

    await act(async () => {
      await result.current.decideApproval(APPROVAL_KEY, 'grant');
    });

    expect(result.current.actionError).toBe(`审批单处置失败（${APPROVAL_KEY}）`);
    expect(getWorkbenchSession).not.toHaveBeenCalled();
  });

  it('ok:false 带后端 reason → 原样展示 reason、不 refresh', async () => {
    vi.mocked(decideWorkbenchApproval).mockResolvedValue({
      ok: false, sessionId: SESSION_ID, reason: '审批单已被处置，请刷新后重试',
    } as never);
    const { result } = mount();
    await act(async () => {});
    vi.mocked(getWorkbenchSession).mockClear();

    await act(async () => {
      await result.current.decideApproval(APPROVAL_KEY, 'deny');
    });

    expect(result.current.actionError).toBe('审批单已被处置，请刷新后重试');
    expect(getWorkbenchSession).not.toHaveBeenCalled();
  });

  it('ok:true → actionError 清空且照常 refresh', async () => {
    vi.mocked(decideWorkbenchApproval).mockResolvedValue({ ok: true, sessionId: SESSION_ID });
    const { result } = mount();
    await act(async () => {});
    vi.mocked(getWorkbenchSession).mockClear();

    await act(async () => {
      await result.current.decideApproval(APPROVAL_KEY, 'grant');
    });

    expect(result.current.actionError).toBeNull();
    expect(getWorkbenchSession).toHaveBeenCalledTimes(1);
    expect(getWorkbenchSession).toHaveBeenCalledWith(SESSION_ID);
  });

  it('已处置深链重复点击：首次 ok:true 成功，二次 ok:false 报错且不再 refresh', async () => {
    vi.mocked(decideWorkbenchApproval)
      .mockResolvedValueOnce({ ok: true, sessionId: SESSION_ID })
      .mockResolvedValueOnce({ ok: false, sessionId: SESSION_ID });
    const { result } = mount();
    await act(async () => {});
    vi.mocked(getWorkbenchSession).mockClear();

    await act(async () => {
      await result.current.decideApproval(APPROVAL_KEY, 'grant');
    });
    expect(result.current.actionError).toBeNull();
    expect(getWorkbenchSession).toHaveBeenCalledTimes(1);

    await act(async () => {
      await result.current.decideApproval(APPROVAL_KEY, 'grant');
    });
    expect(result.current.actionError).toBe(`审批单处置失败（${APPROVAL_KEY}）`);
    // 第二次没有触发第三次读取——不会把「已处置」刷成假成功。
    expect(getWorkbenchSession).toHaveBeenCalledTimes(1);
    expect(decideWorkbenchApproval).toHaveBeenCalledTimes(2);
  });
});
