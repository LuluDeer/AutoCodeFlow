/**
 * 用户报障回归：中台「执行器」列只有一个 IP:端口，看不出是哪台机器。
 *
 * 报障原文（与桌面端同批）：「全面排查和优化潜在问题…客户端执行器 和 中台 的
 * 显示和交互是重点」。
 *
 * 问题形态：部署表（AppDeploymentPage）与版本历史/发布记录表
 * （ApplicationDetailPage 的 VersionHistoryTab / ReleasesTab）的「执行器」列
 * 此前只渲染 `executorAddress`（如 `192.168.4.54:8003`）。用户给执行器起的
 * 名字（`executorName`，注册时上报，执行器列表页就在显示）在这些列里完全缺席
 * ——"这条部署到哪台机器了"要靠背 IP 才能答上来。
 *
 * 数据其实早就在前端：部署页为了渲染下拉候选本来就 GET /executors 拿到完整
 * 清单。缺的只是把两处接起来。修复统一走 useExecutorNames（优先 executorId，
 * 回落 address，解析不到则如实显示地址）。
 *
 * 本测试同时钉住：
 *   ① 解析口径（id 优先 / address 回落 / 匹配不到返回 null 不编造）；
 *   ② 三个表格列**真的接了**解析（源码守卫——只测 hook 不够：hook 可以对而
 *      页面根本没调用它，那正是本次缺陷的形态）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, cleanup } from '@testing-library/react';
import { executorsApi } from '../api/executors';
import { useExecutorNames } from '../hooks/useExecutorNames';

vi.mock('../api/executors', () => ({
  executorsApi: { list: vi.fn() },
}));

const makeExecutor = (over: Record<string, unknown> = {}) => ({
  id: 'exec-1',
  appName: '财务部-主力机',
  address: '192.168.4.54:8003',
  status: 'online',
  runtime: 'node',
  tags: [],
  runtimes: ['node'],
  lastHeartbeat: new Date().toISOString(),
  ...over,
});

describe('useExecutorNames：执行器可读名解析', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('按 executorId 解析出可读名（主口径）', async () => {
    (executorsApi.list as ReturnType<typeof vi.fn>).mockResolvedValue([makeExecutor()]);
    const { result } = renderHook(() => useExecutorNames());
    await waitFor(() => expect(result.current.nameOf({ executorId: 'exec-1' })).toBe('财务部-主力机'));
  });

  it('executorId 缺失的旧记录回落按 address 匹配', async () => {
    (executorsApi.list as ReturnType<typeof vi.fn>).mockResolvedValue([makeExecutor()]);
    const { result } = renderHook(() => useExecutorNames());
    await waitFor(() =>
      expect(result.current.nameOf({ executorAddress: '192.168.4.54:8003' })).toBe('财务部-主力机'),
    );
  });

  it('匹配不到时返回 null——绝不编造名字（调用方回落显示地址）', async () => {
    (executorsApi.list as ReturnType<typeof vi.fn>).mockResolvedValue([makeExecutor()]);
    const { result } = renderHook(() => useExecutorNames());
    await waitFor(() => expect(result.current.executors.length).toBe(1));
    // 反证：未知执行器必须返回 null。若实现回落成"未知执行器"或把地址当名字，
    // 用户会以为那是个真实名字，排查时无法与地址对上。
    expect(result.current.nameOf({ executorId: 'ghost', executorAddress: '10.0.0.9:1' })).toBeNull();
    expect(result.current.nameOf({})).toBeNull();
  });

  it('executorId 命中优先于 address（两者指向不同执行器时不串味）', async () => {
    (executorsApi.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeExecutor({ id: 'exec-1', appName: '甲机器', address: '10.0.0.1:1' }),
      makeExecutor({ id: 'exec-2', appName: '乙机器', address: '10.0.0.2:2' }),
    ]);
    const { result } = renderHook(() => useExecutorNames());
    await waitFor(() => expect(result.current.executors.length).toBe(2));
    // id 与 address 各指向不同执行器时，必须信 id（address 可能因换网/复用而漂移）
    expect(result.current.nameOf({ executorId: 'exec-2', executorAddress: '10.0.0.1:1' })).toBe('乙机器');
  });

  it('清单拉取失败时静默降级（名字为 null），不抛错、不阻断页面', async () => {
    (executorsApi.list as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useExecutorNames());
    await waitFor(() => expect(result.current.loading).toBe(false));
    // 名字解析失败只是不够友好，不该让部署表报错——地址照常显示
    expect(result.current.nameOf({ executorAddress: '192.168.4.54:8003' })).toBeNull();
  });

  it('appName 为空白的执行器不参与解析（不产生空名字）', async () => {
    (executorsApi.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeExecutor({ appName: '   ' }),
    ]);
    const { result } = renderHook(() => useExecutorNames());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.nameOf({ executorId: 'exec-1' })).toBeNull();
  });
});

describe('中台执行器列接线守卫（源码）', () => {
  /**
   * 只测 hook 是不够的：hook 可以完全正确，而页面根本没调用它——那正是本次
   * 缺陷的形态（数据早已在 state 里，只是没被用上）。这里直接读页面源码钉住
   * 三个「执行器」列都接了 nameOf。
   */
  it('三个执行器列都接入了可读名解析', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const read = (p: string) => fs.readFile(path.resolve(process.cwd(), p), 'utf-8');

    const deploySrc = await read('src/pages/AppDeploymentPage.tsx');
    const detailSrc = await read('src/pages/ApplicationDetailPage.tsx');

    // 部署表：必须调用 nameOf 且保留地址作为回落
    expect(deploySrc).toContain('useExecutorNames');
    expect(deploySrc).toMatch(/const displayName = nameOf\(r\)/);
    expect(deploySrc).toMatch(/displayName \?\? \(r\.executorAddress \|\| r\.executorId\)/);
    // 反证：**主标题**不得退回"只渲染地址"的旧形态。旧形态的特征是 strong 的
    // tooltip 之后紧跟裸地址作为子节点（`tooltip: … }}>` 后直接就是地址）。
    // 不能用「出现 {r.executorAddress || r.executorId}</Text>」做判据——新实现
    // 的**次要行**（地址副标题）正是那个形态，会把正确实现误判为回归。
    expect(deploySrc).not.toMatch(
      /tooltip: r\.executorAddress \|\| r\.executorId \}\}>\s*\{r\.executorAddress \|\| r\.executorId\}/,
    );

    // 版本历史 + 发布记录两处列
    expect(detailSrc).toContain('useExecutorNames');
    const nameOfCalls = detailSrc.match(/nameOf\(\{ executorAddress: v \}\)/g) ?? [];
    expect(nameOfCalls.length).toBe(2);
    // 解析不到时必须如实回落地址（而不是显示空白/'未知'）
    expect(detailSrc).toMatch(/if \(!name\) return v \|\| '-';/);
  });
});
