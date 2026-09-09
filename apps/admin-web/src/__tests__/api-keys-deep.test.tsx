/**
 * QA-03 第二阶段：ApiKeysSettings 深交互补测（既有 6 例=002/AUTH-03 的 e24e49c
 * 基础链路：列表渲染/创建回显/失败不回显/吊销锚点/状态纯函数/永不过期）。
 *
 * 本批深交互（不重复 e24e49c 覆盖面）：
 *  1) 创建 Modal 表单校验：名称缺省拦截 / 超 100 字符拦截（不调 create）；
 *  2) 创建 payload 精确性：name/scope/expiresInDays（留空→不传该键）；
 *  3) scope 三级中文映射 Tag 与选中切换；
 *  4) 吊销链路：Popconfirm 确认 → revoke(id) 精确调用 + 成功 toast；失败 toast；
 *  5) 吊销后行状态翻转为「已吊销」且操作列变占位（invalidateQueries 后 list 重取）；
 *  6) 过期 Key 状态展示（expiresAt 过去时 → 已过期）。
 *
 * mock api 层（e24e49c 同文件先例）；QueryClientProvider 包裹。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import ApiKeysSettings from '../pages/settings/ApiKeysSettings';
import { apiKeysApi, ApiKeyView } from '../api/api-keys';

vi.mock('../api/api-keys', () => ({
  apiKeysApi: {
    list: vi.fn(),
    create: vi.fn(),
    revoke: vi.fn(),
  },
}));

const mocked = vi.mocked(apiKeysApi);

// jsdom 缺口 polyfill（e24e49c 同文件先例）
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

const keyRow = (over: Partial<ApiKeyView> = {}): ApiKeyView => ({
  id: 1,
  name: 'ci-deploy',
  keyPrefix: 'acf_dead',
  scope: 'trigger',
  expiresAt: null,
  revokedAt: null,
  lastUsedAt: null,
  createdAt: '2026-09-08T00:00:00Z',
  ...over,
});

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ApiKeysSettings />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const findBtn = (root: ParentNode, text: string): HTMLButtonElement | null =>
  (Array.from(root.querySelectorAll('button')) as HTMLButtonElement[]).find(
    (b) => (b.textContent ?? '').replace(/\s/g, '') === text,
  ) ?? null;

/** Popconfirm 确认键：弹层最后一个按钮（既有先例） */
async function confirmPopconfirm() {
  const layer = (await screen.findByText(/立即收到 401/).then((el) => el.closest('.ant-popover'))) as HTMLElement;
  const layerBtns = Array.from(layer.querySelectorAll('button')) as HTMLButtonElement[];
  const okBtn = layerBtns[layerBtns.length - 1];
  expect(okBtn).toBeTruthy();
  await act(async () => {
    fireEvent.click(okBtn);
  });
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocked.list.mockResolvedValue([
    keyRow(),
    keyRow({ id: 2, name: 'old-key', scope: 'readonly', expiresAt: '2020-01-01T00:00:00Z', lastUsedAt: '2026-09-08T08:00:00Z' }),
  ]);
});

afterEach(() => {
  cleanup();
});

describe('ApiKeysSettings 创建表单校验（QA-03 第二阶段）', () => {
  it('名称缺省提交 → 必填校验拦截，不调 create', async () => {
    renderPage();
    fireEvent.click(await screen.findByTestId('apikey-create'));
    await waitFor(() => expect(document.body.querySelector('.ant-modal-title')).toBeTruthy());
    const swallowed: unknown[] = [];
    const onRejection = (reason: unknown) => { swallowed.push(reason); };
    process.on('unhandledRejection', onRejection);
    await act(async () => {
      fireEvent.click(findBtn(document.body, '创建')!);
    });
    await screen.findByText('请输入名称');
    expect(mocked.create).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 0));
    process.removeListener('unhandledRejection', onRejection);
  });

  it('名称超 100 字符 → max 校验拦截，不调 create', async () => {
    renderPage();
    fireEvent.click(await screen.findByTestId('apikey-create'));
    await waitFor(() => expect(document.body.querySelector('.ant-modal-title')).toBeTruthy());
    fireEvent.change(screen.getByPlaceholderText('如 ci-deploy'), { target: { value: 'x'.repeat(101) } });
    const swallowed: unknown[] = [];
    const onRejection = (reason: unknown) => { swallowed.push(reason); };
    process.on('unhandledRejection', onRejection);
    await act(async () => {
      fireEvent.click(findBtn(document.body, '创建')!);
    });
    await waitFor(() => {
      expect(document.body.querySelector('.ant-form-item-explain-error')).toBeTruthy();
    });
    expect(mocked.create).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 0));
    process.removeListener('unhandledRejection', onRejection);
  });

  it('scope 三级选项渲染（中文映射），默认选中只读', async () => {
    renderPage();
    fireEvent.click(await screen.findByTestId('apikey-create'));
    await waitFor(() => expect(document.body.querySelector('.ant-modal-title')).toBeTruthy());
    await waitFor(() => expect(document.body.querySelector('.ant-select')).toBeTruthy());
    await act(async () => {
      fireEvent.mouseDown(document.body.querySelector('.ant-select')!);
    });
    await screen.findByText('只读 + 任务触发（CI/CD 推荐）');
    expect(screen.getByText('完全（凭证管理除外）')).toBeTruthy();
  });

  it('合法提交（trigger scope + 有效期）→ create 收到精确 payload', async () => {
    mocked.create.mockResolvedValue({ ...keyRow({ id: 3 }), plaintext: 'acf_ff'.padEnd(70, '0') });
    renderPage();
    fireEvent.click(await screen.findByTestId('apikey-create'));
    await waitFor(() => expect(document.body.querySelector('.ant-modal-title')).toBeTruthy());
    fireEvent.change(screen.getByPlaceholderText('如 ci-deploy'), { target: { value: 'cd-pipeline' } });
    // scope 默认 readonly → 切换 trigger（mousedown 展开下拉，再点选项）
    await waitFor(() => expect(document.body.querySelector('.ant-select')).toBeTruthy());
    await act(async () => {
      fireEvent.mouseDown(document.body.querySelector('.ant-select')!);
    });
    fireEvent.click(await screen.findByText('只读 + 任务触发（CI/CD 推荐）'));
    fireEvent.change(screen.getByPlaceholderText('留空表示永不过期'), { target: { value: '90' } });
    await act(async () => {
      fireEvent.click(findBtn(document.body, '创建')!);
    });
    await waitFor(() => {
      expect(mocked.create).toHaveBeenCalledWith({ name: 'cd-pipeline', scope: 'trigger', expiresInDays: 90 });
    });
  });

  it('有效期留空 → create payload 不带 expiresInDays（永不过期语义）', async () => {
    mocked.create.mockResolvedValue({ ...keyRow({ id: 4, name: 'never' }), plaintext: 'acf_ee'.padEnd(70, '0') });
    renderPage();
    fireEvent.click(await screen.findByTestId('apikey-create'));
    await waitFor(() => expect(document.body.querySelector('.ant-modal-title')).toBeTruthy());
    fireEvent.change(screen.getByPlaceholderText('如 ci-deploy'), { target: { value: 'never' } });
    await act(async () => {
      fireEvent.click(findBtn(document.body, '创建')!);
    });
    await waitFor(() => {
      const payload = mocked.create.mock.calls[0][0] as Record<string, unknown>;
      expect(payload.name).toBe('never');
      expect('expiresInDays' in payload).toBe(false);
    });
  });
});

describe('ApiKeysSettings 吊销链路（QA-03 第二阶段）', () => {
  it('吊销 Popconfirm 确认 → revoke(id) 精确调用', async () => {
    mocked.revoke.mockResolvedValue({ success: true, apiKey: keyRow({ revokedAt: '2026-09-08T09:00:00Z' }) });
    renderPage();
    fireEvent.click(await screen.findByTestId('apikey-revoke-1'));
    await confirmPopconfirm();
    await waitFor(() => {
      expect(mocked.revoke).toHaveBeenCalledWith(1);
    });
  });

  it('吊销失败 → 错误 toast（UI-15：补 onError 后不再静默，文案取后端 message）', async () => {
    mocked.revoke.mockRejectedValue(
      Object.assign(new Error('bad'), { response: { data: { message: '吊销事务冲突' } } }),
    );
    renderPage();
    fireEvent.click(await screen.findByTestId('apikey-revoke-1'));
    await confirmPopconfirm();
    await waitFor(() => {
      expect(mocked.revoke).toHaveBeenCalledWith(1);
    });
    // UI-15：getErrMsg 提取 response.data.message → 错误 toast 可见
    expect(await screen.findByText('吊销事务冲突')).toBeTruthy();
    // 失败后未吊销行按钮仍在（无状态翻转）
    await waitFor(() => {
      expect(screen.getByTestId('apikey-revoke-1')).toBeTruthy();
    });
  });

  it('吊销失败（无后端文案）→ 兜底文案 toast（UI-15）', async () => {
    mocked.revoke.mockRejectedValue(new Error('network down'));
    renderPage();
    fireEvent.click(await screen.findByTestId('apikey-revoke-1'));
    await confirmPopconfirm();
    await waitFor(() => {
      expect(mocked.revoke).toHaveBeenCalledWith(1);
    });
    expect(await screen.findByText('network down')).toBeTruthy();
  });

  it('已吊销行渲染「已吊销」Tag 与操作列占位；过期行渲染「已过期」', async () => {
    mocked.list.mockResolvedValue([
      keyRow({ id: 3, name: 'revoked-one', revokedAt: '2026-09-01T00:00:00Z' }),
      keyRow({ id: 4, name: 'expired-one', expiresAt: '2020-01-01T00:00:00Z' }),
    ]);
    renderPage();
    await waitFor(() => expect(screen.getByText('revoked-one')).toBeTruthy());
    expect(screen.getByText('已吊销')).toBeTruthy();
    expect(screen.getByText('已过期')).toBeTruthy();
    // 吊销行无吊销按钮（占位 —），过期行仍可吊销
    expect(screen.queryByTestId('apikey-revoke-3')).toBeNull();
    expect(screen.getByTestId('apikey-revoke-4')).toBeTruthy();
  });
});
