/**
 * 第 95 轮打磨项：成本原因码（后端 PriceReason）不再以英文技术码裸露在中文界面。
 *
 * 覆盖契约（第 2 级：组件级 RTL + API 层 mock，不触网）：
 *   · costReasonLabel 五种 reason 的 zh/en 文案 + 未知码原样回退（含空串不崩）；
 *   · CostPostureCard / ActivationStatsPage 两处渲染都走映射，note 与金额逻辑不变。
 * 反证：删掉任一 case 映射 ⇒ 对应中文文案断言转红；还原即绿。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import CostPostureCard from '../components/dashboard/CostPostureCard';
import { costReasonLabel } from '../utils/cost-reason-label';
import ActivationStatsPage from '../pages/ActivationStatsPage';
import {
  getActivationStats,
  getQuotaStatus,
  type ActivationStats,
  type ActivationStatsDualBasis,
  type PriceReason,
} from '../api/capability-activation';
import i18n, { setLanguage } from '../i18n';

vi.mock('../api/capability-activation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/capability-activation')>();
  return { ...actual, getActivationStats: vi.fn(), getQuotaStatus: vi.fn() };
});

// 与 activation-stats-page.test.tsx 同款：用假 RangePicker 避开 antd 弹层交互。
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

const NOTE = '样本窗口内没有 token 计数，金额不可折算。';

const zhCases: Array<[PriceReason, string]> = [
  ['OK', '已折算'],
  ['NO_TOKEN_SAMPLE', '无 token 样本'],
  ['PRICE_MISSING', '缺价目配置'],
  ['INVALID_TOKEN_COUNT', 'token 样本损坏'],
  ['INVALID_PRICE', '价目配置非法'],
];

const enCases: Array<[PriceReason, string]> = [
  ['OK', 'Converted'],
  ['NO_TOKEN_SAMPLE', 'No token sample'],
  ['PRICE_MISSING', 'Price config missing'],
  ['INVALID_TOKEN_COUNT', 'Invalid token sample'],
  ['INVALID_PRICE', 'Invalid price config'],
];

function dual(reason: PriceReason, currencyValue: number | null = null): ActivationStatsDualBasis {
  return {
    basis: 'per-activation',
    invocations: 12,
    successfulDeliveries: 11,
    skipped: 0,
    note: NOTE,
    tokenSample: null,
    currencyValue,
    priceReason: reason,
    allocationNote: '无 token 样本，不折算金额。',
    byCapability: [],
    byProject: [],
  };
}

const statsOf = (basis: ActivationStatsDualBasis): ActivationStats => ({
  total: 12,
  byCapability: [],
  byProject: [],
  dualBasis: basis,
});

const newClient = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });

function renderCostCard() {
  return render(
    <QueryClientProvider client={newClient()}>
      <CostPostureCard />
    </QueryClientProvider>,
  );
}

function renderStatsPage() {
  return render(
    <QueryClientProvider client={newClient()}>
      <ActivationStatsPage />
    </QueryClientProvider>,
  );
}

beforeEach(async () => {
  await setLanguage('zh');
  vi.mocked(getActivationStats).mockReset();
  vi.mocked(getQuotaStatus).mockReset().mockResolvedValue([]);
});

afterEach(async () => {
  cleanup();
  await setLanguage('zh');
});

describe('costReasonLabel：五种 PriceReason 的双语映射与回退', () => {
  it('中文界面下五种 reason 各有中文文案（不裸露英文码）', () => {
    const t = i18n.getFixedT('zh');
    for (const [reason, label] of zhCases) {
      expect(costReasonLabel(reason, t)).toBe(label);
    }
  });

  it('英文界面下五种 reason 各有英文文案（zh/en 词条成对）', async () => {
    await setLanguage('en');
    const t = i18n.getFixedT('en');
    for (const [reason, label] of enCases) {
      expect(costReasonLabel(reason, t)).toBe(label);
    }
  });

  it('未知原因码（含前端哨兵、未来新增值与空串）原样回退，不伪装不崩', () => {
    const t = i18n.getFixedT('zh');
    expect(costReasonLabel('FUTURE_REASON', t)).toBe('FUTURE_REASON');
    expect(costReasonLabel('READ_FAILED', t)).toBe('READ_FAILED');
    expect(costReasonLabel('UNKNOWN', t)).toBe('UNKNOWN');
    expect(costReasonLabel('', t)).toBe('');
  });
});

describe('CostPostureCard：原因码本地化后标缺语义不变', () => {
  it.each([
    ['NO_TOKEN_SAMPLE', '无 token 样本'],
    ['PRICE_MISSING', '缺价目配置'],
    ['INVALID_TOKEN_COUNT', 'token 样本损坏'],
    ['INVALID_PRICE', '价目配置非法'],
  ] as Array<[PriceReason, string]>)('%s 显示中文原因且 note 不被吞', async (reason, label) => {
    vi.mocked(getActivationStats).mockResolvedValue(statsOf(dual(reason)));
    renderCostCard();
    const detail = await screen.findByTestId('boss-cost-unavailable');
    expect(detail.textContent).toContain(`原因：${label}`);
    expect(detail.textContent).toContain(NOTE);
    expect(detail.textContent).not.toContain(reason);
    expect(screen.queryByTestId('boss-cost-amount')).toBeNull();
  });

  it('未知 reason 回退原码可见（保持可诊断），note 仍展示', async () => {
    vi.mocked(getActivationStats).mockResolvedValue({
      ...statsOf(dual('NO_TOKEN_SAMPLE')),
      dualBasis: { ...dual('NO_TOKEN_SAMPLE'), priceReason: 'FUTURE_REASON' as PriceReason },
    });
    renderCostCard();
    const detail = await screen.findByTestId('boss-cost-unavailable');
    expect(detail.textContent).toContain('原因：FUTURE_REASON');
    expect(detail.textContent).toContain(NOTE);
  });

  it('OK + 金额非 null ⇒ 金额显示逻辑逐字不变', async () => {
    vi.mocked(getActivationStats).mockResolvedValue(statsOf(dual('OK', 123.45)));
    renderCostCard();
    const amount = await screen.findByTestId('boss-cost-amount');
    expect(amount.textContent).toContain('123.45');
    expect(screen.queryByTestId('boss-cost-unavailable')).toBeNull();
  });
});

describe('ActivationStatsPage：同一映射覆盖用量页成本告警', () => {
  it('PRICE_MISSING 显示中文原因 + note，不裸露英文码', async () => {
    vi.mocked(getActivationStats).mockResolvedValue(statsOf(dual('PRICE_MISSING')));
    renderStatsPage();
    await screen.findByText('成本金额不可用（未折算）');
    const text = screen.getByTestId('activation-stats-page').textContent ?? '';
    expect(text).toContain('原因：缺价目配置');
    expect(text).toContain(NOTE);
    expect(text).not.toContain('PRICE_MISSING');
  });

  it('未知 reason 在用量页同样回退原码', async () => {
    vi.mocked(getActivationStats).mockResolvedValue({
      ...statsOf(dual('NO_TOKEN_SAMPLE')),
      dualBasis: { ...dual('NO_TOKEN_SAMPLE'), priceReason: 'FUTURE_REASON' as PriceReason },
    });
    renderStatsPage();
    await screen.findByText('成本金额不可用（未折算）');
    expect(screen.getByTestId('activation-stats-page').textContent).toContain('原因：FUTURE_REASON');
  });

  it('OK + 金额非 null ⇒ 折算金额正常显示且不展示原因文案', async () => {
    vi.mocked(getActivationStats).mockResolvedValue(statsOf(dual('OK', 123.45)));
    renderStatsPage();
    expect(await screen.findByText('折算金额：123.45')).toBeTruthy();
    const text = screen.getByTestId('activation-stats-page').textContent ?? '';
    expect(text).not.toContain('已折算');
    expect(text).not.toContain('原因：');
  });
});
