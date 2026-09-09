/**
 * NF-02: 上游依赖（编排）纯逻辑单测。
 *  - task-dependencies.ts：dependencies 映射提交序列化（空集显式 null/
 *    名称快照缺失 taskId 兜底）+ 编辑态回填（映射 → Select 值 + 快照）。
 */
import { describe, it, expect } from 'vitest';
import {
  buildDependenciesPayload,
  dependenciesFormValues,
} from '../pages/task-dependencies';

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
