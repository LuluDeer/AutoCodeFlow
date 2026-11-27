import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { setLanguage } from '../i18n';
import { getDesktopBridge } from '../api/desktop-bridge';
import WorkbenchComposer from '../components/workbench/WorkbenchComposer';

const g = globalThis as Record<string, unknown>;
if (!g.ResizeObserver) {
  g.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

type BridgeStub = {
  pickLocalFiles: ReturnType<typeof vi.fn>;
  getDesktopContext: ReturnType<typeof vi.fn>;
  getRecentAgentEvents: ReturnType<typeof vi.fn>;
  onAgentEvent: ReturnType<typeof vi.fn>;
  cancelAgentAssignment: ReturnType<typeof vi.fn>;
};

function installBridge(overrides: Partial<BridgeStub> = {}): BridgeStub {
  const bridge: BridgeStub = {
    pickLocalFiles: vi.fn(async () => []),
    getDesktopContext: vi.fn(async () => ({})),
    getRecentAgentEvents: vi.fn(async () => []),
    onAgentEvent: vi.fn(() => () => {}),
    cancelAgentAssignment: vi.fn(async () => ({ ok: true })),
    ...overrides,
  };
  (window as unknown as { workbenchApi?: unknown }).workbenchApi = bridge;
  return bridge;
}

function clearBridge() {
  delete (window as unknown as { workbenchApi?: unknown }).workbenchApi;
}

beforeEach(async () => {
  await setLanguage('zh');
});

afterEach(() => {
  cleanup();
  clearBridge();
  vi.restoreAllMocks();
});

describe('工作台附件：桌面桥与 Web 回退', () => {
  it('无桥或桥方法不全时 getDesktopBridge 返回 null，附件按钮保留 input 路径', () => {
    clearBridge();
    expect(getDesktopBridge()).toBeNull();

    const { getByTestId } = render(<WorkbenchComposer onSend={vi.fn()} onCancel={vi.fn()} running={false} sending={false} />);
    const input = getByTestId('workbench-composer-file');
    const clickSpy = vi.spyOn(input as HTMLInputElement, 'click');
    fireEvent.click(screen.getByRole('button', { name: '附件' }));
    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it('桥方法不全时不进入桌面分支', () => {
    (window as unknown as { workbenchApi?: unknown }).workbenchApi = {
      pickLocalFiles: vi.fn(),
      getDesktopContext: vi.fn(),
    };
    expect(getDesktopBridge()).toBeNull();

    const { getByTestId } = render(<WorkbenchComposer onSend={vi.fn()} onCancel={vi.fn()} running={false} sending={false} />);
    const input = getByTestId('workbench-composer-file');
    const clickSpy = vi.spyOn(input as HTMLInputElement, 'click');
    fireEvent.click(screen.getByRole('button', { name: '附件' }));
    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it('有桥时调用 pickLocalFiles，写入 attachmentNames；textPreview 仅本地展示且不进请求', async () => {
    const pickLocalFiles = vi.fn(async () => [
      { name: 'report.txt', size: 12, mimeType: 'text/plain', textPreview: 'preview-alpha' },
      { name: 'notes.txt', size: 8, mimeType: 'text/plain', textPreview: '<img src=x onerror=alert(1)>' },
      { name: '', textPreview: 'ignored' },
      { size: 1, textPreview: 'ignored' },
      null,
    ]);
    installBridge({ pickLocalFiles });
    const onSend = vi.fn();
    const { container, getByTestId } = render(<WorkbenchComposer onSend={onSend} onCancel={vi.fn()} running={false} sending={false} />);
    const input = getByTestId('workbench-composer-file');
    const clickSpy = vi.spyOn(input as HTMLInputElement, 'click');

    fireEvent.click(screen.getByRole('button', { name: '附件' }));
    await screen.findByText('report.txt');

    expect(pickLocalFiles).toHaveBeenCalledTimes(1);
    expect(clickSpy).not.toHaveBeenCalled();
    expect(screen.getByText('notes.txt')).toBeTruthy();
    expect(screen.queryByText('ignored')).toBeNull();
    expect(container.textContent).toContain('preview-alpha');
    expect(container.querySelector('img')).toBeNull();

    fireEvent.change(getByTestId('workbench-composer-input'), { target: { value: '分析附件' } });
    fireEvent.click(getByTestId('workbench-send'));
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));

    const draft = onSend.mock.calls[0][0] as {
      prompt: string;
      attachmentNames: string[];
    };
    expect(draft.attachmentNames).toEqual(['report.txt', 'notes.txt']);
    const serialized = JSON.stringify(draft);
    expect(serialized).not.toContain('textPreview');
    expect(serialized).not.toContain('preview-alpha');
    expect(serialized).not.toContain('onerror=alert(1)');
  });
});
