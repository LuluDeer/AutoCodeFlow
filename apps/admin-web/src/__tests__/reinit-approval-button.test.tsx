/**
 * 审批发起失败 → 管理员重新发起审批（R92 跨角色闭环最后一跳）。
 *
 * 组件级第 2 级：按钮渲染闸门、点击参数（bump 不传）、成功/400/403 toast、
 * loading 防重、onDone 刷新，以及审计详情 Footer 的 action + detail 判据。
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

import ReinitApprovalButton from '../components/audit/ReinitApprovalButton';
import AuditDetailFooter from '../components/audit/AuditDetailFooter';
import { auditApi } from '../api/audit';
import { message } from '../utils/toast';

vi.mock('../api/audit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/audit')>()),
  auditApi: { retryRelease: vi.fn(), requestReleaseRetry: vi.fn() },
}));
vi.mock('../utils/toast', () => ({
  message: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

const mockedAudit = vi.mocked(auditApi, true);
const mockedMessage = vi.mocked(message, true);

const SOP_ID = 'sop-e2e-reinit-0001';
const CARD_HASH = 'cardhash-e2e-reinit-0001';
const CONTENT_HASH = 'contenthash-e2e-reinit-0001';
const SUCCESS_TEXT = '审批已重新发起，主管可在收件箱看到发布审批卡';
const HASH_MISMATCH = 'contentHash 与服务端从 draft 重算的结果不一致（内容已变更或入参被篡改）';

const button = () =>
  screen.queryByTestId('reinit-approval-button') as HTMLButtonElement | null;

function renderButton(onDone: () => void = vi.fn()) {
  return render(
    <ReinitApprovalButton
      sopId={SOP_ID}
      cardHash={CARD_HASH}
      contentHash={CONTENT_HASH}
      onDone={onDone}
    />,
  );
}

beforeEach(() => {
  mockedAudit.requestReleaseRetry.mockReset().mockResolvedValue({
    approvalKey: 'apr-e2e-reinit-0001',
    sessionId: 'session-e2e-reinit-0001',
    retried: true,
  } as never);
  mockedMessage.success.mockReset();
  mockedMessage.error.mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ReinitApprovalButton 点击路径', () => {
  it('① 渲染 data-testid 契约按钮', () => {
    renderButton();
    expect(button()).toBeTruthy();
    expect(button()!.getAttribute('data-testid')).toBe('reinit-approval-button');
    expect(button()!.textContent).toContain('重新发起审批');
  });

  it('② 点击 ⇒ requestReleaseRetry({sopId, cardHash, contentHash})，不传 bump', async () => {
    renderButton();
    fireEvent.click(button()!);
    await waitFor(() => {
      expect(mockedAudit.requestReleaseRetry).toHaveBeenCalledTimes(1);
    });
    expect(mockedAudit.requestReleaseRetry).toHaveBeenCalledWith({
      sopId: SOP_ID,
      cardHash: CARD_HASH,
      contentHash: CONTENT_HASH,
    });
    expect(mockedAudit.requestReleaseRetry.mock.calls[0][0]).not.toHaveProperty('bump');
  });

  it('③ 成功 ⇒ success 文案 + onDone 刷新，不弹 error', async () => {
    const onDone = vi.fn();
    renderButton(onDone);
    fireEvent.click(button()!);
    await waitFor(() => {
      expect(mockedMessage.success).toHaveBeenCalledTimes(1);
      expect(onDone).toHaveBeenCalledTimes(1);
    });
    expect(mockedMessage.success).toHaveBeenCalledWith(SUCCESS_TEXT);
    expect(mockedMessage.error).not.toHaveBeenCalled();
  });

  it('④ 400（contentHash 不符）⇒ 显示后端 detail，不误报成功、不刷新', async () => {
    const onDone = vi.fn();
    mockedAudit.requestReleaseRetry.mockRejectedValue({
      response: { status: 400, data: { detail: HASH_MISMATCH } },
    });
    renderButton(onDone);
    expect(() => fireEvent.click(button()!)).not.toThrow();
    await waitFor(() => expect(mockedMessage.error).toHaveBeenCalledTimes(1));
    expect(mockedMessage.error).toHaveBeenCalledWith(HASH_MISMATCH);
    expect(mockedMessage.success).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
  });

  it('⑤ 403 ⇒ 显示无权限提示，不暴露框架样板串', async () => {
    const onDone = vi.fn();
    mockedAudit.requestReleaseRetry.mockRejectedValue({
      response: { status: 403, data: { message: 'Forbidden resource' } },
    });
    renderButton(onDone);
    fireEvent.click(button()!);
    await waitFor(() => expect(mockedMessage.error).toHaveBeenCalledTimes(1));
    expect(mockedMessage.error).toHaveBeenCalledWith(expect.stringContaining('无权限'));
    expect(mockedMessage.success).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
  });

  it('⑥ loading 中按钮禁用，重复点击不再发第二个请求', async () => {
    let resolve!: (value: unknown) => void;
    mockedAudit.requestReleaseRetry.mockImplementation(
      () => new Promise((r) => { resolve = r; }) as never,
    );
    const onDone = vi.fn();
    renderButton(onDone);
    fireEvent.click(button()!);
    await waitFor(() => {
      expect(mockedAudit.requestReleaseRetry).toHaveBeenCalledTimes(1);
      expect(button()!.disabled).toBe(true);
    });
    fireEvent.click(button()!);
    expect(mockedAudit.requestReleaseRetry).toHaveBeenCalledTimes(1);
    expect(onDone).not.toHaveBeenCalled();

    await act(async () => {
      resolve({ approvalKey: 'apr-1', sessionId: 's-1', retried: true });
    });
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(button()!.disabled).toBe(false);
  });
});

describe('审计详情 Footer 挂载闸门', () => {
  const detail = {
    sopId: SOP_ID,
    cardHash: CARD_HASH,
    contentHash: CONTENT_HASH,
    requestedBy: 'root',
    attempt: 'initial',
  };

  it('⑦ approval_request_failed + 三字段齐全 ⇒ 挂重新发起按钮', () => {
    render(
      <AuditDetailFooter
        action="sop_publish.approval_request_failed"
        detail={detail}
        onRetryDone={vi.fn()}
      />,
    );
    expect(button()).toBeTruthy();
  });

  it('⑧ 非 approval_request_failed（即便 detail 齐全）⇒ 不挂按钮', () => {
    render(<AuditDetailFooter action="sop.publish" detail={detail} onRetryDone={vi.fn()} />);
    expect(button()).toBeNull();
  });

  it('⑨ detail 缺 contentHash（非 string）⇒ 不挂按钮', () => {
    render(
      <AuditDetailFooter
        action="sop_publish.approval_request_failed"
        detail={{ sopId: SOP_ID, cardHash: CARD_HASH, contentHash: 42 }}
        onRetryDone={vi.fn()}
      />,
    );
    expect(button()).toBeNull();
  });

  it('⑩ 既有 release_failed 分支仍挂旧重试按钮，不受影响', () => {
    render(
      <AuditDetailFooter
        action="sop_publish.release_failed"
        detail={{ approvalKey: 'apr-1', reason: 'content_changed' }}
        onRetryDone={vi.fn()}
      />,
    );
    expect(screen.getByTestId('retry-release-button')).toBeTruthy();
    expect(button()).toBeNull();
  });
});
