/**
 * FEAT-15：设置区「事件订阅」Tab 组件测试（FEAT-07 后端消费）。
 * mock api 层（api-keys-settings.test 先例形态，React Query）。
 * 覆盖：列表渲染 / 新建 payload（secret 留空=服务端代生成）/ 一次性回显弹窗 /
 * 编辑 payload（secret 留空不提交）/ enabled 开关 / 删除确认 / 死信列表 /
 * 死信 replay（成功删行 + 失败保留文案）/ 纯函数 failureStats。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import EventSubscriptionsSettings, { subscriptionFailureStats } from '../pages/settings/EventSubscriptionsSettings';
import { eventSubscriptionsApi, EventSubscription, EventSubscriptionDeadLetter } from '../api/event-subscriptions';

vi.mock('../api/event-subscriptions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/event-subscriptions')>();
  return {
    ...actual,
    eventSubscriptionsApi: {
      list: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
      listDeadLetters: vi.fn(),
      replayDeadLetter: vi.fn(),
    },
  };
});

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, Link: (p: { to: string; children: React.ReactNode }) => <a href={p.to}>{p.children}</a> };
});

const mocked = vi.mocked(eventSubscriptionsApi);

// jsdom 缺口 polyfill（api-keys-settings.test 先例）：antd Table/Modal 需要
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

const subRow = (over: Partial<EventSubscription> = {}): EventSubscription => ({
  id: 'e1111111-1111-4111-8111-111111111111',
  eventTypes: ['execution.failed'],
  url: 'https://ci.example.com/hooks',
  secret: '******',
  enabled: true,
  consecutiveFailures: 0,
  lastFailureAt: null,
  lastFailureError: null,
  userId: 1,
  createdAt: '2026-09-08T00:00:00Z',
  updatedAt: '2026-09-08T00:00:00Z',
  ...over,
});

const deadLetterRow = (over: Partial<EventSubscriptionDeadLetter> = {}): EventSubscriptionDeadLetter => ({
  id: 'd1111111-1111-4111-8111-111111111111',
  subscriptionId: 'e1111111-1111-4111-8111-111111111111',
  eventType: 'execution.failed',
  payload: { event: 'execution.failed', data: { taskId: 'task-1' } },
  error: 'connect ECONNREFUSED',
  attempts: 3,
  createdAt: '2026-09-08T01:00:00Z',
  ...over,
});

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <EventSubscriptionsSettings />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Popconfirm/Modal.confirm 确认键：最后一个弹层的最后一个按钮（既有先例） */
async function confirmDialog(titleText: string) {
  await waitFor(() => {
    expect(screen.queryAllByText(titleText).length).toBeGreaterThanOrEqual(1);
  });
  const holders = Array.from(document.body.querySelectorAll('.ant-modal-confirm, .ant-popover')) as HTMLElement[];
  const layer = holders.length > 0 ? holders[holders.length - 1] : document.body;
  const layerBtns = Array.from(layer.querySelectorAll('button')) as HTMLButtonElement[];
  const okBtn = layerBtns[layerBtns.length - 1];
  expect(okBtn).toBeTruthy();
  await act(async () => {
    fireEvent.click(okBtn);
  });
}

/** antd v6 多选 Select：mousedown 展开下拉后点选项（api-keys-deep 先例） */
async function selectEventOption(label: string) {
  await waitFor(() => expect(document.body.querySelector('.ant-select')).toBeTruthy());
  await act(async () => {
    fireEvent.mouseDown(document.body.querySelector('.ant-select')!);
  });
  await screen.findByText(label);
  await act(async () => {
    fireEvent.click(screen.getByText(label));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocked.list.mockResolvedValue([subRow()]);
  mocked.listDeadLetters.mockResolvedValue({ data: [deadLetterRow()], total: 1 });
});

afterEach(() => {
  cleanup();
});

describe('FEAT-15 EventSubscriptionsSettings', () => {
  it('渲染订阅列表：事件类型 Tag / URL / secret 恒脱敏提示 / 投递状态', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('https://ci.example.com/hooks')).toBeTruthy());
    expect(screen.getAllByText('execution.failed').length).toBeGreaterThanOrEqual(1);
    // 失败统计：健康订阅显示「正常」
    await waitFor(() => expect(screen.getAllByText('正常').length).toBeGreaterThanOrEqual(1));
  });

  it('失败统计列：连续失败订阅显示红色统计与失败摘要 Tooltip', async () => {
    mocked.list.mockResolvedValue([
      subRow({ consecutiveFailures: 3, lastFailureError: 'connect timeout after 10s', lastFailureAt: '2026-09-08T02:00:00Z' }),
    ]);
    renderPage();
    await waitFor(() => expect(screen.getByText('连续失败 3 次')).toBeTruthy());
  });

  it('新建订阅：URL 校验非法拦截提交；合法 payload 不带 secret（=服务端代生成）', async () => {
    mocked.create.mockResolvedValue({
      subscription: subRow({ id: 'e2222222-2222-4222-8222-222222222222' }),
      generatedSecret: 'a'.repeat(64),
    });
    renderPage();
    fireEvent.click(await screen.findByTestId('sub-create'));
    const urlInput = await screen.findByTestId('sub-url-input');
    // 非法 URL：校验错误经 .ant-form-item-explain-error 呈现（文本跨元素拆分，
    // api-keys-deep 先例）；校验 reject 已被 submitSwallowingRejection 吞掉。
    const swallowed: unknown[] = [];
    const onRejection = (reason: unknown) => { swallowed.push(reason); };
    process.on('unhandledRejection', onRejection);
    await act(async () => {
      fireEvent.click(screen.getByText('创 建'));
    });
    await waitFor(() => {
      expect(document.body.querySelector('.ant-form-item-explain-error')).toBeTruthy();
    });
    expect(mocked.create).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 0));
    process.removeListener('unhandledRejection', onRejection);

    fireEvent.change(urlInput, { target: { value: 'https://ci.example.com/hooks' } });
    await selectEventOption('执行失败（execution.failed）');
    await act(async () => {
      fireEvent.click(screen.getByText('创 建'));
    });
    await waitFor(() => expect(mocked.create).toHaveBeenCalledTimes(1));
    const payload = mocked.create.mock.calls[0][0];
    expect(payload.url).toBe('https://ci.example.com/hooks');
    expect(payload.eventTypes).toEqual(['execution.failed']);
    expect(payload.secret).toBeUndefined();
  });

  it('新建成功且服务端代生成时弹一次性回显：警示文案 + 密钥值 + 复制按钮', async () => {
    const generated = 'a'.repeat(64);
    mocked.create.mockResolvedValue({
      subscription: subRow({ id: 'e2222222-2222-4222-8222-222222222222' }),
      generatedSecret: generated,
    });
    renderPage();
    fireEvent.click(await screen.findByTestId('sub-create'));
    fireEvent.change(await screen.findByTestId('sub-url-input'), { target: { value: 'https://ci.example.com/hooks' } });
    await selectEventOption('执行失败（execution.failed）');
    await act(async () => {
      fireEvent.click(screen.getByText('创 建'));
    });
    await waitFor(() => expect(screen.getByTestId('generated-secret')).toBeTruthy());
    expect(screen.getByTestId('generated-secret').textContent).toBe(generated);
    expect(screen.getByText(/仅此一次显示/)).toBeTruthy();
    expect(screen.getByText('复制密钥')).toBeTruthy();
  });

  it('编辑订阅：secret 留空 = 不提交 secret 字段（保持现有密钥语义）', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId('sub-edit-e1111111-1111-4111-8111-111111111111')).toBeTruthy());
    fireEvent.click(screen.getByTestId('sub-edit-e1111111-1111-4111-8111-111111111111'));
    const urlInput = await screen.findByTestId('sub-url-input');
    expect((urlInput as HTMLInputElement).value).toBe('https://ci.example.com/hooks');
    fireEvent.click(screen.getByText('保 存'));
    await waitFor(() => expect(mocked.update).toHaveBeenCalledTimes(1));
    const [id, payload] = mocked.update.mock.calls[0];
    expect(id).toBe('e1111111-1111-4111-8111-111111111111');
    expect(payload.url).toBe('https://ci.example.com/hooks');
    expect(payload.secret).toBeUndefined();
  });

  it('enabled 开关切换调用 update({ enabled })', async () => {
    renderPage();
    const sw = await screen.findByTestId('sub-enabled-e1111111-1111-4111-8111-111111111111');
    fireEvent.click(sw.querySelector('button') ?? sw);
    await waitFor(() => expect(mocked.update).toHaveBeenCalled());
    expect(mocked.update.mock.calls[0][1].enabled).toBe(false);
  });

  it('删除确认：Popconfirm 确认后调 remove 并提示死信级联', async () => {
    mocked.remove.mockResolvedValue({ ok: true });
    renderPage();
    fireEvent.click(await screen.findByTestId('sub-delete-e1111111-1111-4111-8111-111111111111'));
    await waitFor(() => expect(screen.getByText(/关联死信级联删除/)).toBeTruthy());
    await confirmDialog('确认删除该订阅？');
    await waitFor(() => expect(mocked.remove).toHaveBeenCalledWith('e1111111-1111-4111-8111-111111111111'));
  });

  it('死信列表段渲染：事件/失败原因/尝试次数 + 重放按钮', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('https://ci.example.com/hooks')).toBeTruthy());
    await waitFor(() => expect(screen.getByTestId('dead-letter-table')).toBeTruthy());
    expect(mocked.listDeadLetters).toHaveBeenCalledWith('e1111111-1111-4111-8111-111111111111', 1, 20);
    expect(screen.getAllByText('connect ECONNREFUSED').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByTestId('dead-letter-replay-d1111111-1111-4111-8111-111111111111')).toBeTruthy();
  });

  it('死信 replay：确认后调 replay；ok=true 提示成功并刷新死信', async () => {
    mocked.replayDeadLetter.mockResolvedValue({ ok: true });
    renderPage();
    const replayBtn = await screen.findByTestId('dead-letter-replay-d1111111-1111-4111-8111-111111111111');
    await waitFor(() => expect(replayBtn).toBeTruthy());
    fireEvent.click(replayBtn);
    await confirmDialog('确认重放该死信？');
    await waitFor(() =>
      expect(mocked.replayDeadLetter).toHaveBeenCalledWith(
        'e1111111-1111-4111-8111-111111111111',
        'd1111111-1111-4111-8111-111111111111',
      ),
    );
    await waitFor(() => expect(screen.getByText(/重放成功/)).toBeTruthy());
  });

  it('死信 replay 失败：ok=false 展示 error 且提示死信保留', async () => {
    mocked.replayDeadLetter.mockResolvedValue({ ok: false, error: 'target unreachable' });
    renderPage();
    const replayBtn = await screen.findByTestId('dead-letter-replay-d1111111-1111-4111-8111-111111111111');
    await waitFor(() => expect(replayBtn).toBeTruthy());
    fireEvent.click(replayBtn);
    await confirmDialog('确认重放该死信？');
    await waitFor(() => expect(screen.getByText(/重放失败：target unreachable/)).toBeTruthy());
    // 死信保留可再次重放——重放按钮仍在
    expect(screen.getByTestId('dead-letter-replay-d1111111-1111-4111-8111-111111111111')).toBeTruthy();
  });

  it('无订阅时死信段不渲染', async () => {
    mocked.list.mockResolvedValue([]);
    renderPage();
    await waitFor(() => expect(screen.getByTestId('sub-table')).toBeTruthy());
    expect(screen.queryByTestId('dead-letter-table')).toBeNull();
  });

  it('subscriptionFailureStats 纯函数：健康 vs 连续失败', () => {
    const ok = subscriptionFailureStats(subRow());
    expect(ok.label).toBe('正常');
    expect(ok.color).toBe('green');
    const bad = subscriptionFailureStats(
      subRow({ consecutiveFailures: 2, lastFailureError: 'boom', lastFailureAt: '2026-09-08T02:00:00Z' }),
    );
    expect(bad.label).toBe('连续失败 2 次');
    expect(bad.color).toBe('red');
    expect(bad.detail).toBe('boom');
  });
});
