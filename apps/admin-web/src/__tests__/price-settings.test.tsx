/**
 * N20 成本线 P1：设置页「价目表」Tab 的组件级回归。
 *
 * 钉住五条可失败的契约：
 *   ① 列渲染（provider/model/direction/price/currency）+ price-row 行标记；
 *   ② 真空态 = 空表 + 「暂无价目配置，点击新增」；
 *   ③ 新增/覆盖提交参数逐字等于后端 SetPriceDto（PUT upsert 语义）；
 *   ④ 保存失败上报错误、弹窗不关闭、不弹成功 toast；
 *   ⑤ 诚实标注常驻：零 token 样本时看板仍显示未折算 ≠ 价目缺失；
 *   附加：读取失败必须显示错误态，不能退化成空表伪装成功。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import PriceSettings from '../pages/settings/PriceSettings';
import { listPrices, setPrice, type PricingConfig } from '../api/capability-activation';
import { showApiError } from '../utils/error';
import { message } from '../utils/toast';

vi.mock('../api/capability-activation', () => ({
  listPrices: vi.fn(),
  setPrice: vi.fn(),
}));
vi.mock('../utils/error', async (importOriginal) => {
  // StateError 也用本模块的 translateByErrorCode/getErrMsg——部分 mock 保留其余导出。
  const actual = await importOriginal<typeof import('../utils/error')>();
  return { ...actual, showApiError: vi.fn() };
});
vi.mock('../utils/toast', () => ({
  message: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

// antd Table/Modal 在 jsdom 下需要 ResizeObserver（matchMedia 已由全局 setup 桩好）。
const g = globalThis as Record<string, unknown>;
if (!g.ResizeObserver) {
  g.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

const row: PricingConfig = {
  provider: 'openai',
  model: 'gpt-4o',
  direction: 'in',
  pricePerMillionTokens: 12.5,
  currency: 'CNY',
};

const mockedList = vi.mocked(listPrices);
const mockedSet = vi.mocked(setPrice);

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <PriceSettings />
    </QueryClientProvider>,
  );
}

async function openForm() {
  fireEvent.click(screen.getByTestId('price-add-btn'));
  await waitFor(() => expect(screen.getByTestId('price-form')).toBeTruthy());
}

/** 填写普通 Input；Select/Currency 用表单 initialValues（in / CNY），无需驱动下拉。 */
function fillText(id: string, value: string) {
  const input = document.getElementById(id);
  expect(input, `找不到字段 ${id}`).toBeTruthy();
  fireEvent.change(input as HTMLInputElement, { target: { value } });
  fireEvent.blur(input as HTMLInputElement);
}

function clickOk() {
  const ok = document.querySelector('.ant-modal-footer .ant-btn-primary') as HTMLElement | null;
  expect(ok).toBeTruthy();
  fireEvent.click(ok as HTMLElement);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedList.mockResolvedValue([row]);
  mockedSet.mockResolvedValue(row);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('PriceSettings 价目表 Tab', () => {
  it('① 列渲染：五列有值且每行带 price-row 标记', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId('price-table')).toBeTruthy());
    // Table 在 loading 首帧就已挂载——必须等数据行真正落地再断言列值。
    await waitFor(() => expect(screen.getAllByText('openai').length).toBeGreaterThan(0));
    // 表头与（未打开但仍挂载的）表单标签可能同名，故用 getAllByText。
    for (const label of ['提供方', '模型', '方向', '每百万 Token 单价', '币种']) {
      expect(screen.getAllByText(label).length, `缺少列：${label}`).toBeGreaterThan(0);
    }
    expect(screen.getAllByText('openai').length).toBeGreaterThan(0);
    expect(screen.getAllByText('gpt-4o').length).toBeGreaterThan(0);
    expect(screen.getAllByText('输入').length).toBeGreaterThan(0);
    expect(screen.getAllByText('12.5').length).toBeGreaterThan(0);
    expect(screen.getAllByText('CNY').length).toBeGreaterThan(0);
    expect(document.querySelectorAll('[data-testid="price-row"]').length).toBe(1);
  });

  it('② 空态：0 条价目显示提示，不伪装成加载失败', async () => {
    mockedList.mockResolvedValue([]);
    renderPage();
    await waitFor(() => expect(screen.getByTestId('price-table')).toBeTruthy());
    expect(screen.getByText('暂无价目配置，点击新增')).toBeTruthy();
    expect(screen.queryByText('价目表加载失败')).toBeNull();
  });

  it('③ 新增/覆盖：提交参数逐字等于 SetPriceDto，成功后刷新列表 + toast', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId('price-table')).toBeTruthy());
    await openForm();
    fillText('provider', 'acme');
    fillText('model', 'm-1');
    fillText('pricePerMillionTokens', '3.75');
    clickOk();

    await waitFor(() =>
      expect(mockedSet).toHaveBeenCalledWith({
        provider: 'acme',
        model: 'm-1',
        direction: 'in',
        pricePerMillionTokens: 3.75,
        currency: 'CNY',
      }),
    );
    await waitFor(() => expect(message.success).toHaveBeenCalledWith('价目已保存'));
    // 写后必须重取（PUT 是 upsert，列表可能新增一行或覆盖原价）。
    await waitFor(() => expect(mockedList.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it('④ 保存失败：上报后端错误、弹窗保留、不弹成功 toast', async () => {
    const boom = { message: '价目 provider 必须是非空字符串' };
    mockedSet.mockRejectedValue(boom);
    renderPage();
    await waitFor(() => expect(screen.getByTestId('price-table')).toBeTruthy());
    await openForm();
    fillText('provider', 'acme');
    fillText('model', 'm-1');
    fillText('pricePerMillionTokens', '3.75');
    clickOk();

    await waitFor(() => expect(showApiError).toHaveBeenCalledWith(boom, '保存价目失败'));
    expect(document.querySelector('.ant-modal')).toBeTruthy();
    expect(message.success).not.toHaveBeenCalled();
  });

  it('⑤ 诚实标注常驻：零样本不等于价目缺失', async () => {
    mockedList.mockResolvedValue([]);
    renderPage();
    await waitFor(() => expect(screen.getByTestId('price-table')).toBeTruthy());
    expect(screen.getByText(/价目用于 token 用量折算/)).toBeTruthy();
    expect(screen.getByText(/成本看板仍显示未折算/)).toBeTruthy();
    expect(screen.getByText(/不是价目缺失/)).toBeTruthy();
  });

  it('⑥ 读取失败：显示错误态而非空表（失败不得伪装成功）', async () => {
    mockedList.mockRejectedValue(new Error('403 Forbidden'));
    renderPage();
    await waitFor(() => expect(screen.getByText('价目表加载失败')).toBeTruthy());
    expect(screen.queryByTestId('price-table')).toBeNull();
    expect(screen.getByTestId('price-settings')).toBeTruthy();
    expect(screen.getByTestId('price-add-btn')).toBeTruthy();
  });

  it('⑦ 表单校验：非正数单价不得提交', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId('price-table')).toBeTruthy());
    await openForm();
    fillText('provider', 'acme');
    fillText('model', 'm-1');
    fillText('pricePerMillionTokens', '-1');
    clickOk();

    await waitFor(() => expect(screen.getByText('单价必须是正数')).toBeTruthy());
    expect(mockedSet).not.toHaveBeenCalled();
  });
});
