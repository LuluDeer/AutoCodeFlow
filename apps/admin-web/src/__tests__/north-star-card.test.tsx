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
const OPS_TEXT = '运营前置（脚本不验证）：telemetry/status 的 coverage 须为 full 且 count>0';
const promotion = (eligible: boolean, weeks: number, installs: number) => {
  const reasons = eligible
    ? [OPS_TEXT]
    : [`样本期 ${weeks} 周 < 4 周`, `活跃 install 周合计 ${installs} < 20`, OPS_TEXT];
  const reasonDetails = eligible
    ? [{ code: 'OPS_PREREQ_COVERAGE', text: OPS_TEXT }]
    : [
        { code: 'SAMPLE_WEEKS_SHORT', text: `样本期 ${weeks} 周 < 4 周` },
        { code: 'ACTIVE_INSTALL_WEEKS_SHORT', text: `活跃 install 周合计 ${installs} < 20` },
        { code: 'OPS_PREREQ_COVERAGE', text: OPS_TEXT },
      ];
  return { eligible, reasons, reasonDetails, weeks, activeInstallWeeks: installs, thresholds: { minWeeks: 4, minActiveInstallWeeks: 20 } };
};

const ttfvFixture = {
  dataStatus: 'ok' as const,
  medianMinutes: 8.5,
  activation24h: 0.5,
  sampleSize: 7,
  asOf: '2026-11-20T10:30:00.000Z',
  note: '真实口径仅覆盖 opt-in install',
};

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
  ttfv: ttfvFixture,
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
      ttfv: ttfvFixture,
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
      ttfv: ttfvFixture,
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

  // UX-D1：拦截器 reject 的是响应信封对象——错误行必须用 getErrMsg 取后端 message，
  // 不得 String(error) 得到 [object Object]，也不得复用 warnings 栏的「口径护栏」标题。
  it('④b 错误信封：透出后端 message，不出现 [object Object]，不挂护栏标题', async () => {
    mockedMetrics.getNorthStar.mockRejectedValue({
      errorCode: 'NORTH_STAR_UPSTREAM_TIMEOUT',
      message: '指标上游超时：metrics 服务 504',
    });

    renderCard();

    const block = await screen.findByTestId('north-star-read-failed');
    expect(block.textContent).toContain('指标上游超时：metrics 服务 504');
    expect(block.textContent).not.toContain('[object Object]');
    expect(block.textContent).not.toContain('口径护栏');
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

  // ── UX-F1：着色/本地化按后端稳定 code 判定，不再在人话文案里匹配英文子串 ──
  it('⑦ 按 code 着色：运营前置码标 warning，阈值码走 secondary', async () => {
    mockedMetrics.getNorthStar.mockResolvedValue({ ...fullReport, promotionEligibility: promotion(false, 2, 5) });

    renderCard();

    const box = await screen.findByTestId('north-star-promotion-reasons');
    const warnings = box.querySelectorAll('.ant-typography-warning');
    const secondary = box.querySelectorAll('.ant-typography-secondary');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.textContent).toContain('coverage');
    // secondary = 2 条阈值原因 + 1 条 note 说明（同容器内）。
    expect(secondary).toHaveLength(3);
    // 阈值码按 i18n 键插值渲染（周数/下限来自判据字段，不解析文案）。
    expect(box.textContent).toContain('样本期 2 周 < 4 周');
  });

  it('⑧ 反证：文案含 coverage 但码非运营前置 ⇒ 不标 warning；未知码回落后端原文', async () => {
    mockedMetrics.getNorthStar.mockResolvedValue({
      ...fullReport,
      promotionEligibility: {
        eligible: false,
        reasons: ['未来新增判据 coverage 提示'],
        reasonDetails: [{ code: 'FUTURE_NEW_CODE', text: '未来新增判据 coverage 提示' }],
        weeks: 2,
        activeInstallWeeks: 5,
        thresholds: { minWeeks: 4, minActiveInstallWeeks: 20 },
      },
    });

    renderCard();

    const box = await screen.findByTestId('north-star-promotion-reasons');
    // 子串匹配移除后：文本里有 coverage 也不得被误判成运营前置 warning。
    expect(box.querySelectorAll('.ant-typography-warning')).toHaveLength(0);
    // 未登记的 code 不裸渲染码值，回落到后端 text 原文。
    expect(box.textContent).toContain('未来新增判据 coverage 提示');
    expect(box.textContent).not.toContain('FUTURE_NEW_CODE');
  });

  it('⑨ 旧后端回落：未下发 reasonDetails 时按 legacy reasons 原文直出，普通弱化色', async () => {
    const pe = promotion(false, 2, 5);
    const legacyPe = {
      eligible: pe.eligible,
      reasons: pe.reasons,
      weeks: pe.weeks,
      activeInstallWeeks: pe.activeInstallWeeks,
      thresholds: pe.thresholds,
    };
    mockedMetrics.getNorthStar.mockResolvedValue({
      ...fullReport,
      promotionEligibility: legacyPe as NorthStarReport['promotionEligibility'],
    });

    renderCard();

    const box = await screen.findByTestId('north-star-promotion-reasons');
    expect(box.textContent).toContain('样本期 2 周 < 4 周');
    expect(box.querySelectorAll('.ant-typography-warning')).toHaveLength(0);
  });
});
