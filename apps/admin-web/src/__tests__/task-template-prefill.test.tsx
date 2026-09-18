/**
 * CORE-03: 任务模板——前端预填纯映射 + 组件级预填接线回归。
 *
 * 覆盖三层：
 *  1) templateConfigToFormValues——模板 config → 表单初值（timeoutSeconds→timeout 桥接、
 *     表单无控件的键如 blockStrategy 不透传）。
 *  2) templateTriggerAndRuntime——内部 state 同步（triggerType 影响条件渲染）。
 *  3) 组件级——创建态带 ?templateId= 时拉模板并预填表单（含失败降级）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import TaskFormPage from '../pages/TaskFormPage';
import {
  templateConfigToFormValues,
  templateTriggerAndRuntime,
} from '../pages/task-template-prefill';
import { taskTemplatesApi, type TaskTemplate } from '../api/task-templates';
import { tasksApi } from '../api/tasks';
import { executorsApi } from '../api/executors';
import { applicationsApi } from '../api/applications';

vi.mock('../api/task-templates', () => ({ taskTemplatesApi: { get: vi.fn(), list: vi.fn() } }));
vi.mock('../api/tasks', () => ({ tasksApi: { get: vi.fn(), create: vi.fn(), update: vi.fn(), list: vi.fn(), listAll: vi.fn().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 100 }) } }));
vi.mock('../api/executors', () => ({
  executorsApi: { list: vi.fn(), getGroups: vi.fn(), getTags: vi.fn() },
}));
vi.mock('../api/applications', () => ({ applicationsApi: { list: vi.fn() } }));
// F-01 配套：GlueEditor 重依赖（monaco）裁剪（策略同 task-form-ui06 等文件）。
vi.mock('../components/GlueEditor', () => ({ default: () => <div data-testid="glue-editor" /> }));

// 路由 mock：保留 MemoryRouter 等真实导出（对齐 login-totp.test 先例），
// 仅覆写 useParams/useSearchParams/useNavigate 以控制创建态参数。
// UI-03：TaskFormPage 页头 PageHeader 面包屑消费 Link——测试在 Router 上下文外
// 直接渲染页面组件，真实 Link 需 Router，故覆写为纯锚点桩。
let mockSearch = '';
const mockNav = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNav,
    useParams: () => ({}),
    useSearchParams: () => [new URLSearchParams(mockSearch)],
    Link: (props: { to: string; children: React.ReactNode }) => <a href={props.to}>{props.children}</a>,
  };
});

// jsdom 缺失 antd 依赖的浏览器 API，先行补齐（对齐 task-form-page.test 先例）。
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

function makeTemplate(overrides: Partial<TaskTemplate> = {}): TaskTemplate {
  return {
    id: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
    key: 'scheduled_backup',
    name: '定时备份',
    description: '周期性备份任务：Cron 定时触发。',
    category: '备份',
    config: {
      triggerType: 'cron',
      cronExpression: '0 2 * * *',
      timezone: 'Asia/Shanghai',
      runtime: 'shell',
      entrypoint: 'backup.sh',
      timeoutSeconds: 3600,
      maxRetry: 3,
      retryDelay: 60,
      blockStrategy: 'discard',
    },
    isOfficial: true,
    createdAt: '2026-09-07T00:00:00.000Z',
    updatedAt: '2026-09-07T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  mockSearch = '';
  vi.mocked(executorsApi.list).mockReset().mockResolvedValue([] as never);
  vi.mocked(executorsApi.getGroups).mockReset().mockResolvedValue([] as never);
  vi.mocked(executorsApi.getTags).mockReset().mockResolvedValue([] as never);
  vi.mocked(applicationsApi.list).mockReset().mockResolvedValue([] as never);
});

afterEach(() => {
  cleanup();
});

describe('templateConfigToFormValues（config → 表单初值纯映射）', () => {
  it('搬运气表单实际消费的字段（trigger/cron/runtime/entrypoint/重试）', () => {
    const out = templateConfigToFormValues(makeTemplate().config);
    expect(out.triggerType).toBe('cron');
    expect(out.cronExpression).toBe('0 2 * * *');
    expect(out.timezone).toBe('Asia/Shanghai');
    expect(out.runtime).toBe('shell');
    expect(out.entrypoint).toBe('backup.sh');
    expect(out.maxRetry).toBe(3);
    expect(out.retryDelay).toBe(60);
  });

  it('timeoutSeconds（模板侧）桥接为 timeout（表单字段名）', () => {
    expect(templateConfigToFormValues({ timeoutSeconds: 3600 }).timeout).toBe(3600);
  });

  it('config 直接给 timeout 时也落到表单字段（不丢显式值）', () => {
    expect(templateConfigToFormValues({ timeout: 600 }).timeout).toBe(600);
  });

  it('表单无控件的键（blockStrategy）不透传', () => {
    const out = templateConfigToFormValues({ blockStrategy: 'discard', triggerType: 'manual' });
    expect('blockStrategy' in out).toBe(false);
    expect(out.triggerType).toBe('manual');
  });

  it('空 config → 空对象（不产生 undefined 键污染表单）', () => {
    expect(templateConfigToFormValues({})).toEqual({});
  });

  // python_task_multiversion（FR-06/FR-18）：模板固化过的 Python 版本与代码来源
  // 必须能被预填读回。注意**只断言纯映射层**——真正写进组件 state 的那一步
  // （TaskFormPage 的 effect 里显式 setRuntimeVersion/setCodeSource）不属于本文件
  // 的职责，因为这两个值不在表单字段树里，setFieldsValue 对它们无效。
  it('runtimeVersion 与 codeSource 随模板回填（不再被静默丢弃）', () => {
    const out = templateConfigToFormValues({
      runtime: 'python',
      entrypoint: 'main.py',
      runtimeVersion: '3.7',
      codeSource: 'application_zip',
    });
    expect(out.runtimeVersion).toBe('3.7');
    expect(out.codeSource).toBe('application_zip');
  });

  it('旧模板缺这两个键时不写入（表单保持默认空态）', () => {
    const out = templateConfigToFormValues({ runtime: 'python' });
    expect('runtimeVersion' in out).toBe(false);
    expect('codeSource' in out).toBe(false);
  });
});

describe('templateTriggerAndRuntime（内部 state 同步映射）', () => {
  it('取 config 的 triggerType/runtime', () => {
    const t = makeTemplate();
    expect(templateTriggerAndRuntime(t)).toEqual({ triggerType: 'cron', runtime: 'shell' });
  });

  it('config 缺省时回退 manual/python（与表单 initialValues 一致）', () => {
    expect(
      templateTriggerAndRuntime(makeTemplate({ config: {} })),
    ).toEqual({ triggerType: 'manual', runtime: 'python' });
  });

  it('config 字段非字符串时不崩溃，回缺省', () => {
    expect(
      templateTriggerAndRuntime(makeTemplate({ config: { triggerType: 42, runtime: null } as never })),
    ).toEqual({ triggerType: 'manual', runtime: 'python' });
  });
});

describe('TaskFormPage 创建态 ?templateId= 预填（组件级，UI-06 单页语义）', () => {
  // O-2（测试体系审计，2026-09-18）：本 describe 的用例都走**全页挂载 +
  // findByDisplayValue 轮询**，在 coverage 仪器化（v8）与并发 transform 下
  // 15s 硬编码预算实测超时（vite.config.ts 的 O-2 注释记录原始数据）；
  // 按审计建议「对确实慢的用例逐个放宽」提至 30s（与全局 testTimeout 对齐）。
  it('拉取模板后表单预填 config 值（入口文件/运行时/cron 同屏可见）', async () => {
    mockSearch = 'templateId=a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
    vi.mocked(taskTemplatesApi.get).mockClear().mockResolvedValue(makeTemplate() as never);

    render(<TaskFormPage />);

    // 单页全挂载：cronExpression 条件渲染控件（triggerType=cron 预填后）也同屏可见。
    expect(await screen.findByDisplayValue(/周期性备份任务/)).toBeTruthy();
    expect(screen.getByDisplayValue('backup.sh')).toBeTruthy();
    expect(screen.getByDisplayValue('shell')).toBeTruthy();
    expect(screen.getByDisplayValue('0 2 * * *')).toBeTruthy();
    expect(taskTemplatesApi.get).toHaveBeenCalledWith('a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d');
  }, 30_000);

  it('模板 description 预填描述（config 无 description 键，独立取）', async () => {
    mockSearch = 'templateId=a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
    vi.mocked(taskTemplatesApi.get).mockClear().mockResolvedValue(makeTemplate() as never);

    render(<TaskFormPage />);

    expect(await screen.findByDisplayValue(/周期性备份任务/)).toBeTruthy();
  }, 30_000);

  it('预填后显式修改仍可提交（用户字段可覆盖：改 name 后提交，payload 用新值）', async () => {
    mockSearch = 'templateId=a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
    vi.mocked(taskTemplatesApi.get).mockClear().mockResolvedValue(makeTemplate() as never);
    vi.mocked(tasksApi.create).mockClear().mockResolvedValue({ id: 'new-task' } as never);

    render(<TaskFormPage />);

    // 预填可见后再填写必填的 name（模板不提供 name，由用户补全）。
    const nameInput = await screen.findByPlaceholderText('daily-report');
    fireEvent.change(nameInput, { target: { value: 'nightly-backup' } });

    // 单页：直接提交，不再分步推进。
    fireEvent.click(screen.getByRole('button', { name: /创建任务/ }));

    await vi.waitFor(() => expect(tasksApi.create).toHaveBeenCalledTimes(1));
    const payload = vi.mocked(tasksApi.create).mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(payload.name).toBe('nightly-backup');
    // 预填值原样进入 payload。
    expect(payload.cronExpression).toBe('0 2 * * *');
    expect(payload.entrypoint).toBe('backup.sh');
    expect(payload.runtime).toBe('shell');
    // timeoutSeconds 桥接后的 timeout 入 payload。
    expect(payload.timeout).toBe(3600);
  }, 30_000);

  it('模板加载失败降级：空白表单仍可用（不阻塞手动创建）', async () => {
    mockSearch = 'templateId=a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
    vi.mocked(taskTemplatesApi.get).mockClear().mockRejectedValue(new Error('boom') as never);

    render(<TaskFormPage />);

    // 失败后表单仍以空白/默认值渲染，可正常走手动创建。
    expect(await screen.findByPlaceholderText('daily-report')).toBeTruthy();
    expect(screen.queryByDisplayValue('backup.sh')).toBeNull();
  }, 30_000);
});
