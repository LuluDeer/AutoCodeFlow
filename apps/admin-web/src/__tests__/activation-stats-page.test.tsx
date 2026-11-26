/**
 * 能力用量看板单测：概览总数、按能力分布、按项目归属、空态、时间窗切换重取。
 * API 按 GET /api/capability-activation/stats 契约 mock，不触网。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ActivationStatsPage from '../pages/ActivationStatsPage';
import {
  getActivationStats,
  getQuotaStatus,
  type ActivationStats,
} from '../api/capability-activation';

vi.mock('../api/capability-activation', () => ({
  getActivationStats: vi.fn(),
  getQuotaStatus: vi.fn(),
}));

/** 用可点击的假时间选择器替代真实控件的弹层交互，只验证 onChange → 重取链路。 */
vi.mock('antd', async (importOriginal) => {
  const actual = await importOriginal<typeof import('antd')>();
  const { default: dayjs } = await import('dayjs');
  return {
    ...actual,
    DatePicker: {
      ...actual.DatePicker,
      RangePicker: ({
        onChange,
      }: {
        onChange?: (dates: [unknown, unknown] | null) => void;
      }) => (
        <div data-testid="stats-range">
          <button
            type="button"
            onClick={() => onChange?.([dayjs('2026-05-01'), dayjs('2026-05-31')])}
          >
            切换时间范围
          </button>
        </div>
      ),
    },
  };
});

const SAMPLE: ActivationStats = {
  total: 17,
  byCapability: [
    { capabilityKey: 'browser', count: 12, success: 10, failure: 1, blocked: 1 },
    { capabilityKey: 'filesystem', count: 5, success: 4, failure: 1, blocked: 0 },
  ],
  byProject: [
    { projectId: 'proj-a', count: 10 },
    { projectId: null, count: 7 },
  ],
};

function renderPage() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ActivationStatsPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(getActivationStats).mockReset().mockResolvedValue(SAMPLE);
  vi.mocked(getQuotaStatus).mockReset().mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
});

describe('能力用量看板', () => {
  it('概览渲染时间窗内的累计总数', async () => {
    renderPage();
    expect(await screen.findByText('17')).toBeTruthy();
    expect(screen.getByText('累计激活次数')).toBeTruthy();
    expect(screen.getByText('统计时间范围')).toBeTruthy();
  });

  it('按能力表格渲染次数与成功/失败/拦截分布', async () => {
    renderPage();
    await screen.findByText('browser');
    expect(screen.getByText('filesystem')).toBeTruthy();
    expect(screen.getByText('12')).toBeTruthy();
    expect(screen.getByText('成功 10')).toBeTruthy();
    expect(screen.getByText('成功 4')).toBeTruthy();
    expect(screen.getByText('拦截 1')).toBeTruthy();
    expect(screen.getByText('用量占比')).toBeTruthy();
  });

  it('按项目表格渲染项目与未归属项目', async () => {
    renderPage();
    await screen.findByText('proj-a');
    expect(screen.getByText('未归属项目')).toBeTruthy();
    expect(screen.getByText('7')).toBeTruthy();
  });

  it('空数据显示中文提示', async () => {
    vi.mocked(getActivationStats).mockResolvedValue({
      total: 0,
      byCapability: [],
      byProject: [],
    });
    renderPage();
    await screen.findByText('暂无能力激活记录，先到工作台提交一个方案');
    expect(screen.queryByText('按能力分布')).toBeNull();
  });

  it('切换时间范围后按新的 from/to 重新请求', async () => {
    renderPage();
    await screen.findByText('累计激活次数');
    await waitFor(() => {
      expect(getActivationStats).toHaveBeenCalledTimes(1);
    });
    const firstCall = vi.mocked(getActivationStats).mock.calls[0];

    fireEvent.click(screen.getByRole('button', { name: '切换时间范围' }));
    await waitFor(() => {
      expect(getActivationStats).toHaveBeenCalledTimes(2);
    });
    const secondCall = vi.mocked(getActivationStats).mock.calls[1];

    for (const call of [firstCall, secondCall]) {
      expect(call).toHaveLength(2);
      expect(call[0]).toBe(new Date(call[0] ?? '').toISOString());
      expect(call[1]).toBe(new Date(call[1] ?? '').toISOString());
    }
    expect(secondCall[0]).not.toBe(firstCall[0]);
    expect(Date.parse(secondCall[0] ?? '')).toBeLessThan(Date.parse(firstCall[0] ?? ''));
    expect(Date.parse(secondCall[1] ?? '')).toBeGreaterThan(Date.parse(secondCall[0] ?? ''));
  });
});
