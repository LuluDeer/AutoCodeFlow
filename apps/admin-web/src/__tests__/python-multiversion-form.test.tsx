/**
 * python_task_multiversion 前端回归：多版本解释器声明 + 第 4 条代码来源通道（zip）。
 *
 * 覆盖两层：
 *  1) 纯逻辑 helper（executor-mode.ts）——`applyCodeSourcePayload` 的**显式 null**
 *     纪律（PATCH 是 Object.assign 语义，省略字段=保留旧值 → 任务会同时带两个
 *     冲突来源）、`deriveCodeSourceFromTask` 的编辑态推导优先级、
 *     `normalizeRuntimeVersion` 的格式/区间校验；
 *  2) 组件级——版本字段只在 runtime=python 时渲染；执行详情页在缺少/脏
 *     `result.interpreter` 快照时**不崩且不渲染空壳**。
 *
 * 关键断言口径（本文件刻意逐条钉死）：
 *  - 不适用字段必须 `toBeNull()` **且**键存在（`'key' in payload`）——只断言
 *    `toBeNull()` 会被 `undefined == null` 的宽松比较放过去，而 `undefined`
 *    在 JSON 序列化时**整个键消失**，正是要防的那个 bug。
 *  - `requirements` 是依赖型渠道，切换代码来源必须原样存活（AC-18b 红线）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { Form, Radio } from 'antd';
import {
  applyCodeSourcePayload,
  deriveCodeSourceFromTask,
  normalizeRuntimeVersion,
  runtimeVersionIsOfflineTier,
  applyRuntimeVersionPayload,
  RUNTIME_VERSION_MIN,
  RUNTIME_VERSION_MAX,
  runtimeVersionOptions,
} from '../pages/executor-mode';
import {
  extractInterpreterContext,
  interpreterNeedsOfflinePrefill,
} from '../pages/interpreter-context';
import { FAILURE_RUNBOOK_ACTIONS, failureRunbookAction } from '../pages/failure-runbook';
import { RETRYABLE_ERROR_OPTIONS } from '../pages/retry-policy';
import RuntimeVersionField, {
  RUNTIME_VERSION_SELECT_TESTID,
  RUNTIME_VERSION_ERROR_TESTID,
  RUNTIME_VERSION_OFFLINE_TESTID,
} from '../components/task-form/RuntimeVersionField';
import ExecutionDetailPage from '../pages/ExecutionDetailPage';
import { tasksApi } from '../api/tasks';
import { artifactsApi } from '../api/artifacts';
import zh from '../locales/zh';
import en from '../locales/en';

vi.mock('../api/tasks', () => ({
  tasksApi: {
    execution: vi.fn(),
    executionLogs: vi.fn(),
    killExecution: vi.fn(),
    trigger: vi.fn(),
    analyzeExecution: vi.fn(),
    get: vi.fn(),
    executions: vi.fn(),
  },
}));

vi.mock('../api/artifacts', () => ({
  artifactsApi: { listArtifacts: vi.fn(), downloadArtifact: vi.fn() },
}));

vi.mock('../api/execution-reports', () => ({
  executionReportsApi: {
    report: vi.fn().mockResolvedValue({ execution: {}, timeline: [], report: null }),
  },
}));

// jsdom 缺失 antd 依赖的浏览器 API（对齐既有 execution-detail-* 测试先例）。
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

/** 键存在性断言：`undefined` 与「键缺失」在语义上都违规，但 undefined 更隐蔽
 *  （JSON.stringify 会直接丢掉该键），故单独给出可读失败信息。 */
function expectExplicitNull(payload: Record<string, unknown>, key: string) {
  expect(Object.prototype.hasOwnProperty.call(payload, key), `键 ${key} 必须存在`).toBe(true);
  expect(payload[key], `${key} 必须是显式 null（不是 undefined/缺失）`).toBeNull();
}

// ===========================================================================
// 1) applyCodeSourcePayload：互斥三通道的显式 null 纪律
// ===========================================================================

describe('applyCodeSourcePayload（FR-18/AC-17b 代码来源互斥）', () => {
  it('git → application_zip：gitRepo/gitBranch/glueSource 显式 null，requirements 存活', () => {
    const payload = applyCodeSourcePayload(
      {
        name: 't',
        gitRepo: 'https://github.com/acme/demo.git',
        gitBranch: 'main',
        glueSource: 'print(1)',
        applicationId: 'app-1',
        requirements: ['requests>=2.31'],
      },
      'application_zip',
      'git',
    );

    expectExplicitNull(payload, 'gitRepo');
    expectExplicitNull(payload, 'gitBranch');
    expectExplicitNull(payload, 'glueSource');
    expect(payload.applicationId).toBe('app-1');
    expect(payload.codeSource).toBe('application_zip');
    // AC-18b 红线：requirements 是依赖型渠道，切换来源不得清掉依赖声明
    expect(payload.requirements).toEqual(['requests>=2.31']);
  });

  it('git → glue：gitRepo/gitBranch 显式 null，glueSource 与 requirements 存活', () => {
    const payload = applyCodeSourcePayload(
      {
        gitRepo: 'https://github.com/acme/demo.git',
        gitBranch: 'main',
        glueSource: 'echo hi',
        requirements: ['rich==13.7.1'],
      },
      'glue',
      'git',
    );

    expectExplicitNull(payload, 'gitRepo');
    expectExplicitNull(payload, 'gitBranch');
    expect(payload.glueSource).toBe('echo hi');
    expect(payload.codeSource).toBe('glue');
    expect(payload.requirements).toEqual(['rich==13.7.1']);
  });

  it('application_zip → git：applicationId 是 zip 载体，离开即显式 null', () => {
    const payload = applyCodeSourcePayload(
      {
        applicationId: 'app-1',
        requirements: ['requests>=2.31'],
        gitRepo: 'https://github.com/acme/demo.git',
      },
      'git',
      'application_zip',
    );

    expectExplicitNull(payload, 'applicationId');
    expectExplicitNull(payload, 'glueSource');
    expect(payload.gitRepo).toBe('https://github.com/acme/demo.git');
    expect(payload.codeSource).toBe('git');
    expect(payload.requirements).toEqual(['requests>=2.31']);
  });

  it('application_zip → glue：applicationId 清空但 glueSource 保留（GlueEditor 所有）', () => {
    const payload = applyCodeSourcePayload(
      { applicationId: 'app-1', glueSource: 'print(1)' },
      'glue',
      'application_zip',
    );

    expectExplicitNull(payload, 'applicationId');
    expectExplicitNull(payload, 'gitRepo');
    expectExplicitNull(payload, 'gitBranch');
    expect(payload.glueSource).toBe('print(1)');
    expect(payload.codeSource).toBe('glue');
  });

  it('git/glue ↔ git/glue 之间切换：applicationId 是部署绑定，必须保留（不得静默解绑）', () => {
    const payload = applyCodeSourcePayload(
      { applicationId: 'app-1', glueSource: 'print(1)' },
      'git',
      'glue',
    );
    expect(payload.applicationId).toBe('app-1');
  });

  it('每个不适用字段都是显式 null（键存在 + 值 null，绝不 undefined）', () => {
    // 空入参走三条分支：任何一条把不适用字段留成 undefined 都会让 PATCH 保留旧值
    for (const [source, previous, mustBeNull] of [
      ['git', 'git', ['glueSource']],
      ['glue', 'git', ['gitRepo', 'gitBranch']],
      ['application_zip', 'git', ['gitRepo', 'gitBranch', 'glueSource']],
    ] as const) {
      const payload = applyCodeSourcePayload({ applicationId: 'app-1' }, source, previous);
      for (const key of mustBeNull) expectExplicitNull(payload, key);
      // 逐字节确认没有 undefined 值（JSON 序列化会丢键）
      for (const [k, v] of Object.entries(payload)) {
        expect(v, `${source} 分支的 ${k} 不应为 undefined`).not.toBeUndefined();
      }
    }
  });

  it('glue 分支：载荷未携带 glueSource 时不写该键（否则会删掉用户脚本）', () => {
    const payload = applyCodeSourcePayload({ gitRepo: 'x' }, 'glue', 'git');
    // 关键：**不得**出现 glueSource: null —— 它是 GlueEditor 的字段，
    // 表单没有输入框，写 null 等于静默删除用户的脚本。
    expect(Object.prototype.hasOwnProperty.call(payload, 'glueSource')).toBe(false);
    // 载荷无法自证 → 不声明 codeSource（发 null 回到后端隐式推断语义，避免 400）
    expect(payload.codeSource).toBeNull();
  });

  it('载荷无法自证时不声明 codeSource（避免「声明漂移」400）', () => {
    expect(applyCodeSourcePayload({}, 'git', 'git').codeSource).toBeNull();
    expect(applyCodeSourcePayload({}, 'application_zip', 'git').codeSource).toBeNull();
    expect(applyCodeSourcePayload({ gitRepo: '   ' }, 'git', 'git').codeSource).toBeNull();
  });

  it('纯函数：不修改入参对象', () => {
    const values = { gitRepo: 'https://x/y.git', requirements: ['a'] };
    const snapshot = JSON.stringify(values);
    applyCodeSourcePayload(values, 'application_zip', 'git');
    expect(JSON.stringify(values)).toBe(snapshot);
  });
});

// ===========================================================================
// 2) deriveCodeSourceFromTask：编辑态初值推导
// ===========================================================================

describe('deriveCodeSourceFromTask（FR-18/AC-17b 编辑态来源推导）', () => {
  it('后端已回填合法 codeSource → 原样采用（最高优先级）', () => {
    expect(
      deriveCodeSourceFromTask({
        codeSource: 'glue',
        // 三个载体字段同时非空也不影响：显式声明是权威
        gitRepo: 'https://x/y.git',
        glueSource: 'print(1)',
        applicationId: 'app-1',
      }),
    ).toBe('glue');
  });

  it('codeSource 非法/缺省 → 按 gitRepo > glueSource > applicationId 推断（迁移同序）', () => {
    expect(
      deriveCodeSourceFromTask({ codeSource: 'brand_new', gitRepo: 'https://x/y.git' }),
    ).toBe('git');
    expect(deriveCodeSourceFromTask({ gitRepo: 'https://x/y.git', glueSource: 'print(1)' })).toBe('git');
    expect(
      deriveCodeSourceFromTask({ glueSource: 'print(1)', applicationId: 'app-1' }),
    ).toBe('glue');
    expect(deriveCodeSourceFromTask({ applicationId: 'app-1' })).toBe('application_zip');
  });

  it('三者皆空 → 默认 git（保持新建任务的零迁移手感）', () => {
    expect(deriveCodeSourceFromTask({})).toBe('git');
    expect(deriveCodeSourceFromTask({ gitRepo: '  ', glueSource: null, applicationId: '' })).toBe('git');
    expect(deriveCodeSourceFromTask({ codeSource: null })).toBe('git');
  });
});

// ===========================================================================
// 3) normalizeRuntimeVersion / applyRuntimeVersionPayload：区间与显式 null
// ===========================================================================

describe('normalizeRuntimeVersion（FR-06/AC-06a 版本校验）', () => {
  it('拒绝格式非法值（补丁号/纯数字/非数字/带前后缀/空）', () => {
    for (const bad of [
      '3', '3.12.1', '3.7.0', 'python3.11', 'v3.11', 'x.y',
      '3.x', '3,11', '3.1 1', 'abc', '', '   ', null, undefined, 3.11, {},
    ]) {
      expect(normalizeRuntimeVersion(bad), `${String(bad)} 应被拒绝`).toBeNull();
    }
  });

  it('前后空白先 trim 再判定（粘贴带入的空格不算非法）', () => {
    expect(normalizeRuntimeVersion(' 3.11 ')).toBe('3.11');
    expect(normalizeRuntimeVersion('\t3.7\n')).toBe('3.7');
    // trim 后仍非法则照旧拒绝（不因 trim 放宽格式）
    expect(normalizeRuntimeVersion(' 3.11.0 ')).toBeNull();
  });

  it('拒绝越界值（<3.7 与 >3.14），含"3.9 > 3.14"字符串序陷阱外的真越界', () => {
    for (const bad of ['3.6', '3.0', '2.7', '3.15', '3.99', '4.0', '3.100']) {
      expect(normalizeRuntimeVersion(bad), `${bad} 应被拒绝`).toBeNull();
    }
  });

  it('接受 3.7~3.14 全区间（含未在候选列表中的手输值）', () => {
    for (let minor = 7; minor <= 14; minor += 1) {
      expect(normalizeRuntimeVersion(`3.${minor}`)).toBe(`3.${minor}`);
    }
    // 区间端点与常量一致（避免测试与实现各自漂移）
    expect(normalizeRuntimeVersion(RUNTIME_VERSION_MIN)).toBe('3.7');
    expect(normalizeRuntimeVersion(RUNTIME_VERSION_MAX)).toBe('3.14');
  });

  it('数组入参取末位（antd tags 形态防御）', () => {
    expect(normalizeRuntimeVersion(['3.9', '3.12'])).toBe('3.12');
    expect(normalizeRuntimeVersion(['3.12', '3.99'])).toBeNull();
  });

  it('3.7 判为离线层，3.8+ 不是（AC-06b 警示的判据）', () => {
    expect(runtimeVersionIsOfflineTier('3.7')).toBe(true);
    for (const v of ['3.8', '3.9', '3.12', '3.14']) {
      expect(runtimeVersionIsOfflineTier(v), `${v} 不应判为离线层`).toBe(false);
    }
    expect(runtimeVersionIsOfflineTier(null)).toBe(false);
    expect(runtimeVersionIsOfflineTier('3.99')).toBe(false);
  });

  it('候选分层与支持矩阵一致：3.7 单独一层且 offlineOnly', () => {
    const options = runtimeVersionOptions();
    const tier1 = options.filter((o) => o.tier === 1).map((o) => o.value);
    const tier2 = options.filter((o) => o.tier === 2).map((o) => o.value);
    const tier3 = options.filter((o) => o.tier === 3).map((o) => o.value);
    expect(tier1).toEqual(['3.14', '3.13', '3.12', '3.11', '3.10']);
    expect(tier2).toEqual(['3.9', '3.8']);
    expect(tier3).toEqual(['3.7']);
    // offlineOnly 只对 3.7 为真——UI 的 ⚠ 标记与警示 Tag 据此渲染
    expect(options.filter((o) => o.offlineOnly).map((o) => o.value)).toEqual(['3.7']);
  });
});

describe('applyRuntimeVersionPayload（FR-06/NG-02 提交归一）', () => {
  it('runtime=python：保留合法版本；清空/非法 → 显式 null（宿主默认解释器）', () => {
    expect(applyRuntimeVersionPayload({ runtime: 'python' }, '3.7').runtimeVersion).toBe('3.7');
    for (const cleared of [null, '', '  ', '3.99', undefined]) {
      const payload = applyRuntimeVersionPayload({ runtime: 'python' }, cleared);
      expectExplicitNull(payload, 'runtimeVersion');
    }
  });

  it('runtime≠python：恒为显式 null（后端拒绝非 python 声明版本）', () => {
    for (const runtime of ['node', 'shell']) {
      const payload = applyRuntimeVersionPayload({ runtime }, '3.12');
      expectExplicitNull(payload, 'runtimeVersion');
    }
  });

  it('第二参缺省时回落到 values.runtimeVersion（纯函数两条通路都可用）', () => {
    expect(
      applyRuntimeVersionPayload({ runtime: 'python', runtimeVersion: '3.11' }).runtimeVersion,
    ).toBe('3.11');
  });
});

// ===========================================================================
// 4) RuntimeVersionField 组件：仅 runtime=python 渲染
// ===========================================================================

/**
 * 组合框 testid 落在 **Form.Item 的 Field 根节点**（外层 div），不在内部 <input>
 * 上——antd 的 data-testid 由 Field 透传到包裹层，故断言用 closest 找内部控件，
 * 而"是否渲染"直接查 Field 根节点本身。
 */
function versionFieldRoot(): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-testid="${RUNTIME_VERSION_SELECT_TESTID}"]`);
}

/**
 * 测试桩必须**真实挂载** `runtime` 字段（Form.Item + 控件），不能只靠
 * `initialValues`：rc-field-form 的 useWatch 只订阅已注册字段，未挂载时读回
 * undefined，会让"仅 python 渲染"的断言永远走 null 分支而假绿。
 * 这里用与生产同款的 Radio.Group，使桩与 TaskFormPage 的字段形态一致。
 */
function renderVersionField(
  runtime: string,
  props: Partial<{ value: string | null; onChange: (v: string | null) => void }> = {},
) {
  function Harness() {
    const [form] = Form.useForm();
    return (
      <Form form={form} initialValues={{ runtime }}>
        <Form.Item name="runtime" label="runtime">
          <Radio.Group>
            <Radio value="python">python</Radio>
            <Radio value="node">node</Radio>
            <Radio value="shell">shell</Radio>
          </Radio.Group>
        </Form.Item>
        <RuntimeVersionField form={form} value={null} onChange={() => {}} {...props} />
      </Form>
    );
  }
  return render(<Harness />);
}

describe('RuntimeVersionField（FR-06 只读性）', () => {
  it('runtime=python 时渲染版本组合框（含内部 Select 控件）', () => {
    const { container } = renderVersionField('python');
    const root = versionFieldRoot();
    expect(root).toBeTruthy();
    expect(container.querySelector('.ant-select')).toBeTruthy();
    // 组合框语义：有输入框可手输版本
    expect(container.querySelector('input')).toBeTruthy();
  });

  it('runtime=node / shell 时不渲染（后端会拒绝声明版本，NG-02）', () => {
    for (const runtime of ['node', 'shell']) {
      const { container, unmount } = renderVersionField(runtime);
      expect(versionFieldRoot()).toBeNull();
      // 连内部 Select 都不该挂载——不是"隐藏"，是整块 return null
      expect(container.querySelector('.ant-select')).toBeNull();
      unmount();
    }
  });

  it('3.7 选中时的离线警示与"未声明"提示互斥（AC-06b 可见警示）', () => {
    const { container } = renderVersionField('python', { value: '3.7' });
    // 3.7 → 显著警示存在
    expect(screen.getByTestId(RUNTIME_VERSION_OFFLINE_TESTID)).toBeTruthy();
    // 3.7 不是"未声明"，故不出现宿主默认提示
    expect(container.textContent).not.toContain('宿主默认解释器');
  });

  it('非法手输 → 就地清空并常驻红字，绝不把脏值带进提交', () => {
    const onChange = vi.fn();
    const { container } = renderVersionField('python', { onChange });
    // 必须取**组合框内部**的搜索输入框：桩里还有一个 Radio.Group，
    // container.querySelector('input') 会先命中它的 radio。
    const input = container.querySelector<HTMLInputElement>('.ant-select input')!;
    expect(input).toBeTruthy();

    // 手输越界值（3.99 > 3.14）后回车确认
    fireEvent.change(input, { target: { value: '3.99' } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13 });

    // 组件必须已就"确认"作出反应：归一为 null（而非原样透传 '3.99'）
    expect(onChange).toHaveBeenCalled();
    for (const call of onChange.mock.calls) {
      expect(call[0] === null || /^\d+\.\d+$/.test(String(call[0])), '不得透传非法值').toBe(true);
    }
    expect(onChange).toHaveBeenLastCalledWith(null);
    // 红字常驻（回显用户输入了什么），且 Form.Item validateStatus 变 error
    // （桩里只有版本字段可能进 error——runtime 的 Radio 无 rules）
    expect(screen.getByTestId(RUNTIME_VERSION_ERROR_TESTID).textContent).toContain('3.99');
    expect(document.querySelector('.ant-form-item-has-error')).toBeTruthy();
  });

  it('未声明版本（value=null）时提示走宿主默认解释器（FR-10）', () => {
    const { container } = renderVersionField('python', { value: null });
    expect(container.textContent).toContain('宿主默认解释器');
    expect(screen.queryByTestId(RUNTIME_VERSION_OFFLINE_TESTID)).toBeNull();
  });
});

// ===========================================================================
// 5) 三端对齐：runbook / retry-policy / 失败分类映射
// ===========================================================================

describe('interpreter_unavailable 三端对齐（runbook / retryable / 失败分类）', () => {
  it('failure-runbook 收录该键且动作非空（与 mcp RUNBOOK 键集对齐）', () => {
    // 刻意**不**硬编码键总数：断言的是"该键有内容且非 unknown 兜底"，
    // 未来继续扩分类时本用例无需改动（键集完整性由 execution-detail-ui05 锚定）。
    expect(FAILURE_RUNBOOK_ACTIONS.interpreter_unavailable?.action.length).toBeGreaterThan(0);
    expect(FAILURE_RUNBOOK_ACTIONS.interpreter_unavailable.action).not.toBe(
      FAILURE_RUNBOOK_ACTIONS.unknown.action,
    );
    // 传 t 时走 i18n key（RUNBOOK_ACTION_T_KEY 未导出，用恒等 t 间接钉死映射）
    const identity = (k: string) => k;
    expect(failureRunbookAction('interpreter_unavailable', identity).action).toBe(
      'runbook.interpreterUnavailable',
    );
  });

  it('retry-policy 收录候选但**不**进任何默认值（重试对环境类失败无益）', () => {
    const values = RETRYABLE_ERROR_OPTIONS.map((o) => o.value);
    expect(values).toContain('interpreter_unavailable');
    // 候选表是纯展示清单，不存在"默认勾选"概念——此处锚定它不落在默认重试集
    // 的任何隐式来源上（默认集 = 任务 retryableErrors，空 = 全部可重试）。
    const option = RETRYABLE_ERROR_OPTIONS.find((o) => o.value === 'interpreter_unavailable');
    expect(option?.label).toBe('解释器不可用');
  });

  it('i18n：中英字典均有该分类与 runbook 文案（不裸 key）', () => {
    for (const dict of [zh, en] as Record<string, string>[]) {
      for (const key of [
        'execDetail.failure.interpreterUnavailable',
        'execDetail.failure.interpreterUnavailableHint',
        'taskForm.retryable.interpreterUnavailable',
        'runbook.interpreterUnavailable',
      ]) {
        expect(dict[key], `${key} 缺失`).toBeTruthy();
        expect(dict[key], `${key} 不应等于裸 key`).not.toBe(key);
      }
    }
  });
});

// ===========================================================================
// 6) 执行详情页：解释器快照（含"旧执行无该字段"的健壮性）
// ===========================================================================

describe('extractInterpreterContext（防御式读取层）', () => {
  it('旧执行/脏数据一律归 null，不抛错', () => {
    for (const bad of [
      null, undefined, 'boom', 42, [], {}, { interpreter: null },
      { interpreter: 'x' }, { interpreter: [] }, { interpreter: {} },
    ]) {
      expect(extractInterpreterContext(bad)).toBeNull();
    }
  });

  it('normalize：数字 requested 归 null（不 String() 出假版本号）、池空归 null', () => {
    const ctx = extractInterpreterContext({
      interpreter: {
        requested: 3.7,
        resolved: '',
        reason: 'not_downloadable',
        detail: '  3.7 needs offline prefill  ',
        pool: { install_dir: '', versions: [] },
      },
    })!;
    expect(ctx.requested).toBeNull();
    expect(ctx.resolved).toBeNull();
    expect(ctx.detail).toBe('3.7 needs offline prefill');
    expect(ctx.pool).toBeNull();
    expect(interpreterNeedsOfflinePrefill(ctx)).toBe(true);
  });

  it('3.7 专项指引判据：requested<3.8 或 reason=not_downloadable', () => {
    expect(
      interpreterNeedsOfflinePrefill(
        extractInterpreterContext({ interpreter: { requested: '3.7' } }),
      ),
    ).toBe(true);
    expect(
      interpreterNeedsOfflinePrefill(
        extractInterpreterContext({ interpreter: { reason: 'not_downloadable' } }),
      ),
    ).toBe(true);
    expect(
      interpreterNeedsOfflinePrefill(
        extractInterpreterContext({ interpreter: { requested: '3.12', reason: 'cache_miss' } }),
      ),
    ).toBe(false);
    expect(interpreterNeedsOfflinePrefill(null)).toBe(false);
  });
});

function mockExecution(overrides: Record<string, unknown> = {}) {
  vi.mocked(tasksApi.execution).mockReset().mockResolvedValue({
    id: 'e1',
    taskId: 't1',
    taskName: 'nightly',
    status: 'failed',
    triggerType: 'manual',
    logs: 'line-1',
    failureReason: 'script_error',
    createdAt: new Date().toISOString(),
    ...overrides,
  } as never);
  vi.mocked(tasksApi.get).mockReset().mockResolvedValue({ id: 't1', maxRetry: 3 } as never);
  vi.mocked(tasksApi.executions).mockReset().mockResolvedValue({
    items: [{ id: 'e1', retryCount: 0, status: 'failed' }], total: 1, page: 1, pageSize: 100,
  } as never);
  vi.mocked(tasksApi.executionLogs).mockReset();
}

function renderDetail() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/tasks/t1/executions/e1']}>
        <Routes>
          <Route path="/tasks/:taskId/executions/:execId" element={<ExecutionDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('ExecutionDetailPage：解释器快照渲染（AC-12a）', () => {
  beforeEach(() => {
    mockExecution();
    vi.mocked(artifactsApi.listArtifacts).mockReset().mockResolvedValue([] as never);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('无 result.interpreter（旧执行）：整块不渲染，页面其余部分完好', async () => {
    renderDetail();
    await screen.findByTestId('failure-triage-card');
    expect(screen.queryByTestId('execution-interpreter')).toBeNull();
    // 排障入口仍在（缺快照不得影响失败定位卡片等既有信息）
    expect(screen.getByTestId('failure-triage-card').textContent).toContain('阅读日志末尾');
  });

  it('result 为脏值（字符串/空对象）：不崩且不渲染空壳', async () => {
    for (const dirty of ['boom', {}, { interpreter: {} }]) {
      mockExecution({ result: dirty });
      const { unmount } = renderDetail();
      await screen.findByTestId('failure-triage-card');
      expect(screen.queryByTestId('execution-interpreter')).toBeNull();
      unmount();
    }
  });

  it('有快照：渲染 requested/reason/池版本，并给 3.7 专项指引', async () => {
    mockExecution({
      failureReason: 'interpreter_unavailable',
      result: {
        interpreter: {
          requested: '3.7',
          resolved: null,
          reason: 'not_downloadable',
          detail: 'uv cannot download 3.7; prefill the cache volume',
          pool: { install_dir: '/opt/uv/python', versions: ['3.12.11', '3.9.20'] },
        },
      },
    });
    renderDetail();
    const block = await screen.findByTestId('execution-interpreter');
    expect(block.textContent).toContain('3.7');
    expect(block.textContent).toContain('not_downloadable');
    expect(block.textContent).toContain('/opt/uv/python');
    expect(block.textContent).toContain('3.12.11');
    // not_downloadable → 3.7 离线预填指引置顶
    expect(screen.getByTestId('interpreter-offline-prefill')).toBeTruthy();
    // 兜底：快照里没有的字段渲染"未留痕"占位而非空白
    expect(block.textContent).toContain('未留痕');
  });

  it('3.12 的 cache_miss 快照：渲染但**不**出现 3.7 专项指引', async () => {
    mockExecution({
      failureReason: 'interpreter_unavailable',
      result: {
        interpreter: {
          requested: '3.12',
          reason: 'cache_miss',
          pool: { install_dir: '/opt/uv/python', versions: [] },
        },
      },
    });
    renderDetail();
    const block = await screen.findByTestId('execution-interpreter');
    expect(block.textContent).toContain('3.12');
    expect(screen.queryByTestId('interpreter-offline-prefill')).toBeNull();
  });

  it('失败分类映射：interpreter_unavailable → 「解释器不可用」+ 环境类展示', async () => {
    mockExecution({ failureReason: 'interpreter_unavailable' });
    renderDetail();
    const card = await screen.findByTestId('failure-triage-card');
    // 定位卡片标题 = `${状态}：${分类}`
    expect(card.textContent).toContain('解释器不可用');
    // 分类 Tag 在页面上方的执行信息卡里（不在定位卡片内），颜色为 gold
    // （与 runtime_missing 同族的环境/配置类）。
    const goldTags = [...document.querySelectorAll('.ant-tag-gold')];
    expect(
      goldTags.some((el) => el.textContent === '解释器不可用'),
      'gold 分类标签应显示「解释器不可用」',
    ).toBe(true);
    // 已从 unknown 兜底升级为专有映射（否则会渲染成裸 token + 未识别提示）
    expect(document.body.textContent).not.toContain('未识别的失败分类');
    // runbook 动作走专项文案而非 runtime_missing/unknown 兜底
    expect(card.textContent).toContain('解释器缓存卷');
  });
});
