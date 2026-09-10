/**
 * NF-02: 上游依赖（编排）纯逻辑单测。
 *  - task-dependencies.ts：dependencies 映射提交序列化（空集显式 null/
 *    名称快照缺失 taskId 兜底）+ 编辑态回填（映射 → Select 值 + 快照）。
 */
import { describe, it, expect } from 'vitest';
import {
  applyDependenciesPayload,
  buildDependenciesPayload,
  dependenciesFormValues,
} from '../pages/task-dependencies';

describe('applyDependenciesPayload（提交序列化 + 载体字段剥离）', () => {
  it('写入 dependencies 映射并删除表单载体 upstreamDependencies', () => {
    const out = applyDependenciesPayload(
      {
        name: 't',
        runtime: 'node',
        upstreamDependencies: ['a-uuid'],
      },
      { 'a-uuid': 'task-a' },
    );
    expect(out.dependencies).toEqual({ 'a-uuid': 'task-a' });
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

describe('buildDependenciesPayload（提交序列化）', () => {
  it('选中 taskId 列表 → {taskId: taskName} 映射', () => {
    expect(
      buildDependenciesPayload(['a-uuid', 'b-uuid'], {
        'a-uuid': 'task-a',
        'b-uuid': 'task-b',
      }),
    ).toEqual({ 'a-uuid': 'task-a', 'b-uuid': 'task-b' });
  });

  it('空集 → 显式 null（PATCH 缺省=保留旧值，必须发 null 才能清空依赖链）', () => {
    expect(buildDependenciesPayload([], { 'a-uuid': 'task-a' })).toBeNull();
  });

  it('字段未挂载（undefined）→ 归 null', () => {
    expect(buildDependenciesPayload(undefined, {})).toBeNull();
  });

  it('名称快照缺失（任务刚被删除）→ taskId 兜底', () => {
    expect(buildDependenciesPayload(['a-uuid'], {})).toEqual({
      'a-uuid': 'a-uuid',
    });
  });

  it('非数组值 → null', () => {
    expect(
      buildDependenciesPayload('not-array' as unknown as string[], {}),
    ).toBeNull();
  });
});

describe('dependenciesFormValues（编辑态回填）', () => {
  it('null/缺省 → 空选中集 + 空快照', () => {
    expect(dependenciesFormValues(null)).toEqual({ selected: [], nameSnapshot: {} });
    expect(dependenciesFormValues(undefined)).toEqual({ selected: [], nameSnapshot: {} });
  });

  it('已有映射 → taskId 列表 + 名称快照原样回填', () => {
    const { selected, nameSnapshot } = dependenciesFormValues({
      'a-uuid': 'task-a',
      'b-uuid': 'task-b',
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
