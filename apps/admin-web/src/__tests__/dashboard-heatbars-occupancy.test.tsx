/**
 * R67（§7.17 P3 收尾）`heatbars-metrics-semantics`：仪表盘「执行器资源热力条」行内那个
 * 「运行 N」到底在说什么？
 *
 * ## 事实（不是猜测）
 *
 * · 数据源：`GET /metrics/executors`（`metricsApi.getExecutorStats`），后端
 *   `metrics.service.ts::getExecutorStats` 的 select 只取实体列
 *   id/appName/address/status/cpuUsage/memUsage/runningTaskCount/lastHeartbeat
 *   ——**不取 reservedSlots**；
 * · `runningTaskCount` 是**已占槽位**（含 E-01 pull 取件预留；R16 起还被抬到
 *   「客户端上报 vs 服务端在途占坑」的较大值），也正是派发闸门读的数；
 * · 而 UI 文案是 `heatBars.running` = 「运行 {{count}}」——**声称**这是「实际在跑的任务数」。
 *
 * ⇒ 对一台空闲 pull 执行器（已占 1、其中 1 个是预留），仪表盘会说「运行 1」，
 * 而那台机器上**没有任何任务在跑**——正是 E-01-RPT 在生产里暴露的那类谎报
 * （RPA5 恒显「当前运行任务 1/10」）。
 *
 * ## 为什么不是「改成实际在跑」
 *
 * 本条数据面（`ExecutorStat`）**没有 reservedSlots 列**，前端无从换算；且本文件
 * 不改后端。故按「已占槽位」语义**消歧**：文案与可访问标签如实说「已占」，
 * 并说明它含取件预留、与详情页「当前运行任务」可能差一个预留槽位。
 *
 * 判据：
 *  ① 数字标注为**已占**（旧实现写「运行 N」⇒ 首轮红）；
 *  ② 有可访问说明（aria-label 含「已占槽位」；旧实现只有裸文字）；
 *  ③ 不消费 reservedSlots：行对象夹带该字段也不换算、不触发「计数不一致」——
 *     证明这里的语义是容量占用，不是详情页的展示口径。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import ExecutorHeatBars, { type ExecutorHeatRow } from '../components/dashboard/ExecutorHeatBars';

// jsdom 缺失 antd 依赖的浏览器 API（既有先例 shim；antd Tooltip 会经 rc-resize-observer 用到）
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
    matches: false, media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

const row = (over: Partial<ExecutorHeatRow> = {}): ExecutorHeatRow => ({
  id: 'ex-1',
  appName: 'RPA5',
  address: '10.0.0.5:3002',
  status: 'online',
  cpuUsage: 10,
  memUsage: 20,
  // 空闲 pull 执行器的稳态：已占 1 个槽位（其中就是那个取件预留），实际在跑 0。
  runningTaskCount: 1,
  ...over,
});

const renderBars = (executors: ExecutorHeatRow[]) =>
  render(<ExecutorHeatBars executors={executors} onOpenExecutor={() => {}} />);

beforeEach(() => {
  cleanup();
});

afterEach(() => {
  cleanup();
});

describe('R67 — 热力条行内数字是「已占槽位」，不是「实际在跑」', () => {
  it('【语义①】不得再写「运行 N」；应如实标为已占槽位', () => {
    renderBars([row()]);

    // 旧实现的谎报：空闲 pull 执行器被说成「运行 1」。
    expect(screen.queryByText(/运行\s*1/)).toBeNull();
    // 如实口径（已占 1 个槽位）。
    expect(screen.getByText(/已占\s*1/)).toBeTruthy();
  });

  it('【语义②】该数字带可访问说明（含「已占槽位」与取件预留的来由）', () => {
    renderBars([row()]);

    // 不是只靠 hover：读屏/触屏也要能拿到「这个数是已占槽位」。
    const labelled = document.querySelector('[aria-label*="已占槽位"]');
    expect(labelled).toBeTruthy();
    expect(labelled?.getAttribute('aria-label')).toMatch(/取件预留|预留/);
  });

  it('【语义③】不消费 reservedSlots：夹带该字段也不换算、不触发「计数不一致」', () => {
    // 后端 /metrics/executors 的 select 本就不含 reservedSlots；这里故意夹带一个
    // 矛盾值，锁死「本处消费 runningTaskCount（已占槽位）而非展示口径」。
    renderBars([{ ...row(), reservedSlots: 999 } as unknown as ExecutorHeatRow]);

    expect(screen.getByText(/已占\s*1/)).toBeTruthy();
    // 若有人把 displayedRunningCount / hasInconsistentMetrics 搬进来，上面这句会变 0。
    expect(screen.queryByText(/已占\s*0/)).toBeNull();
    expect(screen.queryByLabelText(/后端上报的任务计数不一致/)).toBeNull();
  });
});
