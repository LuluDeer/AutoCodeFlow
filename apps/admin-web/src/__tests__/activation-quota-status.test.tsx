/**
 * 配额状态面板单测（内存替身级）：
 * 金额不可得必须诚实显示"硬闸已跳过"，绝不出现 ¥0.00 / 未超限暗示；
 * 金额可得、invocations 三态徽标、空态与错误 Alert 各自钉住。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ActivationStatsPage from '../pages/ActivationStatsPage';
import {
  getActivationStats,
  getQuotaStatus,
  type ActivationStats,
  type QuotaStatusRow,
} from '../api/capability-activation';

vi.mock('../api/capability-activation', () => ({
  getActivationStats: vi.fn(),
  getQuotaStatus: vi.fn(),
}));

vi.mock('antd', async (importOriginal) => {
  const actual = await importOriginal<typeof import('antd')>();
  return {
    ...actual,
    DatePicker: {
      ...actual.DatePicker,
      RangePicker: () => <div data-testid="stats-range" />,
    },
  };
});

const STATS_SAMPLE: ActivationStats = {
  total: 1,
  byCapability: [
    { capabilityKey: 'browser', count: 1, success: 1, failure: 0, blocked: 0 },
  ],
  byProject: [],
};

const INVOCATION_ROW = (
  target: string,
  status: QuotaStatusRow['status'],
  usage: number,
): QuotaStatusRow => ({
  scope: 'capability',
  target,
  softLimit: 5,
  hardLimit: 10,
  usage,
  status,
  windowDays: 30,
  unit: 'invocations',
});

function renderPage() {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <ActivationStatsPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(getActivationStats).mockReset().mockResolvedValue(STATS_SAMPLE);
  vi.mocked(getQuotaStatus).mockReset().mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
});

describe('配额状态面板', () => {
  it('金额不可得时明说硬闸跳过，不出现 ¥0.00 或"未超限"', async () => {
    vi.mocked(getQuotaStatus).mockResolvedValue([
      {
        scope: 'capability',
        target: 'finance-export',
        softLimit: 1,
        hardLimit: 1,
        usage: 99,
        status: 'exceeded',
        windowDays: 30,
        unit: 'amount',
        amount: null,
        priceReason: 'NO_TOKEN_SAMPLE',
        amountNote: '金额不可得，硬闸已跳过，未与 0 比较',
        amountHardLimit: 100,
      },
    ]);

    renderPage();

    expect(await screen.findByText('金额不可得，硬闸已跳过')).toBeTruthy();
    expect(screen.getByText(/NO_TOKEN_SAMPLE/)).toBeTruthy();
    const text = document.body.textContent ?? '';
    expect(text).not.toContain('¥0.00');
    expect(text).not.toContain('未超限');
  });

  it('金额可得时显示实际金额，不显示缺口文案', async () => {
    vi.mocked(getQuotaStatus).mockResolvedValue([
      {
        ...INVOCATION_ROW('paid-export', 'warn', 7),
        unit: 'amount',
        amount: 12.34,
        currency: 'CNY',
        priceReason: 'OK',
        amountHardLimit: 20,
      },
    ]);

    renderPage();

    expect(await screen.findByText('CNY 12.34')).toBeTruthy();
    expect(screen.queryByText('金额不可得，硬闸已跳过')).toBeNull();
  });

  it('invocations 行展示用量/硬阈与 ok/warn/exceeded 三态徽标', async () => {
    vi.mocked(getQuotaStatus).mockResolvedValue([
      INVOCATION_ROW('cap-ok', 'ok', 2),
      INVOCATION_ROW('cap-warn', 'warn', 7),
      INVOCATION_ROW('cap-exceeded', 'exceeded', 12),
    ]);

    renderPage();

    const badges = await screen.findAllByTestId('quota-status-badge');
    expect(badges.map((badge) => badge.textContent)).toEqual([
      '正常',
      '预警',
      '已超限',
    ]);
    expect(badges[0].className).toContain('ant-tag-success');
    expect(badges[1].className).toContain('ant-tag-warning');
    expect(badges[2].className).toContain('ant-tag-error');
    expect(screen.getByText('2 / 10')).toBeTruthy();
    expect(screen.getByText('7 / 10')).toBeTruthy();
    expect(screen.getByText('12 / 10')).toBeTruthy();
  });

  it('空数组显示空状态提示并按当前 30 天窗请求', async () => {
    renderPage();

    expect(await screen.findByText('暂无配额状态记录')).toBeTruthy();
    await waitFor(() => {
      expect(getQuotaStatus).toHaveBeenCalledWith(30);
    });
  });

  it('API 错误走既有 Alert 范式，不新造 toast', async () => {
    vi.mocked(getQuotaStatus).mockRejectedValue(new Error('quota down'));

    renderPage();

    expect(await screen.findByText('配额状态加载失败，请稍后重试。')).toBeTruthy();
    expect(screen.queryByText('暂无配额状态记录')).toBeNull();
  });
});
