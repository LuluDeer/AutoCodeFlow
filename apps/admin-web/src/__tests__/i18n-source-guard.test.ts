/**
 * SEC-02 续（生产故障）：i18n **源码守卫**——代码里 `t('...')` 用到的字面量 key
 * 必须在字典里真实存在。
 *
 * ## 为什么需要这条守卫
 *
 * 已有的 i18n-infra.test.tsx 只比 `zh` 与 `en` 的 key 集合是否一致，它拦不住
 * "两边都没加"的情形：此时 i18next 查不到 key，**直接把 key 原样渲染到界面上**
 * （`secretsEditor.alertTitle` 这种字符串），既不报错也不影响构建。本次生产
 * 故障就是这一形态——凭据编辑器整体漏了文案键，界面上一片裸 key。
 *
 * 与"漏翻"的区别：漏翻是体验降级，漏定义是**功能看起来坏了**（用户读到的不是
 * 文案而是标识符）。两者的检测面也不同：漏翻靠中英集合比对，漏定义只能靠
 * "源码引用面 ⊆ 字典定义面"这条判据。
 *
 * ## 只查字面量实参
 *
 * 代码里有少量查表式调用（`t(TASK_ACTION_LABEL_KEY[kind])`、`` t(`projects.role.${role}`) ``
 * 等），实参不是字面量——静态无法枚举其取值，故此处只覆盖字面量形态。这不是
 * 妥协：本次漏的 key 全是字面量形态，且字面量是绝大多数用法。
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import zh from '../locales/zh';
import en from '../locales/en';

const SRC_ROOT = resolve(__dirname, '..');

function collectSourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (entry === '__tests__' || entry === 'locales') continue;
      collectSourceFiles(p, acc);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      acc.push(p);
    }
  }
  return acc;
}

/** 抽取 `t('literal')` / `t("literal")` 形式的 key。 */
function extractLiteralKeys(src: string): string[] {
  const keys: string[] = [];
  for (const m of src.matchAll(/\bt\(\s*(['"])([^'"]+)\1/g)) {
    keys.push(m[2]);
  }
  return keys;
}

describe('i18n 源码守卫：t() 用到的字面量 key 必须已在字典中定义', () => {
  const files = collectSourceFiles(SRC_ROOT);

  it('扫描面非空（反永真：目录遍历本身没坏）', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('所有字面量 key 都存在于 zh 字典（否则界面渲染裸 key）', () => {
    const missing = new Map<string, string>();
    for (const file of files) {
      const src = readFileSync(file, 'utf-8');
      for (const key of extractLiteralKeys(src)) {
        if (!(key in zh) && !missing.has(key)) {
          missing.set(key, file.replace(SRC_ROOT, '').replace(/\\/g, '/'));
        }
      }
    }
    // 打印出"key → 首个引用文件"，让失败信息可直接定位（而不是一串裸 key）
    expect([...missing.entries()].map(([k, f]) => `${k} (${f})`)).toEqual([]);
  });

  it('en 字典同样覆盖（en 缺失会回退中文，属静默非预期）', () => {
    const missing: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, 'utf-8');
      for (const key of extractLiteralKeys(src)) {
        if (!(key in en) && !missing.includes(key)) missing.push(key);
      }
    }
    expect(missing).toEqual([]);
  });

  it('守卫自身有牙：人为构造一个不存在的 key 会被判定为缺失', () => {
    // 反证：这段源码字符串模拟"代码引用了未定义 key"，抽取逻辑必须能抓出来，
    // 否则上面的断言可能因为正则写错而恒真（"守卫假绿"是守卫类测试的通病）。
    const fake = "const t = (k: string) => k;\nt('secretsEditor.definitelyNotDefined');";
    const keys = extractLiteralKeys(fake);
    expect(keys).toContain('secretsEditor.definitelyNotDefined');
    expect('secretsEditor.definitelyNotDefined' in zh).toBe(false);
  });
});

describe('SEC-02 续：凭据编辑器的文案键齐备（本次故障的直接成因）', () => {
  const REQUIRED = [
    'taskForm.field.secrets',
    'taskForm.field.secretsHelp',
    'secretsEditor.alertTitle',
    'secretsEditor.alertDesc',
    'secretsEditor.empty',
    'secretsEditor.keyPlaceholder',
    'secretsEditor.valuePlaceholder',
    'secretsEditor.maskedPlaceholder',
    'secretsEditor.add',
    'secretsEditor.remove',
    'secretsEditor.clearAll',
    'secretsEditor.tooltip',
    'secretsEditor.touchedWarning',
  ];

  it.each(REQUIRED)('%s 在 zh/en 均已定义', (key) => {
    expect(key in zh).toBe(true);
    expect(key in en).toBe(true);
    expect((zh as Record<string, string>)[key]?.length).toBeGreaterThan(0);
    expect((en as Record<string, string>)[key]?.length).toBeGreaterThan(0);
  });

  it('SecretsEditor 组件文件存在且引用的 key 全在上面这份清单里', () => {
    const comp = resolve(SRC_ROOT, 'components/SecretsEditor.tsx');
    expect(existsSync(comp)).toBe(true);
    const keys = extractLiteralKeys(readFileSync(comp, 'utf-8'));
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) expect(REQUIRED).toContain(k);
  });
});
