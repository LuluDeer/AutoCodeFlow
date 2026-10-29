/**
 * WEB-5（第 3 轮 web-ux 审计）：「模型接入与分配」不得把**读取失败**渲染成
 * 「没有配置任何模型」。
 *
 * 缺陷：`load()` 失败只弹一条 3 秒 toast，`data` 保持 null，页面就如实渲染成
 * 「providers 为空 + 分配下拉全空」。用户看到的是「没配模型」，实际是「没读到」
 * ——对一个配置页这是危险的误导：最可能的下一步是**重复添加一份 provider**
 * （密钥再录一次）或误判「推理能力未配置」而回滚版本。
 *
 * 本文件钉住三条（每条都能失败）：
 *   ① listProviders reject → 页内出现 StateError（含 `aiProviders.loadFailed`
 *      标题与重试按钮），且**不**出现空表（`.ant-table` / 「暂无数据」/「No data」）
 *      与分配区（「按用途选用模型」）——"空"不得被读成事实；
 *   ② 重试成功后错误态消失、表格回来（证明 onRetry 真的接上了 load）；
 *   ③ 对照组：**真空**结果（providers: []）仍然渲染空表 —— 说明 ① 里的
 *      「没有空表」不是因为空表永远不渲染，而是因为「读失败」走了错误分支。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import AiProvidersSettings from '../pages/settings/AiProvidersSettings';
import { aiApi } from '../api/ai';

// 隔离 api 层（底层 axios client 会拉起拦截器）；只留本页用到的四个方法。
vi.mock('../api/ai', () => ({
  aiApi: {
    listProviders: vi.fn(),
    saveProvider: vi.fn(),
    deleteProvider: vi.fn(),
    assignRoute: vi.fn(),
  },
}));

// jsdom 缺 antd Table/Select 依赖的浏览器 API，先行补齐
const g = globalThis as Record<string, unknown>;
if (!g.ResizeObserver) {
  g.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

/** 后端返回的空视图（结构同 AiProviderAdminView）。 */
const emptyView = {
  providers: [],
  errors: [],
  routes: {
    analysis: { provider: '', model: '', maxTokens: '', timeoutMs: '' },
    agent: { provider: '', model: '', maxTokens: '', timeoutMs: '' },
    video: { provider: '', model: '', maxTokens: '', timeoutMs: '' },
  },
};

beforeEach(() => {
  vi.mocked(aiApi.listProviders).mockReset();
});

afterEach(() => {
  cleanup();
});

/** 空表文案（antd 默认 en_US = "No data"，zh_CN = "暂无数据"）——两种都不许出现。 */
function expectNoEmptyTable() {
  expect(document.querySelector('.ant-table')).toBeNull();
  // queryAllBy*（不是 queryBy*）：antd Table 的占位文案会出现多处，
  // queryByText 在多命中时会抛错，用数量判定才是本意。
  expect(screen.queryAllByText('暂无数据')).toHaveLength(0);
  expect(screen.queryAllByText('No data')).toHaveLength(0);
}

describe('WEB-5：模型接入与分配 —— 读失败 ≠ 没配置', () => {
  it('① listProviders 失败 → 页内错误态 + 重试按钮，且不渲染空表与分配区', async () => {
    vi.mocked(aiApi.listProviders).mockRejectedValue(
      new Error('Request failed with status code 502'),
    );
    render(<AiProvidersSettings />);

    const err = await screen.findByTestId('state-error');
    // 标题走 i18n（zh 基线，test-setup 已钉 zh）
    expect(err.textContent).toContain('读取模型接入配置失败');
    // 错误本身要可见（不只是一个 3 秒后消失的 toast）
    expect(err.textContent).toContain('502');
    expect(screen.getByText('重试')).toBeTruthy();

    expectNoEmptyTable();
    // 分配区也不许渲染：「只有『跟随全局』的下拉」等价于「没有可用模型」
    expect(screen.queryByText('按用途选用模型')).toBeNull();
  });

  it('② 点重试 → 重新拉取，成功后错误态消失、表格回来', async () => {
    vi.mocked(aiApi.listProviders)
      .mockRejectedValueOnce(new Error('502'))
      .mockResolvedValueOnce(emptyView as never);
    render(<AiProvidersSettings />);

    await screen.findByTestId('state-error');
    fireEvent.click(screen.getByText('重试'));

    await waitFor(() => expect(screen.queryByTestId('state-error')).toBeNull());
    expect(aiApi.listProviders).toHaveBeenCalledTimes(2);
    expect(document.querySelector('.ant-table')).toBeTruthy();
    expect(screen.getByText('按用途选用模型')).toBeTruthy();
  });

  it('③ 对照组：真正的空结果仍渲染空表（空态与错误态不是一回事）', async () => {
    vi.mocked(aiApi.listProviders).mockResolvedValue(emptyView as never);
    render(<AiProvidersSettings />);

    await waitFor(() => expect(document.querySelector('.ant-table')).toBeTruthy());
    expect(screen.queryByTestId('state-error')).toBeNull();
    // 空表在场（antd 空态文案随 locale 二选一）
    const emptyHint =
      screen.queryAllByText('暂无数据').length + screen.queryAllByText('No data').length;
    expect(emptyHint).toBeGreaterThan(0);
    expect(screen.getByText('按用途选用模型')).toBeTruthy();
  });
});
