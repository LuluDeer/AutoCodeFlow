/**
 * P1-5：任务定义导入的客户端校验与冲突预览纯函数测试。
 * 判据与后端 POST /tasks/import 契约对齐：单条定义、重名自动加后缀、不覆盖。
 */
import { describe, it, expect } from 'vitest';
import {
  parseTaskImportText,
  previewTaskConflicts,
} from '../taskImport';

const validPayload = JSON.stringify({
  schemaVersion: '1',
  exportedAt: '2026-11-15T00:00:00.000Z',
  task: {
    name: '每日订单同步',
    triggerType: 'cron',
    runtime: 'python',
    cronExpr: '0 2 * * *',
  },
});

describe('parseTaskImportText — 校验', () => {
  it('合法定义通过，保留 schemaVersion 与 task 原样', () => {
    const parsed = parseTaskImportText(validPayload);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.payload.schemaVersion).toBe('1');
      expect(parsed.payload.task.name).toBe('每日订单同步');
    }
  });

  it('非法 JSON → notJson', () => {
    const parsed = parseTaskImportText('{ not json');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.issues[0].code).toBe('notJson');
  });

  it('数组载荷拒绝：后端只收单条定义', () => {
    const parsed = parseTaskImportText('[{"task": {}}]');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.issues[0].code).toBe('arrayNotSupported');
  });

  it('顶层非对象 → notObject', () => {
    const parsed = parseTaskImportText('"hello"');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.issues[0].code).toBe('notObject');
  });

  it('缺 schemaVersion / 版本不符 → 对应问题码', () => {
    const noVersion = parseTaskImportText(JSON.stringify({ task: { name: 'x', triggerType: 'manual' } }));
    expect(noVersion.ok).toBe(false);
    if (!noVersion.ok) expect(noVersion.issues.some((i) => i.code === 'schemaVersionMissing')).toBe(true);

    const wrongVersion = parseTaskImportText(JSON.stringify({ schemaVersion: '2', task: { name: 'x', triggerType: 'manual' } }));
    expect(wrongVersion.ok).toBe(false);
    if (!wrongVersion.ok) expect(wrongVersion.issues.some((i) => i.code === 'schemaVersionMismatch')).toBe(true);
  });

  it('缺 task / task 非对象 → 对应问题码', () => {
    const missing = parseTaskImportText(JSON.stringify({ schemaVersion: '1' }));
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.issues[0].code).toBe('taskMissing');

    const notObj = parseTaskImportText(JSON.stringify({ schemaVersion: '1', task: 'x' }));
    expect(notObj.ok).toBe(false);
    if (!notObj.ok) expect(notObj.issues[0].code).toBe('taskNotObject');
  });

  it('name 缺失 / 非字符串 / 空白 / 超长 → 对应问题码', () => {
    const base = { schemaVersion: '1', task: { triggerType: 'manual' } };
    const missing = parseTaskImportText(JSON.stringify(base));
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.issues.some((i) => i.code === 'nameMissing')).toBe(true);

    const num = parseTaskImportText(JSON.stringify({ ...base, task: { name: 5, triggerType: 'manual' } }));
    if (!num.ok) expect(num.issues.some((i) => i.code === 'nameNotString')).toBe(true);

    const blank = parseTaskImportText(JSON.stringify({ ...base, task: { name: '   ', triggerType: 'manual' } }));
    if (!blank.ok) expect(blank.issues.some((i) => i.code === 'nameBlank')).toBe(true);

    const long = parseTaskImportText(
      JSON.stringify({ ...base, task: { name: 'a'.repeat(256), triggerType: 'manual' } }),
    );
    if (!long.ok) expect(long.issues.some((i) => i.code === 'nameTooLong')).toBe(true);
  });

  it('triggerType 必填且在值域内；runtime 可选但在值域内', () => {
    const missingTrigger = parseTaskImportText(
      JSON.stringify({ schemaVersion: '1', task: { name: 'x' } }),
    );
    if (!missingTrigger.ok) {
      expect(missingTrigger.issues.some((i) => i.code === 'triggerTypeMissing')).toBe(true);
    }

    const badTrigger = parseTaskImportText(
      JSON.stringify({ schemaVersion: '1', task: { name: 'x', triggerType: 'webhook' } }),
    );
    if (!badTrigger.ok) {
      expect(badTrigger.issues.some((i) => i.code === 'triggerTypeInvalid')).toBe(true);
    }

    const badRuntime = parseTaskImportText(
      JSON.stringify({ schemaVersion: '1', task: { name: 'x', triggerType: 'manual', runtime: 'docker' } }),
    );
    if (!badRuntime.ok) expect(badRuntime.issues.some((i) => i.code === 'runtimeInvalid')).toBe(true);
  });

  it('id 给了就必须是 UUID 形态', () => {
    const badId = parseTaskImportText(
      JSON.stringify({ schemaVersion: '1', task: { name: 'x', triggerType: 'manual', id: 'not-a-uuid' } }),
    );
    if (!badId.ok) expect(badId.issues.some((i) => i.code === 'idInvalid')).toBe(true);
  });
});

describe('previewTaskConflicts — 冲突预览', () => {
  const existing = [
    { id: '11111111-1111-1111-1111-111111111111', name: '每日订单同步', projectId: 'proj-a' },
    { id: '22222222-2222-2222-2222-222222222222', name: '巡检任务', projectId: 'proj-a' },
  ];

  const payload = (over: Record<string, unknown>) =>
    ({ schemaVersion: '1', task: { name: 'x', triggerType: 'manual', ...over } }) as never;

  it('重名（忽略大小写与首尾空白）→ name 冲突', () => {
    const conflicts = previewTaskConflicts(payload({ name: '  每日订单同步 ' }), existing, 'proj-a');
    expect(conflicts.some((c) => c.type === 'name')).toBe(true);
  });

  it('id 已存在 → id 冲突', () => {
    const conflicts = previewTaskConflicts(
      payload({ id: '22222222-2222-2222-2222-222222222222' }),
      existing,
      'proj-a',
    );
    expect(conflicts.some((c) => c.type === 'id')).toBe(true);
  });

  it('载荷项目与当前项目不一致 → project 冲突；同项目不报', () => {
    const cross = previewTaskConflicts(payload({ projectId: 'proj-b' }), existing, 'proj-a');
    expect(cross.some((c) => c.type === 'project')).toBe(true);

    const same = previewTaskConflicts(payload({ projectId: 'proj-a' }), existing, 'proj-a');
    expect(someType(same, 'project')).toBe(false);
  });

  it('无冲突时返回空数组', () => {
    const conflicts = previewTaskConflicts(payload({ name: '全新任务' }), existing, 'proj-a');
    expect(conflicts).toHaveLength(0);
  });
});

function someType(list: { type: string }[], type: string): boolean {
  return list.some((c) => c.type === type);
}
