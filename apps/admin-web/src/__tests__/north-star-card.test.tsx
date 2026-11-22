/**
 * R328 前端切片② —— 北极星双口径看板卡片验收（组件渲染级，vitest + RTL）。
 *
 * 钉住 PM「不混用」护栏的四条：
 *  ① 严格值（confirmed_events / active_install_weeks）为主指标，近似值（executions）
 *    为参考值，两者独立区域 + 独立 Tag，数值不串；
 *  ② warnings 逐字原文渲染，**空周序列也不隐藏**（反证：去掉 WarningRail 的 map 即转红）；
 *  ③ 空数据展示 0 而非报错，warnings 容器仍在；
 *  ④ 读取失败给友好提示而非崩溃/静默变空态。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import NorthStarCard from '../components/dashboard/NorthStarCard';
import { metricsApi, type NorthStarReport } from '../api/metrics';

vi.mock('../api/metrics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/metrics')>();
  return {
    ...actual,
    metricsApi: { ...actual.metricsApi, getNorthStar: vi.fn() },
  };
});
const mockedMetrics = vi.mocked(metricsApi, true);

/** 后端中文警告原文（en 界面也按原文展示），逐字断言。 */
const GUARD = '⚠️ 有产物/有证据 ≠ 被业务确认，代理值勿当严格值';

/** R448 升主判据 fixture（与脚本 computePromotionEligibility 同形状）。 */
const promotion = (eligible: boolean, weeks: number, installs: number) => ({
  eligible,
  reasons: eligible
    ? ['运营前置（脚本不验证）：telemetry/status 的 coverage 须为 full 且 count>0']
    : [`样本期 ${weeks} 周 < 4 周`, `活跃 install 周合计 ${installs} < 20`, '运营前置（脚本不验证）：telemetry/status 的 coverage 须为 full 且 count>0'],
  weeks,
  activeInstallWeeks: installs,
  thresholds: { minWeeks: 4, minActiveInstallWeeks: 20 },
});

const fullReport: NorthStarReport = {
  as_of: '2026-11-20T10:30:00.000Z',
  business_confirmed: {
    weeks: [{ week_start: '2026-11-16', active_installs: 7, confirmed_events: 42 }],
    totals: { active_install_weeks: 7, confirmed_events: 42 },
  },
  business_results_proxy: {
    weeks: [{ week_start: '2026-11-16', executions: 99 }],
    totals: { executions: 99 },
  },
  promotionEligibility: promotion(true, 1, 7),
  warnings: [GUARD],
};

function renderCard() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <NorthStarCard />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
});

afterEach(() => cleanup());

describe('R328 北极星双口径看板卡片', () => {
  it('① 严格值主 / 近似值参考并列：两套数值与 Tag 各自独立', async () => {
    mockedMetrics.getNorthStar.mockResolvedValue(fullReport);

    renderCard();

    expect(await screen.findByTestId('north-star-strict')).toBeTruthy();
    const strict = screen.getByTestId('north-star-strict');
    const proxy = screen.getByTestId('north-star-proxy');
    // 严格值（主）：42 个被业务确认执行 + 7 个活跃实例
    expect(within(strict).getByTestId('north-star-confirmed').textContent).toBe('42');
    expect(within(strict).getByTestId('north-star-installs').textContent).toBe('7');
    expect(within(strict).getByTestId('north-star-strict-tag').textContent).toContain('严格');
    // 近似值（参考）：99 个有产物/有证据执行，独立区域 + 弱化 Tag
    expect(within(proxy).getByTestId('north-star-proxy-executions').textContent).toBe('99');
    expect(within(proxy).getByTestId('north-star-proxy-tag').textContent).toContain('参考');
    // 全局口径：卡片带全局标识，且周口径说明展示 as_of
    expect(screen.getByTestId('north-star-global-tag')).toBeTruthy();
    expect(screen.getByText(/按周统计 · 截止/)).toBeTruthy();
    // 全局口径回归锚点：getNorthStar 第一参必须是 undefined（不带 projectId）——
    // 北极星是全局指标，任何项目过滤传入都会让看板与权威脚本口径分叉。
    expect(mockedMetrics.getNorthStar).toHaveBeenCalled();
    const firstCall = mockedMetrics.getNorthStar.mock.calls[0];
    expect(firstCall?.[0]).toBeUndefined();
  });

  it('② warnings 逐字常驻：周序列与 totals 全空也不隐藏', async () => {
    mockedMetrics.getNorthStar.mockResolvedValue({
      as_of: '2026-11-20T10:30:00.000Z',
      business_confirmed: { weeks: [], totals: { active_install_weeks: 0, confirmed_events: 0 } },
      business_results_proxy: { weeks: [], totals: { executions: 0 } },
      promotionEligibility: promotion(false, 0, 0),
      warnings: [GUARD],
    });

    renderCard();

    expect(await screen.findByText(GUARD)).toBeTruthy();
    expect(screen.getAllByTestId('north-star-warning')).toHaveLength(1);
    expect(screen.getByTestId('north-star-warnings')).toBeTruthy();
  });

  it('③ 空数据展示 0 而非报错，warnings 容器仍在', async () => {
    mockedMetrics.getNorthStar.mockResolvedValue({
      as_of: '2026-11-20T10:30:00.000Z',
      business_confirmed: { weeks: [], totals: { active_install_weeks: 0, confirmed_events: 0 } },
      business_results_proxy: { weeks: [], totals: { executions: 0 } },
      promotionEligibility: promotion(false, 0, 0),
      warnings: [],
    });

    renderCard();

    expect(await screen.findByTestId('north-star-confirmed')).toBeTruthy();
    expect(screen.getByTestId('north-star-confirmed').textContent).toBe('0');
    expect(screen.getByTestId('north-star-installs').textContent).toBe('0');
    expect(screen.getByTestId('north-star-proxy-executions').textContent).toBe('0');
    expect(screen.getByTestId('north-star-empty')).toBeTruthy();
    expect(screen.getByTestId('north-star-warnings')).toBeTruthy();
    expect(screen.queryByTestId('north-star-read-failed')).toBeNull();
  });

  it('④ 读取失败：友好提示 + 重试，不崩成空态', async () => {
    mockedMetrics.getNorthStar.mockRejectedValue(new Error('503 Service Unavailable'));

    renderCard();

    expect(await screen.findByTestId('north-star-read-failed')).toBeTruthy();
    expect(screen.getByText(/北极星数据读取失败/)).toBeTruthy();
    expect(screen.queryByTestId('north-star-confirmed')).toBeNull();
  });

  // ── R448/R449 升主判据展示（数值阈值达标/未达标 + 运营前置提示）──
  it('⑤ 升主达标：显示已达 Tag + 周数/install 明细 + 运营前置提示', async () => {
    mockedMetrics.getNorthStar.mockResolvedValue({ ...fullReport, promotionEligibility: promotion(true, 4, 20) });

    renderCard();

    expect(await screen.findByTestId('north-star-promotion')).toBeTruthy();
    expect(screen.getByTestId('north-star-promotion-tag').textContent).toContain('已达升主条件');
    expect(screen.getByTestId('north-star-promotion-detail').textContent).toContain('20');
    const reasons = screen.getByTestId('north-star-promotion-reasons').textContent ?? '';
    expect(reasons).toContain('coverage'); // 运营前置提示原文直出
    // 既有双口径 + 警告不因升主状态而消失（不混用护栏）
    expect(screen.getByTestId('north-star-strict')).toBeTruthy();
    expect(screen.getByTestId('north-star-proxy')).toBeTruthy();
    expect(screen.getByTestId('north-star-warning')).toBeTruthy();
  });

  it('⑥ 升主未达标：显示未达 Tag + 逐条 reasons（数值未达标 + 运营前置）', async () => {
    mockedMetrics.getNorthStar.mockResolvedValue({ ...fullReport, promotionEligibility: promotion(false, 3, 15) });

    renderCard();

    expect(await screen.findByTestId('north-star-promotion-tag')).toBeTruthy();
    expect(screen.getByTestId('north-star-promotion-tag').textContent).toContain('未达升主条件');
    const reasons = screen.getByTestId('north-star-promotion-reasons').textContent ?? '';
    expect(reasons).toContain('样本期 3 周 < 4 周');
    expect(reasons).toContain('coverage');
  });
});
