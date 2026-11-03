/**
 * 设置页（pages/settings/index.tsx）**未覆盖分支**补面。
 *
 * ## 为什么单开这个文件
 *
 * v8 覆盖率实测（全量 275 文件 / 2237 用例）本页是 stmt 71% / branch 66% /
 * func 65%——设置区里第二差的一档（对照 Security 92/80/90、ApiKeys 90/84/89）。
 * 已有用例覆盖的是：
 *   · settings.ai.test.tsx          —— 非管理员降级、管理员表单渲染、AI 配置**保存失败** toast
 *   · settings.history-rollback.test.tsx —— 变更历史回滚（渲染/确认/失败/取消/非管理员）
 *   · ui16-batch4-error-state.test.tsx —— 系统配置 Tab 读失败、AI 配置读失败
 *   · ui09-mobile-round3-admin.test.tsx —— ?tab=config 深链、valueType 词条、移动端列形态
 *
 * 仍然**一行都没有被驱动过**的分支（coverage-final.json 实测未覆盖语句行号）：
 *
 *   106-124  TokenSection 的**生成**链路：generateExecutorToken 成功/失败
 *            （onSuccess 失效 ['executor-token'] / onError toast）
 *   147-154  Token **读失败** → 页内 StateError（tokenError 分支）+ 重试
 *   182-191  Token 已存在时的**显隐切换**（tokenVisible）与**复制**
 *            （copyText 成功 → copied toast；失败 → copyFailed toast）
 *   239-299  EditModal 整个组件：新增/编辑两套表单、保存成功（added/updated
 *            toast）、保存失败（addFail/updateFail toast）、取消关闭
 *   361      HistoryModal：historyError 分支的**页内错误态**（loadFail + 重试）
 *   427-432  配置**删除**成功/失败（deleted toast / deleteFail toast）
 *   466/471  行内「编辑」/「删除」按钮（isAdmin 门控的 disabled 形态）
 *   488/490  「刷新」按钮（refetch）与「新增配置」入口
 *   512-517  logRetention.days 提示条 + 「新建并设为 30 天」按钮
 *   553-561  EditModal 关闭回调（onSaved → 失效 ['system-configs']）与
 *            HistoryModal 的打开/关闭
 *   633-668  AI 配置**保存成功**（saved toast + 失效 ['ai-config']）、
 *            **测试连通性**成功/失败两种结果（testSuccess / testFailed + 详情）
 *   700      表格分页 onChange（切页 → setPage）
 *   861/879  历史行的 oldValue/newValue 缺省（'-'）与 testResult 关闭
 *
 * 换句话说：**「新增/编辑/删除一条系统配置」这条本页最核心的写路径，以及
 * 「生成执行器 Token」「测试 AI 连通性」这两条运维路径，都从未被执行过一次。**
 *
 * ## 本文件钉住的行为（每条都能失败）
 *
 *  ① Token 读失败 → 页内 StateError（不是空转圈）+ 重试重新请求。
 *  ② 非管理员：Token Tab 整块不渲染（后端 R4 收紧，连 GET 都不发）。
 *  ③ 生成 Token：成功 → 成功 toast + 读面刷新（重新 GET）；失败 → 错误 toast。
 *  ④ Token 已存在 → 默认打码、显隐切换、复制成功/失败两种反馈。
 *  ⑤ 新增配置：必填校验拦住空表单 → 保存成功 → added toast + 列表刷新 +
 *     Modal 关闭；保存失败 → 错误 toast + Modal 保持打开（数据不丢）。
 *  ⑥ 编辑配置：key 字段禁用、标题带 key、保存走 updated 文案。
 *  ⑦ 取消编辑 → Modal 关闭且不发起 upsert。
 *  ⑧ 删除配置：Popconfirm 确认 → remove(key) + deleted toast；失败 → 错误 toast。
 *  ⑨ 「刷新」→ 重新拉取配置列表。
 *  ⑩ logRetention.days 提示条：未配该键时出现，「新建并设为 30 天」预填该键。
 *  ⑪ 变更历史**读失败** → 页内错误块（loadFail）+ 重试（此前 historyError
 *     分支从未被驱动，只有列表渲染与回滚被覆盖）。
 *  ⑫ AI 配置**保存成功** → saved toast + 重新拉取 GET /ai/config。
 *  ⑬ AI 配置**测试连通性**成功/失败 → testSuccess / testFailed + 后端原文。
 *  ⑭ ?tab= 深链：非法值回退首个 Tab；点 Tab 把选择写回 URL ?tab=。
 *
 * ## 一处**诚实的未覆盖**（不编造假用例）
 *
 * `TokenSection` 内 `if (!isAdmin)` 那条只读分支（源码 127-138 行）在
 * SettingsPage 的调用形态下**不可达**：`tabs` 数组本身就把 token Tab 从非管理员
 * 的列表里剔除了（index.tsx:907-909），故该分支只在把 TokenSection 单独渲染时
 * 才会命中，而它未导出。本文件因此改为钉住**可观测的等价契约**——非管理员
 * 连 Tab 都没有、且不发 GET——而不是硬凑一条走不到的分支。
 *
 * 隔离方式对齐既有先例：模块级 mock `../api/config` 与 `../api/ai`、
 * QueryClientProvider 包裹、MemoryRouter、jsdom 的 ResizeObserver/matchMedia shim。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';
import SettingsPage from '../pages/settings/index';
import { configApi } from '../api/config';
import { aiApi } from '../api/ai';
import { useAuthStore } from '../store/auth';

vi.mock('../api/ai', () => ({
  aiApi: {
    getConfig: vi.fn(),
    saveConfig: vi.fn(),
    testConfig: vi.fn(),
    analyzeApp: vi.fn(),
    suggestSchedule: vi.fn(),
    // 推理质量轮：「模型接入与分配」卡片（ADMIN-only）
    listProviders: vi.fn().mockResolvedValue({
      providers: [],
      errors: [],
      routes: {
        analysis: { provider: '', model: '', maxTokens: '', timeoutMs: '' },
        agent: { provider: '', model: '', maxTokens: '', timeoutMs: '' },
        video: { provider: '', model: '', maxTokens: '', timeoutMs: '' },
      },
    }),
    saveProvider: vi.fn(),
    deleteProvider: vi.fn(),
    assignRoute: vi.fn(),
  },
}));
vi.mock('../api/config', () => ({
  configApi: {
    findAll: vi.fn(),
    findOne: vi.fn(),
    upsert: vi.fn(),
    remove: vi.fn(),
    getHistory: vi.fn(),
    rollback: vi.fn(),
    generateExecutorToken: vi.fn(),
    getExecutorToken: vi.fn(),
  },
}));

// jsdom 缺失 antd 依赖的浏览器 API，先行补齐（对齐 settings.ai.test 先例）
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

const configFixture = [
  {
    id: 1,
    key: 'feature.x',
    value: 'cur',
    description: null,
    valueType: 'string' as const,
    isSecret: false,
    tag: null,
    createdAt: '2026-08-31T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  },
];

/**
 * antd 双汉字按钮自动插空格（「保 存」），故两侧都归一化后再比。
 * 注意也要归一化**期望值**——本页有「生成共享 Token」这类含空格的标签，
 * 只归一化一侧会永远匹配不上（本文件踩过）。
 */
const norm = (s: string | null | undefined): string => (s ?? '').replace(/\s/g, '');
const findBtn = (root: ParentNode, text: string): HTMLButtonElement | null =>
  (Array.from(root.querySelectorAll('button')) as HTMLButtonElement[]).find(
    (b) => norm(b.textContent) === norm(text),
  ) ?? null;

/** 打开某个 Tab（按可见标签文字）。 */
const openTab = async (label: string | RegExp) => {
  const tab = await screen.findByRole('tab', { name: label });
  fireEvent.click(tab);
  return tab;
};

/** 把当前 MemoryRouter 的 location.search 暴露成可断言节点。 */
function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="location-search">{loc.search}</div>;
}

function renderSettings(initialEntries?: string[]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={initialEntries ?? ['/settings']}>
        <SettingsPage />
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Modal 内的表单控件（按字段 id 定位——本页 Form.Item 的 name 会落成 input id）。 */
const modalField = (id: string): HTMLInputElement | HTMLTextAreaElement => {
  const el = document.querySelector(`.ant-modal #${id}`) as
    | HTMLInputElement
    | HTMLTextAreaElement
    | null;
  expect(el, `未找到 Modal 字段 #${id}`).toBeTruthy();
  return el!;
};

/** Modal footer 的「保存」键（antd 6 的 footer 在 .ant-modal-container 内）。 */
const modalSaveBtn = (): HTMLButtonElement => {
  const modal = document.querySelector('.ant-modal') as HTMLElement;
  expect(modal, '未找到 Modal').toBeTruthy();
  const btns = Array.from(modal.querySelectorAll('.ant-modal-footer button')) as HTMLButtonElement[];
  expect(btns.length, 'Modal footer 无按钮').toBeGreaterThan(0);
  return btns[btns.length - 1];
};

beforeEach(() => {
  vi.mocked(configApi.findAll).mockReset().mockResolvedValue(configFixture as never);
  vi.mocked(configApi.getExecutorToken)
    .mockReset()
    .mockResolvedValue({ hasToken: false, token: null } as never);
  vi.mocked(configApi.getHistory).mockReset().mockResolvedValue({ data: [], total: 0 } as never);
  vi.mocked(configApi.upsert).mockReset().mockResolvedValue({ key: 'feature.x' } as never);
  vi.mocked(configApi.remove).mockReset().mockResolvedValue({ key: 'feature.x' } as never);
  vi.mocked(configApi.rollback).mockReset().mockResolvedValue({ key: 'feature.x' } as never);
  vi.mocked(configApi.generateExecutorToken)
    .mockReset()
    .mockResolvedValue({ token: 'tk_new' } as never);
  vi.mocked(aiApi.getConfig)
    .mockReset()
    .mockResolvedValue({ provider: 'disabled', hasApiKey: false } as never);
  vi.mocked(aiApi.saveConfig).mockReset().mockResolvedValue({ ok: true } as never);
  vi.mocked(aiApi.testConfig)
    .mockReset()
    .mockResolvedValue({ ok: true, message: 'ping ok' } as never);
  useAuthStore.setState({ user: { id: 1, username: 'root', role: 'admin' } });
  // 只清残留的**通知条目**，绝不碰 `.ant-message` holder 本身——holder 被移除后
  // antd 内部引用成游离节点，后续 toast 会渲染进不可见节点。
  document.body.querySelectorAll('.ant-message-notice').forEach((el) => el.remove());
  // 清理上一用例遗留的**命令式** Modal（Modal.confirm / Popconfirm 是命令式渲染，
  // 挂在 body 上、不随 RTL cleanup 卸载）。不清的话 `document.querySelector('.ant-modal')`
  // 会先命中残留的 confirm（它没有 .ant-modal-footer），后续 click 落到 null 上。
  document.body.querySelectorAll('.ant-modal-root').forEach((el) => el.remove());
});

afterEach(() => {
  cleanup();
  document.body.querySelectorAll('.ant-message-notice').forEach((el) => el.remove());
});

describe('设置页：执行器 Token 分支', () => {
  it('① Token 读失败 → 页内错误块 + 重试重新请求（不落空 Spin）', async () => {
    vi.mocked(configApi.getExecutorToken)
      .mockRejectedValueOnce(new Error('Token 服务不可用'))
      .mockResolvedValueOnce({ hasToken: false, token: null } as never);

    renderSettings();
    // 管理员首个 Tab 就是「执行器 Token」
    expect(await screen.findByText('执行器共享 Token 加载失败')).toBeTruthy();
    expect(screen.getByText('Token 服务不可用')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /重试/ }));

    await waitFor(() => {
      expect(configApi.getExecutorToken).toHaveBeenCalledTimes(2);
      expect(screen.queryByText('执行器共享 Token 加载失败')).toBeNull();
    });
  });

  it('② 非管理员：Token Tab 整块不渲染，且不发起 GET /config/executor-shared-token', async () => {
    useAuthStore.setState({ user: { id: 2, username: 'dev', role: 'user' } });
    renderSettings();
    // 非管理员首个 Tab 是「AI 配置」，token Tab 不存在
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: /AI 配置/ }).getAttribute('aria-selected')).toBe(
        'true',
      ),
    );
    expect(screen.queryByRole('tab', { name: /执行器 Token/ })).toBeNull();
    expect(screen.queryByText('执行器共享 Token')).toBeNull();
    // 关键：不发会 403 的 GET
    expect(configApi.getExecutorToken).not.toHaveBeenCalled();
  });

  it('③ 生成 Token：确认后调 generateExecutorToken，成功提示并刷新读面', async () => {
    renderSettings();
    await screen.findByText('尚未生成执行器 Token，请先生成后再安装执行器');

    fireEvent.click(findBtn(document.body, '生成共享 Token')!);

    // 命令式确认框（utils/modal → antd 静态 Modal.confirm）
    const confirmTitle = await screen.findByText('生成新的共享 Token', {
      selector: '.ant-modal-confirm-title',
    });
    const holder = (confirmTitle.closest('.ant-modal-confirm') ?? document.body) as HTMLElement;
    const btns = Array.from(holder.querySelectorAll('button')) as HTMLButtonElement[];
    const okBtn = btns[btns.length - 1];
    expect(norm(okBtn.textContent)).toBe('确认生成');
    await act(async () => {
      fireEvent.click(okBtn);
    });

    await waitFor(() => expect(configApi.generateExecutorToken).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('新 Token 已生成')).toBeTruthy();
    // 读面被重新拉取（onSuccess 失效 ['executor-token']）
    await waitFor(() => {
      expect(vi.mocked(configApi.getExecutorToken).mock.calls.length).toBeGreaterThan(1);
    });
  });

  it('④ 生成 Token 失败 → 错误 toast（UI-15 onError 补齐）', async () => {
    vi.mocked(configApi.generateExecutorToken).mockRejectedValue(
      Object.assign(new Error('bad'), {
        response: { data: { message: '生成 Token 失败：权限不足' } },
      }),
    );
    renderSettings();
    await screen.findByText('尚未生成执行器 Token，请先生成后再安装执行器');

    fireEvent.click(findBtn(document.body, '生成共享 Token')!);
    const confirmTitle = await screen.findByText('生成新的共享 Token', {
      selector: '.ant-modal-confirm-title',
    });
    const holder = (confirmTitle.closest('.ant-modal-confirm') ?? document.body) as HTMLElement;
    const btns = Array.from(holder.querySelectorAll('button')) as HTMLButtonElement[];
    await act(async () => {
      fireEvent.click(btns[btns.length - 1]);
    });

    await waitFor(() => expect(configApi.generateExecutorToken).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('生成 Token 失败：权限不足')).toBeTruthy();
  });

  it('⑤ Token 已存在：默认打码 → 显隐切换 → 复制成功提示「已复制」', async () => {
    vi.mocked(configApi.getExecutorToken).mockResolvedValue({
      hasToken: true,
      token: 'tk_secret_value',
    } as never);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
      writable: true,
    });

    renderSettings();
    // 默认打码（40 个圆点）
    await waitFor(() => {
      const masked = (Array.from(document.querySelectorAll('input')) as HTMLInputElement[]).find(
        (i) => (i.value ?? '').startsWith('•'),
      );
      expect(masked, '未找到打码后的 Token 输入框').toBeTruthy();
      expect(masked!.value).toBe('•'.repeat(40));
    });

    // 点「显示 Token」→ 真值出现
    fireEvent.click(screen.getByRole('button', { name: '显示 Token' }));
    await waitFor(() => {
      const shown = (Array.from(document.querySelectorAll('input')) as HTMLInputElement[]).find(
        (i) => i.value === 'tk_secret_value',
      );
      expect(shown, 'Token 未显示').toBeTruthy();
    });

    // 复制按钮此时才出现 → 复制成功
    fireEvent.click(findBtn(document.body, '复制')!);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('tk_secret_value'));
    expect(await screen.findByText('已复制')).toBeTruthy();
  });

  it('⑥ Token 复制失败 → 错误 toast（不谎报「已复制」）', async () => {
    vi.mocked(configApi.getExecutorToken).mockResolvedValue({
      hasToken: true,
      token: 'tk_secret_value',
    } as never);
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
      writable: true,
    });
    // execCommand 降级也失败 → copyText 返回 false
    const origExec = document.execCommand;
    (document as unknown as { execCommand: () => boolean }).execCommand = () => false;

    try {
      renderSettings();
      await waitFor(() => {
        expect(
          (Array.from(document.querySelectorAll('input')) as HTMLInputElement[]).some((i) =>
            (i.value ?? '').startsWith('•'),
          ),
        ).toBe(true);
      });
      fireEvent.click(screen.getByRole('button', { name: '显示 Token' }));
      fireEvent.click(findBtn(document.body, '复制')!);

      expect(await screen.findByText('复制失败，请检查浏览器剪贴板权限')).toBeTruthy();
      expect(screen.queryByText('已复制')).toBeNull();
    } finally {
      (document as unknown as { execCommand: unknown }).execCommand = origExec;
    }
  });
});

describe('设置页：系统配置新增/编辑/删除', () => {
  it('⑦ 新增配置：必填校验拦空表单；填好后保存成功 → added toast + 列表刷新', async () => {
    renderSettings();
    await openTab('系统配置');
    await screen.findByText('feature.x');

    fireEvent.click(findBtn(document.body, '新增配置')!);
    await waitFor(() => expect(screen.getByText('新增配置项')).toBeTruthy());

    // 空表单 → 校验拦下，不发请求
    await act(async () => {
      fireEvent.click(modalSaveBtn());
    });
    await waitFor(() => {
      expect(document.querySelector('.ant-form-item-explain-error')).toBeTruthy();
    });
    expect(configApi.upsert).not.toHaveBeenCalled();

    // 填表 → 保存
    fireEvent.change(modalField('key'), { target: { value: 'feature.y' } });
    fireEvent.change(modalField('value'), { target: { value: 'v1' } });
    await act(async () => {
      fireEvent.click(modalSaveBtn());
    });

    await waitFor(() => expect(configApi.upsert).toHaveBeenCalledTimes(1));
    const payload = vi.mocked(configApi.upsert).mock.calls[0][0] as unknown as {
      key: string;
      value: string;
    };
    expect(payload.key).toBe('feature.y');
    expect(payload.value).toBe('v1');
    expect(await screen.findByText('配置已添加')).toBeTruthy();
    // 列表被重新拉取（onSaved → 失效 ['system-configs']）
    await waitFor(() => {
      expect(vi.mocked(configApi.findAll).mock.calls.length).toBeGreaterThan(1);
    });
  });

  it('⑧ 编辑配置：key 字段禁用、标题带 key，保存成功走 updated 文案', async () => {
    renderSettings();
    await openTab('系统配置');
    const keyCell = await screen.findByText('feature.x');
    const row = keyCell.closest('tr') as HTMLElement;
    // 行内编辑按钮是 icon-only（aria-label = 编辑此系统配置）
    const editBtn = row.querySelector(
      'button[aria-label="编辑此系统配置"]',
    ) as HTMLButtonElement;
    expect(editBtn, '未找到行内编辑按钮').toBeTruthy();
    fireEvent.click(editBtn);

    await waitFor(() => expect(screen.getByText('编辑：feature.x')).toBeTruthy());
    // 既有 key 禁用（不可改）
    expect(modalField('key').disabled).toBe(true);
    expect((modalField('key') as HTMLInputElement).value).toBe('feature.x');

    await act(async () => {
      fireEvent.click(modalSaveBtn());
    });
    await waitFor(() => expect(configApi.upsert).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('配置已更新')).toBeTruthy();
  });

  it('⑨ 编辑保存失败 → 错误 toast + Modal 保持打开（数据不丢）', async () => {
    vi.mocked(configApi.upsert).mockRejectedValue(
      Object.assign(new Error('bad'), { response: { data: { message: '配置项已被并发修改' } } }),
    );
    renderSettings();
    await openTab('系统配置');
    const keyCell = await screen.findByText('feature.x');
    const row = keyCell.closest('tr') as HTMLElement;
    fireEvent.click(row.querySelector('button[aria-label="编辑此系统配置"]') as HTMLButtonElement);

    await waitFor(() => expect(screen.getByText('编辑：feature.x')).toBeTruthy());
    await act(async () => {
      fireEvent.click(modalSaveBtn());
    });

    await waitFor(() => expect(configApi.upsert).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('配置项已被并发修改')).toBeTruthy();
    // Modal 仍在（标题还在）→ 用户改完还能再提交
    expect(screen.getByText('编辑：feature.x')).toBeTruthy();
  });

  it('⑩ 取消编辑 → Modal 关闭且不发起 upsert', async () => {
    renderSettings();
    await openTab('系统配置');
    const keyCell = await screen.findByText('feature.x');
    const row = keyCell.closest('tr') as HTMLElement;
    fireEvent.click(row.querySelector('button[aria-label="编辑此系统配置"]') as HTMLButtonElement);

    await waitFor(() => expect(screen.getByText('编辑：feature.x')).toBeTruthy());
    // Modal 的「取消」键（footer 第一个按钮）
    const modal = document.querySelector('.ant-modal') as HTMLElement;
    const footBtns = Array.from(
      modal.querySelectorAll('.ant-modal-footer button'),
    ) as HTMLButtonElement[];
    await act(async () => {
      fireEvent.click(footBtns[0]);
    });

    await new Promise((r) => setTimeout(r, 80));
    expect(configApi.upsert).not.toHaveBeenCalled();
  });

  it('⑪ 删除配置：Popconfirm 确认 → remove(key) + deleted toast', async () => {
    renderSettings();
    await openTab('系统配置');
    const keyCell = await screen.findByText('feature.x');
    const row = keyCell.closest('tr') as HTMLElement;
    fireEvent.click(row.querySelector('button[aria-label="删除此系统配置"]') as HTMLButtonElement);

    const confirmText = await screen.findByText('确认删除此配置？');
    const layer = (confirmText.closest('.ant-popover') ??
      confirmText.closest('[class*="popconfirm"]') ??
      document.body) as HTMLElement;
    const layerBtns = Array.from(layer.querySelectorAll('button')) as HTMLButtonElement[];
    await act(async () => {
      fireEvent.click(layerBtns[layerBtns.length - 1]);
    });

    await waitFor(() => expect(configApi.remove).toHaveBeenCalledTimes(1));
    // useMutation 的 mutationFn 会收到 (variables, context) 两个参数——只断言首个实参
    expect(vi.mocked(configApi.remove).mock.calls[0][0]).toBe('feature.x');
    expect(await screen.findByText('已删除')).toBeTruthy();
  });

  it('⑫ 删除配置失败 → 错误 toast（消费后端文案，不谎报已删）', async () => {
    vi.mocked(configApi.remove).mockRejectedValue(
      Object.assign(new Error('bad'), { response: { data: { message: '配置项正被使用' } } }),
    );
    renderSettings();
    await openTab('系统配置');
    const keyCell = await screen.findByText('feature.x');
    const row = keyCell.closest('tr') as HTMLElement;
    fireEvent.click(row.querySelector('button[aria-label="删除此系统配置"]') as HTMLButtonElement);

    const confirmText = await screen.findByText('确认删除此配置？');
    const layer = (confirmText.closest('.ant-popover') ??
      confirmText.closest('[class*="popconfirm"]') ??
      document.body) as HTMLElement;
    const layerBtns = Array.from(layer.querySelectorAll('button')) as HTMLButtonElement[];
    await act(async () => {
      fireEvent.click(layerBtns[layerBtns.length - 1]);
    });

    await waitFor(() => expect(configApi.remove).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('配置项正被使用')).toBeTruthy();
    expect(screen.queryByText('已删除')).toBeNull();
    // 行仍在（失败不等于已删）
    expect(screen.getByText('feature.x')).toBeTruthy();
  });

  it('⑬ 「刷新」按钮 → 重新拉取配置列表', async () => {
    renderSettings();
    await openTab('系统配置');
    await screen.findByText('feature.x');
    const before = vi.mocked(configApi.findAll).mock.calls.length;

    fireEvent.click(findBtn(document.body, '刷新')!);

    await waitFor(() => {
      expect(vi.mocked(configApi.findAll).mock.calls.length).toBeGreaterThan(before);
    });
  });

  it('⑭ logRetention.days 提示条：未配该键时出现，「新建并设为 30 天」预填该键', async () => {
    renderSettings();
    await openTab('系统配置');
    await screen.findByText('feature.x');

    const hint = screen.getByTestId('log-retention-hint');
    expect(hint).toBeTruthy();
    fireEvent.click(findBtn(hint, '新建并设为 30 天')!);

    // 预填：key=logRetention.days（编辑既有键 → key 字段禁用、标题带 key）
    await waitFor(() => expect(screen.getByText('编辑：logRetention.days')).toBeTruthy());
  });

  it('⑮ 已配置 logRetention.days → 提示条不再出现（只有缺键时才提示）', async () => {
    vi.mocked(configApi.findAll).mockResolvedValue([
      ...configFixture,
      {
        id: 2,
        key: 'logRetention.days',
        value: '30',
        description: null,
        valueType: 'number' as const,
        isSecret: false,
        tag: null,
        createdAt: '2026-09-02T00:00:00.000Z',
        updatedAt: '2026-09-02T00:00:00.000Z',
      },
    ] as never);
    renderSettings();
    await openTab('系统配置');
    await screen.findByText('logRetention.days');

    expect(screen.queryByTestId('log-retention-hint')).toBeNull();
  });
});

describe('设置页：变更历史读失败', () => {
  it('⑯ 变更历史读失败 → 页内错误块 + 重试重新拉取', async () => {
    vi.mocked(configApi.getHistory)
      .mockRejectedValueOnce(new Error('历史服务不可用'))
      .mockResolvedValueOnce({ data: [], total: 0 } as never);

    renderSettings();
    await openTab('系统配置');
    const keyCell = await screen.findByText('feature.x');
    const row = keyCell.closest('tr') as HTMLElement;
    const historyBtn = row
      .querySelector('button .anticon-history')
      ?.closest('button') as HTMLButtonElement;
    fireEvent.click(historyBtn);

    expect(await screen.findByText('变更历史加载失败')).toBeTruthy();
    expect(screen.getByText('历史服务不可用')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /重试/ }));

    await waitFor(() => {
      expect(configApi.getHistory).toHaveBeenCalledTimes(2);
      expect(screen.queryByText('变更历史加载失败')).toBeNull();
    });
  });
});

describe('设置页：AI 配置保存成功与连通性测试', () => {
  /** 把 provider 切到 openai（只有非 disabled 才渲染「测试连通性」按钮）。 */
  const switchToOpenai = async () => {
    const providerSelect = document.querySelector('.ant-select') as HTMLElement;
    expect(providerSelect, '未找到 provider 下拉').toBeTruthy();
    await act(async () => {
      fireEvent.mouseDown(providerSelect);
    });
    const option = await waitFor(() => {
      const el = Array.from(document.querySelectorAll('.ant-select-item-option-content')).find((o) =>
        (o.textContent ?? '').includes('OpenAI'),
      );
      expect(el, '未找到 OpenAI 选项').toBeTruthy();
      return el!;
    });
    await act(async () => {
      fireEvent.click(option);
    });
  };

  it('⑰ AI 配置保存成功 → saved toast + 重新拉取 GET /ai/config', async () => {
    renderSettings();
    await openTab(/AI 配置/);
    await screen.findByText('保存配置');

    fireEvent.click(findBtn(document.body, '保存配置')!);

    await waitFor(() => expect(aiApi.saveConfig).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('AI 配置已保存')).toBeTruthy();
    // onSuccess 失效 ['ai-config'] → 重新 GET
    await waitFor(() => {
      expect(vi.mocked(aiApi.getConfig).mock.calls.length).toBeGreaterThan(1);
    });
  });

  it('⑱ 连通性测试成功 → testSuccess + 后端消息原文', async () => {
    vi.mocked(aiApi.testConfig).mockResolvedValue({ ok: true, message: 'ping ok' } as never);
    renderSettings();
    await openTab(/AI 配置/);
    await screen.findByText('保存配置');

    await switchToOpenai();

    fireEvent.click(await screen.findByText('测试连通性'));

    await waitFor(() => expect(aiApi.testConfig).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('AI 连接成功')).toBeTruthy();
    expect(screen.getByText('ping ok')).toBeTruthy();
  });

  it('⑲ 连通性测试失败（ok=false）→ testFailed + 错误详情原文（不吞掉）', async () => {
    vi.mocked(aiApi.testConfig).mockResolvedValue({
      ok: false,
      message: 'connect ECONNREFUSED 127.0.0.1:11434',
    } as never);
    renderSettings();
    await openTab(/AI 配置/);
    await screen.findByText('保存配置');

    await switchToOpenai();

    fireEvent.click(await screen.findByText('测试连通性'));

    await waitFor(() => expect(aiApi.testConfig).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('连接失败')).toBeTruthy();
    expect(screen.getByText('connect ECONNREFUSED 127.0.0.1:11434')).toBeTruthy();
  });

  it('⑳ 连通性测试请求 reject → 兜底「请求失败，请检查配置」（UI-15 onError）', async () => {
    vi.mocked(aiApi.testConfig).mockRejectedValue(new Error('network down'));
    renderSettings();
    await openTab(/AI 配置/);
    await screen.findByText('保存配置');

    await switchToOpenai();

    fireEvent.click(await screen.findByText('测试连通性'));

    await waitFor(() => expect(aiApi.testConfig).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('连接失败')).toBeTruthy();
    expect(screen.getByText('请求失败，请检查配置')).toBeTruthy();
  });
});

describe('设置页：?tab= 深链与 Tab 切换', () => {
  it('㉑ 合法 ?tab= 深链 → 精确激活该 Tab（不落回首个）', async () => {
    renderSettings(['/settings?tab=config']);
    // 系统配置 Tab 被激活：其内容（配置表）在场
    expect(await screen.findByText('feature.x')).toBeTruthy();
    const tab = screen.getByRole('tab', { name: '系统配置' });
    expect(tab.getAttribute('aria-selected')).toBe('true');
  });

  it('㉒ 非法 ?tab= → 回退首个 Tab（管理员 = 执行器 Token）', async () => {
    renderSettings(['/settings?tab=not-a-real-tab']);
    const tokenTab = await screen.findByRole('tab', { name: /执行器 Token/ });
    expect(tokenTab.getAttribute('aria-selected')).toBe('true');
    // 回退只作用于 activeKey：非法值不会被接受，也不会渲染该 Tab 的内容
    expect(screen.queryByRole('tab', { name: 'not-a-real-tab' })).toBeNull();
    // 配置表不应被渲染（否则说明非法值被当成了 config）
    expect(screen.queryByText('feature.x')).toBeNull();
    expect(configApi.findAll).not.toHaveBeenCalled();
  });

  it('㉓ 点 Tab → 选择写进 URL ?tab=（刷新/深链/前进后退保留位置）', async () => {
    renderSettings();
    await openTab('系统配置');
    await screen.findByText('feature.x');

    const tab = screen.getByRole('tab', { name: '系统配置' });
    expect(tab.getAttribute('aria-selected')).toBe('true');
    await waitFor(() => {
      expect(screen.getByTestId('location-search').textContent).toContain('tab=config');
    });
  });

  it('㉔ 非管理员：?tab=token 非法（该 Tab 不渲染）→ 回退到 AI 配置', async () => {
    useAuthStore.setState({ user: { id: 2, username: 'dev', role: 'user' } });
    renderSettings(['/settings?tab=token']);

    const aiTab = await screen.findByRole('tab', { name: /AI 配置/ });
    expect(aiTab.getAttribute('aria-selected')).toBe('true');
  });
});
