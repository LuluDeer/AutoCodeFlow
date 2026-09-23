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
 * ② **应用列表的部署统计被静默截断到 20 条**。`deploymentsApi.list(app.id)`
 *    用默认 pageSize=20，统计只数当前页：部署行 >20 的应用分母恒为 20，且
 *    **一个正在运行但排在 20 行之外的实例会让整列显示"均未运行"**。
 *    修法：显式取后端上限 100，分母改用响应里的 total。
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
  executorsApi: { list: vi.fn() },
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
    (executorsApi.list as ReturnType<typeof vi.fn>).mockResolvedValue([]);
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

describe('应用列表统计：不得被默认分页静默截断', () => {
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
    (executorsApi.list as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  });

  afterEach(() => {
    cleanup();
    clearAntdMessages();
  });

  it('按后端上限 100 取数（不是默认 20），且分母用响应 total', async () => {
    // 构造"运行中的实例排在窗口外"的场景：本页 100 行全是 stopped，
    // 但 total=137（说明还有更多行没取到）。
    const page = Array.from({ length: 100 }, (_, i) =>
      dep({ id: `d-${i}`, status: 'stopped' }),
    );
    (deploymentsApi.list as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: page,
      total: 137,
    });

    render(<ApplicationListPage />);

    await waitFor(() => expect(deploymentsApi.list).toHaveBeenCalled());
    // ① 必须显式传 pageSize=100（默认 20 会让分母偏小、且运行中实例可能漏计）
    const call = (deploymentsApi.list as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[1]).toBe(1);
    expect(call[2]).toBe(100);
    // ② 分母必须是真实总数 137，不是本页长度 100。
    //    渲染走的是「{{total}} 个部署均未运行」这条文案——直接断言整句，
    //    比只查 /137/ 更能钉住"分母来自 total"这一意图（本页长度恰好是 100，
    //    只查 137 会在分母被改回 deps.length 时……仍然命中 137 之外的数字而
    //    漏判；断言完整文案才真正锁住）。
    await waitFor(() =>
      expect(screen.getByText('137 个部署均未运行')).toBeTruthy(),
    );
    // 反证：本页长度 100 绝不能出现在分母位置（修复前的形态）
    expect(screen.queryByText('100 个部署均未运行')).toBeNull();
  });
});
