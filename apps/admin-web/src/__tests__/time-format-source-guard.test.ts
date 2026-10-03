/**
 * 时间格式化源码守卫（功能细节一致性 · 2026-10-03 收敛散落 toLocale* 直调）。
 *
 * ## 为什么需要这条守卫
 *
 * utils/timeFormat.ts 是全站时间展示的唯一设施（formatDateTime 走 currentLocale()
 * 跟随 i18n 应用语言），但页面/组件仍散落裸调 toLocaleString/toLocaleDateString：
 * 其中 TaskListPage 上次执行列 tooltip 是**不带 locale** 的裸调，跟随浏览器 locale
 * ——英文浏览器跑中文界面时显示 MM/DD/YYYY，与界面语言割裂，且与走
 * formatDateTime 的页面格式不统一。本次把 8 个文件 12 处 datetime 直调收敛到
 * formatDateTime（「仅时刻」形态的就地豁免，理由见各调用点注释）。
 *
 * 与 raw-enum-labels.ux06 / i18n-source-guard 同形态：源码层锚定，把任一处改回
 * 裸调立即变红。确需新豁免：优先在 timeFormat.ts 落共享函数；确需就地保留的，
 * 在 ALLOWLIST 登记（文件相对路径 → 允许次数）并在调用点附「为什么」注释。
 *
 * toLocaleTimeString（仅时刻：趋势图同日 tooltip、MainLayout 挂钟）不在禁止
 * 之列——共享设施没有「仅时刻」函数，且挂钟本就在 layouts（不在扫描面）。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(__dirname, '..');
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

function collectFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      collectFiles(p, acc);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      acc.push(p);
    }
  }
  return acc;
}

/** 豁免清单：文件相对 src 的 posix 路径 → 允许的裸调次数上限。当前为空——
 *  pages/components 内已无 toLocaleString/toLocaleDateString 直调。 */
const ALLOWLIST: Record<string, number> = {};

const TARGET_DIRS = ['pages', 'components'];

describe('时间格式化源码守卫：pages/components 禁止裸调 toLocaleString/toLocaleDateString', () => {
  const files = TARGET_DIRS.flatMap((dir) => collectFiles(join(SRC, dir)));

  it('扫描面非空（反永真：目录遍历本身没坏）', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('全部源文件零裸调（豁免清单外不允许出现，改走 utils/timeFormat）', () => {
    const offenders: string[] = [];
    for (const f of files) {
      const rel = f.slice(SRC.length + 1).replace(/\\/g, '/');
      const n = (stripComments(readFileSync(f, 'utf-8')).match(
        /toLocale(String|DateString)\(/g,
      ) ?? []).length;
      const quota = ALLOWLIST[rel] ?? 0;
      if (n > quota) offenders.push(`${rel}: ${n} 处（配额 ${quota}）`);
    }
    expect(
      offenders,
      `以下文件仍在裸调 toLocaleString/toLocaleDateString，应改走 utils/timeFormat 的 ` +
        `formatDateTime 等共享函数（locale 跟随 i18n 而非浏览器）:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('锚定收敛成果：本次 8 个文件均已 import formatDateTime（改回裸调即失去此断言）', () => {
    for (const rel of [
      'pages/AppDeploymentPage.tsx',
      'pages/ExecutorListPage.tsx',
      'pages/ExecutorDetailPage.tsx',
      'pages/TaskListPage.tsx',
      'pages/UserManagementPage.tsx',
      'pages/audit/index.tsx',
      'pages/settings/SecuritySettings.tsx',
      'components/executor/ExecutorCardGrid.tsx',
    ]) {
      expect(readFileSync(join(SRC, rel), 'utf-8'), `${rel} 未引入 formatDateTime`).toContain(
        'formatDateTime',
      );
    }
  });

  it('ExecutorDetailPage 仅存的 toLocale 直调是趋势图同日 tooltip 的「仅时刻」形态', () => {
    const src = stripComments(readFileSync(join(SRC, 'pages/ExecutorDetailPage.tsx'), 'utf-8'));
    expect(src, '同日分支的 toLocaleTimeString（仅时刻）不应被移除').toContain('toLocaleTimeString(');
    expect(src, '跨日分支应已收敛 formatDateTime').not.toMatch(/toLocale(String|DateString)\(/);
  });
});
