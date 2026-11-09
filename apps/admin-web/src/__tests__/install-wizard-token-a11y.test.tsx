/**
 * R151（F5）：安装向导「共享 Token 显示/隐藏」按钮的**可访问名**（DOM 层）。
 *
 * ## 为什么专门守这一处
 *
 * 全仓 icon-only `<Button>` 里，这一处此前是**唯一**没有可访问名的
 * （其余要么在 `Form.Item` 下有 `label`，要么自带 `aria-label`）。
 * icon-only 且无名 ⇒ 读屏用户听到的只有「按钮」，不知道它做什么、也不知道
 * 点下去会发生什么（显示还是隐藏）。
 *
 * 它偏偏出现在**安装流程的关键令牌卡片**上（令牌是 `EXECUTOR_SHARED_TOKEN`，
 * 泄露风险面），所以这条不是形式主义。
 *
 * ## 判据（两条，都必须过）
 *
 * ① 按钮**有可访问名**且名称**随状态联动**：初始是「显示共享 Token」（因为此时
 *    token 是隐藏态），点一下之后变成「隐藏共享 Token」——读屏用户听到的是
 *    **马上要发生什么**，而不是一个静态标签。
 * ② 同一屏里**不能有第二个无名 icon-only 按钮**（本测试顺带把「该文件的 icon-only
 *    控件都可用名字定位」这条钉住：复制按钮有文字 `install.copy`，故也能按名定位）。
 *
 * ## 为什么走真渲染而不是读源码文本
 *
 * 「有没有可访问名」是**渲染后**的属性（`aria-label` 可能来自 props、i18n 或
 * 包装组件），读源码文本只能证明「写了这几个字符」，证明不了 DOM 上确实有名字。
 * 本仓 `check:source-text-contracts` 也要求这类断言必须登记 —— 真渲染测试不需要。
 *
 * ## 交互形态备注（antd v6 的 Select）
 *
 * 走到第 2 步要先在第 1 步选一个安装包（类型 Select）。antd v6 里下拉的 combobox
 * 输入在 `.ant-select-content` 里（不是 v5 的 `.ant-select-selector`），选项挂在
 * body portal 的 `.ant-select-item-option`；本步有**两个** Select（类型 / 平台）
 * ⇒ 用 `getAllByRole('combobox')` 取第一个。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../api/executors', () => ({
  executorsApi: {
    list: vi.fn().mockResolvedValue([]),
    getGroups: vi.fn(),
    getTags: vi.fn(),
    installCommand: vi.fn(),
  },
}));
vi.mock('../api/executor-packages', () => ({
  executorPackagesApi: {
    list: vi.fn().mockResolvedValue([]),
    listLatest: vi.fn(),
    get: vi.fn(),
    download: vi.fn(),
  },
}));
vi.mock('../api/config', () => ({
  configApi: {
    getExecutorToken: vi.fn(),
  },
}));

const mockNavigate = vi.fn();
vi.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
  useParams: () => ({}),
  useSearchParams: () => [new URLSearchParams('')],
  Link: (props: { to: string; children: React.ReactNode }) => <a href={props.to}>{props.children}</a>,
}));

const g = globalThis as Record<string, unknown>;
if (!g.ResizeObserver) {
  g.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
}
if (!window.matchMedia) {
  window.matchMedia = ((q: string) => ({
    matches: false, media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

import ExecutorInstallWizardPage from '../pages/ExecutorInstallWizardPage';
import { executorPackagesApi } from '../api/executor-packages';
import { configApi } from '../api/config';

/** 一个足以让第 1 步「下一步」可点的安装包（字段照 ExecutorPackage 的必需项）。 */
const PKG = {
  id: 'p1',
  name: 'pkg-node-linux',
  version: '1.0.0',
  type: 'node' as const,
  platform: 'linux',
  fileSize: 1024,
  checksum: 'abc',
  changelog: '',
  downloadUrl: '/x',
  createdAt: '2026-01-01T00:00:00.000Z',
};

beforeEach(() => {
  mockNavigate.mockClear();
  vi.mocked(executorPackagesApi.listLatest).mockResolvedValue([PKG] as never);
  vi.mocked(configApi.getExecutorToken).mockResolvedValue({ token: 'secret-token' } as never);
});

afterEach(() => cleanup());

/**
 * 走到第 2 步（共享 Token 卡）。
 *
 * 路径：第 0 步「下一步」→ 第 1 步选类型（antd Select：mousedown 打开 → 点选项）
 * → 「下一步」（触发 fetchSharedToken）→ 第 2 步。
 */
async function gotoTokenStep() {
  render(<ExecutorInstallWizardPage />);

  const next0 = await screen.findByRole('button', { name: /下一步|Next/ });
  fireEvent.click(next0);

  // 第 1 步：打开「类型」下拉并选中第一项。
  const combos = await screen.findAllByRole('combobox');
  fireEvent.mouseDown(combos[0]);
  const options = await waitFor(() => {
    const all = Array.from(document.querySelectorAll('.ant-select-item-option'));
    expect(all.length).toBeGreaterThan(0);
    return all;
  });
  fireEvent.click(options[0]);

  // 「下一步」此时应可点（matchedPackage 已就绪）。
  // ⚠️ 必须在 waitFor **外**点一次：waitFor 的回调会被重试多次，每次都点会
  // 把向导一路推进到后面的步骤去（下一步在第 2 步也是同一个按钮名）。
  const nextBtn = await waitFor(() => {
    const buttons = screen.getAllByRole('button', { name: /下一步|Next/ });
    const enabled = buttons.find((b) => !(b as HTMLButtonElement).disabled);
    expect(enabled).toBeTruthy();
    return enabled as HTMLElement;
  });
  fireEvent.click(nextBtn);

  // 第 2 步：等共享 Token 卡片渲染出来（token 到位后掩码输入框才出现）。
  // ⚠️ 掩码是 `<Input value="•••">` 的**属性**，不是文本节点 ⇒ 不能用
  // findByText 找「•」；判据改用本步骤真正要守的那个按钮的可访问名。
  await screen.findByRole('button', { name: /显示共享 Token|Show shared Token/ });
}

describe('R151/F5：共享 Token 显示/隐藏按钮必须有可访问名', () => {
  it('① 初始可访问名是「显示共享 Token」，点一下变「隐藏共享 Token」', async () => {
    await gotoTokenStep();

    // 初始是隐藏态 ⇒ 名称应表达「点下去会显示」
    const showBtn = await screen.findByRole('button', { name: /显示共享 Token|Show shared Token/ });

    fireEvent.click(showBtn);

    // 切换后名称必须跟着变（否则读屏用户会听到与实际动作不符的标签）
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /隐藏共享 Token|Hide shared Token/ })).toBeTruthy();
    });
    // 旧的名称必须消失（不能两个名字同时命中同一个按钮）
    expect(screen.queryByRole('button', { name: /显示共享 Token|Show shared Token/ })).toBeNull();
  });

  it('② 该屏所有 icon-only 按钮都能用「可访问名」定位（不留无名按钮）', async () => {
    await gotoTokenStep();

    // 显示/隐藏按钮靠 aria-label（初始隐藏态 ⇒ 名称是「显示共享 Token」）。
    const showBtn = await screen.findByRole('button', { name: /显示共享 Token|Show shared Token/ });
    expect(showBtn).toBeTruthy();

    // 切到明文态 ⇒ 复制按钮出现（它是「图标 + 文字」，按名可定位）。
    fireEvent.click(showBtn);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /复制|Copy/ })).toBeTruthy();
    });

    // 反向断言：该卡片里不得存在「既无文字、又无 aria-label/title」的 <button>。
    const buttons = Array.from(document.querySelectorAll('button'));
    const unnamed = buttons.filter((b) => {
      const hasText = (b.textContent ?? '').trim().length > 0;
      const hasAria = b.hasAttribute('aria-label') && (b.getAttribute('aria-label') ?? '').trim().length > 0;
      const hasTitle = b.hasAttribute('title') && (b.getAttribute('title') ?? '').trim().length > 0;
      const hasLabelledBy = b.hasAttribute('aria-labelledby');
      return !hasText && !hasAria && !hasTitle && !hasLabelledBy;
    });
    expect(unnamed.map((b) => b.outerHTML.slice(0, 120))).toEqual([]);
  });
});
