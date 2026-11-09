/**
 * 视频转 SOP + 模型接入（推理质量轮）：
 *  · 员工侧：上传 → 生成 → 编辑 → 保存草稿，**只存草稿**（验收项要人补）；
 *  · 管理员侧：模型接入表 + 按用途分配，视频用途只列「支持视频」的模型。
 *
 * 这两条都是"界面看着对、语义错了也不报错"的地方，故断言落在**发出的请求**上。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import SopFromVideoPage from '../pages/SopFromVideoPage';
import AiProvidersSettings from '../pages/settings/AiProvidersSettings';
import { filterProvidersForPurpose } from '../pages/settings/ai-provider-filter';
import { aiApi } from '../api/ai';
import { sopsApi } from '../api/sops';

vi.mock('../api/ai', () => ({
  aiApi: {
    listProviders: vi.fn(),
    saveProvider: vi.fn(),
    deleteProvider: vi.fn(),
    assignRoute: vi.fn(),
    uploadVideo: vi.fn(),
    generateSopDraft: vi.fn(),
    listSopSessions: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    createSopSession: vi.fn(),
    getSopSession: vi.fn(),
    sopSessionTurn: vi.fn(),
    sopSessionTurnStream: vi.fn(),
    markSopSessionSaved: vi.fn(),
  },
}));
vi.mock('../api/sops', () => ({
  sopsApi: { draft: vi.fn() },
}));

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
// jsdom 没有 URL.createObjectURL（本地预览用）
if (!URL.createObjectURL) {
  (URL as unknown as Record<string, unknown>).createObjectURL = () => 'blob:preview';
  (URL as unknown as Record<string, unknown>).revokeObjectURL = () => {};
}

const videoProvider = {
  id: 'qwen-vl',
  label: '通义千问 VL',
  transport: 'openai' as const,
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  model: 'qwen-vl-max',
  maxTokens: 8192,
  timeoutMs: 120000,
  supportsVideo: true,
  enabled: true,
  hasApiKey: true,
  legacy: false,
};
const textProvider = {
  ...videoProvider,
  id: 'cheap',
  label: '便宜档',
  model: 'gpt-4o-mini',
  supportsVideo: false,
};

const view = (providers = [videoProvider, textProvider]) => ({
  providers,
  errors: [],
  routes: {
    analysis: { provider: '', model: '', maxTokens: '', timeoutMs: '' },
    agent: { provider: '', model: '', maxTokens: '', timeoutMs: '' },
    video: { provider: 'qwen-vl', model: '', maxTokens: '', timeoutMs: '' },
  },
});

beforeEach(() => {
  vi.mocked(aiApi.listProviders).mockResolvedValue(view() as never);
  // R157：**替身必须兑现生产契约**（ADR-027「测试替身保真」）。
  // 生产侧 `markSopSessionSaved()` 返回 Promise 且调用点写的是
  // `await aiApi.markSopSessionSaved(id).catch(...)`；本文件此前用裸 `vi.fn()`
  // ⇒ 返回 `undefined` ⇒ 保存成功路径上 `.catch` 直接抛 TypeError
  // 「Cannot read properties of undefined (reading 'catch')」。
  // 该 TypeError 会被外层 catch 接住并弹一条**假错误** toast，污染
  // `document.body.textContent` ⇒ 同文件后面那条「空必填时点保存」的断言
  // 就会间歇性失败（全量并行时暴露，单跑不出现 —— 典型「测试互相污染」）。
  vi.mocked(aiApi.markSopSessionSaved).mockResolvedValue(undefined as never);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const askSession = {
  id: 'sess-1',
  status: 'active' as const,
  messages: [
    { role: 'user' as const, text: '这是我的一段操作录屏', at: 't1' },
    { role: 'assistant' as const, text: '报表最终发到哪里？', action: 'ask' as const, at: 't2' },
  ],
  media: [{ mediaId: 'm-1', name: 'demo.mp4' }],
  draft: null,
  provider: 'qwen-vl',
  questionsAsked: 1,
  remainingQuestions: 5,
};

const draftedSession = {
  ...askSession,
  status: 'drafted' as const,
  messages: [
    ...askSession.messages,
    { role: 'user' as const, text: '发到 OSS 的 reports/ 目录', at: 't3' },
    { role: 'assistant' as const, text: '已生成草稿：每日报表', action: 'draft' as const, at: 't4' },
  ],
  draft: {
    title: '每日报表',
    slug: 'daily-report',
    frontMatterYaml: 'acceptance: []',
    bodyMarkdown: '## 步骤\n1. 打开报表页',
    assumptions: ['假设报表走浏览器'],
    provider: 'qwen-vl',
    model: 'qwen-vl-max',
  },
};

describe("SopFromVideoPage —— 会话式编写", () => {
  it("没有视频模型时给出明确提示（不让人等到失败）", async () => {
    vi.mocked(aiApi.listProviders).mockResolvedValue(view([textProvider]) as never);
    render(
      <MemoryRouter>
        <SopFromVideoPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText('没有可用的视频模型')).toBeTruthy();
  });

  it("首段录屏 → 开会话；模型追问 → 用户回答 → 出稿 → 保存草稿", async () => {
    vi.mocked(aiApi.uploadVideo).mockResolvedValue({
      id: 'm-1',
      name: 'demo.mp4',
      mime: 'video/mp4',
      sizeBytes: 10,
    } as never);
    vi.mocked(aiApi.createSopSession).mockResolvedValue(askSession as never);
    vi.mocked(aiApi.sopSessionTurnStream).mockImplementation(
      async (_id, _data, handlers) => {
        handlers.onDelta('已生成');
        return draftedSession as never;
      },
    );
    vi.mocked(sopsApi.draft).mockResolvedValue({ id: 'sop-1' } as never);

    render(
      <MemoryRouter>
        <SopFromVideoPage />
      </MemoryRouter>,
    );

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(['v'], 'demo.mp4', { type: 'video/mp4' })] },
    });

    await waitFor(() => expect(aiApi.createSopSession).toHaveBeenCalled());
    // 第一轮追问必须原样呈现（用户才知道要答什么）
    expect(await screen.findByText('报表最终发到哪里？')).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText(/补充说明，或直接回答/), {
      target: { value: '发到 OSS 的 reports/ 目录' },
    });
    fireEvent.click(screen.getByText('发送'));

    await waitFor(() =>
      expect(aiApi.sopSessionTurnStream).toHaveBeenCalledWith(
        'sess-1',
        { text: '发到 OSS 的 reports/ 目录' },
        expect.objectContaining({ onDelta: expect.any(Function) }),
      ),
    );
    // 草稿 + 模型假设都要露出来（假设是"它怎么补的"，用户必须能复核）
    expect(await screen.findByText('模型做出的假设（请复核）')).toBeTruthy();

    fireEvent.click(screen.getByText('保存为草稿'));
    await waitFor(() =>
      expect(sopsApi.draft).toHaveBeenCalledWith(
        expect.objectContaining({ slug: 'daily-report', title: '每日报表' }),
      ),
    );
    // 保存成功后标记会话（不自动发布）
    await waitFor(() => expect(aiApi.markSopSessionSaved).toHaveBeenCalledWith('sess-1'));
  });

  it("URL 带 session 时续跑（刷新/换设备不丢上下文）", async () => {
    vi.mocked(aiApi.getSopSession).mockResolvedValue(askSession as never);
    render(
      <MemoryRouter initialEntries={['/sops/from-video?session=sess-1']}>
        <SopFromVideoPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText('报表最终发到哪里？')).toBeTruthy();
    expect(aiApi.getSopSession).toHaveBeenCalledWith('sess-1');
  });
});

// ── R139 P2-1：模型列表的「加载中 / 读取失败 / 真空列表」三态 ──────────────
// 缺陷：`videoProviders.length === 0` 一句同时覆盖了三种事实，于是
//   ① 首帧（请求还没回来）就闪一次「没有可用的视频模型」，上传区被禁用；
//   ② 请求**失败**后永久停在这条预警上，文案把人引向「设置 → AI 接入」这个
//      **错误的根因**，页面没有任何重试入口，只能整页刷新。
// 判据：失败 ≠ 空；加载中 ≠ 空。两者都不许渲染空态预警，且失败必须给可恢复路径。
describe("P2-1 模型列表三态：加载中 / 读取失败 / 真空列表", () => {
  it("读取失败：不渲染空态预警，给出错误块 + 重试；重试成功后恢复可用", async () => {
    vi.mocked(aiApi.listProviders).mockRejectedValueOnce(new Error('网关超时'));
    render(
      <MemoryRouter>
        <SopFromVideoPage />
      </MemoryRouter>,
    );

    // 失败必须显式可见（不是一闪而过的 toast）
    const errBox = await screen.findByTestId('state-error');
    expect(errBox.textContent).toContain('模型列表读取失败');
    // 反证锚点：旧实现此处渲染的是「没有可用的视频模型」+「设置 → AI 接入」指引
    expect(screen.queryByText('没有可用的视频模型')).toBeNull();

    // 可恢复路径：重试重新拉取，成功后错误块消失、上传主操作可用
    // （antd 的图标带 aria-label，可访问名是「reload 重试」，故用正则）
    fireEvent.click(screen.getByRole('button', { name: /重试/ }));
    await waitFor(() => expect(aiApi.listProviders).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByTestId('state-error')).toBeNull());
    expect(screen.queryByText('没有可用的视频模型')).toBeNull();
    expect(document.querySelector('.ant-upload-disabled')).toBeNull();
  });

  it("读取中：不渲染空态预警（首帧不得先报空），主操作保持禁用", async () => {
    vi.mocked(aiApi.listProviders).mockReturnValue(new Promise(() => {}) as never);
    render(
      <MemoryRouter>
        <SopFromVideoPage />
      </MemoryRouter>,
    );

    await waitFor(() => expect(aiApi.listProviders).toHaveBeenCalled());
    // 请求还挂着：既不可能是「没有模型」，也不可能是「读取失败」
    expect(screen.queryByText('没有可用的视频模型')).toBeNull();
    expect(screen.queryByTestId('state-error')).toBeNull();
    // 但要有加载态（不是空白），且主操作在未知态下禁用
    expect(screen.getByTestId('sopFromVideo-model-loading')).toBeTruthy();
    expect(document.querySelector('.ant-upload-disabled')).toBeTruthy();
  });
});

// ── R139 P3-3：「保存为草稿」的 `validateFields()` rejection 必须被消费 ──────
// antd 的 `form.validateFields()` 校验不通过时是 **reject**（带 errorFields 的对象）。
// 旧实现裸 `await form.validateFields()`，reject 直接逃出函数 ⇒ 常驻
// unhandledRejection（`main.tsx` 的 installGlobalErrorHandlers 会打
// `[admin-web][unhandled-rejection]`，线上错误聚合每次校验失败多一条）。
// 全仓 `validateFields` 调用点只剩本页这一处没消费（R92 修过设置页 4 处）。
//
// 观测口用 **process**：`src/test-support/unhandled-rejection.ts` 的 reporter
// 装在 process 上，`void saveDraft()` 这种被 void 掉的 promise 在 jsdom 里
// **不会**触发 window 的 `unhandledrejection`（settings 同名用例实测过）。
describe("P3-3 「保存为草稿」校验失败不得产生浮空 rejection", () => {
  const captureUnhandled = () => {
    const seen: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      seen.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    return { seen, stop: () => process.off('unhandledRejection', onUnhandled) };
  };

  /** 草稿缺必填标题（模型产出的草稿并非必然合法，slug/正文同理）。 */
  const draftWithoutTitle = {
    ...draftedSession,
    draft: { ...draftedSession.draft, title: '' },
  };

  it("空必填时点保存：无浮空 rejection、不发保存请求、给出可见提示", async () => {
    vi.mocked(aiApi.getSopSession).mockResolvedValue(draftWithoutTitle as never);
    const cap = captureUnhandled();
    try {
      render(
        <MemoryRouter initialEntries={['/sops/from-video?session=sess-1']}>
          <SopFromVideoPage />
        </MemoryRouter>,
      );
      fireEvent.click(await screen.findByText('保存为草稿'));

      // R158：**等「可观测事实」而不是等一个固定毫秒数**。
      //
      // 旧写法是 `await sleep(120)` 然后断言 body 里有提示文案 —— 这是把
      // **「antd message 的 portal 在这台机器上 120ms 内一定挂载完成」**当成前提。
      // 全量并行 + 覆盖率插桩时 CPU 被抢，这个前提会破 ⇒ 断言在提示还没挂上时
      // 就执行 ⇒ **间歇性失败**（单跑必绿、全量偶发，本仓长期记为
      // `web-flake-not-reproduced`，本轮定位到具体形态之一）。
      // 改为 `waitFor` 等**它该出现的东西**出现（超时 3s），随后再断言
      // 「没有浮空 rejection」「没发请求」—— 这两条此时才有意义。
      await waitFor(
        () => {
          expect(document.body.textContent).toContain('还有必填项没填好');
        },
        { timeout: 3000 },
      );

      // 消息已经出现 ⇒ 校验分支确实执行完了；再给浮空 rejection 一个冒头窗口
      await new Promise((r) => setTimeout(r, 50));

      // 核心断言：校验失败被消费，没有变成未处理拒绝
      expect(cap.seen).toEqual([]);
      // 校验错误不是请求错误：一次保存请求都不该发
      expect(sopsApi.draft).not.toHaveBeenCalled();
    } finally {
      cap.stop();
    }
  });
});

describe("AiProvidersSettings —— 接入与分配", () => {
  it("列出接入项并标注能力（视频/密钥/状态）", async () => {
    render(<AiProvidersSettings />);
    expect(await screen.findByText('通义千问 VL')).toBeTruthy();
    expect(screen.getByText('qwen-vl')).toBeTruthy();
    expect(screen.getAllByText('支持').length).toBeGreaterThan(0);
    expect(screen.getAllByText('已配置').length).toBeGreaterThan(0);
  });

  it("能力闸在 UI 侧先挡一次：视频用途只留支持视频的模型，Agent 只留 OpenAI 兼容面", () => {
    const providers = [
      videoProvider,
      textProvider,
      { ...videoProvider, id: 'local', transport: 'ollama' as const, supportsVideo: false },
      { ...videoProvider, id: 'off', enabled: false },
    ] as never[];

    expect(filterProvidersForPurpose('video', providers).map((p) => p.id)).toEqual(['qwen-vl']);
    expect(filterProvidersForPurpose('agent', providers).map((p) => p.id)).toEqual([
      'qwen-vl',
      'cheap',
    ]);
    expect(filterProvidersForPurpose('analysis', providers).map((p) => p.id)).toEqual([
      'qwen-vl',
      'cheap',
      'local',
    ]);
  });
});
