/**
 * NorthStarCard gate_off 诚实化 · 第 2 级验收（组件级 / vitest + RTL，API 层 mock）。
 *
 * 契约：仅当 data?.ttfv?.dataStatus === 'gate_off' 时，严格值区
 *（north-star-confirmed / north-star-installs 两处）显示未采集态
 * `north-star-strict-uncollected`，不再把 totals 的 0 画成绿色真零；
 * 代理值区 north-star-proxy-executions 逐字不动。
 * gate_off 之外（ok / no_data / ttfv 缺席 / 读取失败）严格值区保持既有行为。
 *
 * 边界：mock 的是 metricsApi.getNorthStar（内存替身），只证明组件分支逻辑，
 * 不证明后端真跑/传输层接通。产物见 docs 分级：单测/内存替身。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
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

const GUARD = '⚠️ 有产物/有证据 ≠ 被业务确认，代理值勿当严格值';
const OPS_TEXT = '运营前置（脚本不验证）：telemetry/status 的 coverage 须为 full 且 count>0';
const AS_OF = '2026-11-20T10:30:00.000Z';

const promotion = (): NorthStarReport['promotionEligibility'] => ({
  eligible: false,
  reasons: [`样本期 0 周 < 4 周`, `活跃 install 周合计 0 < 20`, OPS_TEXT],
  reasonDetails: [
    { code: 'SAMPLE_WEEKS_SHORT', text: '样本期 0 周 < 4 周' },
    { code: 'ACTIVE_INSTALL_WEEKS_SHORT', text: '活跃 install 周合计 0 < 20' },
    { code: 'OPS_PREREQ_COVERAGE', text: OPS_TEXT },
  ],
  weeks: 0,
  activeInstallWeeks: 0,
  thresholds: { minWeeks: 4, minActiveInstallWeeks: 20 },
});

type Status = 'gate_off' | 'no_data' | 'ok' | 'absent';

function makeReport(opts: {
  status?: Status;
  confirmed?: number;
  installs?: number;
  proxy?: number;
  warnings?: string[];
} = {}): NorthStarReport {
  const {
    status = 'ok',
    confirmed = 0,
    installs = 0,
    proxy = 0,
    warnings = [GUARD],
  } = opts;
  const report: NorthStarReport = {
    as_of: AS_OF,
    business_confirmed: {
      weeks: [],
      totals: { active_install_weeks: installs, confirmed_events: confirmed },
    },
    business_results_proxy: {
      weeks: [],
      totals: { executions: proxy },
    },
    promotionEligibility: promotion(),
    warnings,
    ttfv: {
      dataStatus: status === 'absent' ? 'ok' : status,
      medianMinutes: null,
      activation24h: null,
      sampleSize: 0,
      asOf: AS_OF,
      note: '',
    },
  };
  if (status === 'absent') {
    delete (report as Record<string, unknown>).ttfv;
  }
  return report;
}

async function renderWith(report: NorthStarReport) {
  mockedMetrics.getNorthStar.mockResolvedValue(report);
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const view = render(
    <QueryClientProvider client={qc}>
      <NorthStarCard />
    </QueryClientProvider>,
  );
  await screen.findByTestId('north-star-strict');
  return view;
}

/** 严格值区的数字 testid 不得呈现给定文本（元素消失或文本改写均视为通过）。 */
function expectStrictNumberNotShown(value: string) {
  const confirmed = screen.queryByTestId('north-star-confirmed');
  expect(confirmed === null || confirmed.textContent !== value).toBe(true);
  const installs = screen.queryByTestId('north-star-installs');
  expect(installs === null || installs.textContent !== value).toBe(true);
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
});

afterEach(() => cleanup());

describe('NorthStarCard gate_off 诚实化（第 2 级：组件 / API 层 mock）', () => {
  it('① gate_off + strict totals=0：未采集态可见、严格值区无绿色 0、代理值区不动', async () => {
    await renderWith(makeReport({ status: 'gate_off', confirmed: 0, installs: 0, proxy: 99 }));

    expect(screen.getByTestId('north-star-strict-uncollected')).toBeTruthy();
    expectStrictNumberNotShown('0');
    // 代理值区逐字不动（99 原样展示）
    expect(screen.getByTestId('north-star-proxy-executions').textContent).toBe('99');
    expect(screen.getByTestId('north-star-proxy-tag')).toBeTruthy();
  });

  it('② gate_off 优先：即便 strict totals 人为非 0，仍显示未采集态且不信任数字', async () => {
    await renderWith(makeReport({ status: 'gate_off', confirmed: 42, installs: 7, proxy: 99 }));

    expect(screen.getByTestId('north-star-strict-uncollected')).toBeTruthy();
    expectStrictNumberNotShown('42');
    expectStrictNumberNotShown('7');
    expect(screen.getByTestId('north-star-proxy-executions').textContent).toBe('99');
  });

  it('③ ok + strict totals=0：真零照常显示 0，未采集态不存在', async () => {
    await renderWith(makeReport({ status: 'ok', confirmed: 0, installs: 0, proxy: 0 }));

    expect(screen.queryByTestId('north-star-strict-uncollected')).toBeNull();
    expect(screen.getByTestId('north-star-confirmed').textContent).toBe('0');
    expect(screen.getByTestId('north-star-installs').textContent).toBe('0');
    expect(screen.getByTestId('north-star-empty')).toBeTruthy();
    expect(screen.getByTestId('north-star-warnings')).toBeTruthy();
  });

  it('④ no_data：严格值照常显示真值，不得推断为未采集', async () => {
    await renderWith(makeReport({ status: 'no_data', confirmed: 13, installs: 4, proxy: 6 }));

    expect(screen.queryByTestId('north-star-strict-uncollected')).toBeNull();
    expect(screen.getByTestId('north-star-confirmed').textContent).toBe('13');
    expect(screen.getByTestId('north-star-installs').textContent).toBe('4');
    expect(screen.getByTestId('north-star-proxy-executions').textContent).toBe('6');
  });

  it('⑤ ttfv 字段整体缺席：防御分支不误标未采集，严格值照常显示真值', async () => {
    await renderWith(makeReport({ status: 'absent', confirmed: 8, installs: 3, proxy: 2 }));

    expect(screen.queryByTestId('north-star-strict-uncollected')).toBeNull();
    expect(screen.getByTestId('north-star-confirmed').textContent).toBe('8');
    expect(screen.getByTestId('north-star-installs').textContent).toBe('3');
    expect(screen.getByTestId('north-star-proxy-executions').textContent).toBe('2');
  });

  it('⑥ gate_off 时代理值 executions=5 仍逐字显示 5（代理区不被牵连）', async () => {
    await renderWith(makeReport({ status: 'gate_off', confirmed: 0, installs: 0, proxy: 5 }));

    expect(screen.getByTestId('north-star-strict-uncollected')).toBeTruthy();
    const proxyBox = screen.getByTestId('north-star-proxy');
    expect(proxyBox.querySelector('[data-testid="north-star-proxy-executions"]')?.textContent).toBe('5');
    // 代理区不得混入未采集标识
    expect(proxyBox.querySelector('[data-testid="north-star-strict-uncollected"]')).toBeNull();
  });

  it('⑦ gate_off 时 warnings 容器与护栏原文常驻', async () => {
    await renderWith(makeReport({ status: 'gate_off', confirmed: 0, installs: 0, proxy: 0 }));

    expect(screen.getByTestId('north-star-strict-uncollected')).toBeTruthy();
    expect(screen.getByTestId('north-star-warnings')).toBeTruthy();
    expect(screen.getAllByTestId('north-star-warning')).toHaveLength(1);
    expect(screen.getByText(GUARD)).toBeTruthy();
  });

  it('⑧ 读取失败：既有友好提示保持，不误标未采集', async () => {
    mockedMetrics.getNorthStar.mockRejectedValue(new Error('503 Service Unavailable'));
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    render(
      <QueryClientProvider client={qc}>
        <NorthStarCard />
      </QueryClientProvider>,
    );

    expect(await screen.findByTestId('north-star-read-failed')).toBeTruthy();
    expect(screen.queryByTestId('north-star-strict-uncollected')).toBeNull();
    expect(screen.queryByTestId('north-star-confirmed')).toBeNull();
  });
});
