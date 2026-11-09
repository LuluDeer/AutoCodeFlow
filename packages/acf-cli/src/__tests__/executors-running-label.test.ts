/**
 * R68（§7.17 P3 收尾）`acf-cli-running-label`：`acf executor list` / `acf executor get`
 * 里的「Running Tasks」是不是「实际在跑的任务数」？
 *
 * ## 事实（已核实，非猜测）
 *
 * · 上游 `GET /executors`（`executor.service.ts::findAll` → `repo.find(...)`，**无 select
 *   收窄**）与 `GET /executors/:id`（`findOne` → `repo.findOne`）返回**整行实体**；
 *   实体列含 `reservedSlots`（`executor.entity.ts:213`，DTO 亦有：
 *   `executor-response.dto.ts:137`）⇒ **CLI 拿得到 reservedSlots**；
 * · `runningTaskCount` 是**已占槽位**（含 E-01 pull 取件预留；R16 起还被抬到
 *   「客户端上报 vs 服务端在途占坑」的较大值）；
 * · `reservedSlots` = 已预留但尚未领取的槽位 ⇒ **实际在跑 = 已占 − 预留**（下限 0），
 *   与 admin-web 详情页（R18/R59）同一口径。
 *
 * ⇒ CLI 旧文案「Running Tasks : N」把**已占槽位**说成在跑任务数：空闲 pull 执行器
 * 会显示「Running Tasks : 1」而机器上没有任何任务在跑（admin-web 侧同类谎报已在
 * R62/R64/R67 逐处消歧，本文件是同一系列的最后一处）。
 *
 * ## 本文件钉住的口径
 *
 * ① `reservedSlots` **可算**（上游给了）⇒ `executor get` 显示**实际在跑**
 *    （已占 − 预留，下限 0），并**同时**显示「已占槽位」，两个数都在；
 * ② `reservedSlots` 缺失/null（旧版执行器未上报）⇒ **无从换算** ⇒ 只显示
 *    「已占槽位」，**不得**出现「Running Tasks」行（不谎称在跑任务数）；
 * ③ `executor list` 是**机群概览**（容量视角，同 R67 热力条 / R64 部署下拉）⇒
 *    列头如实叫「Occupied」，值为已占槽位；
 * ④ `runningExecutionIds`（另一账本：真正领取到的执行）保持原三态输出不动。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('ora', () => ({
  default: () => {
    const o: Record<string, unknown> = {
      succeed: vi.fn(), fail: vi.fn(), stop: vi.fn(), text: '',
    };
    o.start = vi.fn(() => o);
    return o;
  },
}));

vi.mock('chalk', () => ({
  default: {
    green: (s: unknown) => String(s),
    gray: (s: unknown) => String(s),
    red: (s: unknown) => String(s),
    yellow: (s: unknown) => String(s),
    cyan: (s: unknown) => String(s),
    bold: (s: unknown) => String(s),
  },
}));

vi.mock('../client.js', () => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  patch: vi.fn(),
  del: vi.fn(),
  resetClient: vi.fn(),
  formatApiError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  classifyApiError: () => 'unknown',
}));

import { get } from '../client.js';
import { executorsCommand } from '../commands/executors.js';

const mockedGet = vi.mocked(get);

async function run(args: string): Promise<void> {
  const { Command } = await import('commander');
  const program = new Command();
  program.addCommand(executorsCommand() as never);
  program.exitOverride();
  const parts = args.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((s) => s.replace(/"/g, '')) ?? [];
  await program.parseAsync(['node', 'acf', ...parts], { from: 'node' });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code})`);
  }) as never);
});

/** 抓取本次命令的全部 stdout。 */
async function capture(args: string): Promise<string> {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    await run(args);
    return log.mock.calls.map((c) => c.join(' ')).join('\n');
  } finally {
    log.mockRestore();
  }
}

describe('R68 — acf executor：不得把「已占槽位」说成「Running Tasks」', () => {
  it('【正向】有 reservedSlots ⇒ 显示实际在跑（已占 − 预留），且已占槽位也在', async () => {
    // 空闲 pull 执行器：已占 1（就是那个取件预留），实际在跑 0。
    mockedGet.mockResolvedValueOnce({
      id: 'e1', appName: 'RPA5', address: '10.0.0.5:3002', status: 'online',
      runningTaskCount: 1, reservedSlots: 1, maxConcurrentTasks: 10,
    });
    const out = await capture('executor get e1');

    // 旧实现打印「Running Tasks : 1」——谎称有 1 个任务在跑。
    expect(out).not.toMatch(/Running Tasks\s*:\s*1\b/);
    // 新口径：实际在跑 = 1 − 1 = 0；同时如实给出已占槽位 1。
    expect(out).toMatch(/Running Tasks\s*:\s*0\b/);
    expect(out).toMatch(/Occupied Slots\s*:\s*1\b/);
  });

  it('【反向】旧版执行器未上报 reservedSlots ⇒ 无从换算，只显示「已占槽位」', async () => {
    mockedGet.mockResolvedValueOnce({
      id: 'e1', appName: 'RPA5', address: '10.0.0.5:3002', status: 'online',
      runningTaskCount: 3, maxConcurrentTasks: 10,
    });
    const out = await capture('executor get e1');

    // 无从换算 ⇒ 不得出现「Running Tasks」行（不谎称在跑任务数）。
    expect(out).not.toMatch(/Running Tasks\s*:/);
    // 必须如实说明这个数是「已占槽位」。
    expect(out).toMatch(/Occupied Slots\s*:\s*3\b/);
  });

  it('【反向】reservedSlots 为 null（旧版执行器三态）⇒ 同回落「已占槽位」', async () => {
    mockedGet.mockResolvedValueOnce({
      id: 'e1', appName: 'RPA5', address: '10.0.0.5:3002', status: 'online',
      runningTaskCount: 3, reservedSlots: null, maxConcurrentTasks: 10,
    });
    const out = await capture('executor get e1');

    expect(out).not.toMatch(/Running Tasks\s*:/);
    expect(out).toMatch(/Occupied Slots\s*:\s*3\b/);
  });

  it('【反向】计数自相矛盾（reserved > 已占）⇒ 实际在跑不得为负', async () => {
    // R16/R17 实证可达的落库形态：服务端抬高了已占下限，预留仍是旧自述值。
    mockedGet.mockResolvedValueOnce({
      id: 'e1', appName: 'RPA5', address: '10.0.0.5:3002', status: 'online',
      runningTaskCount: 1, reservedSlots: 8, maxConcurrentTasks: 10,
    });
    const out = await capture('executor get e1');

    expect(out).not.toMatch(/Running Tasks\s*:\s*-\d/);
    expect(out).toMatch(/Running Tasks\s*:\s*0\b/);
  });

  it('【列表】表格列头不得再叫「Running」而声称在跑；机群概览按已占槽位', async () => {
    mockedGet.mockResolvedValueOnce([
      {
        id: '11111111-2222-3333-4444-555555555555', appName: 'RPA5',
        address: '10.0.0.5:3002', status: 'online',
        runningTaskCount: 4, reservedSlots: 4, maxConcurrentTasks: 10,
      },
    ]);
    const out = await capture('executor list');

    // 表头：旧的是「Running」，易被读成「在跑任务数」。
    expect(out).not.toMatch(/\bRunning\b/);
    expect(out).toMatch(/Occupied/);
    // 列值 = 已占槽位（机群概览 = 容量视角）。
    expect(out).toMatch(/4/);
  });

  it('【保持】runningExecutionIds 三态输出不变（另一账本，不是槽位）', async () => {
    mockedGet.mockResolvedValueOnce({
      id: 'e1', appName: 'exec', address: 'x:1', status: 'online',
      runningTaskCount: 0, reservedSlots: 0, runningExecutionIds: ['aaaa-bbbb'],
    });
    const out = await capture('executor get e1');

    expect(out).toMatch(/Running Executions:\s*1 running: aaaa-bbbb/);
  });
});
