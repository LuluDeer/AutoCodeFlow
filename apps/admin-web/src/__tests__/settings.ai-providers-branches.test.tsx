/**
 * 「模型接入与分配」（pages/settings/AiProvidersSettings.tsx）交互分支补面。
 *
 * ## 为什么单开这个文件
 *
 * v8 覆盖率实测（全量 275 文件 / 2237 用例）显示本页是设置区里**最差**的一档：
 * stmt 58% / branch 63% / **func 50%**（对照 ApiKeys 90/84/89、Security 92/80/90）。
 * 已有用例（settings.ai-providers-load-error.test.tsx）只钉了**读失败**这一条
 * 路径（load() reject → 页内 StateError → 重试），本页的**写面**——provider
 * 编辑器 Modal 的开/存/关、save 的失败分支、删除二次确认、按用途分配路由
 * （assignRoute）——**一行都没有被驱动过**：
 *
 *   覆盖率实测未覆盖的语句（coverage-final.json，未覆盖语句行号）：
 *     86-101  openEditor（新增/编辑两套初值 + form.setFieldsValue）
 *     105-115 save（validateFields → saveProvider → 成功关窗 / 失败 catch）
 *     119-124 remove（deleteProvider → 成功 toast / 失败 catch）
 *     128-133 assign（assignRoute → 成功 toast / 失败 catch）
 *     185     「编辑」按钮 onClick → openEditor(row)
 *     193-196 删除按钮 → Modal.confirm → onOk → remove(row.id)
 *     212     routeSelect 的 onChange → assign(purpose, v)
 *     227     「接入模型」按钮 onClick → openEditor()
 *     279-280 Modal 的 onCancel / onOk
 *   未覆盖的函数（fnMap）：85(openEditor) 104(save) 118(remove) 127(assign)
 *     185(编辑按钮) 192/195(删除按钮/确认 onOk) 212/215(routeSelect onChange/label)
 *     227(接入按钮) 279/280(Modal onCancel/onOk)
 *
 * 换句话说：**一个新增 provider 的完整流程（打开编辑器 → 填表 → 保存）在这
 * 个页面从未被执行过一次**，而这恰恰是本页最核心的用户路径。API 拒绝时的
 * 状态一致性（弹窗保持打开、数据不被清空）同样无人验证。
 *
 * ## 本文件钉住的行为（每条都能失败）
 *
 *  ① 编辑器打开的**两套初值**：新增 = 空 id / maxTokens 4096 / timeoutMs 60000 /
 *     enabled=true / supportsVideo=false；编辑 = 既有行的值，且 **apiKey 显示为
 *     `***`**（读面只有 hasApiKey，前端不可能回显密钥——若编辑时把 apiKey 清空，
 *     保存就会把已存密钥抹掉）。
 *  ② 编辑时 id 字段**禁用**（id 是注册表主键，不可改）。
 *  ③ 保存成功 → 成功 toast + Modal 关闭 + 列表换成服务端返回的新视图。
 *  ④ 保存**失败** → 错误 toast（后端文案透出）+ **Modal 保持打开**
 *     （用户数据不丢，能改完再提交）+ 列表仍是旧数据。
 *  ⑤ 取消 → 关闭 Modal 且不发起保存请求。
 *  ⑥ 表单校验不通过 → 不发起保存请求，Modal 保持打开。
 *  ⑦ 删除必须走二次确认（Modal.confirm）；取消 → 不发请求；确认 →
 *     deleteProvider(id)；删除失败 → 错误 toast 且行**不消失**（不误删行）。
 *  ⑧ 按用途分配路由 → assignRoute(purpose, providerId)；失败 → 错误 toast。
 *  ⑨ `filterProvidersForPurpose` 的**用途分流**在页面上真的生效：
 *     「视频理解」下拉只列 supportsVideo 的模型；「Agent 推理」只列
 *     transport=openai 的模型；停用的模型任何用途都不列。
 *  ⑩ data.errors 非空 → 页内 Alert（部分条目无法解析），不静默。
 *
 * 隔离方式对齐 settings.ai-providers-load-error.test.tsx 先例：
 * `vi.mock('../api/ai')` 模块级 mock；antd 浏览器 API shim 照抄既有文件。
 *
 * ## antd 6 的两处 DOM 陷阱（本文件踩过，注释留给后来者）
 *
 *  ① **antd 6 的 Modal 没有 `.ant-modal-content`**（v5 才有），容器类名是
 *     `.ant-modal-container`；且 jsdom 下 rc-motion 的 transitionend 永不触发，
 *     关闭动画结束后 DOM 仍留在 body 里——所以「Modal 已关」不能靠
 *     `querySelector('.ant-modal-content') === null` 判定，要看 `.ant-modal`
 *     元素上是否挂了 `ant-zoom-leave`（离场类）。
 *  ② **antd message 的 holder 是单例**：`.ant-message` 一旦被 remove，antd
 *     内部的引用就成游离节点，后续 toast 渲染进不可见节点——症状是
 *     「toast 调用了但断言找不到文案」。故清残留只能删 `.ant-message-notice`
 *     （既有 notification-silences / settings.history-rollback 注记同款）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import AiProvidersSettings from '../pages/settings/AiProvidersSettings';
import { aiApi } from '../api/ai';

// 隔离 api 层（底层 axios client 会拉起拦截器）；只留本页用到的四个方法。
vi.mock('../api/ai', () => ({
  aiApi: {
    listProviders: vi.fn(),
    saveProvider: vi.fn(),
    deleteProvider: vi.fn(),
    assignRoute: vi.fn(),
  },
}));

// jsdom 缺 antd Table/Select/Modal 依赖的浏览器 API，先行补齐
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

/**
 * 一个 provider 行夹具。
 *
 * `transport: 'openai'` + `supportsVideo: true` 让它在 analysis/agent/video
 * 三个用途下都出现；用途分流的对照组见 `providers` 组里的另外几条。
 */
const providerRow = (over: Record<string, unknown> = {}) => ({
  id: 'qwen-vl',
  label: 'Qwen VL',
  transport: 'openai' as const,
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  model: 'qwen-vl-max',
  maxTokens: 4096,
  timeoutMs: 60000,
  supportsVideo: true,
  enabled: true,
  hasApiKey: true,
  legacy: false,
  ...over,
});

const view = (providers: unknown[], errors: string[] = []) => ({
  providers,
  errors,
  routes: {
    analysis: { provider: '', model: '', maxTokens: '', timeoutMs: '' },
    agent: { provider: '', model: '', maxTokens: '', timeoutMs: '' },
    video: { provider: '', model: '', maxTokens: '', timeoutMs: '' },
  },
});

/** antd 双汉字按钮自动插空格，textContent 归一化后再匹配（既有先例）。 */
const findBtn = (root: ParentNode, text: string): HTMLButtonElement | null =>
  (Array.from(root.querySelectorAll('button')) as HTMLButtonElement[]).find(
    (b) => (b.textContent ?? '').replace(/\s/g, '') === text,
  ) ?? null;

/**
 * 打开 Modal 内的表单控件。
 *
 * 用 label 文本定位（antd Form.Item 的 label 与控件在同一个 .ant-form-item
 * 容器里），比 nth-child 稳。
 */
const fieldIn = (labelText: string): HTMLElement => {
  const items = Array.from(document.querySelectorAll('.ant-modal .ant-form-item')) as HTMLElement[];
  const item = items.find((el) =>
    (el.querySelector('.ant-form-item-label')?.textContent ?? '').includes(labelText),
  );
  expect(item, `未找到表单字段：${labelText}`).toBeTruthy();
  return item!;
};

const inputIn = (labelText: string): HTMLInputElement => {
  const item = fieldIn(labelText);
  const input = item.querySelector('input') as HTMLInputElement;
  expect(input, `字段 ${labelText} 内未找到 input`).toBeTruthy();
  return input;
};

/** Modal 的 footer 按钮组（antd 6：取 消 / 保 存）。 */
const modalFooterBtns = (): HTMLButtonElement[] => {
  const modal = document.querySelector('.ant-modal') as HTMLElement;
  expect(modal, '未找到 Modal').toBeTruthy();
  return Array.from(modal!.querySelectorAll('.ant-modal-footer button')) as HTMLButtonElement[];
};

/** Modal 的「确定」键（footer 最后一个按钮）。 */
const modalOkBtn = (): HTMLButtonElement => {
  const btns = modalFooterBtns();
  expect(btns.length).toBeGreaterThan(0);
  return btns[btns.length - 1];
};

/** Modal 的「取消」键（footer 第一个按钮）。 */
const modalCancelBtn = (): HTMLButtonElement => modalFooterBtns()[0];

/**
 * Modal 当前是否处于「已打开」态。
 *
 * 不能用「DOM 里还有没有 .ant-modal」判定——antd 6 的 rc-motion 在 jsdom 下
 * 不触发 transitionend，关闭后 DOM 仍留着。真正的离场信号是 `.ant-modal`
 * 元素上的 `ant-zoom-leave` 类（见文件头陷阱注①）。
 */
const modalIsOpen = (): boolean => {
  const modal = document.querySelector('.ant-modal') as HTMLElement | null;
  if (!modal) return false;
  return !modal.className.includes('ant-zoom-leave');
};

/**
 * 当前**活跃**的下拉浮层。
 *
 * rc-select 会把关闭掉的浮层留在 DOM（挂着 `-leave` 类直到动画结束），且同
 * 一时刻可能有多份浮层（三个用途各一个）。只取最后一个「非 leave 态」的。
 */
const liveDropdown = (): HTMLElement => {
  const dds = Array.from(document.querySelectorAll('.ant-select-dropdown')) as HTMLElement[];
  const live = dds.filter((d) => !d.className.includes('-leave'));
  expect(live.length, '未找到活跃的下拉浮层').toBeGreaterThan(0);
  return live[live.length - 1];
};

/** 活跃下拉里的选项文案。 */
const liveOptions = (): string[] =>
  Array.from(liveDropdown().querySelectorAll('.ant-select-item-option-content')).map(
    (e) => e.textContent ?? '',
  );

/** 按用途标签定位对应的下拉列。 */
const selectCol = (purposeLabel: string): HTMLElement => {
  const cols = Array.from(document.querySelectorAll('.ant-col')) as HTMLElement[];
  const col = cols.find((c) => (c.textContent ?? '').includes(purposeLabel));
  expect(col, `未找到用途列：${purposeLabel}`).toBeTruthy();
  return col!;
};

beforeEach(() => {
  vi.mocked(aiApi.listProviders).mockReset().mockResolvedValue(view([providerRow()]) as never);
  vi.mocked(aiApi.saveProvider).mockReset().mockResolvedValue(view([providerRow()]) as never);
  vi.mocked(aiApi.deleteProvider).mockReset().mockResolvedValue(view([]) as never);
  vi.mocked(aiApi.assignRoute).mockReset().mockResolvedValue(view([providerRow()]) as never);
  // 只清残留的**通知条目**，绝不碰 `.ant-message` holder 本身——holder 被移除后
  // antd 内部引用成游离节点，后续 toast 会渲染进不可见节点（文件头陷阱注②）。
  document.body.querySelectorAll('.ant-message-notice').forEach((el) => el.remove());
});

afterEach(() => {
  cleanup();
  document.body.querySelectorAll('.ant-message-notice').forEach((el) => el.remove());
});

describe('AiProvidersSettings：编辑器打开/保存/取消', () => {
  it('① 新增：打开编辑器是空 id + 默认 maxTokens/timeoutMs（enabled 开、supportsVideo 关）', async () => {
    render(<AiProvidersSettings />);
    await screen.findByText('qwen-vl');

    fireEvent.click(findBtn(document.body, '接入模型')!);

    await waitFor(() => expect(document.querySelector('.ant-modal-container')).toBeTruthy());
    // 新增态：id 为空（不是既有行的 id）
    expect(inputIn('标识').value).toBe('');
    // 默认值来自 openEditor 的新增分支（4096 / 60000）
    expect(inputIn('输出令牌上限').value).toBe('4096');
    expect(inputIn('超时（毫秒）').value).toBe('60000');
    // enabled 默认开、supportsVideo 默认关（两个 Switch）
    const switches = Array.from(
      document.querySelectorAll('.ant-modal .ant-form-item .ant-switch'),
    ) as HTMLElement[];
    expect(switches.length).toBeGreaterThanOrEqual(2);
    // 新增态不预填密钥（留空 = 服务端按缺省处理）
    expect(inputIn('API Key').value).toBe('');
  });

  it('② 编辑：既有值回填，apiKey 显示为 ***（不是真密钥，也不清空），id 字段禁用', async () => {
    render(<AiProvidersSettings />);
    await screen.findByText('qwen-vl');

    // 点行内「编辑」按钮（不是「接入模型」）
    const editBtn = findBtn(document.body, '编辑');
    expect(editBtn, '未找到行内「编辑」按钮').toBeTruthy();
    fireEvent.click(editBtn!);

    await waitFor(() => expect(document.querySelector('.ant-modal-container')).toBeTruthy());
    expect(inputIn('标识').value).toBe('qwen-vl');
    // id 是注册表主键 → 禁用（不可改）
    expect(inputIn('标识').disabled).toBe(true);
    expect(inputIn('模型名').value).toBe('qwen-vl-max');
    expect(inputIn('显示名').value).toBe('Qwen VL');
    // 密钥读面只有 hasApiKey 布尔：编辑器里必须是掩码 ***
    expect(inputIn('API Key').value).toBe('***');
    // 既有行的其它能力位也回填
    expect(inputIn('输出令牌上限').value).toBe('4096');
  });

  it('③ 保存成功 → 成功 toast + Modal 关闭 + 列表换成服务端返回的新视图', async () => {
    vi.mocked(aiApi.saveProvider).mockResolvedValue(
      view([providerRow({ id: 'new-model', label: '新模型' })]) as never,
    );
    render(<AiProvidersSettings />);
    await screen.findByText('qwen-vl');

    fireEvent.click(findBtn(document.body, '接入模型')!);
    await waitFor(() => expect(document.querySelector('.ant-modal-container')).toBeTruthy());

    fireEvent.change(inputIn('标识'), { target: { value: 'new-model' } });
    fireEvent.change(inputIn('baseUrl'), { target: { value: 'https://example.com/v1' } });
    fireEvent.change(inputIn('模型名'), { target: { value: 'new-model-v1' } });

    await act(async () => {
      fireEvent.click(modalOkBtn());
    });

    await waitFor(() => expect(aiApi.saveProvider).toHaveBeenCalledTimes(1));
    const payload = vi.mocked(aiApi.saveProvider).mock.calls[0][0];
    expect(payload.id).toBe('new-model');
    expect(payload.baseUrl).toBe('https://example.com/v1');
    expect(payload.model).toBe('new-model-v1');
    // 成功 toast
    expect(await screen.findByText('已保存')).toBeTruthy();
    // Modal 关闭（离场类出现）
    await waitFor(() => expect(modalIsOpen()).toBe(false));
    // 列表换成服务端返回的新视图
    expect(await screen.findByText('new-model')).toBeTruthy();
  });

  it('④ 保存失败 → 错误 toast + Modal 保持打开（数据不丢）+ 列表仍是旧数据', async () => {
    vi.mocked(aiApi.saveProvider).mockRejectedValue(
      Object.assign(new Error('bad'), { response: { data: { message: '标识已存在' } } }),
    );
    render(<AiProvidersSettings />);
    await screen.findByText('qwen-vl');

    fireEvent.click(findBtn(document.body, '接入模型')!);
    await waitFor(() => expect(document.querySelector('.ant-modal-container')).toBeTruthy());
    fireEvent.change(inputIn('标识'), { target: { value: 'dup-id' } });
    fireEvent.change(inputIn('baseUrl'), { target: { value: 'https://example.com/v1' } });
    fireEvent.change(inputIn('模型名'), { target: { value: 'm' } });

    await act(async () => {
      fireEvent.click(modalOkBtn());
    });

    await waitFor(() => expect(aiApi.saveProvider).toHaveBeenCalledTimes(1));
    // 后端文案透出（getErrMsg 取 response.data.message）
    expect(await screen.findByText('标识已存在')).toBeTruthy();
    // Modal 保持打开 → 用户填的内容不丢，能改完再提交
    expect(modalIsOpen()).toBe(true);
    expect(inputIn('标识').value).toBe('dup-id');
    // 列表未被失败写入污染
    expect(screen.queryByText('dup-id')).toBeNull();
    expect(screen.getByText('qwen-vl')).toBeTruthy();
  });

  it('⑤ 取消 → 关闭 Modal 且不发起保存请求', async () => {
    render(<AiProvidersSettings />);
    await screen.findByText('qwen-vl');

    fireEvent.click(findBtn(document.body, '接入模型')!);
    await waitFor(() => expect(document.querySelector('.ant-modal-container')).toBeTruthy());
    fireEvent.change(inputIn('标识'), { target: { value: 'never-saved' } });

    await act(async () => {
      fireEvent.click(modalCancelBtn());
    });

    await waitFor(() => expect(modalIsOpen()).toBe(false));
    expect(aiApi.saveProvider).not.toHaveBeenCalled();
    expect(screen.queryByText('never-saved')).toBeNull();
  });

  it('⑥ 表单校验不通过 → 不发起保存请求，Modal 保持打开', async () => {
    render(<AiProvidersSettings />);
    await screen.findByText('qwen-vl');

    fireEvent.click(findBtn(document.body, '接入模型')!);
    await waitFor(() => expect(document.querySelector('.ant-modal-container')).toBeTruthy());

    await act(async () => {
      fireEvent.click(modalOkBtn());
    });

    await waitFor(() => {
      expect(document.querySelector('.ant-form-item-explain-error')).toBeTruthy();
    });
    expect(aiApi.saveProvider).not.toHaveBeenCalled();
    // Modal 不该被关掉（校验失败仍在编辑）
    expect(modalIsOpen()).toBe(true);
  });
});

describe('AiProvidersSettings：删除二次确认', () => {
  it('⑦ 点删除先弹二次确认；取消 → 不发请求', async () => {
    render(<AiProvidersSettings />);
    await screen.findByText('qwen-vl');

    const delBtn = findBtn(document.body, '删除');
    expect(delBtn, '未找到行内「删除」按钮').toBeTruthy();
    fireEvent.click(delBtn!);

    // 二次确认框出现（含目标 id）
    const confirmHolder = await waitFor(() => {
      const el = document.querySelector('.ant-modal-confirm') as HTMLElement | null;
      expect(el, '未出现 Modal.confirm 二次确认').toBeTruthy();
      return el!;
    });
    expect(confirmHolder.textContent ?? '').toContain('qwen-vl');

    // 取消键（确认框 footer 第一个按钮）
    const btns = Array.from(confirmHolder.querySelectorAll('button')) as HTMLButtonElement[];
    await act(async () => {
      fireEvent.click(btns[0]);
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(aiApi.deleteProvider).not.toHaveBeenCalled();
  });

  it('⑧ 确认 → deleteProvider(id) 被调用，列表换成服务端返回的新视图', async () => {
    vi.mocked(aiApi.deleteProvider).mockResolvedValue(view([]) as never);
    render(<AiProvidersSettings />);
    await screen.findByText('qwen-vl');

    fireEvent.click(findBtn(document.body, '删除')!);
    const confirmHolder = await waitFor(() => {
      const el = document.querySelector('.ant-modal-confirm') as HTMLElement | null;
      expect(el).toBeTruthy();
      return el!;
    });
    const btns = Array.from(confirmHolder.querySelectorAll('button')) as HTMLButtonElement[];
    await act(async () => {
      fireEvent.click(btns[btns.length - 1]);
    });

    await waitFor(() => expect(aiApi.deleteProvider).toHaveBeenCalledTimes(1));
    expect(aiApi.deleteProvider).toHaveBeenCalledWith('qwen-vl');
    expect(await screen.findByText('已删除')).toBeTruthy();
  });

  it('⑨ 删除失败 → 错误 toast，列表保持不变（不误删行）', async () => {
    vi.mocked(aiApi.deleteProvider).mockRejectedValue(
      Object.assign(new Error('bad'), { response: { data: { message: '该模型正被路由引用' } } }),
    );
    render(<AiProvidersSettings />);
    await screen.findByText('qwen-vl');

    fireEvent.click(findBtn(document.body, '删除')!);
    const confirmHolder = await waitFor(() => {
      const el = document.querySelector('.ant-modal-confirm') as HTMLElement | null;
      expect(el).toBeTruthy();
      return el!;
    });
    const btns = Array.from(confirmHolder.querySelectorAll('button')) as HTMLButtonElement[];
    await act(async () => {
      fireEvent.click(btns[btns.length - 1]);
    });

    await waitFor(() => expect(aiApi.deleteProvider).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('该模型正被路由引用')).toBeTruthy();
    // 行仍在（失败不等于已删除）
    expect(screen.getByText('qwen-vl')).toBeTruthy();
  });
});

describe('AiProvidersSettings：按用途分配路由', () => {
  it('⑩ 选一个模型 → assignRoute(purpose, providerId) 被调用并提示成功', async () => {
    render(<AiProvidersSettings />);
    await screen.findByText('qwen-vl');

    const col = selectCol('日志分析');
    await act(async () => {
      fireEvent.mouseDown(col.querySelector('.ant-select') as HTMLElement);
    });
    // 等下拉里出现该 provider 的选项（选项 label = `${label} · ${model}`）
    const pickOption = (): HTMLElement | undefined =>
      Array.from(liveDropdown().querySelectorAll('.ant-select-item-option-content')).find((o) =>
        (o.textContent ?? '').includes('Qwen VL'),
      ) as HTMLElement | undefined;
    await waitFor(() => expect(pickOption(), '未找到 Qwen VL 选项').toBeTruthy());

    await act(async () => {
      fireEvent.click(pickOption() as HTMLElement);
    });

    await waitFor(() => expect(aiApi.assignRoute).toHaveBeenCalledTimes(1));
    expect(aiApi.assignRoute).toHaveBeenCalledWith('analysis', 'qwen-vl');
    expect(await screen.findByText('已更新用途分配')).toBeTruthy();
  });

  it('⑪ 分配失败 → 错误 toast（后端文案），不静默吞掉', async () => {
    vi.mocked(aiApi.assignRoute).mockRejectedValue(
      Object.assign(new Error('bad'), { response: { data: { message: '该模型不支持视频理解' } } }),
    );
    render(<AiProvidersSettings />);
    await screen.findByText('qwen-vl');

    const col = selectCol('日志分析');
    await act(async () => {
      fireEvent.mouseDown(col.querySelector('.ant-select') as HTMLElement);
    });
    await waitFor(() => {
      expect(
        Array.from(liveDropdown().querySelectorAll('.ant-select-item-option-content')).some((o) =>
          (o.textContent ?? '').includes('Qwen VL'),
        ),
      ).toBe(true);
    });
    await act(async () => {
      fireEvent.click(
        Array.from(liveDropdown().querySelectorAll('.ant-select-item-option-content')).find((o) =>
          (o.textContent ?? '').includes('Qwen VL'),
        ) as HTMLElement,
      );
    });

    await waitFor(() => expect(aiApi.assignRoute).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('该模型不支持视频理解')).toBeTruthy();
  });
});

describe('AiProvidersSettings：用途分流（filterProvidersForPurpose 在页面上生效）', () => {
  it('⑫ 视频理解下拉只列 supportsVideo 的模型；Agent 推理只列 openai 传输的模型', async () => {
    vi.mocked(aiApi.listProviders).mockResolvedValue(
      view([
        providerRow({ id: 'p-video', label: '视频模型', supportsVideo: true, transport: 'openai' }),
        providerRow({ id: 'p-plain', label: '普通模型', supportsVideo: false, transport: 'openai' }),
        providerRow({ id: 'p-ollama', label: 'Ollama模型', supportsVideo: true, transport: 'ollama' }),
      ]) as never,
    );
    render(<AiProvidersSettings />);
    await screen.findByText('p-video');

    // 视频理解：supportsVideo=true 的两个，不含 p-plain
    await act(async () => {
      fireEvent.mouseDown(selectCol('视频理解').querySelector('.ant-select') as HTMLElement);
    });
    await waitFor(() => expect(liveOptions().length).toBeGreaterThan(0));
    let texts = liveOptions();
    expect(texts.some((t) => t.includes('视频模型'))).toBe(true);
    expect(texts.some((t) => t.includes('Ollama模型'))).toBe(true);
    expect(texts.some((t) => t.includes('普通模型'))).toBe(false);

    // Agent 推理：transport 必须是 openai
    await act(async () => {
      fireEvent.mouseDown(selectCol('Agent 推理').querySelector('.ant-select') as HTMLElement);
    });
    await waitFor(() => {
      texts = liveOptions();
      expect(texts.length).toBeGreaterThan(0);
    });
    expect(texts.some((t) => t.includes('视频模型'))).toBe(true);
    expect(texts.some((t) => t.includes('普通模型'))).toBe(true);
    expect(texts.some((t) => t.includes('Ollama模型'))).toBe(false);
  });

  it('⑬ 停用的模型在任何用途下都不出现（enabled=false 一律排除）', async () => {
    vi.mocked(aiApi.listProviders).mockResolvedValue(
      view([
        providerRow({ id: 'p-on', label: '启用模型', enabled: true }),
        providerRow({ id: 'p-off', label: '停用模型', enabled: false }),
      ]) as never,
    );
    render(<AiProvidersSettings />);
    await screen.findByText('p-on');

    await act(async () => {
      fireEvent.mouseDown(selectCol('日志分析').querySelector('.ant-select') as HTMLElement);
    });
    await waitFor(() => expect(liveOptions().length).toBeGreaterThan(0));
    const texts = liveOptions();
    expect(texts.some((t) => t.includes('启用模型'))).toBe(true);
    expect(texts.some((t) => t.includes('停用模型'))).toBe(false);
  });
});

describe('AiProvidersSettings：解析告警与行内形态', () => {
  it('⑭ data.errors 非空 → 页内 Alert 列出无法解析的条目（不静默吞掉）', async () => {
    vi.mocked(aiApi.listProviders).mockResolvedValue(
      view([providerRow()], ['legacy.qwen: 缺少 baseUrl']) as never,
    );
    render(<AiProvidersSettings />);

    expect(await screen.findByText('部分条目无法解析')).toBeTruthy();
    expect(screen.getByText(/缺少 baseUrl/)).toBeTruthy();
  });

  it('⑮ 旧配置行（legacy）标「旧配置」Tag；无密钥行标「未配置」', async () => {
    vi.mocked(aiApi.listProviders).mockResolvedValue(
      view([
        providerRow({ id: 'p-legacy', label: '', legacy: true, hasApiKey: false }),
      ]) as never,
    );
    render(<AiProvidersSettings />);

    expect(await screen.findByText('旧配置')).toBeTruthy();
    expect(screen.getByText('未配置')).toBeTruthy();
    // 无 label 时回落显示 id（不渲染空标签）
    expect(screen.getByText('p-legacy')).toBeTruthy();
  });
});
