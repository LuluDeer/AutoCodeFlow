/**
 * H-6（本轮 web-hardening，Round 2）：SSE 工厂的 visible 恢复路径必须遵守
 * 调用方传入的 `reconnect` 语义。
 *
 * ── 缺陷（Round 1 审计 §1.7 缺陷 1）────────────────────────────────────
 * `createSseClient` 里 `reconnect:false` 的判据**只写在 scheduleReconnect**
 * （`if (!reconnect) { setStatus('reconnecting'); return; }`），而
 * `onVisibilityChange` 的 visible 分支**直接调 `connect()`**、完全不经过
 * scheduleReconnect ⇒ 调用方明确声明的「断线即停（交由轮询兜底）」在
 * 可见性恢复路径上形同虚设：标签页切回前台时工厂会**静默复活一条流**。
 *
 * 后果（ExecutionLogSection，`reconnect:false` + 自管重连预算 + 8s 轮询
 * 兜底）：工厂静默重连 ⇒ 组件侧状态机（retryCount / gaveUp /
 * streamDisconnected）毫不知情 ⇒ **日志流与 8s 轮询兜底同时在跑**，
 * 同一条数据两个新鲜度来源（状态机不同步）。
 *
 * ── 本文件钉住的行为（每条都能失败）────────────────────────────────────
 *   ① reconnect:false + hidden→visible ⇒ **不重建** EventSource，
 *      且状态转为 'reconnecting'（把恢复决策权交还调用方）；
 *   ② reconnect:false + hidden→visible ⇒ **不消耗换票预算**（不新建票据）；
 *   ③ reconnect:true（默认）时 visible 行为**完全不变**：立即重建 +
 *      attempt 归零 + 状态回 'connecting'（不继承退避）——
 *      这是本次修改的**非回归护栏**，防止把默认路径改坏；
 *   ④ 端到端：经**真实消费方**（ExecutionLogSection 的 effect）驱动，
 *      断言「降级到轮询兜底后切走标签页再切回，不会复活 SSE 连接」
 *      ⇒ **轮询兜底与日志流不再双跑**。
 *
 * ④ 是本文件的核心：**断言直接打在真实消费路径上**（不是直接调工厂函数
 * 断言返回值）——吸取上一轮「守卫自指盲区」的教训：只有经消费方路径
 * 生效的断言才证明得了「缺陷真的被修掉了」。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createSseClient, SSE_STATUS_KEYS } from '../api/sse-client';

// 组件按 status 判定是否建流；本文件只关心 SSE 生命周期，隔离 tasks api。
vi.mock('../api/tasks', () => ({
  tasksApi: {
    executionLogs: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    get: vi.fn().mockResolvedValue({}),
  },
}));

// A5：SSE 建流前先换 30s 短效票据。组件走 createSseClient 的默认换票函数，
// 这里桩成固定值（否则会去打真实网络）。
vi.mock('../api/sse', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/sse')>();
  return { ...actual, fetchSseTicket: vi.fn().mockResolvedValue('tok-h6') };
});

// jsdom 缺失 antd 依赖的浏览器 API（既有先例 shim：audit-page / settings.ai）。
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

// ── Fake EventSource ─────────────────────────────────────────────────────
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  closed = false;
  onopen?: () => void;
  onerror?: () => void;
  onmessage?: (e: unknown) => void;
  private listeners = new Map<string, Array<(e: unknown) => void>>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  addEventListener(name: string, cb: (e: unknown) => void) {
    const arr = this.listeners.get(name) ?? [];
    arr.push(cb);
    this.listeners.set(name, arr);
  }
  emit(name: string, e: unknown = { data: '' }) {
    for (const cb of this.listeners.get(name) ?? []) cb(e);
  }
  close() {
    this.closed = true;
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0));

let visState: DocumentVisibilityState = 'visible';

function setVisibility(next: DocumentVisibilityState) {
  visState = next;
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visState,
  });
  document.dispatchEvent(new Event('visibilitychange'));
}

const makeClient = (over: Partial<Parameters<typeof createSseClient>[0]> = {}) => {
  const c = createSseClient({
    baseUrl: 'http://api',
    path: '/logs/stream',
    statusKey: SSE_STATUS_KEYS.metricsStream,
    fetchTicket: async () => 't-1',
    ...over,
  });
  // 登记以便 afterEach 统一 close()——否则某个用例断言失败时其 client 泄漏，
  // 残留的 visibilitychange 监听会在后续用例里额外建流 ⇒ **用例间串扰**，
  // 使「构造漂移 ⇒ 守卫变红」的实证读数失真。
  createdClients.push(c);
  return c;
};

const createdClients: { close: () => void }[] = [];

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource);
  visState = 'visible';
});

afterEach(() => {
  for (const c of createdClients.splice(0)) c.close();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete (document as unknown as Record<string, unknown>).visibilityState;
});

// ── ① / ② / ③：工厂层契约 ───────────────────────────────────────────────
describe('H-6：visible 恢复路径遵守 reconnect 契约', () => {
  it('① reconnect:false 时 hidden→visible 不重建 EventSource（断线即停的语义不被绕过）', async () => {
    vi.useFakeTimers();
    const statuses: string[] = [];
    const client = makeClient({
      reconnect: false,
      onStatus: (s) => statuses.push(s),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeEventSource.instances).toHaveLength(1);

    // 标签页切后台 → 工厂关流并进入 paused
    setVisibility('hidden');
    expect(FakeEventSource.instances[0].closed).toBe(true);

    // 切回前台：reconnect:false ⇒ **不得**重建
    setVisibility('visible');
    await vi.advanceTimersByTimeAsync(0);

    // 关键断言：仍只有最初那一条连接（旧实现会变成 2 条 ⇒ 双跑）
    expect(FakeEventSource.instances).toHaveLength(1);
    // 状态须报告 'reconnecting'——把「要不要重建」的决策权交还调用方
    expect(statuses[statuses.length - 1]).toBe('reconnecting');
    client.close();
  });

  it('② reconnect:false 时 visible 恢复不消耗换票预算（不新建票据）', async () => {
    const fetchTicket = vi.fn().mockResolvedValue('t-1');
    const client = makeClient({ reconnect: false, fetchTicket });
    await flush();
    expect(fetchTicket).toHaveBeenCalledTimes(1);

    setVisibility('hidden');
    setVisibility('visible');
    await flush();

    // 换票是建流的前置：多一次调用即说明工厂擅自复活了流
    expect(fetchTicket).toHaveBeenCalledTimes(1);
    expect(FakeEventSource.instances).toHaveLength(1);
    client.close();
  });

  it('③ reconnect:true（默认）时 visible 行为不变：立即重建 + attempt 归零 + 状态回 connecting', async () => {
    vi.useFakeTimers();
    const statuses: string[] = [];
    const client = makeClient({
      onStatus: (s) => statuses.push(s),
      base: 3_000,
      cap: 30_000,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeEventSource.instances).toHaveLength(1);

    // 先制造一次真实断线：attempt 0→1，退避定时器在跑
    FakeEventSource.instances[0].onopen?.();
    FakeEventSource.instances[0].onerror?.();
    expect(statuses[statuses.length - 1]).toBe('reconnecting');

    setVisibility('hidden');
    setVisibility('visible');
    await vi.advanceTimersByTimeAsync(0);

    // 默认路径非回归：立即重建（不必等满 3s 退避），attempt 归零
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(statuses[statuses.length - 1]).toBe('connecting');
    client.close();
  });
});

// ── ④：端到端——经真实消费方（ExecutionLogSection）验证契约 ────────────────
//
// ⚠️ 诚实前提（与 Round 1 审计 §1.7 缺陷 1 的**更正**）：
// 审计原文设想「已 gaveUp（降级 8s 轮询）后切走标签页再切回 ⇒ 工厂静默重连
// ⇒ 日志流与轮询兜底双跑」。本轮实测**证伪**该字面路径：gaveUp 分支会先调
// `client?.close()`（ExecutionLogSection.tsx:285），工厂 close() 摘掉了
// `visibilitychange` 监听（sse-client.ts:301-303），因此 gaveUp 之后工厂
// **已经不可能**再复活流——「SSE 与轮询同时跑」在当前代码里被这段清理
// **掩盖**，不可达。
//
// 仍然**真实可达**的契约破坏发生在**重连预算窗口内**（retryCount < MAX 时
// 客户端尚未 close、visibility 监听还活着）：
//   断线① → 组件排定 1.5s 后重试（此时 `reconnect:false` 的客户端仍存活）
//   窗口内用户 切走→切回 → **buggy**：工厂 visible 分支绕过 reconnect:false
//   直接 connect() ⇒ 多换一次票据 + 多建一条 EventSource（占服务端 32 槽位
//   之一），而组件侧状态机（retryCount/retryTimer）对此一无所知。
//
// 本条用**真实消费路径**（渲染组件 + 工厂真实代码）断言这个可达缺陷：
// 断言「窗口内 hide→show 不得产生任何额外换票」。
// 该断言在 buggy 版本变红、修复后变绿——见报告 §5 的实证输出。
describe('H-6 端到端：重连预算窗口内 hide→show 不得让工厂擅自建流', () => {
  it('④ 重连预算窗口内 hide→show：不额外换票、不额外建连（工厂不越过调用方预算）', async () => {
    vi.useFakeTimers();

    const { render, act } = await import('@testing-library/react');
    const { default: ExecutionLogSection } = await import('../components/ExecutionLogSection');
    const { fetchSseTicket } = await import('../api/sse');
    const ticketMock = vi.mocked(fetchSseTicket);
    ticketMock.mockClear();

    const refresh = vi.fn();
    const onStreamStatusChange = vi.fn();

    const { unmount } = render(
      <ExecutionLogSection
        taskId="t1"
        execId="e1"
        data={{ id: 'e1', taskId: 't1', status: 'running', logs: 'line-1' } as never}
        refresh={refresh}
        isLive={true}
        onStreamStatusChange={onStreamStatusChange}
        reconnectKey={0}
        runbookText={null}
        statusLabel="running"
        onRetrigger={vi.fn()}
        retriggering={false}
        onJumpToReport={vi.fn()}
      />,
    );

    // 首连建立：1 条连接 + 1 次换票
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(FakeEventSource.instances).toHaveLength(1);
    const ticketsAfterFirstConnect = ticketMock.mock.calls.length;
    expect(ticketsAfterFirstConnect).toBeGreaterThan(0);

    // 制造一次断线：工厂 scheduleReconnect → reconnect:false ⇒ 只报
    // 'reconnecting'；组件据此排定 1.5s 后的**自己**的重试（retryCount=1）。
    // 此刻客户端尚未 close，visibility 监听仍存活 ⇒ 进入「预算窗口」。
    await act(async () => {
      FakeEventSource.instances[0].onerror?.();
      await vi.advanceTimersByTimeAsync(0);
    });

    const connectionsInWindow = FakeEventSource.instances.length;
    const ticketsInWindow = ticketMock.mock.calls.length;

    // ── 缺陷触发点：预算窗口内切走标签页再切回 ────────────────────────
    setVisibility('hidden');
    setVisibility('visible');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    // 关键断言：工厂**不得**代调用方建流
    //   buggy：visible 分支直接 connect() ⇒ 换票 +1、EventSource +1（红）
    //   fixed：只报 'reconnecting'，恢复交还组件侧预算（绿）
    expect(ticketMock.mock.calls.length).toBe(ticketsInWindow);
    expect(FakeEventSource.instances.length).toBe(connectionsInWindow);

    // 反向佐证：恢复**没有丢**——组件的重试预算仍会自己把流拉起来，
    // 且总共只多一条连接（预算内、由调用方主导），不是工厂悄悄地多建。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(FakeEventSource.instances.length).toBe(connectionsInWindow + 1);

    unmount();
  }, 30_000);
});
