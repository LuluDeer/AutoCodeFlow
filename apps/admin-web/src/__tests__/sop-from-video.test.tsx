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
