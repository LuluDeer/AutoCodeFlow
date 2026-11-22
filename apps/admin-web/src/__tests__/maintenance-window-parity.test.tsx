/**
 * R282 / FEAT-06：维护窗口判定在**前端的复刻**——与后端同输入同结论。
 *
 * ## 为什么必须对拍而不是"看着对"
 *
 * 后端 `maintenance-window.util.ts:371-399` 的判据是「**最近触达比较**」，不是
 * 「比时刻」。它在窗口命中时 `return null`（scheduler.service.ts:2804-2816），
 * **不建执行行、不推进 lastTriggerTime、不补跑**——用户看到的是「这时间段什么
 * 都没发生」。而列表列与详情 Tag 此前只调 `nextRunAt`（入参连
 * `maintenanceWindows` 都没有），于是它们在渲染**一次不会发生的执行**。
 *
 * 修法只能是把同一条判据复刻到前端。复刻错的代价不是"显示不准"，而是让用户
 * 以为任务不会跑（或反之）——所以本 spec 的判据是**与后端黄金表逐条一致**，
 * 不是"列表上看起来对"。
 *
 * ## 三条最容易写反的语义（每条都有对应用例）
 *
 *   ① `endFire === null` ⇒ **开窗**（不是"窗口无效"）；
 *   ② 恰在 `end` 触达分钟 ⇒ **已关窗**（半开 `[start, end)`，平局归关窗）；
 *   ③ 跨午夜 / 周级窗口必须比 **instant**，不能化简成 pair(时,分)。
 *
 * ## 用例来源
 *
 * `apps/admin-api/src/modules/task/__tests__/maintenance-window.util.spec.ts`
 * （31 例黄金表）的**逐条搬运**：本文件用同一组输入跑前端实现，断言同一个结论。
 * 后端用例里按"服务端本地时区"写的那些，这里改用**显式 IANA 时区**表达
 * （`UTC` / `Asia/Shanghai`），否则结论会随跑测试的机器时区漂移——而后端 spec
 * 自己也说明了这个口径（文件头 `:5-8`）。

 * ## 渲染面（第二个 describe 组）
 *
 * 侦察确认「下次执行」列的**内容渲染**此前由 0 条组件级测试覆盖
 * （`grep buildTaskListColumns` 在 `__tests__/` 下命中 0）——纯函数绿了不代表列
 * 真的换了文案：列定义漏接一个 `kind` 就能让整轮修复静默失效，而所有既有 spec
 * 仍然全绿。故第二个 describe 组只断言**用户看得见的文本**（DOM），不 mock
 * 被测纯函数；详情页那一例走真实 TaskDetailPage 渲染（api 层 mock）。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import i18n from '../i18n';
import {
  findActiveMaintenanceWindowPreview,
  lastWindowCronFireBefore,
  nextRunOutcome,
} from '../utils/trigger-preview';
import { buildTaskListColumns, type TaskListColumnsDeps } from '../pages/task-list-columns';
import TaskDetailPage from '../pages/TaskDetailPage';
import { tasksApi, type Task } from '../api/tasks';

vi.mock('../api/tasks', () => ({
  tasksApi: {
    webhookStatus: vi.fn().mockResolvedValue({ enabled: false, url: '' }),
    get: vi.fn(),
    executions: vi.fn(),
    stats: vi.fn(),
    schedulerStats: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    delete: vi.fn(),
    trigger: vi.fn(),
    killExecution: vi.fn(),
  },
}));
vi.mock('../api/ai', () => ({ aiApi: { suggestSchedule: vi.fn() } }));
// 只用**部分** mock：页面里的 Link（PageHeader 面包屑）需要真实 Router 上下文，
// 故 useNavigate/useParams 打桩、其余导出保留（照 task-list-columns.test 先例）。
vi.mock('react-router-dom', async (orig) => ({
  ...(await orig<typeof import('react-router-dom')>()),
  useNavigate: () => vi.fn(),
  useParams: () => ({ id: 'task-1' }),
}));
vi.mock('../components/GlueEditor', () => ({ default: () => null }));
vi.mock('../components/TaskDependencyGraph', () => ({ default: () => null }));
vi.mock('../components/ParamsEditor', () => ({ default: () => null }));

// jsdom 缺失 antd 依赖的浏览器 API（对齐 task-detail-maintenance.test 先例）。
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

afterEach(cleanup);

const at = (iso: string): Date => new Date(iso);

describe('lastWindowCronFireBefore（前端复刻）· 与后端黄金表逐条对拍', () => {
  it('命中精确分钟（后端 :21）', () => {
    expect(lastWindowCronFireBefore('30 2 * * *', at('2026-06-15T02:30:00Z'), 'UTC'))
      .toEqual(at('2026-06-15T02:30:00Z'));
  });

  it('当前分钟未命中时向下回扫到上一次触达（后端 :29）', () => {
    expect(lastWindowCronFireBefore('30 2 * * *', at('2026-06-15T03:10:00Z'), 'UTC'))
      .toEqual(at('2026-06-15T02:30:00Z'));
  });

  it('支持步进 */15（后端 :37）', () => {
    expect(lastWindowCronFireBefore('*/15 * * * *', at('2026-06-15T04:07:00Z'), 'UTC'))
      .toEqual(at('2026-06-15T04:00:00Z'));
  });

  it('支持范围+步进 30-45/5（后端 :45）', () => {
    expect(lastWindowCronFireBefore('30-45/5 2 * * *', at('2026-06-15T02:38:00Z'), 'UTC'))
      .toEqual(at('2026-06-15T02:35:00Z'));
  });

  it('weekday 0 与 7 等价（后端 :53）', () => {
    // 2026-06-14 是周日
    expect(lastWindowCronFireBefore('0 8 * * 0', at('2026-06-14T09:00:00Z'), 'UTC'))
      .toEqual(at('2026-06-14T08:00:00Z'));
    expect(lastWindowCronFireBefore('0 8 * * 7', at('2026-06-14T09:00:00Z'), 'UTC'))
      .toEqual(at('2026-06-14T08:00:00Z'));
  });

  it('dom 与 dow 同时受限按 POSIX OR（后端 :67）', () => {
    // 2026-06-15 周一（dow=1）且 dom=15
    expect(lastWindowCronFireBefore('0 6 1 * 1', at('2026-06-15T07:00:00Z'), 'UTC'))
      .toEqual(at('2026-06-15T06:00:00Z'));
  });

  it('月字段过滤：8 月 cron 在 6 月不命中 → null（后端 :77）', () => {
    expect(lastWindowCronFireBefore('0 3 * 8 *', at('2026-06-15T10:00:00Z'), 'UTC')).toBeNull();
  });

  it('非法表达式 → null（后端 :85）', () => {
    expect(lastWindowCronFireBefore('61 * * * *', at('2026-06-15T10:00:00Z'), 'UTC')).toBeNull();
    expect(lastWindowCronFireBefore('not a cron', at('2026-06-15T10:00:00Z'), 'UTC')).toBeNull();
    expect(lastWindowCronFireBefore('* * * *', at('2026-06-15T10:00:00Z'), 'UTC')).toBeNull();
  });

  it('回看上限兜底：周期超过 7 天的 cron 视为未触达（后端 :97）', () => {
    // 2 月 30 日不存在；即使存在也远超 7 天回看
    expect(lastWindowCronFireBefore('0 3 30 2 *', at('2026-06-15T10:00:00Z'), 'UTC')).toBeNull();
  });

  it('Asia/Shanghai：壁钟 02:30 换算回正确的 UTC instant（后端 :298）', () => {
    expect(
      lastWindowCronFireBefore('30 2 * * *', at('2026-06-15T19:35:00Z'), 'Asia/Shanghai')?.toISOString(),
    ).toBe('2026-06-15T18:30:00.000Z');
  });

  it('DST 春跳（America/New_York 2026-03-08 02:00→03:00）：被跳过的壁钟分钟不误命中（后端 :309）', () => {
    expect(
      lastWindowCronFireBefore('30 2 * * *', at('2026-03-08T10:00:00Z'), 'America/New_York')?.toISOString(),
    ).toBe('2026-03-07T07:30:00.000Z');
  });

  it('DST 秋回拨（America/New_York 2026-11-01 02:00→01:00）：重复壁钟分钟取后触达（后端 :320）', () => {
    expect(
      lastWindowCronFireBefore('30 1 * * *', at('2026-11-01T09:00:00Z'), 'America/New_York')?.toISOString(),
    ).toBe('2026-11-01T06:30:00.000Z');
  });
});

describe('findActiveMaintenanceWindowPreview · 与后端黄金表逐条对拍', () => {
  const daily = (start: string, end: string) => [{ start, end, description: '发布冻结' }];

  it('start 触达后、end 触达前 → 命中（后端 :113）', () => {
    const w = daily('30 2 * * *', '0 4 * * *');
    expect(findActiveMaintenanceWindowPreview(w, at('2026-06-15T02:30:00Z'), 'UTC')).toEqual(w[0]);
    expect(findActiveMaintenanceWindowPreview(w, at('2026-06-15T03:59:00Z'), 'UTC')).toEqual(w[0]);
  });

  it('恰在 end 触达分钟 → 已关窗（半开区间，后端 :123）', () => {
    const w = daily('30 2 * * *', '0 4 * * *');
    expect(findActiveMaintenanceWindowPreview(w, at('2026-06-15T04:00:00Z'), 'UTC')).toBeNull();
  });

  it('start 触达前 / 当天关窗后 → 未命中（后端 :130）', () => {
    const w = daily('30 2 * * *', '0 4 * * *');
    expect(findActiveMaintenanceWindowPreview(w, at('2026-06-15T01:00:00Z'), 'UTC')).toBeNull();
    expect(findActiveMaintenanceWindowPreview(w, at('2026-06-15T05:00:00Z'), 'UTC')).toBeNull();
  });

  it('未配置（null / [] / 非数组）→ 未命中（后端 :140）', () => {
    const now = at('2026-06-15T03:00:00Z');
    expect(findActiveMaintenanceWindowPreview(null, now, 'UTC')).toBeNull();
    expect(findActiveMaintenanceWindowPreview([], now, 'UTC')).toBeNull();
  });

  it('条目字段非法 → 跳过该条不抛错（后端 :147）', () => {
    const now = at('2026-06-15T03:00:00Z');
    expect(
      findActiveMaintenanceWindowPreview([{ start: 'bad', end: '0 4 * * *' }], now, 'UTC'),
    ).toBeNull();
    expect(
      findActiveMaintenanceWindowPreview(
        [null as never, { start: '30 2 * * *', end: '0 4 * * *' }],
        now,
        'UTC',
      ),
    ).toEqual({ start: '30 2 * * *', end: '0 4 * * *' });
  });

  it('多窗口并集：任一命中即返回该条（短路，后端 :163）', () => {
    const windows = [
      { start: '0 5 * * *', end: '0 6 * * *' }, // 未开
      { start: '30 2 * * *', end: '0 4 * * *' }, // 开启中
    ];
    expect(findActiveMaintenanceWindowPreview(windows, at('2026-06-15T03:00:00Z'), 'UTC'))
      .toEqual(windows[1]);
  });

  it('跨午夜窗口按最近触达自然成立（start 23:30 / end 次日 01:00，后端 :173）', () => {
    const w = daily('30 23 * * *', '0 1 * * *');
    // 当日 23:59：start=23:30 今日，end=01:00 今日之前 → 开
    expect(findActiveMaintenanceWindowPreview(w, at('2026-06-15T23:59:00Z'), 'UTC')).toEqual(w[0]);
    // 次日 00:30：仍开（start 昨日 23:30 > end 昨日 01:00）
    expect(findActiveMaintenanceWindowPreview(w, at('2026-06-16T00:30:00Z'), 'UTC')).toEqual(w[0]);
    // 次日 01:00 关窗
    expect(findActiveMaintenanceWindowPreview(w, at('2026-06-16T01:00:00Z'), 'UTC')).toBeNull();
  });

  it('start/end 写反 → 退化为长窗口而非报错（后端 :189）', () => {
    const w = daily('0 4 * * *', '0 2 * * *');
    expect(findActiveMaintenanceWindowPreview(w, at('2026-06-15T05:00:00Z'), 'UTC')).toEqual(w[0]);
    expect(findActiveMaintenanceWindowPreview(w, at('2026-06-16T02:00:00Z'), 'UTC')).toBeNull();
  });

  it('start 与 end 同 cron：平局按关窗（零长度窗口，后端 :200）', () => {
    const w = daily('0 3 * * *', '0 3 * * *');
    expect(findActiveMaintenanceWindowPreview(w, at('2026-06-15T03:00:00Z'), 'UTC')).toBeNull();
    expect(findActiveMaintenanceWindowPreview(w, at('2026-06-15T04:00:00Z'), 'UTC')).toBeNull();
  });

  it('周级窗口：周一 03:00-04:00 仅周一命中（后端 :210）', () => {
    const w = daily('0 3 * * 1', '0 4 * * *');
    expect(findActiveMaintenanceWindowPreview(w, at('2026-06-15T03:30:00Z'), 'UTC')).toEqual(w[0]);
    // 周二同刻：end（周二 04:00 前最后一次=周一 04:00）已关
    expect(findActiveMaintenanceWindowPreview(w, at('2026-06-16T03:30:00Z'), 'UTC')).toBeNull();
  });

  it('Asia/Shanghai 任务（UTC 容器视角）：窗口内命中 / 恰在 end 已关（后端 :228/:248）', () => {
    const w = daily('30 2 * * *', '0 4 * * *');
    // 2026-06-15T19:30:00Z = 上海 2026-06-16 03:30（02:30-04:00 窗口内）
    expect(findActiveMaintenanceWindowPreview(w, at('2026-06-15T19:30:00Z'), 'Asia/Shanghai'))
      .toEqual(w[0]);
    expect(findActiveMaintenanceWindowPreview(w, at('2026-06-15T12:00:00Z'), 'Asia/Shanghai'))
      .toBeNull();
    // 上海 03:59（19:59Z）仍在窗内；上海 04:00（20:00Z）恰关窗
    expect(findActiveMaintenanceWindowPreview(w, at('2026-06-15T19:59:00Z'), 'Asia/Shanghai'))
      .toEqual(w[0]);
    expect(findActiveMaintenanceWindowPreview(w, at('2026-06-15T20:00:00Z'), 'Asia/Shanghai'))
      .toBeNull();
  });

  it('endFire === null ⇒ 开窗（不是"窗口无效"）：end 配了永不触达的 cron', () => {
    // 后端 :395 的 `endFire &&` 短路：end 找不到触达时**落进开窗**，不是关窗。
    // 这条最容易被写成「end 算不出来 ⇒ 窗口无效 ⇒ 不跳过」，方向正好反。
    const w = daily('30 2 * * *', '0 3 30 2 *'); // 2 月 30 日永不触达
    expect(findActiveMaintenanceWindowPreview(w, at('2026-06-15T02:40:00Z'), 'UTC')).toEqual(w[0]);
  });
});

describe('nextRunOutcome · 列表/详情「下次执行」的判别式结果', () => {
  const NOW = at('2026-09-20T23:00:00Z');

  it('① 窗口内 ⇒ skipped-by-window，且给出窗口时段（D5：必须说出原因）', () => {
    const out = nextRunOutcome(
      {
        status: 'active',
        triggerType: 'cron',
        cronExpression: '0 8 * * *',
        timezone: 'UTC',
        maintenanceWindows: [{ start: '0 7 * * *', end: '0 9 * * *', description: '发布冻结' }],
      },
      NOW,
    );
    expect(out.kind).toBe('skipped-by-window');
    if (out.kind !== 'skipped-by-window') throw new Error('unreachable');
    expect(out.at.toISOString()).toBe('2026-09-21T08:00:00.000Z');
    expect(out.window).toEqual({ start: '0 7 * * *', end: '0 9 * * *', description: '发布冻结' });
  });

  it('② 窗口外 ⇒ at，且与 nextRunAt 逐毫秒相同（钉住"零行为变化"）', () => {
    const task = {
      status: 'active',
      triggerType: 'cron',
      cronExpression: '0 8 * * *',
      timezone: 'UTC',
      maintenanceWindows: [{ start: '0 9 * * *', end: '0 10 * * *' }],
    };
    const out = nextRunOutcome(task, NOW);
    expect(out.kind).toBe('at');
    if (out.kind !== 'at') throw new Error('unreachable');
    expect(out.at.toISOString()).toBe('2026-09-21T08:00:00.000Z');
  });

  it('③ 跨午夜窗口 23:30–01:00：00:30 在窗内 ⇒ skipped；03:00 在窗外 ⇒ at', () => {
    const win = [{ start: '30 23 * * *', end: '0 1 * * *' }];
    // at = 次日 00:30（触发 cron 00:30）
    const inWin = nextRunOutcome(
      { status: 'active', triggerType: 'cron', cronExpression: '30 0 * * *', timezone: 'UTC', maintenanceWindows: win },
      at('2026-09-21T00:00:00Z'),
    );
    expect(inWin.kind).toBe('skipped-by-window');
    // at = 03:00（窗口已在 01:00 关闭）
    const outWin = nextRunOutcome(
      { status: 'active', triggerType: 'cron', cronExpression: '0 3 * * *', timezone: 'UTC', maintenanceWindows: win },
      at('2026-09-21T00:00:00Z'),
    );
    expect(outWin.kind).toBe('at');
  });

  it('④ 恰在 end 触达分钟 ⇒ 已关窗（不是跳过）', () => {
    const out = nextRunOutcome(
      {
        status: 'active',
        triggerType: 'cron',
        cronExpression: '0 4 * * *',
        timezone: 'UTC',
        maintenanceWindows: [{ start: '30 2 * * *', end: '0 4 * * *' }],
      },
      at('2026-09-21T00:00:00Z'),
    );
    expect(out.kind).toBe('at');
  });

  it('⑤ tz 未填/非法 ⇒ unknown-window（不猜，D3）', () => {
    for (const timezone of ['', null, 'Not/AZone', 'UTC+8']) {
      const out = nextRunOutcome(
        {
          status: 'active',
          triggerType: 'cron',
          cronExpression: '0 8 * * *',
          timezone,
          maintenanceWindows: [{ start: '0 7 * * *', end: '0 9 * * *' }],
        },
        NOW,
      );
      expect(out.kind).toBe('unknown-window');
    }
  });

  it('⑥ 无窗口字段（undefined / null / []）⇒ at，与 nextRunAt 同一时刻', () => {
    for (const maintenanceWindows of [undefined, null, []]) {
      const out = nextRunOutcome(
        { status: 'active', triggerType: 'cron', cronExpression: '0 8 * * *', timezone: 'UTC', maintenanceWindows },
        NOW,
      );
      expect(out.kind).toBe('at');
      if (out.kind !== 'at') throw new Error('unreachable');
      expect(out.at.toISOString()).toBe('2026-09-21T08:00:00.000Z');
    }
  });

  it('暂停 / 手动 / 表达式非法 ⇒ none（既有 null 语义不变）', () => {
    expect(nextRunOutcome({ status: 'paused', triggerType: 'cron', cronExpression: '0 8 * * *' }, NOW).kind)
      .toBe('none');
    expect(nextRunOutcome({ status: 'active', triggerType: 'manual' }, NOW).kind).toBe('none');
    expect(
      nextRunOutcome(
        { status: 'active', triggerType: 'cron', cronExpression: 'not a cron', timezone: 'UTC' },
        NOW,
      ).kind,
    ).toBe('none');
  });

  it('周级窗口：周二 03:30 不在周一窗口内 ⇒ at（不是 skipped）', () => {
    const out = nextRunOutcome(
      {
        status: 'active',
        triggerType: 'cron',
        cronExpression: '30 3 * * 2',
        timezone: 'UTC',
        maintenanceWindows: [{ start: '0 3 * * 1', end: '0 4 * * 1' }],
      },
      at('2026-06-15T00:00:00Z'),
    );
    expect(out.kind).toBe('at');
  });
});

describe('性能红线（D2）：20 个带窗口任务全量计算必须 < 50ms', () => {
  /** 构造 n 个带窗口的真实形态任务（日级 + 周级混合，覆盖两档回看）。 */
  const tasks = Array.from({ length: 20 }, (_, i) => ({
    status: 'active',
    triggerType: 'cron',
    cronExpression: '0 8 * * *',
    timezone: 'Asia/Shanghai',
    maintenanceWindows: [
      i % 2 === 0
        ? { start: '30 2 * * *', end: '0 4 * * *', description: '发布冻结' }
        : { start: '0 3 * * 1', end: '0 4 * * 1', description: '周级冻结' },
    ],
  }));

  it('20 个任务全量 < 50ms（改前基线见 R282 回执：127ms 日级 / 962ms 周级）', () => {
    const now = new Date('2026-06-15T10:00:00Z');
    // 预热：Intl 格式化器首次构造与 JIT 不计入断言
    for (let i = 0; i < 3; i++) for (const t of tasks) nextRunOutcome(t, now);

    // R444：墙钟 → CPU user time 口径（不再靠 best-of-N 赌抢占窗口）。
    //   R442 全量实证：单跑 13.07ms，全量 forks 池 350 文件并发 best-of-3 = 72.8ms；
    //   R444 验收实测 best-of-9 仍 9/9 全被抢占 = 61.94ms > 50。OS 抢走的时间片
    //   算进墙钟、却不算进本进程 CPU，所以再多次取最小也救不回来。
    //   process.cpuUsage() 的 user 增量只统计本进程真正执行的 CPU 时间，天然免疫
    //   并发抢占；忙等/真实计算会转成 CPU 时间，反证照样转红，断言没被架空。
    // 阈值来源（PM 裁决）：R282 墙钟基线 13ms / 红线 50ms = 3.8× 余量；CPU user 口径
    //   实测区间 10.59–34.90ms（中位 ~20ms，独立验收多次采样），/ 红线 50ms = 1.4–4.7×
    //   余量——与墙钟同量级且部分更严，故 50ms 上限在 CPU 口径下不是放宽，数值保持 R282 契约。
    //   5 次取最小只用于滤掉进程内多线程/GC 的 CPU 记账抖动，与防抢占无关。
    // fail-closed：口径不可用/读数异常直接红，不降级为墙钟、不 skip。
    expect(typeof process?.cpuUsage).toBe('function');
    const CPU_SAMPLES = 5;
    const CPU_LIMIT_MS = 50;
    let cpuMs = Number.POSITIVE_INFINITY;
    let kinds: string[] = [];
    const cpuSamples: number[] = [];
    for (let i = 0; i < CPU_SAMPLES; i++) {
      const before = process.cpuUsage();
      kinds = tasks.map((t) => nextRunOutcome(t, now).kind);
      const userUs = process.cpuUsage(before).user;
      expect(Number.isFinite(userUs) && userUs >= 0).toBe(true); // fail-closed
      const sample = userUs / 1000; // µs → ms
      cpuSamples.push(sample);
      cpuMs = Math.min(cpuMs, sample);
    }

    expect(kinds).toHaveLength(20);
    expect(kinds.every((k) => k === 'at' || k === 'skipped-by-window')).toBe(true);
    console.log(`[PERF] 20 tasks cpu-user best-of-${CPU_SAMPLES} = ${cpuMs.toFixed(2)}ms samples=[${cpuSamples.map((s) => s.toFixed(1)).join(',')}]`);
    expect(cpuMs, `20 tasks cpu-user best-of-${CPU_SAMPLES} took ${cpuMs.toFixed(2)}ms`).toBeLessThan(CPU_LIMIT_MS);
  });
});


afterEach(cleanup);

const baseTask = (over: Partial<Task>): Task => ({
  id: 'task-1',
  name: 'demo',
  projectId: 'p1',
  status: 'active',
  triggerType: 'cron',
  cronExpression: '0 8 * * *',
  timezone: 'UTC',
  maxRetry: 3,
  timeout: 300,
  priority: 2,
  createdAt: '2026-09-01T08:00:00Z',
  updatedAt: '2026-09-07T08:00:00Z',
  ...over,
} as Task);

const deps: TaskListColumnsDeps = {
  // i18next 的 t 重载对本仓库的"任意键 + 插值对象"调用过窄（词条是闭合键集),
  // 这里只做一次显式转型——运行期就是真实的 i18n.t，断言才验得到真词条。
  t: ((k: string, o?: Record<string, unknown>) => i18n.t(k, (o ?? {}) as never)) as unknown as TaskListColumnsDeps['t'],
  statusConfig: {},
  triggerLabel: {},
  triggerColor: {},
  nav: () => {},
  isAdmin: false,
  togglingId: null,
  cloningId: null,
  colorPrimary: '#1677ff',
  onPause: async () => {},
  onResume: async () => {},
  onTrigger: () => {},
  onClone: async () => {},
  onDelete: async () => {},
};

/** 渲染「下次执行」列对该任务的输出文本。 */
function cellText(task: Task): string {
  const columns = buildTaskListColumns(deps);
  const colDef = columns.find((c) => c.key === 'nextRun');
  if (!colDef) throw new Error('nextRun column missing');
  const node = (colDef.render as (v: unknown, r: Task) => ReactNode)(undefined, task);
  const { container } = render(<MemoryRouter>{node}</MemoryRouter>);
  return container.textContent ?? '';
}

describe('R282: 列表「下次执行」列 —— 窗口内必须说出来', () => {
  it('窗口内 ⇒ 显式「跳过（维护窗口 …）」，不再是逐字相同的假时刻', () => {
    const text = cellText(
      baseTask({
        cronExpression: '0 8 * * *',
        timezone: 'UTC',
        maintenanceWindows: [{ start: '0 7 * * *', end: '0 9 * * *', description: '发布冻结' }],
      }),
    );
    expect(text).toContain(i18n.t('taskList.nextRun.skippedByWindow', { start: '07:00', end: '09:00' }));
    // 反证锚：此文案在"直接返回 at"的实现里绝不可能出现
    expect(text).not.toContain('09/');
  });

  it('窗口外 ⇒ 既有时刻文案（零视觉变化），且不含「跳过」字样', () => {
    const text = cellText(
      baseTask({
        cronExpression: '0 8 * * *',
        timezone: 'UTC',
        maintenanceWindows: [{ start: '0 9 * * *', end: '0 10 * * *' }],
      }),
    );
    expect(text.trim()).not.toBe('');
    expect(text).not.toContain(i18n.t('taskList.nextRun.skippedByWindow', { start: '', end: '' }).slice(0, 2));
  });

  it('时区未填/非法 + 配了窗口 ⇒ 不猜结论，显式「窗口内？时区未知」', () => {
    for (const timezone of [null, '', 'Not/AZone']) {
      const text = cellText(
        baseTask({
          cronExpression: '0 8 * * *',
          timezone,
          maintenanceWindows: [{ start: '0 7 * * *', end: '0 9 * * *' }],
        }),
      );
      expect(text).toContain(i18n.t('taskList.nextRun.unknownWindow'));
    }
  });

  it('未配窗口 ⇒ 既有时刻文案（与改动前一致：不含窗口相关字样）', () => {
    const text = cellText(baseTask({ cronExpression: '0 8 * * *', timezone: 'UTC' }));
    expect(text.trim()).not.toBe('');
    expect(text).not.toContain(i18n.t('taskList.nextRun.unknownWindow'));
  });

  it('暂停任务 ⇒ 既有占位（不看窗口）', () => {
    const text = cellText(
      baseTask({
        status: 'paused',
        maintenanceWindows: [{ start: '0 7 * * *', end: '0 9 * * *' }],
      }),
    );
    expect(text).toContain(i18n.t('taskList.nextRun.none'));
  });
});


/**
 * 详情页「下次执行」Tag（`TaskScheduleTags`）的渲染面。
 *
 * 判据刻意**不依赖真实时钟**（组件内部用 `new Date()`）：两例都靠窗口 cron 的
 * **形态**得出结论，与"现在几点"无关——
 *   · 始终开窗：start `* * * * *`（每分钟触达）+ end `0 3 30 2 *`（2 月 30 日，
 *     永不触达）⇒ 无论此刻是何时，最近触达都是 start、end 无触达 ⇒ **开窗**；
 *   · 始终关窗：start `0 3 30 2 *`（永不触达）⇒ startFire 为 null ⇒ 窗口静默
 *     失效 ⇒ **at**。这正是后端 scheduler spec 用的同款构造。
 */
describe('R282: 详情页「下次执行」Tag 的渲染面', () => {
  const BASE_TASK = {
    id: 'task-1',
    name: 'windowed-job',
    runtime: 'python',
    entrypoint: 'main.py',
    triggerType: 'cron',
    cronExpression: '*/5 * * * *',
    status: 'active',
    timezone: 'UTC',
    maxRetry: 3,
    timeout: 300,
    params: {},
  };

  const renderDetail = async (over: Record<string, unknown>) => {
    vi.mocked(tasksApi.get).mockResolvedValue({ ...BASE_TASK, ...over } as never);
    vi.mocked(tasksApi.executions).mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 } as never);
    vi.mocked(tasksApi.stats).mockResolvedValue({ recentExecutions: [], successRate: 0, avgDuration: 0, totalRuns: 0 } as never);
    vi.mocked(tasksApi.schedulerStats).mockResolvedValue({ healthy: true, activeTimers: 0, activeCronTasks: 0, runningTaskCount: 0, totalScheduledTasks: 0, uptime: 0 } as never);
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter>
          <TaskDetailPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getAllByText('windowed-job').length).toBeGreaterThan(0));
  };

  it('窗口内 ⇒ Tag 说「跳过（维护窗口 …）」而不是 processing 蓝的假时刻', async () => {
    await renderDetail({ maintenanceWindows: [{ start: '* * * * *', end: '0 3 30 2 *' }] });
    const tag = await screen.findByText(/^跳过（维护窗口/);
    expect(tag).toBeTruthy();
    // 反证锚：窗口 Tag（橙色）另有一个「维护窗口」描述项，这里断言的是工作区
    // 出现的是**跳过**语义，而不是一个看起来确定会跑的时刻。
    expect(screen.queryByText(/^下次执行 \d{2}\//)).toBeNull();
  });

  it('窗口关（start 永不触达）⇒ 既有「下次执行 {{time}}」Tag（零视觉变化）', async () => {
    await renderDetail({ maintenanceWindows: [{ start: '0 3 30 2 *', end: '0 4 * * *' }] });
    expect(await screen.findByText(/^下次执行 \d{2}\//)).toBeTruthy();
    expect(screen.queryByText(/^跳过（维护窗口/)).toBeNull();
  });
});
