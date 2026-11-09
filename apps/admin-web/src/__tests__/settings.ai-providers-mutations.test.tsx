/**
 * B0（Round 2 web-hardening）：`AiProvidersSettings` 的**写操作**分支回归。
 *
 * ── 为什么是这条盲区 ───────────────────────────────────────────────────
 * 该文件是全仓 settings 子页里覆盖率最低的一个（实测 stmt 58% / func 50%）。
 * 既有 `settings.ai-providers-load-error.test.tsx` 已把**读取失败**那条线钉死
 * （StateError 原位错误态 + 重试 + 「真空 ≠ 读失败」的对照组），但**写操作**
 * （save / remove / assign）的**失败分支**仍无覆盖——而这几个 catch 分支恰恰是
 * 最容易腐烂的地方：
 *
 *   · 删除失败若误把 `data` 置空，页面就退化成「没有任何 provider」——用户会
 *     以为删成功了（本页的 `data` 就是唯一事实源，`:117-126`）；
 *   · 删除失败若吞掉错误（不 showApiError），用户点了「确定」后界面毫无反应；
 *   · 保存失败若提前 `setEditing(null)`，用户填的表单被清空、错误也被关掉，
 *     等于把一次失败伪装成成功。
 *
 * 本文件钉住三条（每条都能失败）：
 *   ① 删除**成功** → `deleteProvider(id)` 被调用，且页面渲染**新**列表（后端
 *      返回值即新事实源，不是本地删行）；
 *   ② 删除**失败** → 上报错误（`showApiError`），且**列表原样保留**、不出现
 *      空表（失败不得被读成「删光了」）；
 *   ③ 保存**失败** → 上报错误，且**编辑弹窗不关闭**（用户输入不丢）。
 *
 * 刻意不测：antd `Select` 的 onChange（jsdom 下驱动 antd v6 下拉需要
 * mouseDown + option 命中，脆且与本盲区无关）；`assign` 的失败分支结构与
 * `remove` 同型（`try/catch + showApiError`），由 ② 代表。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import AiProvidersSettings from '../pages/settings/AiProvidersSettings';
import { aiApi } from '../api/ai';
import { showApiError } from '../utils/error';
import { message } from '../utils/toast';

vi.mock('../api/ai', () => ({
  aiApi: {
    listProviders: vi.fn(),
    saveProvider: vi.fn(),
    deleteProvider: vi.fn(),
    assignRoute: vi.fn(),
  },
}));

// 错误上报与成功提示都桩掉：本文件只关心「状态机是否走对分支」，
// 不关心 toast 长什么样（那是 message 组件自己的测试）。
vi.mock('../utils/error', () => ({ showApiError: vi.fn() }));
vi.mock('../utils/toast', () => ({
  message: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

// jsdom 缺 antd Table/Modal 依赖的浏览器 API（既有先例 shim）。
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

const provider = (id: string, label: string) => ({
  id,
  label,
  baseUrl: 'https://api.example.test/v1',
  model: 'm-1',
  maxTokens: 4096,
  timeoutMs: 60000,
  supportsVideo: false,
  enabled: true,
  hasApiKey: true,
});

const viewOf = (providers: ReturnType<typeof provider>[]) => ({
  providers,
  errors: [],
  routes: {
    analysis: { provider: '', model: '', maxTokens: '', timeoutMs: '' },
    agent: { provider: '', model: '', maxTokens: '', timeoutMs: '' },
    video: { provider: '', model: '', maxTokens: '', timeoutMs: '' },
  },
});

const mockedAi = vi.mocked(aiApi, true);

beforeEach(() => {
  vi.clearAllMocks();
  mockedAi.listProviders.mockResolvedValue(viewOf([provider('p-1', '主端点')]) as never);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** 等首屏加载完成（表格里出现 provider 的 id）。 */
async function renderLoaded() {
  render(<AiProvidersSettings />);
  await waitFor(() => expect(screen.getAllByText('p-1').length).toBeGreaterThan(0));
}

/** 点某行的「删除」并在 Modal.confirm 里确认。 */
async function confirmDelete(label: string) {
  const rows = screen.getAllByRole('button', { name: new RegExp(label) });
  fireEvent.click(rows[rows.length - 1]);
  // antd Modal.confirm 是命令式渲染：等确定按钮出现再点。
  const ok = await waitFor(() => {
    const btn = document.querySelector('.ant-modal-confirm-btns .ant-btn-primary');
    expect(btn).toBeTruthy();
    return btn as HTMLElement;
  });
  fireEvent.click(ok);
}

describe('AiProvidersSettings 写操作分支', () => {
  it('① 删除成功：调 deleteProvider(id)，页面渲染后端返回的新列表', async () => {
    await renderLoaded();
    // 后端返回「已删掉 p-1、只剩 p-2」——证明页面用的是**返回值**，不是本地删行。
    mockedAi.deleteProvider.mockResolvedValue(viewOf([provider('p-2', '备用端点')]) as never);

    await confirmDelete('删除');

    await waitFor(() => expect(mockedAi.deleteProvider).toHaveBeenCalledWith('p-1'));
    // 新列表落地：p-2 出现，p-1 消失
    await waitFor(() =>
      expect(screen.getAllByText('p-2').length).toBeGreaterThan(0),
    );
    expect(screen.queryByText('p-1')).toBeNull();
  });

  it('② 删除失败：上报错误且列表原样保留（失败不得被读成「删光了」）', async () => {
    await renderLoaded();
    const boom = new Error('409 该 provider 仍被引用');
    mockedAi.deleteProvider.mockRejectedValue(boom);

    await confirmDelete('删除');

    await waitFor(() => expect(showApiError).toHaveBeenCalledWith(boom));
    // 关键断言：列表**没有**被置空，p-1 仍在（否则用户误以为删成功）
    expect(screen.getAllByText('p-1').length).toBeGreaterThan(0);
    // 也没有退化成「读失败」的错误态
    expect(screen.queryByText(/加载失败|读取失败|loadFailed/)).toBeNull();
  });

  it('③ 保存失败：上报错误且编辑弹窗不关闭（用户输入不丢）', async () => {
    await renderLoaded();
    const boom = new Error('400 baseUrl 不可达');
    mockedAi.saveProvider.mockRejectedValue(boom);

    // 打开「编辑」弹窗（第一行）
    const editBtns = screen.getAllByRole('button', { name: /编辑/ });
    fireEvent.click(editBtns[0]);
    await waitFor(() => expect(document.querySelector('.ant-modal')).toBeTruthy());

    // 点弹窗里的「保存」/OK：antd Form 会先 validateFields，必填项已由
    // openEditor 的 setFieldsValue 预填（row 的所有字段），故能落到 saveProvider。
    const modalFooterBtns = Array.from(
      document.querySelectorAll('.ant-modal-footer .ant-btn'),
    ) as HTMLElement[];
    const saveBtn = modalFooterBtns[modalFooterBtns.length - 1];
    expect(saveBtn).toBeTruthy();
    fireEvent.click(saveBtn);

    await waitFor(() => expect(showApiError).toHaveBeenCalledWith(boom));
    // 关键断言：弹窗仍在（setEditing(null) 只在成功分支），表单内容没被清掉
    expect(document.querySelector('.ant-modal')).toBeTruthy();
    expect(message.success).not.toHaveBeenCalled();
  });
});
