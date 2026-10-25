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
  dependenciesFormValues,
  humanizeDependencyTaskIds,
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

