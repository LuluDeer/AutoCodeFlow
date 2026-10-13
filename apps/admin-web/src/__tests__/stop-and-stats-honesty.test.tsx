/**
 * 用户报障回归：「界面说的和实际不一致」——停止/统计两处会给出错误答案。
 *
 * 报障原文：「全面排查和优化潜在问题，或者体验不好的地方，客户端执行器 和
 * 中台 的显示和交互是重点。」
 *
 * 本文件覆盖两条同源缺陷（都属"中台显示不可信"）：
 *
 * ① **停止在未触达执行器时仍报成功**。后端 stop() 是 best-effort：执行器离线/
 *    不可达时只 `logger.warn`，行照样转 STOPPED，接口返回 {status:'stopped'}。
 *    于是用户看到"已停止"、行变灰，但设备上的进程还在跑——而该行已不在 running
 *    （没有停止按钮），用户失去了唯一的真相来源。修法：后端把送达失败写进
 *    statusMessage（前缀 [Stop not delivered] ），前端据此改用 warning。
 *
 * ② **应用列表的部署统计**。原实现逐应用拉列表（默认 pageSize=20）再在前端
 *    filter，统计只数当前页：部署行 >20 的应用分母恒为 20，且**一个正在运行但
 *    排在 20 行之外的实例会让整列显示"均未运行"**。先修为"显式取上限 100 + 分母
 *    用响应 total"；2026-10-13 生产报障（26 个应用 = 26 个请求共享同一个 60/min
 *    限流桶 → 整页 ThrottlerException 429）后，进一步改为**服务端聚合**
 *    （GET /app-deployments/stats，1 个请求）。本文件覆盖"分母不得被静默截断"
 *    这一不变意图，并反证不得退回逐应用扇出。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import AppDeploymentPage from '../pages/AppDeploymentPage';
import ApplicationListPage from '../pages/ApplicationListPage';
import { deploymentsApi, applicationsApi } from '../api/applications';
import { executorsApi } from '../api/executors';
import { useAuthStore } from '../store/auth';
import {
  STOP_NOT_DELIVERED_PREFIX,
  isStopNotDelivered,
} from '../utils/backend-contracts';

vi.mock('../api/applications', () => ({
  deploymentsApi: {
    list: vi.fn(),
    // 列表页统计走聚合端点（1 个请求），见本文件头注 ②。
    stats: vi.fn().mockResolvedValue([]),
    deploy: vi.fn(),
    stop: vi.fn(),
    upgrade: vi.fn(),
    remove: vi.fn(),
    approve: vi.fn(),
    reject: vi.fn(),
    cancel: vi.fn(),
  },
  applicationsApi: { list: vi.fn(), upgradeAll: vi.fn(), remove: vi.fn(), removalImpact: vi.fn() },
}));
vi.mock('../api/executors', () => ({
  executorsApi: { list: vi.fn(), picker: vi.fn() },
}));
// ApplicationListPage 用 useNavigate/Link；单测无 Router，按既有先例
// （application-list-quick-deploy.test.tsx）mock 掉路由面。
vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
  Link: ({ children }: { children?: unknown }) => children,
  useSearchParams: () => [new URLSearchParams(), vi.fn()],
  useLocation: () => ({ pathname: '/applications', search: '', hash: '', state: null }),
}));

/**
 * 找 Popconfirm 的确认按钮。
 *
 * 必须**等弹层挂载后再查**：`document.querySelector('.ant-popconfirm')` 在首个
 * tick 就返回 null（弹层异步渲染），直接 click 会抛
 * "Unable to fire a click event - provided element is null"。
 * 与 app-deployment-delete-record.test.tsx 同款写法（按文案匹配）。
 */
async function clickPopconfirmButton(label: string): Promise<void> {
  const btn = await waitFor(() => {
    const b = Array.from(document.body.querySelectorAll('.ant-popconfirm button')).find(
      (x) => (x.textContent ?? '').replace(/\s/g, '') === label,
    );
    expect(b).toBeTruthy();
    return b as HTMLButtonElement;
  });
  fireEvent.click(btn);
}

/** 找到行内按钮（按可见文案）。 */
async function findRowButton(label: string): Promise<HTMLButtonElement> {
  return waitFor(() => {
    const b = Array.from(document.querySelectorAll('button')).find((x) =>
      (x.textContent ?? '').includes(label),
    );
    expect(b).toBeTruthy();
    return b as HTMLButtonElement;
  });
}

/**
 * 清掉 antd 静态 message 的残留**通知**（保留 holder 容器本身）。
 *
 * `message.success/warning(...)` 是**静态调用**：它把 holder（`.ant-message`）
 * 直接挂到 document.body 上，不归 React 树管，因此 RTL 的 `cleanup()` 不会移除
 * 它。不清理的话，上一条用例弹出的警告会留在 DOM 里，让"本次没有警告"这类反证
 * 断言假失败。
 *
 * 注意**只删通知、不删 holder**：antd 内部缓存了 holder 节点引用，把 holder
 * 一起删掉后，后续 message 会渲染进那个已脱离文档的节点，于是**再也查不到**
 * 任何提示（实测：删 holder 会让"正常送达"用例查不到"已停止"）。
 */
function clearAntdMessages(): void {
  document.querySelectorAll('.ant-message-notice').forEach((n) => n.remove());
}

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
    matches: false,
    media: q,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

const dep = (overrides: Record<string, unknown> = {}) => ({
  id: 'dep-1',
  applicationId: 'app-1',
  executorId: 'exec-1',
  executorAddress: 'executor-a:3001',
  status: 'running',
  runMode: 'daemon',
  deployedVersion: '1.0.0',
  statusMessage: null,
  deployedAt: new Date().toISOString(),
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  ...overrides,
});

describe('契约常量：STOP_NOT_DELIVERED_PREFIX 与后端同源', () => {
  it('前端常量与后端 service 里的字面量逐字一致', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const svc = fs.readFileSync(
      path.resolve(process.cwd(), '../admin-api/src/modules/application/app-deployment.service.ts'),
      'utf8',
    );
    // 从后端源码里**提取**它实际使用的字面量，再与前端常量比对（而不是把期望值
    // 在测试里再抄一遍——那样改错前缀测试照样绿）。
    const backendLiteral = svc.match(
      /export const STOP_NOT_DELIVERED_PREFIX = "([^"]*)";/,
    )?.[1];
    expect(backendLiteral).toBeTruthy();
    // 反证：若后端改了前缀而前端没跟上，前端就再也识别不出"未送达"，
    // 用户又会看到"已停止"的假成功——本条立即变红。
    expect(backendLiteral).toBe(STOP_NOT_DELIVERED_PREFIX);
    // 前端必须真的拿它去判（而非定义了不用）
    const page = fs.readFileSync(
      path.resolve(process.cwd(), 'src/pages/AppDeploymentPage.tsx'),
      'utf8',
    );
    expect(page).toContain('isStopNotDelivered');
  });

  it('isStopNotDelivered 只认该前缀', () => {
    expect(isStopNotDelivered(`${STOP_NOT_DELIVERED_PREFIX}ECONNREFUSED`)).toBe(true);
    expect(isStopNotDelivered('Deployed in scheduled mode')).toBe(false);
    expect(isStopNotDelivered(null)).toBe(false);
    expect(isStopNotDelivered(undefined)).toBe(false);
  });
});

describe('停止：未送达执行器时必须用 warning 如实告知', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearAntdMessages();
    useAuthStore.setState({
      user: { id: 1, username: 'admin', role: 'admin' } as never,
      token: 't',
    } as never);
    // 部署页已不请求 list()（R3-E 收口：名字解析吃 picker 行），list mock 随之退场
    (executorsApi.picker as ReturnType<typeof vi.fn>).mockResolvedValue({ items: [], total: 0, truncated: false, limit: 2000 });
  });

  afterEach(() => {
    cleanup();
    clearAntdMessages();
  });

  it('后端返回送达失败前缀 → 提示"未能联系到执行器"而不是"已停止"', async () => {
    (deploymentsApi.list as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [dep()],
      total: 1,
    });
    (deploymentsApi.stop as ReturnType<typeof vi.fn>).mockResolvedValue(
      dep({
        status: 'stopped',
        statusMessage: `${STOP_NOT_DELIVERED_PREFIX}connect ECONNREFUSED 10.0.0.5:8003`,
      }),
    );
    render(<AppDeploymentPage applicationId="app-1" />);

    const stopBtn = await findRowButton('停止');
    fireEvent.click(stopBtn);
    await clickPopconfirmButton('停止');

    await waitFor(() => expect(deploymentsApi.stop).toHaveBeenCalledWith('dep-1'));
    // 反证：必须出现"未能联系到执行器"的如实提示。若实现退回恒报 success，
    // 这里查不到该文案 → 变红（这正是修复前的形态）。
    await waitFor(() =>
      expect(screen.getByText(/未能联系到执行器/)).toBeTruthy(),
    );
  });

  it('正常送达时仍报"已停止"（反证：不能因为新增判断就恒报 warning）', async () => {
    (deploymentsApi.list as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [dep()],
      total: 1,
    });
    (deploymentsApi.stop as ReturnType<typeof vi.fn>).mockResolvedValue(
      dep({ status: 'stopped', statusMessage: null }),
    );
    render(<AppDeploymentPage applicationId="app-1" />);

    const stopBtn = await findRowButton('停止');
    fireEvent.click(stopBtn);
    await clickPopconfirmButton('停止');

    await waitFor(() => expect(screen.getByText('已停止')).toBeTruthy());
    expect(screen.queryByText(/未能联系到执行器/)).toBeNull();
  });
});

describe('应用列表统计：1 个聚合请求、分母不得被静默截断', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearAntdMessages();
    useAuthStore.setState({
      user: { id: 1, username: 'admin', role: 'admin' } as never,
      token: 't',
    } as never);
    (applicationsApi.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'app-1', name: '订单同步', version: '1.0.0', runtime: 'node' },
    ]);
    // 默认无部署行（各用例按需覆盖）——clearAllMocks 不清实现，这里显式兜底。
    (deploymentsApi.stats as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  });

  afterEach(() => {
    cleanup();
    clearAntdMessages();
  });

  it('统计走 1 个聚合请求（不按应用数扇出），且分母用服务端真实 total', async () => {
    // 构造"运行中的实例排在取数窗口外"的场景：服务端聚合给出的 total=137，
    // 而 running=0、failed=0（说明更多行里没有在跑的）。
    //
    // 历史脉络：本条原先是「显式传 pageSize=100，别用默认 20」——因为当时是
    // 逐应用拉列表再在前端 filter。2026-10-13 生产报障后改为服务端聚合
    // （GET /app-deployments/stats）：26 个应用各发一个 list 会共享同一个
    // 60/min 限流桶，进页面+返回+部署后刷新就打满 → 整页 429。现在无论多少
    // 应用都只发 1 个请求，**"分母不得被静默截断"这一意图不变**，只是保证方
    // 从"取到上限 100"上移到了服务端聚合。
    (deploymentsApi.stats as ReturnType<typeof vi.fn>).mockResolvedValue([
      { applicationId: 'app-1', total: 137, running: 0, failed: 0, lastDeployedAt: null },
    ]);

    render(<ApplicationListPage />);

    // ① 只发 1 个聚合请求——这是 429 报障的修复本体：请求数不再随应用数增长。
    await waitFor(() => expect(deploymentsApi.stats).toHaveBeenCalledTimes(1));
    // 反证：绝不能再走逐应用 list 扇出（旧实现即 26 个请求打满限流桶）。
    expect(deploymentsApi.list).not.toHaveBeenCalled();
    // ② 分母必须是服务端给的 137，不是任何"本页长度"。
    //    渲染走的是「{{total}} 个部署均未运行」这条文案——直接断言整句，
    //    比只查 /137/ 更能钉住"分母来自 total"这一意图。
    await waitFor(() =>
      expect(screen.getByText('137 个部署均未运行')).toBeTruthy(),
    );
  });

  it('聚合结果按 applicationId 落到对应行；未出现在 stats 的应用按 0 处理', async () => {
    (applicationsApi.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'app-1', name: '有部署的应用', version: '1.0.0', runtime: 'node' },
      { id: 'app-2', name: '没有部署的应用', version: '1.0.0', runtime: 'node' },
    ]);
    (deploymentsApi.stats as ReturnType<typeof vi.fn>).mockResolvedValue([
      { applicationId: 'app-1', total: 3, running: 2, failed: 1, lastDeployedAt: new Date().toISOString() },
      // app-2 无部署行 → 服务端不返回该行
    ]);

    render(<ApplicationListPage />);

    // app-1：如实显示 2/3 运行中
    await waitFor(() => expect(screen.getByText('2 / 3 台运行中')).toBeTruthy());
    // app-2：回落「暂无部署」，而不是因为查不到就崩掉或显示空白
    expect(screen.getByText('暂无部署')).toBeTruthy();
  });
});
