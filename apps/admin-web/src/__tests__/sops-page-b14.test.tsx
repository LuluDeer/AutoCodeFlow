/**
 * B-14（前端最小步）回归：SopsPage
 *  ① 15s 轮询自动刷新——interval 注入（截获 15000ms 定时器回调后手动触发），
 *     标签页不可见时跳过本拍（对齐 ExecutionsPage / app-deployment-polling 先例）；
 *  ② 人工回复表单的修订正文（amendedBodyMarkdown）载荷——API 已支持，
 *     此前表单只给了 front-matter YAML 入口。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import '../i18n';
import SopsPage from '../pages/SopsPage';
import { sopsApi } from '../api/sops';
import type { Sop, SopAssignment, SopClarification } from '../api/sops';

vi.mock('../api/sops', () => ({
  sopsApi: {
    list: vi.fn(),
    get: vi.fn(),
    draft: vi.fn(),
    updateDraft: vi.fn(),
    publish: vi.fn(),
    deprecate: vi.fn(),
    restore: vi.fn(),
    cancelAssignments: vi.fn(),
    assign: vi.fn(),
    versions: vi.fn(),
    assignments: vi.fn(),
    assignment: vi.fn(),
    replyClarification: vi.fn(),
    listAssignableExecutors: vi.fn(),
    assignmentMedia: vi.fn(),
    viewMedia: vi.fn(),
  },
}));

// jsdom 缺失 antd 依赖的浏览器 API，先行补齐（对齐 app-deployment-polling 先例）
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

/** 真实 setInterval（截获 15s 轮询定时器时用于放行其它调用） */
const realSetInterval = globalThis.setInterval;

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
}

const sop: Sop = {
  id: 'sop-1',
  slug: 'demo',
  title: 'Demo SOP',
  status: 'published',
  currentVersion: '1.0.0',
  applicationId: null,
  frontMatterJson: {},
  bodyMarkdown: 'body',
  createdBy: 'tester',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

const assignment: SopAssignment = {
  id: 'asg-1',
  sopId: 'sop-1',
  sopVersion: '1.0.0',
  targetExecutorId: 'exec-1',
  targetAgentSessionId: null,
  status: 'in_progress',
  clarificationRound: 1,
  maxRounds: 5,
  resultJson: null,
  parentSessionId: null,
  pulledAt: '2026-01-01T01:00:00Z',
  lastProgressAt: null,
  progressJson: null,
  attempt: 1,
  lastReplyDeliveredAt: null,
  capabilitySnapshotJson: null,
  permissionProfileAtPull: null,
  assignedBy: 'tester',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T02:00:00Z',
};

const clarification: SopClarification = {
  id: 'clr-1',
  clientClarificationId: null,
  assignmentId: 'asg-1',
  round: 1,
  question: '第 3 步弹窗点不动',
  questionContextJson: null,
  answer: null,
  resolution: null,
  newSopVersion: null,
  mediaRefsJson: null,
  reviewSessionId: null,
  createdAt: '2026-01-01T01:30:00Z',
  updatedAt: '2026-01-01T01:30:00Z',
};

beforeEach(() => {
  setVisibility('visible');
  vi.mocked(sopsApi.list).mockReset().mockResolvedValue({ items: [sop], total: 1 });
  vi.mocked(sopsApi.versions).mockReset().mockResolvedValue([]);
  vi.mocked(sopsApi.assignments).mockReset().mockResolvedValue([assignment]);
  vi.mocked(sopsApi.assignment).mockReset().mockResolvedValue({
    assignment,
    clarifications: [clarification],
  });
  vi.mocked(sopsApi.assignmentMedia).mockReset().mockResolvedValue([]);
  vi.mocked(sopsApi.replyClarification).mockReset().mockResolvedValue({ ok: true });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (document as unknown as Record<string, unknown>).visibilityState;
});

describe('B-14 SopsPage 15s 轮询', () => {
  it('interval 注入：可见时每拍静默刷新；标签页隐藏时跳过本拍', async () => {
    const pollers: Array<() => void> = [];
    vi.spyOn(globalThis, 'setInterval').mockImplementation(((fn: () => void, delay?: number) => {
      if (delay === 15_000) {
        pollers.push(fn);
        return 0 as never;
      }
      return realSetInterval(fn as never, delay as never) as never;
    }) as never);

    render(
      <MemoryRouter>
        <SopsPage />
      </MemoryRouter>,
    );
    await waitFor(() => expect(sopsApi.list).toHaveBeenCalledTimes(1));

    // 可见：本拍触发一次静默刷新（不闪 loading，仅多一次请求）
    await act(async () => {
      pollers[0]();
    });
    await waitFor(() => expect(sopsApi.list).toHaveBeenCalledTimes(2));

    // 隐藏：跳过本拍
    setVisibility('hidden');
    await act(async () => {
      pollers[0]();
    });
    expect(sopsApi.list).toHaveBeenCalledTimes(2);
  });
});

describe('B-14 SopsPage 回复表单 bodyMarkdown', () => {
  it('sop_amended 时载荷携带 amendedBodyMarkdown（与 YAML 至少其一）', async () => {
    render(
      <MemoryRouter>
        <SopsPage />
      </MemoryRouter>,
    );

    // 打开详情抽屉 → 指派与澄清 tab（antd 两字按钮插空格：「详 情」）
    await screen.findByText('Demo SOP');
    fireEvent.click(screen.getByText('详 情'));
    await screen.findByText('指派与澄清');
    fireEvent.click(screen.getByText('指派与澄清'));

    // 待回复澄清出现「回复」按钮 → 打开回复弹窗（antd：「回 复」）
    await waitFor(() => expect(screen.getByText('回 复')).toBeTruthy());
    fireEvent.click(screen.getByText('回 复'));
    await waitFor(() => expect(screen.getByText('提交答复')).toBeTruthy());

    // 选择 sop_amended（antd v6 Select：mousedown 根节点展开下拉）
    const selectEl = document.querySelector('.ant-modal .ant-select') as HTMLElement;
    fireEvent.mouseDown(selectEl);
    const option = await screen.findByText('修订 SOP 并发新版本');
    fireEvent.click(option);

    // 弹窗内出现三个文本域：答复 / front-matter YAML / 修订正文
    await waitFor(() => expect(document.querySelectorAll('.ant-modal textarea').length).toBe(3));
    const textareas = document.querySelectorAll('.ant-modal textarea');
    fireEvent.change(textareas[0], { target: { value: '修订说明：补充了弹窗步骤' } });
    fireEvent.change(textareas[1], { target: { value: 'sop:\n  constraints:\n    maxDurationSec: 900' } });
    fireEvent.change(textareas[2], { target: { value: '## 修订后的正文' } });

    fireEvent.click(screen.getByText('提交答复'));
    await waitFor(() => expect(sopsApi.replyClarification).toHaveBeenCalledTimes(1));
    expect(sopsApi.replyClarification).toHaveBeenCalledWith('asg-1', 'clr-1', {
      resolution: 'sop_amended',
      answer: '修订说明：补充了弹窗步骤',
      amendedFrontMatterYaml: 'sop:\n  constraints:\n    maxDurationSec: 900',
      amendedBodyMarkdown: '## 修订后的正文',
    });
  });

  it('answered 时不携带修订字段（正文本域不出现）', async () => {
    render(
      <MemoryRouter>
        <SopsPage />
      </MemoryRouter>,
    );
    await screen.findByText('Demo SOP');
    fireEvent.click(screen.getByText('详 情'));
    await screen.findByText('指派与澄清');
    fireEvent.click(screen.getByText('指派与澄清'));
    await waitFor(() => expect(screen.getByText('回 复')).toBeTruthy());
    fireEvent.click(screen.getByText('回 复'));
    await waitFor(() => expect(screen.getByText('提交答复')).toBeTruthy());

    // 默认 resolution=answered：只有答复一个文本域
    expect(document.querySelectorAll('.ant-modal textarea').length).toBe(1);
    const textarea = document.querySelector('.ant-modal textarea') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '直接答复内容' } });

    fireEvent.click(screen.getByText('提交答复'));
    await waitFor(() => expect(sopsApi.replyClarification).toHaveBeenCalledTimes(1));
    expect(sopsApi.replyClarification).toHaveBeenCalledWith('asg-1', 'clr-1', {
      resolution: 'answered',
      answer: '直接答复内容',
    });
  });
});

// ─── 本轮 UX 打磨回归：首载失败错误态 + 新建草稿标题必填 ───────────────────
describe('SopsPage UX 边界（首载失败态 / 草稿标题必填）', () => {
  it('首次加载失败 → 页内 StateError + 重试成功后恢复，不再落「暂无数据」空表', async () => {
    vi.mocked(sopsApi.list)
      .mockReset()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValue({ items: [sop], total: 1 } as never);

    render(
      <MemoryRouter>
        <SopsPage />
      </MemoryRouter>,
    );

    // 失败如实呈现（StateError），而非空表把失败谎报成「没有 SOP」
    expect(await screen.findByTestId('state-error')).toBeTruthy();

    // 重试成功 → 错误块消失、数据正常渲染
    fireEvent.click(within(screen.getByTestId('state-error')).getByText('重试'));
    await screen.findByText('Demo SOP');
    expect(screen.queryByTestId('state-error')).toBeNull();
  });

  it('新建草稿：标题为空时先行拦截，不发 draft 请求（后端 title 无 @IsNotEmpty）', async () => {
    render(
      <MemoryRouter>
        <SopsPage />
      </MemoryRouter>,
    );
    await screen.findByText('Demo SOP');

    // 打开新建草稿弹窗
    fireEvent.click(screen.getByText('新建草稿'));
    await waitFor(() => expect(screen.getByText('保存草稿')).toBeTruthy());

    // 只填 slug（合法格式，通过 slug 校验），标题留空
    const slugInput = document.querySelector('.ant-modal input') as HTMLInputElement;
    fireEvent.change(slugInput, { target: { value: 'demo-sop' } });

    fireEvent.click(screen.getByText('保存草稿'));
    await waitFor(() => expect(screen.getByText('请填写标题')).toBeTruthy());
    expect(sopsApi.draft).not.toHaveBeenCalled();
  });

  // 2026-10-23：归档 / 恢复。此前 `deprecated` 是死状态——SOP 只增不减，
  // 测试残留（实测 16 条 headless-smoke-*）永远留在列表里。
  describe('归档 / 恢复（2026-10-23）', () => {
    const renderPage = () =>
      render(
        <MemoryRouter>
          <SopsPage />
        </MemoryRouter>,
      );

    it('已发布行显示「归档」，确认后调 deprecate 并刷新列表', async () => {
      vi.mocked(sopsApi.deprecate).mockReset().mockResolvedValue({
        ...sop,
        status: 'deprecated',
      } as Sop);
      renderPage();
      await screen.findByText('Demo SOP');

      fireEvent.click(await screen.findByTestId('sop-archive-demo'));
      await waitFor(() => expect(screen.getByText(/归档 SOP「demo」/)).toBeTruthy());
      // Popconfirm 的确认键是弹层里最后一个按钮
      const layerBtns = Array.from(
        document.querySelectorAll('.ant-popover button'),
      ) as HTMLButtonElement[];
      await act(async () => {
        fireEvent.click(layerBtns[layerBtns.length - 1]);
      });

      await waitFor(() => expect(sopsApi.deprecate).toHaveBeenCalledWith('sop-1'));
      // 成功后重新拉列表
      await waitFor(() => expect(vi.mocked(sopsApi.list).mock.calls.length).toBeGreaterThan(1));
    });

    it('已归档行显示「恢复」（不再显示归档），确认后调 restore', async () => {
      vi.mocked(sopsApi.list).mockResolvedValue({
        items: [{ ...sop, status: 'deprecated' } as Sop],
        total: 1,
      });
      vi.mocked(sopsApi.restore).mockReset().mockResolvedValue(sop);
      renderPage();
      await screen.findByText('Demo SOP');

      expect(screen.queryByTestId('sop-archive-demo')).toBeNull();
      fireEvent.click(await screen.findByTestId('sop-restore-demo'));
      await waitFor(() => expect(screen.getByText(/恢复 SOP「demo」/)).toBeTruthy());
      const layerBtns = Array.from(
        document.querySelectorAll('.ant-popover button'),
      ) as HTMLButtonElement[];
      await act(async () => {
        fireEvent.click(layerBtns[layerBtns.length - 1]);
      });
      await waitFor(() => expect(sopsApi.restore).toHaveBeenCalledWith('sop-1'));
    });

    it('归档被 409 拒绝（有未结束指派）→ 给出「取消指派并归档」二段确认', async () => {
      // 2026-10-23：`cancelled` 曾是零写入点的死状态，遇到 409 只能改库。
      // 现在 409 会转成可行动的二段确认：取消未结束指派 → 立即重试归档。
      vi.mocked(sopsApi.deprecate)
        .mockReset()
        .mockRejectedValueOnce(
          Object.assign(new Error('conflict'), {
            response: {
              data: {
                errorCode: 'SOP_ARCHIVE_HAS_ACTIVE_ASSIGNMENTS',
                params: { slug: 'demo', count: 1 },
                message: 'SOP demo 还有 1 个未结束的指派，先处理完再归档',
              },
            },
          }),
        )
        .mockResolvedValueOnce({ ...sop, status: 'deprecated' } as Sop);
      vi.mocked(sopsApi.cancelAssignments).mockReset().mockResolvedValue({ cancelled: 1 });

      renderPage();
      await screen.findByText('Demo SOP');

      fireEvent.click(await screen.findByTestId('sop-archive-demo'));
      await waitFor(() => expect(screen.getByText(/归档 SOP「demo」/)).toBeTruthy());
      const popBtns = Array.from(
        document.querySelectorAll('.ant-popover button'),
      ) as HTMLButtonElement[];
      await act(async () => {
        fireEvent.click(popBtns[popBtns.length - 1]);
      });

      // 二段确认出现（Modal.confirm 的标题写明未结束指派）
      await waitFor(() =>
        expect(document.body.textContent).toContain('还有未结束的指派'),
      );
      const confirmBtns = Array.from(
        document.querySelectorAll('.ant-modal-confirm-btns button'),
      ) as HTMLButtonElement[];
      await act(async () => {
        fireEvent.click(confirmBtns[confirmBtns.length - 1]);
      });

      await waitFor(() =>
        expect(sopsApi.cancelAssignments).toHaveBeenCalledWith('sop-1'),
      );
      // 取消后自动重试归档（用户上一步的意图不丢）
      await waitFor(() => expect(sopsApi.deprecate).toHaveBeenCalledTimes(2));
    });

    it('409 确认框提供「先查看未结束指派」→ 关闭后抽屉落到「指派」Tab', async () => {
      vi.mocked(sopsApi.deprecate)
        .mockReset()
        .mockRejectedValue(
          Object.assign(new Error('conflict'), {
            response: {
              data: {
                errorCode: 'SOP_ARCHIVE_HAS_ACTIVE_ASSIGNMENTS',
                params: { slug: 'demo', count: 1 },
                message: '还有 1 个未结束的指派',
              },
            },
          }),
        );
      renderPage();
      await screen.findByText('Demo SOP');

      fireEvent.click(await screen.findByTestId('sop-archive-demo'));
      await waitFor(() => expect(screen.getByText(/归档 SOP「demo」/)).toBeTruthy());
      const popBtns = Array.from(document.querySelectorAll('.ant-popover button')) as HTMLButtonElement[];
      await act(async () => {
        fireEvent.click(popBtns[popBtns.length - 1]);
      });

      // 二段确认里出现「先查看未结束的指派」
      const viewBtn = await screen.findByText('先查看未结束的指派');
      await act(async () => {
        fireEvent.click(viewBtn);
      });

      // 抽屉打开且停在「指派」Tab（该 Tab 的表格才会渲染指派 id）
      await waitFor(() => expect(screen.getAllByText(/指派|工单/).length).toBeGreaterThan(0));
      // 关键证据：assignments 接口被调用（只有打开详情才会拉）
      expect(sopsApi.assignments).toHaveBeenCalledWith('sop-1');
      // 且没有误触发取消
      expect(sopsApi.cancelAssignments).not.toHaveBeenCalled();
    });
  });
});
