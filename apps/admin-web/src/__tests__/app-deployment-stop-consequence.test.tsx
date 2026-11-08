/**
 * R171（P2-4）：「确认停止？」必须写**后果**，不是问「你确定吗」。
 *
 * ## 缺陷现场（`AppDeploymentPage` 行内「停止」Popconfirm）
 *
 * `title={t('appDeploy.op.stopConfirm')}` 的原文案是「确认停止？」/「Confirm stop?」——
 * 它只复述了用户刚点的按钮，没有一句说明停止意味着什么。而在这个动作上：
 *
 *   · 执行器上该应用的进程被终止，**正在处理的请求随之中断**；
 *   · 记录转为「已停止」，**没有自动重启**，要恢复只能**重新部署**；
 *   · stop 是 best-effort：执行器不可达时平台仍标记已停止，设备上的进程可能还在跑。
 *
 * 三条都是「点下去之后才知道」的事实，而这一步不可撤销（进程已经没了）。
 *
 * ## 本 spec 钉住三条
 *
 * ① 确认框正文含**后果**（重新部署才能恢复 / 不会自动重启 / 请求中断 / 送达边界）；
 * ② 旧文案「确认停止？」不再出现在界面上（避免只改了一处）；
 * ③ zh + en **成对**：两个语言都换了文案，且都不是旧文案（禁硬编码、禁单边）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import AppDeploymentPage from '../pages/AppDeploymentPage';
import { deploymentsApi } from '../api/applications';
import { executorsApi } from '../api/executors';
import { useAuthStore } from '../store/auth';

vi.mock('../api/applications', () => ({
  deploymentsApi: {
    list: vi.fn(),
    deploy: vi.fn(),
    stop: vi.fn(),
    upgrade: vi.fn(),
    remove: vi.fn(),
    approve: vi.fn(),
    reject: vi.fn(),
    cancel: vi.fn(),
  },
  applicationsApi: { upgradeAll: vi.fn() },
}));
vi.mock('../api/executors', () => ({
  executorsApi: { list: vi.fn(), picker: vi.fn() },
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

const dep = (overrides: Record<string, unknown> = {}) => ({
  id: 'dep-1',
  applicationId: 'app-1',
  executorAddress: 'executor-a:3001',
  status: 'running',
  runMode: 'daemon',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  ...overrides,
});

const mockList = (data: ReturnType<typeof dep>[], total = data.length) => {
  vi.mocked(deploymentsApi.list).mockReset().mockResolvedValue({ data, total } as never);
};

/** 表格行内按钮：antd 会给双汉字按钮插空格，文本需归一化。 */
const findRowBtn = (label: string) =>
  Array.from(document.body.querySelectorAll('.ant-table button')).find(
    (b) => (b.textContent ?? '').replace(/\s/g, '') === label,
  ) as HTMLButtonElement | undefined;

const findPopconfirmBtn = (label: string) =>
  Array.from(document.body.querySelectorAll('.ant-popconfirm button')).find(
    (b) => (b.textContent ?? '').replace(/\s/g, '') === label,
  ) as HTMLButtonElement | undefined;

const readLocale = async (rel: string) => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  return fs.readFileSync(path.resolve(process.cwd(), rel), 'utf8');
};

beforeEach(() => {
  cleanup();
  useAuthStore.setState({ user: { id: 1, username: 'bob', role: 'admin' } });
  vi.mocked(executorsApi.picker).mockReset().mockResolvedValue({ items: [], total: 0, truncated: false, limit: 2000 } as never);
  vi.mocked(deploymentsApi.stop).mockReset().mockResolvedValue({ id: 'dep-1', status: 'stopped' } as never);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('R171 P2-4：停止确认必须说明后果', () => {
  it('① 确认框正文写清「进程终止 / 请求中断 / 只能重新部署恢复 / 执行器不可达仍在跑」', async () => {
    mockList([dep({ status: 'running' })]);
    render(<AppDeploymentPage applicationId="app-1" />);

    const stopBtn = await waitFor(() => {
      const b = findRowBtn('停止');
      expect(b).toBeTruthy();
      return b as HTMLButtonElement;
    });
    fireEvent.click(stopBtn);

    // 标题不再是「确认停止？」而是点明「停的是这台设备上的实例」
    await waitFor(() => expect(screen.getByText('停止这台设备上的应用实例？')).toBeTruthy());

    // 后果四要素
    const body = document.body.textContent ?? '';
    expect(body).toMatch(/进程会被终止/);
    expect(body).toMatch(/请求随之中断/);
    expect(body).toMatch(/只能重新部署/);
    expect(body).toMatch(/不会自动重启/);
    expect(body).toMatch(/执行器不可达/);

    // 旧文案不得残留
    expect(screen.queryByText('确认停止？')).toBeNull();

    // 确认仍然真的调 stop（提示变长不代表动作变样）
    fireEvent.click(findPopconfirmBtn('停止') as HTMLButtonElement);
    await waitFor(() => expect(deploymentsApi.stop).toHaveBeenCalledWith('dep-1'));
  });

  it('② zh + en 成对：两种语言都不是旧文案，且都写明后果', async () => {
    const zh = await readLocale('src/locales/zh.ts');
    const en = await readLocale('src/locales/en.ts');

    expect(zh).not.toContain("'appDeploy.op.stopConfirm': '确认停止？'");
    expect(en).not.toContain("'appDeploy.op.stopConfirm': 'Confirm stop?'");

    const zhTitle = zh.match(/'appDeploy\.op\.stopConfirm':\s*\n?\s*'([^']+)'/)?.[1] ?? '';
    const enTitle = en.match(/'appDeploy\.op\.stopConfirm':\s*\n?\s*'([^']+)'/)?.[1] ?? '';
    const zhDesc = zh.match(/'appDeploy\.op\.stopConsequence':\s*\n?\s*'([^']+)'/)?.[1] ?? '';
    const enDesc = en.match(/'appDeploy\.op\.stopConsequence':\s*\n?\s*'([^']+)'/)?.[1] ?? '';

    expect(zhTitle.length).toBeGreaterThan(0);
    expect(enTitle.length).toBeGreaterThan(0);
    // 后果文案 zh/en 都要在，且各自写清「重新部署」这条恢复路径
    expect(zhDesc).toMatch(/重新部署/);
    expect(enDesc).toMatch(/redeploy/i);
    // 送达边界（best-effort）两边都不得漏
    expect(zhDesc).toMatch(/不可达/);
    expect(enDesc).toMatch(/unreachable/i);
    // 不是同一串（防「en 里抄了中文」这类假成对）
    expect(zhDesc).not.toBe(enDesc);
  });
});
