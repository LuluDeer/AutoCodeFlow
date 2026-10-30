/**
 * NF-02: 上游依赖（编排）纯逻辑单测。
 *  - task-dependencies.ts：dependencies 映射提交序列化（契约 FIX-1.1：
 *    value=上游任务 id、key=显示名快照；快照缺失 key=value=id；同名冲突
 *    降级 key=id）+ 空集显式 null + 编辑态回填（映射 → Select 值 + 快照）。
 */
import { describe, it, expect } from 'vitest';
import {
  applyDependenciesPayload,
  buildDependenciesPayload,
  buildDependencyAliasRows,
  dependenciesFormValues,
  humanizeDependencyTaskIds,
  resolveDependencyAliases,
} from '../pages/task-dependencies';

describe('applyDependenciesPayload（提交序列化 + 载体字段剥离）', () => {
  it('写入 dependencies 映射（value=id）并删除表单载体 upstreamDependencies', () => {
    const out = applyDependenciesPayload(
      {
        name: 't',
        runtime: 'node',
        upstreamDependencies: ['a-uuid'],
      },
      { 'a-uuid': 'task-a' },
    );
    expect(out.dependencies).toEqual({ 'task-a': 'a-uuid' });
    // 关键断言：载体键必须从请求体中消失（否则 forbidNonWhitelisted → 400）
    expect('upstreamDependencies' in out).toBe(false);
    expect(Object.keys(out)).not.toContain('upstreamDependencies');
    expect(out.name).toBe('t');
  });

  it('空选中集（编辑态恒置 []）→ dependencies=null 且载体键消失', () => {
    const out = applyDependenciesPayload(
      { name: 't', upstreamDependencies: [] },
      {},
    );
    expect(out.dependencies).toBeNull();
    expect('upstreamDependencies' in out).toBe(false);
  });

  it('字段未挂载（undefined）→ dependencies=null 且不新增载体键', () => {
    const out = applyDependenciesPayload({ name: 't' }, {});
    expect(out.dependencies).toBeNull();
    expect('upstreamDependencies' in out).toBe(false);
  });

  it('不修改入参对象（纯函数契约）', () => {
    const values = { name: 't', upstreamDependencies: ['a-uuid'] };
    applyDependenciesPayload(values, { 'a-uuid': 'task-a' });
    expect(values.upstreamDependencies).toEqual(['a-uuid']);
    expect('dependencies' in values).toBe(false);
  });
});

describe('buildDependenciesPayload（提交序列化，value=上游任务 id 契约）', () => {
  it('选中 taskId 列表 → {显示名: taskId} 映射（value 恒为 id，后端扇出/环检测语义位）', () => {
    expect(
      buildDependenciesPayload(['a-uuid', 'b-uuid'], {
        'a-uuid': 'task-a',
        'b-uuid': 'task-b',
      }),
    ).toEqual({ 'task-a': 'a-uuid', 'task-b': 'b-uuid' });
  });

  it('空集 → 显式 null（PATCH 缺省=保留旧值，必须发 null 才能清空依赖链）', () => {
    expect(buildDependenciesPayload([], { 'a-uuid': 'task-a' })).toBeNull();
  });

  it('字段未挂载（undefined）→ 归 null', () => {
    expect(buildDependenciesPayload(undefined, {})).toBeNull();
  });

  it('名称快照缺失（任务刚被删除）→ key 与 value 同用 taskId（value 语义位永不失效）', () => {
    expect(buildDependenciesPayload(['a-uuid'], {})).toEqual({
      'a-uuid': 'a-uuid',
    });
  });

  it('同名上游任务（key 冲突）→ 后者降级 key=id，两个 value 都保住', () => {
    expect(
      buildDependenciesPayload(['a-uuid', 'b-uuid'], {
        'a-uuid': 'task-a',
        'b-uuid': 'task-a', // 与 a 同名：key 冲突
      }),
    ).toEqual({ 'task-a': 'a-uuid', 'b-uuid': 'b-uuid' });
  });

  it('同一任务重复选中 → 单键幂等', () => {
    expect(
      buildDependenciesPayload(['a-uuid', 'a-uuid'], { 'a-uuid': 'task-a' }),
    ).toEqual({ 'task-a': 'a-uuid' });
  });

  it('非数组值 → null', () => {
    expect(
      buildDependenciesPayload('not-array' as unknown as string[], {}),
    ).toBeNull();
  });
});

describe('dependenciesFormValues（编辑态回填，读 value=id 契约）', () => {
  it('null/缺省 → 空选中集 + 空快照', () => {
    expect(dependenciesFormValues(null)).toEqual({ selected: [], nameSnapshot: {} });
    expect(dependenciesFormValues(undefined)).toEqual({ selected: [], nameSnapshot: {} });
  });

  it('已有映射（key=显示名/value=id）→ Select 值取 value(id)，快照 id→显示名', () => {
    const { selected, nameSnapshot } = dependenciesFormValues({
      'task-a': 'a-uuid',
      'task-b': 'b-uuid',
    });
    expect(selected.sort()).toEqual(['a-uuid', 'b-uuid'].sort());
    expect(nameSnapshot).toEqual({ 'a-uuid': 'task-a', 'b-uuid': 'task-b' });
  });

  it('序列化→回填 往返一致', () => {
    const payload = buildDependenciesPayload(['a-uuid', 'b-uuid'], {
      'a-uuid': 'task-a',
      'b-uuid': 'task-b',
    });
    const back = dependenciesFormValues(payload);
    expect(back.selected.sort()).toEqual(['a-uuid', 'b-uuid'].sort());
    expect(back.nameSnapshot).toEqual({ 'a-uuid': 'task-a', 'b-uuid': 'task-b' });
    // 再序列化（快照来自回填）幂等
    expect(buildDependenciesPayload(back.selected, back.nameSnapshot)).toEqual(payload);
  });
});

// F-8（本轮审计）：后端依赖类校验错误（循环依赖等）把 taskId（UUID）裸拼进
// message；表单持有 id→显示名快照，toast 前替换为任务名，映射不到保持原文。
describe('humanizeDependencyTaskIds（F-8：错误消息 UUID→任务名）', () => {
  const snapshot = {
    '11111111-2222-3333-4444-555555555555': '每日备份',
    'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee': 'UPPER-TASK',
  };

  it('消息中的 UUID 替换为快照中的任务名（其余文本原样）', () => {
    expect(
      humanizeDependencyTaskIds('循环依赖: 11111111-2222-3333-4444-555555555555', snapshot),
    ).toBe('循环依赖: 每日备份');
    expect(
      humanizeDependencyTaskIds(
        '检测到循环依赖 task 11111111-2222-3333-4444-555555555555 → aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        snapshot,
      ),
    ).toBe('检测到循环依赖 task 每日备份 → UPPER-TASK');
  });

  it('大小写不同的 UUID 也能命中（快照键大小写三态兜底）', () => {
    expect(
      humanizeDependencyTaskIds('dep AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE', snapshot),
    ).toBe('dep UPPER-TASK');
  });

  it('映射不到（任务已删除/快照未含）保持原文，绝不编造', () => {
    expect(
      humanizeDependencyTaskIds('missing 99999999-8888-7777-6666-555555555555', snapshot),
    ).toBe('missing 99999999-8888-7777-6666-555555555555');
  });

  it('无快照/空消息原样返回', () => {
    expect(humanizeDependencyTaskIds('some message', undefined)).toBe('some message');
    expect(humanizeDependencyTaskIds('some message', null)).toBe('some message');
    expect(humanizeDependencyTaskIds('', snapshot)).toBe('');
    expect(humanizeDependencyTaskIds('plain', {})).toBe('plain');
  });
});

// ── G6 别名可见性（只读展示 + 提示，**不改提交载荷**） ─────────────────────
//
// 别名 = dependencies 的 key，就是下游脚本里 `$upstream("…")` 认的键。UI 此前
// 只显示候选任务的**当前**名，用户看不到存的是哪个别名。以下用例锁三件事：
//   ① UI 展示的别名与提交载荷同源（resolveDependencyAliases 折叠 === payload）；
//   ② 改名漂移（key ≠ 上游当前名）与同名退化（key=id）能被判定出来；
//   ③ **提交载荷逐字节不变**（golden：改动前后 buildDependenciesPayload 输出一致）。
describe('resolveDependencyAliases（别名解析，与提交载荷同源）', () => {
  it('快照命中 → 别名=显示名快照（id 仍是 value）', () => {
    expect(resolveDependencyAliases(['a-uuid', 'b-uuid'], {
      'a-uuid': 'task-a',
      'b-uuid': 'task-b',
    })).toEqual([
      { id: 'a-uuid', alias: 'task-a' },
      { id: 'b-uuid', alias: 'task-b' },
    ]);
  });

  it('快照缺失（任务刚被删除）→ 别名退化为 taskId（id 形态）', () => {
    expect(resolveDependencyAliases(['a-uuid'], {})).toEqual([
      { id: 'a-uuid', alias: 'a-uuid' },
    ]);
  });

  it('同名冲突 → 先到者保留名字，后者别名退化为 taskId', () => {
    expect(resolveDependencyAliases(['a-uuid', 'b-uuid'], {
      'a-uuid': 'same-name',
      'b-uuid': 'same-name',
    })).toEqual([
      { id: 'a-uuid', alias: 'same-name' },
      { id: 'b-uuid', alias: 'b-uuid' },
    ]);
  });

  it('空集/非数组 → 空清单', () => {
    expect(resolveDependencyAliases([], { 'a-uuid': 'task-a' })).toEqual([]);
    expect(resolveDependencyAliases(undefined, {})).toEqual([]);
    expect(resolveDependencyAliases('nope' as unknown as string[], {})).toEqual([]);
  });

  // ②「界面说的别名 = 真正落库的 key」：把解析结果按 alias→id 折叠，必须与
  // buildDependenciesPayload 的输出完全一致（覆盖冲突/缺失/重复选中三类）。
  it('解析结果折叠后与 buildDependenciesPayload 逐键一致（UI 不会说谎）', () => {
    const cases: Array<{ selected: string[]; snapshot: Record<string, string> }> = [
      { selected: ['a-uuid', 'b-uuid'], snapshot: { 'a-uuid': 'task-a', 'b-uuid': 'task-b' } },
      { selected: ['a-uuid'], snapshot: {} },
      { selected: ['a-uuid', 'b-uuid'], snapshot: { 'a-uuid': 'dup', 'b-uuid': 'dup' } },
      { selected: ['a-uuid', 'a-uuid'], snapshot: { 'a-uuid': 'task-a' } },
      { selected: ['b-uuid', 'a-uuid'], snapshot: { 'a-uuid': 'task-b', 'b-uuid': 'task-b' } },
      { selected: ['a-uuid', 'b-uuid'], snapshot: { 'a-uuid': 'task-a' } },
    ];
    for (const c of cases) {
      const folded: Record<string, string> = {};
      for (const { id, alias } of resolveDependencyAliases(c.selected, c.snapshot)) {
        folded[alias] = id;
      }
      expect(folded).toEqual(buildDependenciesPayload(c.selected, c.snapshot));
    }
  });
});

describe('buildDependencyAliasRows（依赖区只读别名清单）', () => {
  const options = [
    { id: 'a-uuid', name: 'task-a' },
    { id: 'b-uuid', name: 'task-b' },
  ];

  it('已选依赖逐行给出「当前名 + 别名」：别名=已存 key（快照）', () => {
    const rows = buildDependencyAliasRows(
      ['a-uuid', 'b-uuid'],
      options,
      { 'a-uuid': 'task-a', 'b-uuid': 'task-b' },
    );
    expect(rows.map((r) => ({ id: r.id, alias: r.alias, name: r.currentName }))).toEqual([
      { id: 'a-uuid', alias: 'task-a', name: 'task-a' },
      { id: 'b-uuid', alias: 'task-b', name: 'task-b' },
    ]);
    // 名字与别名一致 → 无漂移、无同名提示
    expect(rows.every((r) => !r.drifted && !r.duplicateName && !r.aliasIsId)).toBe(true);
  });

  it('上游改名（key=旧名，候选当前名=新名）→ drifted=true（别名不自动改）', () => {
    const rows = buildDependencyAliasRows(
      ['a-uuid'],
      [{ id: 'a-uuid', name: 'task-a-renamed' }],
      { 'a-uuid': 'task-a' },
    );
    expect(rows[0]).toMatchObject({
      id: 'a-uuid',
      alias: 'task-a',
      currentName: 'task-a-renamed',
      drifted: true,
      aliasIsId: false,
    });
  });

  it('别名已是 id 形态（降级）→ aliasIsId=true 且不算漂移（id 与名字无关）', () => {
    const rows = buildDependencyAliasRows(
      ['a-uuid'],
      [{ id: 'a-uuid', name: 'task-a' }],
      {},
    );
    expect(rows[0]).toMatchObject({ alias: 'a-uuid', aliasIsId: true, drifted: false });
  });

  it('候选同名 → duplicateName=true（该上游的名字形态别名会退化）', () => {
    const rows = buildDependencyAliasRows(
      ['a-uuid'],
      [
        { id: 'a-uuid', name: 'same-name' },
        { id: 'b-uuid', name: 'same-name' },
      ],
      { 'a-uuid': 'same-name' },
    );
    expect(rows[0].duplicateName).toBe(true);
  });

  it('候选里查不到（已删除/未加载）→ currentName=null，不做漂移判定', () => {
    const rows = buildDependencyAliasRows(['a-uuid'], [], { 'a-uuid': 'task-a' });
    expect(rows[0]).toMatchObject({ currentName: null, drifted: false, duplicateName: false });
  });

  it('空选中集 → 空清单（依赖区不渲染别名块）', () => {
    expect(buildDependencyAliasRows([], options, {})).toEqual([]);
    expect(buildDependencyAliasRows(undefined, options, {})).toEqual([]);
  });
});

/**
 * 提交载荷冻结（关键回归）：本次改动只加"可见性"，`dependencies` 映射必须
 * **逐字节不变**。以下 golden 期望值取自改动前的实现（与既有用例同源），任何
 * 语义漂移（键改名/降级规则变化/空集不再是 null）都会让本用例红。
 */
describe('提交载荷不变（G6 可见性改动的 golden 断言）', () => {
  it('buildDependenciesPayload 输出与改动前一致（含冲突/缺失/空集）', () => {
    const cases: Array<{
      selected: string[] | undefined;
      snapshot: Record<string, string>;
      expected: Record<string, string> | null;
    }> = [
      {
        selected: ['a-uuid', 'b-uuid'],
        snapshot: { 'a-uuid': 'task-a', 'b-uuid': 'task-b' },
        expected: { 'task-a': 'a-uuid', 'task-b': 'b-uuid' },
      },
      {
        selected: ['a-uuid', 'b-uuid'],
        // 同名降级：后者 key=id，value 语义位不丢
        snapshot: { 'a-uuid': 'task-a', 'b-uuid': 'task-a' },
        expected: { 'task-a': 'a-uuid', 'b-uuid': 'b-uuid' },
      },
      {
        selected: ['a-uuid'],
        snapshot: {},
        expected: { 'a-uuid': 'a-uuid' },
      },
      {
        selected: ['a-uuid', 'a-uuid'],
        snapshot: { 'a-uuid': 'task-a' },
        expected: { 'task-a': 'a-uuid' },
      },
      { selected: [], snapshot: {}, expected: null },
      { selected: undefined, snapshot: {}, expected: null },
    ];
    for (const c of cases) {
      expect(buildDependenciesPayload(c.selected, c.snapshot)).toEqual(c.expected);
    }
  });

  it('applyDependenciesPayload 的 dependencies 与载体键剥离行为不变', () => {
    const out = applyDependenciesPayload(
      { name: 't', upstreamDependencies: ['a-uuid', 'b-uuid'] },
      { 'a-uuid': 'task-a', 'b-uuid': 'task-b' },
    );
    expect(out).toEqual({ name: 't', dependencies: { 'task-a': 'a-uuid', 'task-b': 'b-uuid' } });
  });
});
