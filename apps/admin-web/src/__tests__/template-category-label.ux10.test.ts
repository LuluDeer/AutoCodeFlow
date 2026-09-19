// @vitest-environment jsdom
/**
 * UX-10（本轮体验审查）：模板分类的标签与配色都以**中文显示名**为键。
 *
 * 数据侧事实：`category` 在 admin-api 里是自由文本 `varchar(32)`
 * （task-template.entity.ts:37），官方种子写死中文
 * （task-template.constants.ts 的「备份/巡检/同步/清理/通知」）。
 *
 * 前端两处缺陷：
 *  ① `{tpl.category}` 直接渲染 → **英文界面下分类标签仍是中文**，而同一张
 *     卡片上相邻的触发方式已走 t() 显示 "Cron scheduled"，中英混排；
 *  ② `CATEGORY_COLOR` 以中文显示名为键 → 一旦有人把分类文案改成英文/本地化，
 *     配色**静默退回 default 灰**（"改个文案就掉色"）。
 *
 * 修法：加 分类→i18n key 映射，渲染过 t()；未知分类回退原始值（用户可自建
 * 任意分类，露原文才可诊断），配色仍回退 default。
 *
 * 反证：把渲染改回 `{tpl.category}`，行为层用例立即变红（英文下渲染出中文）。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(__dirname, '..');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf-8');
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const TPL_PAGE = stripComments(read('pages/TaskTemplatesPage.tsx'));

describe('UX-10 行为层：分类标签按语言渲染', () => {
  let zhDict: Record<string, string>;
  let enDict: Record<string, string>;

  beforeEach(async () => {
    zhDict = (await import('../locales/zh')).default as unknown as Record<string, string>;
    enDict = (await import('../locales/en')).default as unknown as Record<string, string>;
  });
  afterEach(() => vi.resetModules());

  it('五个官方分类在两套词条里都有标签', () => {
    const keys = [
      'templates.category.backup',
      'templates.category.inspection',
      'templates.category.sync',
      'templates.category.cleanup',
      'templates.category.notify',
    ];
    for (const k of keys) {
      expect(zhDict[k], `${k} 缺 zh 词条`).toBeTruthy();
      expect(enDict[k], `${k} 缺 en 词条`).toBeTruthy();
    }
  });

  it('en 词条里分类标签**不含中文**（这正是本缺陷的用户可见症状）', () => {
    const cjk = /[\u4e00-\u9fff]/;
    for (const k of [
      'templates.category.backup',
      'templates.category.inspection',
      'templates.category.sync',
      'templates.category.cleanup',
      'templates.category.notify',
    ]) {
      expect(cjk.test(enDict[k]), `en 的 ${k} 仍是中文：「${enDict[k]}」`).toBe(false);
    }
  });

  it('zh 词条与后端种子值一致（不改变既有中文界面观感）', () => {
    // 种子值来自 admin-api 的 task-template.constants.ts。
    expect(zhDict['templates.category.backup']).toBe('备份');
    expect(zhDict['templates.category.inspection']).toBe('巡检');
    expect(zhDict['templates.category.sync']).toBe('同步');
    expect(zhDict['templates.category.cleanup']).toBe('清理');
    expect(zhDict['templates.category.notify']).toBe('通知');
  });

  it('后端种子里的每个分类都已在 CATEGORY_T_KEY 里有映射（防新增种子漏翻译）', () => {
    // 读后端常量作为**事实源**，避免前端映射表与种子脱节。
    const seed = readFileSync(
      join(SRC, '..', '..', 'admin-api', 'src', 'modules', 'task-template', 'task-template.constants.ts'),
      'utf-8',
    );
    const categories = [...seed.matchAll(/category:\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(categories.length).toBeGreaterThanOrEqual(5); // 有齿：种子表不能被清空
    for (const c of categories) {
      expect(
        TPL_PAGE.includes(`${c}:`),
        `后端分类「${c}」在 CATEGORY_T_KEY / CATEGORY_COLOR 里没有条目`,
      ).toBe(true);
    }
  });
});

describe('UX-10 源码层：渲染必须过 categoryLabel', () => {
  it('不再直接渲染 {tpl.category}', () => {
    expect(TPL_PAGE).not.toMatch(/\{tpl\.category\}/);
    expect(TPL_PAGE).not.toMatch(/>\s*\{tpl\.category\}\s*</);
  });

  it('改用 categoryLabel(tpl.category, t)', () => {
    expect(TPL_PAGE).toContain('categoryLabel(tpl.category, t)');
  });

  it('categoryLabel 对未知分类回退原始值（用户自建分类不能被吞掉）', () => {
    // 提取函数体，验证回退分支存在且返回入参本身
    const m = /function categoryLabel\(([\s\S]*?)\n\}/.exec(TPL_PAGE);
    expect(m, '找不到 categoryLabel').toBeTruthy();
    const body = m![1];
    expect(body).toMatch(/return\s+key\s*\?\s*t\(key\)\s*:\s*category/);
  });

  it('配色表仍以分类为键（颜色不因引入 i18n 而失联）', () => {
    expect(TPL_PAGE).toMatch(/CATEGORY_COLOR\[tpl\.category\]/);
  });
});
