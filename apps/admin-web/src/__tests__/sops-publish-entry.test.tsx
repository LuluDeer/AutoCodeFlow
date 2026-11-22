/**
 * SOP-PUBLISH-UI-01（P1 审计）+ P3-⑤（发布者显示）回归：
 *
 *  1) 发布入口——后端 `POST /sop/:id/publish` 早已存在，但 sopsApi.publish 在
 *     本仓零调用方：UI 创建的 SOP 永远无法发布。本组用例钉住新入口的完整链路：
 *     详情抽屉「发布」→ 确认弹窗（bump + changelog）→ 确认后调 publish →
 *     列表与详情刷新。
 *  2) 门控——已归档（deprecated）不显示发布入口（走「恢复」）；工作副本缺
 *     front-matter/正文时按钮禁用（后端必 400 SOP_CONTENT_MISSING）。
 *  3) P3-⑤——版本历史发布者列：后端 publishedBy 存主体标识且响应不带用户名，
 *     `user:<id>`（人工，恒 ADMIN）显示中性文案「管理员」；`agent:tool-call`
 *     （代理标识，本身可读）原样保留；空值回落 '—'。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import '../i18n';
import SopsPage from '../pages/SopsPage';
import { sopsApi } from '../api/sops';
import type { Sop, SopVersion } from '../api/sops';

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

// jsdom 缺失 antd 依赖的浏览器 API（sops-page-b14 先例 shim）
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

const versionRow = (over: Partial<SopVersion> = {}): SopVersion => ({
  id: 'ver-1',
  sopId: 'sop-1',
  version: '1.0.0',
  frontMatterJson: {},
  bodyMarkdown: 'body',
  changelog: null,
  contentHash: 'abcdef1234567890abcdef1234567890',
  publishedBy: 'user:1',
  publishedAt: '2026-01-01T00:00:00Z',
  createdAt: '2026-01-01T00:00:00Z',
  ...over,
});

const renderPage = () =>
  render(
    <MemoryRouter>
      <SopsPage />
    </MemoryRouter>,
  );

/** 打开指定 SOP 的详情抽屉（列表行「详情」按钮，antd 双字插空格「详 情」） */
async function openDetail(slug: string) {
  await screen.findByText(slug);
  fireEvent.click(screen.getByText('详 情'));
  await waitFor(() => expect(sopsApi.versions).toHaveBeenCalledWith('sop-1'));
}

beforeEach(() => {
  vi.mocked(sopsApi.list).mockReset().mockResolvedValue({ items: [sop], total: 1 });
  vi.mocked(sopsApi.versions).mockReset().mockResolvedValue([
    versionRow(),
    versionRow({ id: 'ver-2', version: '0.9.0', publishedBy: 'agent:tool-call' }),
    versionRow({ id: 'ver-3', version: '0.8.0', publishedBy: '' }),
  ]);
  vi.mocked(sopsApi.assignments).mockReset().mockResolvedValue([]);
  vi.mocked(sopsApi.assignment).mockReset().mockResolvedValue({ assignment: {} as never, clarifications: [] });
  vi.mocked(sopsApi.assignmentMedia).mockReset().mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('SOP-PUBLISH-UI-01 发布入口', () => {
  it('点击「发布」→ 确认弹窗（含 bump 与 changelog）→ 确认后调 publish 并刷新列表/详情', async () => {
    vi.mocked(sopsApi.publish).mockReset().mockResolvedValue({
      sop: { ...sop, status: 'published', currentVersion: '1.0.1' },
      version: versionRow({ id: 'ver-4', version: '1.0.1', changelog: '修复了第 3 步' }),
    });
    renderPage();
    await openDetail('demo');

    // 详情抽屉出现发布入口（testid 带 slug），点击打开确认弹窗
    fireEvent.click(screen.getByTestId('sop-publish-demo'));
    expect(await screen.findByText('发布 SOP「demo」')).toBeTruthy();

    // 弹窗含版本档位 Select（默认 patch）与 changelog 文本域
    expect(document.querySelector('.ant-modal .ant-select')).toBeTruthy();
    const changelog = document.querySelector('.ant-modal textarea') as HTMLTextAreaElement;
    fireEvent.change(changelog, { target: { value: '修复了第 3 步' } });

    // 确认发布 → 调 publish（bump=patch + changelog），随后刷新列表与详情
    fireEvent.click(screen.getByText('确认发布'));
    await waitFor(() =>
      expect(sopsApi.publish).toHaveBeenCalledWith('sop-1', {
        bump: 'patch',
        changelog: '修复了第 3 步',
      }),
    );
    // 成功后列表重拉 + 抽屉详情用发布返回的最新 sop 重开（versions 再次拉取）。
    // 注：不再断言「弹窗 DOM 消失/loading 清除」——antd Modal 关闭走 rc-motion
    // 退场动画，jsdom 无 transition 事件会冻结在最后一帧，这是测试环境产物
    // （真实浏览器正常关闭）；publish 调用与列表/详情刷新才是本页的契约。
    await waitFor(() => expect(vi.mocked(sopsApi.list).mock.calls.length).toBeGreaterThan(1));
    await waitFor(() => expect(vi.mocked(sopsApi.versions).mock.calls.length).toBeGreaterThan(1));
    expect(sopsApi.publish).toHaveBeenCalledTimes(1);
  });

  it('changelog 留空 → 不发 changelog 字段（后端落 null）', async () => {
    vi.mocked(sopsApi.publish).mockReset().mockResolvedValue({
      sop: { ...sop, currentVersion: '1.0.1' },
      version: versionRow({ id: 'ver-4', version: '1.0.1' }),
    });
    renderPage();
    await openDetail('demo');

    fireEvent.click(screen.getByTestId('sop-publish-demo'));
    await screen.findByText('发布 SOP「demo」');
    fireEvent.click(screen.getByText('确认发布'));

    await waitFor(() =>
      expect(sopsApi.publish).toHaveBeenCalledWith('sop-1', { bump: 'patch', changelog: undefined }),
    );
  });

  it('已归档（deprecated）行：抽屉不显示发布入口（恢复路径负责回到可发布态）', async () => {
    vi.mocked(sopsApi.list).mockResolvedValue({
      items: [{ ...sop, status: 'deprecated' } as Sop],
      total: 1,
    });
    renderPage();
    await openDetail('demo');

    // 抽屉已打开（Tab 标签渲染；deprecated 行的操作列是「恢复」而非「归档」）
    await screen.findByText('版本历史');
    expect(screen.queryByTestId('sop-publish-demo')).toBeNull();
    // 草稿内容编辑入口只对 draft 工作副本开放
    expect(screen.queryByTestId('sop-edit-draft-demo')).toBeNull();
  });

  it('工作副本缺 front-matter/正文 → 发布按钮禁用（后端必 400 SOP_CONTENT_MISSING）', async () => {
    vi.mocked(sopsApi.list).mockResolvedValue({
      items: [{ ...sop, frontMatterJson: null, bodyMarkdown: null } as Sop],
      total: 1,
    });
    renderPage();
    await openDetail('demo');

    const btn = await screen.findByTestId('sop-publish-demo');
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });

  it('发布失败（内容未变更 400）→ 错误 toast 透出后端口径，弹窗不误关成假成功', async () => {
    vi.mocked(sopsApi.publish).mockReset().mockRejectedValue(
      Object.assign(new Error('unchanged'), {
        response: {
          data: {
            errorCode: 'SOP_CONTENT_UNCHANGED',
            message: '内容与当前版本完全一致，修订必须真的改了什么',
          },
        },
      }),
    );
    renderPage();
    await openDetail('demo');

    fireEvent.click(screen.getByTestId('sop-publish-demo'));
    await screen.findByText('发布 SOP「demo」');
    fireEvent.click(screen.getByText('确认发布'));

    await waitFor(() => expect(sopsApi.publish).toHaveBeenCalledTimes(1));
    // 后端 message 透出（getErrMsg 三级降级：无 err.<CODE> 词条时回落 message）
    expect(await screen.findByText(/内容与当前版本完全一致/)).toBeTruthy();
    // 弹窗保持打开，用户可修正后再试
    expect(screen.getByText('发布 SOP「demo」')).toBeTruthy();
  });
});

describe('SOP-DRAFT-EDIT-UI 草稿内容编辑（空正文草稿可救回）', () => {
  const emptyDraft: Sop = {
    ...sop,
    slug: 'empty-draft',
    status: 'draft',
    title: 'Empty Draft',
    frontMatterJson: null,
    bodyMarkdown: null,
  };

  function openEditModal() {
    fireEvent.click(screen.getByTestId('sop-edit-draft-empty-draft'));
    return screen.findByText('编辑草稿「empty-draft」');
  }

  it('空正文草稿 → 详情编辑并保存 → updateDraft 调用 → 刷新后发布按钮可用', async () => {
    const updated: Sop = {
      ...emptyDraft,
      frontMatterJson: { acceptance: [] },
      bodyMarkdown: '# 正文',
    };
    vi.mocked(sopsApi.list).mockResolvedValue({ items: [emptyDraft], total: 1 });
    vi.mocked(sopsApi.updateDraft).mockReset().mockResolvedValue(updated);
    renderPage();
    await openDetail('empty-draft');

    // 前置缺陷复现：空 front-matter/正文 → 发布按钮禁用（此前无编辑入口，永久卡死）
    expect((await screen.findByTestId('sop-publish-empty-draft') as HTMLButtonElement).disabled).toBe(true);

    await openEditModal();
    // 预填：标题来自草稿，空契约/正文留空给用户填
    expect((document.getElementById('sops-edit-draft-title') as HTMLInputElement).value).toBe('Empty Draft');
    expect((document.getElementById('sops-edit-draft-front-matter') as HTMLTextAreaElement).value).toBe('');
    expect((document.getElementById('sops-edit-draft-body') as HTMLTextAreaElement).value).toBe('');

    fireEvent.change(document.getElementById('sops-edit-draft-front-matter')!, {
      target: { value: 'acceptance: []' },
    });
    fireEvent.change(document.getElementById('sops-edit-draft-body')!, { target: { value: '# 正文' } });
    fireEvent.click(document.getElementById('sops-edit-draft-save')!);

    await waitFor(() =>
      expect(sopsApi.updateDraft).toHaveBeenCalledWith('sop-1', {
        title: 'Empty Draft',
        frontMatterYaml: 'acceptance: []',
        bodyMarkdown: '# 正文',
      }),
    );
    // 成功后详情用返回值重开、列表重拉：发布门控从禁用转可用
    await waitFor(() =>
      expect((screen.getByTestId('sop-publish-empty-draft') as HTMLButtonElement).disabled).toBe(false),
    );
    await waitFor(() => expect(vi.mocked(sopsApi.list).mock.calls.length).toBeGreaterThan(1));
    expect(sopsApi.updateDraft).toHaveBeenCalledTimes(1);
  });

  it('空草稿只填正文 → frontMatterYaml 传 undefined（空串会被后端判内容为空），保存成功且列表刷新', async () => {
    vi.mocked(sopsApi.list).mockResolvedValue({ items: [emptyDraft], total: 1 });
    vi.mocked(sopsApi.updateDraft).mockReset().mockResolvedValue({ ...emptyDraft, bodyMarkdown: '# 只有正文' });
    renderPage();
    await openDetail('empty-draft');
    await openEditModal();

    fireEvent.change(document.getElementById('sops-edit-draft-body')!, { target: { value: '# 只有正文' } });
    fireEvent.click(document.getElementById('sops-edit-draft-save')!);

    await waitFor(() =>
      expect(sopsApi.updateDraft).toHaveBeenCalledWith('sop-1', {
        title: 'Empty Draft',
        frontMatterYaml: undefined,
        bodyMarkdown: '# 只有正文',
      }),
    );
    expect(await screen.findByText('草稿内容已保存')).toBeTruthy();
    await waitFor(() => expect(vi.mocked(sopsApi.list).mock.calls.length).toBeGreaterThan(1));
    // 契约仍为空 → 发布门控如实保持禁用（部分保存不等于补齐内容）
    expect((screen.getByTestId('sop-publish-empty-draft') as HTMLButtonElement).disabled).toBe(true);
  });

  it('非空 frontMatterJson → YAML 预填；清空契约只补正文 → 不覆盖契约，刷新后发布按钮可用', async () => {
    const withFrontMatter: Sop = { ...emptyDraft, frontMatterJson: { acceptance: [] } };
    vi.mocked(sopsApi.list).mockResolvedValue({ items: [withFrontMatter], total: 1 });
    vi.mocked(sopsApi.updateDraft).mockReset().mockResolvedValue({
      ...withFrontMatter,
      bodyMarkdown: '# 补正文',
    });
    renderPage();
    await openDetail('empty-draft');
    await openEditModal();

    // dump 分支：JSON 契约被序列化成 YAML 文本回填
    expect((document.getElementById('sops-edit-draft-front-matter') as HTMLTextAreaElement).value).toBe('acceptance: []');
    // 用户只补正文：把契约框清空也不该把空串发给后端（保留既有契约）
    fireEvent.change(document.getElementById('sops-edit-draft-front-matter')!, { target: { value: '' } });
    fireEvent.change(document.getElementById('sops-edit-draft-body')!, { target: { value: '# 补正文' } });
    fireEvent.click(document.getElementById('sops-edit-draft-save')!);

    await waitFor(() =>
      expect(sopsApi.updateDraft).toHaveBeenCalledWith('sop-1', {
        title: 'Empty Draft',
        frontMatterYaml: undefined,
        bodyMarkdown: '# 补正文',
      }),
    );
    await waitFor(() =>
      expect((screen.getByTestId('sop-publish-empty-draft') as HTMLButtonElement).disabled).toBe(false),
    );
  });

  it('保存失败 → showApiError 透出错误且弹窗不关、表单不丢', async () => {
    vi.mocked(sopsApi.list).mockResolvedValue({ items: [emptyDraft], total: 1 });
    vi.mocked(sopsApi.updateDraft).mockReset().mockRejectedValue(new Error('保存被后端拒绝'));
    renderPage();
    await openDetail('empty-draft');
    await openEditModal();

    const frontMatter = document.getElementById('sops-edit-draft-front-matter')!;
    fireEvent.change(frontMatter, { target: { value: 'acceptance: []' } });
    fireEvent.click(document.getElementById('sops-edit-draft-save')!);

    expect(await screen.findByText('保存被后端拒绝')).toBeTruthy();
    // 不丢表单：原样保留用户输入，弹窗仍在
    expect((document.getElementById('sops-edit-draft-front-matter') as HTMLTextAreaElement).value).toBe('acceptance: []');
    expect(screen.getByText('编辑草稿「empty-draft」')).toBeTruthy();
  });
});

describe('P3-⑤ 版本历史发布者显示', () => {
  it('user:<id> 显示中性文案「管理员」；agent:tool-call 原样；空值回落 —', async () => {
    renderPage();
    await openDetail('demo');

    // 版本历史 Tab（antd 双字插空格：表格单元格文本不走按钮插空格，直接匹配）
    fireEvent.click(screen.getByText('版本历史'));
    await waitFor(() => expect(screen.getAllByText('管理员').length).toBe(1));
    expect(screen.getByText('agent:tool-call')).toBeTruthy();
    // 空发布者 → 占位符
    expect(screen.getByText('—')).toBeTruthy();
    // 内部 ID user:1 不再裸渲染
    expect(screen.queryByText('user:1')).toBeNull();
  });
});
