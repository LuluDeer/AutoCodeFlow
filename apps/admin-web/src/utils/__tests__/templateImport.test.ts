/**
 * P1-5：模板清单导入的客户端校验与 key 冲突预览纯函数测试。
 * 判据与后端 task-template.manifest.ts 对齐：扁平清单、key 唯一、不覆盖。
 */
import { describe, it, expect } from 'vitest';
import {
  parseTemplateImportText,
  previewTemplateConflicts,
} from '../templateImport';

const validManifest = JSON.stringify({
  name: 'custom-monthly-report',
  version: '1.0.0',
  description: '每月报表生成模板',
  capabilities: [],
  params: {},
  entrypoints: [],
  config: { triggerType: 'manual', runtime: 'python', entrypoint: 'report.py' },
});

describe('parseTemplateImportText — 校验', () => {
  it('合法清单通过，字段原样保留', () => {
    const parsed = parseTemplateImportText(validManifest);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.payload.name).toBe('custom-monthly-report');
      expect(parsed.payload.version).toBe('1.0.0');
    }
  });

  it('非法 JSON → notJson；顶层非对象 → notObject', () => {
    expect(parseTemplateImportText('oops').ok).toBe(false);
    const arr = parseTemplateImportText('[1,2]');
    expect(arr.ok).toBe(false);
    if (!arr.ok) expect(arr.issues[0].code).toBe('notObject');
  });

  it('name 缺失 / 空白 / 非法字符 → 对应问题码', () => {
    const missing = parseTemplateImportText(JSON.stringify({ version: '1.0.0', description: 'd' }));
    if (!missing.ok) expect(missing.issues.some((i) => i.code === 'nameMissing')).toBe(true);

    const blank = parseTemplateImportText(JSON.stringify({ name: '  ', version: '1.0.0', description: 'd' }));
    if (!blank.ok) expect(blank.issues.some((i) => i.code === 'nameBlank')).toBe(true);

    const bad = parseTemplateImportText(JSON.stringify({ name: 'My-Key', version: '1.0.0', description: 'd' }));
    if (!bad.ok) expect(bad.issues.some((i) => i.code === 'nameInvalid')).toBe(true);
  });

  it('version 缺失 / 非语义化版本 → 对应问题码', () => {
    const missing = parseTemplateImportText(JSON.stringify({ name: 'k', description: 'd' }));
    if (!missing.ok) expect(missing.issues.some((i) => i.code === 'versionMissing')).toBe(true);

    const bad = parseTemplateImportText(JSON.stringify({ name: 'k', version: 'v1', description: 'd' }));
    if (!bad.ok) expect(bad.issues.some((i) => i.code === 'versionInvalid')).toBe(true);
  });

  it('description 缺失 / 空白 / 超长 → 对应问题码', () => {
    const missing = parseTemplateImportText(JSON.stringify({ name: 'k', version: '1.0.0' }));
    if (!missing.ok) expect(missing.issues.some((i) => i.code === 'descriptionMissing')).toBe(true);

    const blank = parseTemplateImportText(JSON.stringify({ name: 'k', version: '1.0.0', description: '' }));
    if (!blank.ok) expect(blank.issues.some((i) => i.code === 'descriptionBlank')).toBe(true);

    const long = parseTemplateImportText(
      JSON.stringify({ name: 'k', version: '1.0.0', description: 'x'.repeat(501) }),
    );
    if (!long.ok) expect(long.issues.some((i) => i.code === 'descriptionTooLong')).toBe(true);
  });

  it('config 给了必须是对象', () => {
    const bad = parseTemplateImportText(JSON.stringify({ name: 'k', version: '1.0.0', description: 'd', config: [] }));
    if (!bad.ok) expect(bad.issues.some((i) => i.code === 'configNotObject')).toBe(true);
  });
});

describe('previewTemplateConflicts — key 冲突预览', () => {
  const existing = [
    { id: 'tpl-1', key: 'custom-monthly-report', name: '月报模板' },
  ];

  it('key 已存在 → key 冲突；新 key 无冲突', () => {
    const hit = previewTemplateConflicts({ name: 'custom-monthly-report' }, existing);
    expect(hit).toHaveLength(1);
    expect(hit[0].existingName).toBe('月报模板');

    const free = previewTemplateConflicts({ name: 'brand-new-key' }, existing);
    expect(free).toHaveLength(0);
  });
});
