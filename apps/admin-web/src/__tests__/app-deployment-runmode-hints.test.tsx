/**
 * 生产反馈回归：应用部署的「模式」没有任何说明。
 *
 * 用户原话：「这个部署是部署应用，为什么要管什么模式呢 不太懂，可能你是想常驻
 * 任务，但是其他 2 个选项 任务调度里 创建任务不是也能进行对应的配置吗？」
 *
 * 这个困惑本身是产品缺陷的信号：三个模式当时既没有 UI 说明，实现上「单次」与
 * 「常驻」还完全等价（executor-node deploy.ts 的 runMode 形参零引用）。修复分
 * 两部分——实现侧让 daemon 真正常驻（见 deploy-restart.spec.ts），UI 侧把每个
 * 模式的行为写清楚，尤其是「定时」= 只下发代码不启动进程。
 *
 * 本测试钉住 UI 说明的存在性与语义，避免以后又被删回"三个没有解释的按钮"。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import { deploymentsApi } from '../api/applications';
import { executorsApi } from '../api/executors';
import { useAuthStore } from '../store/auth';

vi.mock('../api/applications', () => ({
  deploymentsApi: { list: vi.fn(), deploy: vi.fn(), stop: vi.fn(), upgrade: vi.fn() },
  applicationsApi: { upgradeAll: vi.fn() },
}));
vi.mock('../api/executors', () => ({
  executorsApi: { list: vi.fn() },
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

const onlineExecutor = {
  id: 'exec-1',
  name: 'exec-1',
  address: '203.0.113.10:3002',
  status: 'online',
  runtime: 'node',
  tags: [],
  runtimes: ['node'],
  lastHeartbeat: new Date().toISOString(),
};

describe('AppDeploymentPage：部署模式的说明文案（生产反馈回归）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAuthStore.setState({
      user: { id: 1, username: 'admin', role: 'admin' } as never,
      token: 't',
    } as never);
    (deploymentsApi.list as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (executorsApi.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      onlineExecutor,
    ]);
  });

  afterEach(() => {
    cleanup();
  });

  it('语言包里三个模式都有说明键，且「定时」明确写了不启动进程', async () => {
    const zh = (await import('../locales/zh')).default as Record<string, string>;
    const en = (await import('../locales/en')).default as Record<string, string>;

    for (const dict of [zh, en]) {
      expect(dict['appDeploy.mode.hint']).toBeTruthy();
      expect(dict['appDeploy.mode.hintDaemon']).toBeTruthy();
      expect(dict['appDeploy.mode.hintScheduled']).toBeTruthy();
      expect(dict['appDeploy.redeploy.reuseHint']).toBeTruthy();
    }

    // 「定时」必须说清"只下发代码/不启动进程"——这正是用户困惑的核心
    expect(zh['appDeploy.mode.hintScheduled']).toMatch(/不启动|只下发/);
    expect(en['appDeploy.mode.hintScheduled']).toMatch(/no process|not start/i);
    // 「常驻」必须说清会自动重启
    expect(zh['appDeploy.mode.hintDaemon']).toMatch(/自动重启/);
    expect(en['appDeploy.mode.hintDaemon']).toMatch(/auto-restart/i);
  });

  /**
   * 源码守卫：三个模式的说明必须真的挂在 runMode 字段/按钮上。
   *
   * 只断言语言键存在是不够的——键可以存在却没有任何控件引用它（这正是
   * "三个没有解释的按钮"当初的形态）。这里直接读页面源码钉住接线。
   */
  it('页面源码把说明接到了 runMode 字段与重新部署按钮上', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    // jsdom 环境下 import.meta.url 不是 file: scheme，故用 cwd（vitest 以包根为
    // cwd 运行）拼绝对路径。
    const pageSrc = await fs.readFile(
      path.resolve(process.cwd(), 'src/pages/AppDeploymentPage.tsx'),
      'utf-8',
    );
    // P1-15：runMode 字段 + 模式说明抽到共享组件 DeployModeFields（两页复用），
    // 故接线守卫改查组件源码；redeploy 按钮的 tooltip 仍在详情页源码里。
    const fieldsSrc = await fs.readFile(
      path.resolve(process.cwd(), 'src/components/DeployModeFields.tsx'),
      'utf-8',
    );

    // runMode 字段的 extra 说明（在共享组件里）
    expect(fieldsSrc).toMatch(/name="runMode"[\s\S]{0,200}extra=\{t\('appDeploy\.mode\.hint'\)\}/);
    // scheduled / daemon 各自的 Alert 说明（在共享组件里）
    expect(fieldsSrc).toMatch(/mode === 'scheduled'[\s\S]{0,300}appDeploy\.mode\.hintScheduled/);
    expect(fieldsSrc).toMatch(/mode === 'daemon'[\s\S]{0,300}appDeploy\.mode\.hintDaemon/);
    // 重新部署按钮的 tooltip 说明复用语义（仍在详情页源码里）
    expect(pageSrc).toMatch(/appDeploy\.redeploy\.reuseHint/);
  });
});
