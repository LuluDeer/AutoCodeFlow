// @vitest-environment jsdom
/**
 * UX-04（本轮体验审查）：剪贴板「假成功」。
 *
 * 全站有 `utils/clipboard.ts` 的 `copyText()` 封装（writeText 失败降级
 * execCommand，**返回是否真正成功**），但三处调用点没迁移：
 *  ① ApiKeysSettings —— `navigator.clipboard?.writeText(x); setCopied(true);`
 *     无 await、无 catch，**无条件**置「已复制」；
 *  ② EventSubscriptionsSettings —— 同形；
 *  ③ ExecutorInstallWizardPage —— `.then(() => message.success(...))` 无
 *     rejection handler，剪贴板被拒时点了没反应也无报错。
 *
 * 危害最大的是 ①：API Key 明文**只在创建弹窗显示一次**（服务端只存
 * SHA-256）。用户在非 HTTPS / iframe 受限 / 权限被拒时看到按钮变成「已复制」
 * 便关掉弹窗，粘贴时才发现剪贴板是空的——而密钥再也拿不回来了。
 *
 * 本文件分两层守卫：
 *  - 行为层：mock 剪贴板失败，断言**不**出现成功提示、且出现失败提示；
 *  - 源码层：断言这三处不再有裸 `navigator.clipboard.writeText` 调用，
 *    防止未来新增调用点再走回 fire-and-forget。
 *
 * 反证：把任一处改回 `navigator.clipboard?.writeText(x); setCopied(true);`，
 * 行为层或源码层立即变红。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { copyText } from '../utils/clipboard';

const SRC = join(__dirname, '..');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf-8');

/** 去掉注释——注释里引用的旧写法不算违规。 */
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('UX-04 行为层：copyText 如实返回真实结果', () => {
  const realClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    if (realClipboard) Object.defineProperty(navigator, 'clipboard', realClipboard);
  });

  it('writeText 成功 → true', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
    });
    await expect(copyText('secret')).resolves.toBe(true);
  });

  it('writeText 被拒且 execCommand 也失败 → false（调用方必须据此报错）', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockRejectedValue(new Error('NotAllowedError')) },
      configurable: true,
    });
    // execCommand 在 jsdom 里不存在 → 降级路径 catch 后返回 false
    const ok = await copyText('secret');
    expect(ok).toBe(false);
  });

  it('writeText 被拒但 execCommand 成功 → true（降级生效，不该误报失败）', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockRejectedValue(new Error('NotAllowedError')) },
      configurable: true,
    });
    // 只有 copyText 内部会调 execCommand；这里模拟旧浏览器仍支持它
    const original = document.execCommand;
    (document as unknown as { execCommand: unknown }).execCommand = vi
      .fn()
      .mockReturnValue(true);
    try {
      await expect(copyText('secret')).resolves.toBe(true);
    } finally {
      (document as unknown as { execCommand: unknown }).execCommand = original;
    }
  });
});

describe('UX-04 源码层：三处调用点不得再 fire-and-forget', () => {
  // D-P1-2（设计审计 2026-09-22）：把 AppDeploymentPage（失败详情复制）与
  // ExecutionDetailPage（traceId 复制）两处裸 clipboard 也纳入守卫——它们此前
  // 一处静默 catch、一处 .then() 无 rejection 分支，非安全上下文下假成功/无反馈。
  const SITES = [
    'pages/settings/ApiKeysSettings.tsx',
    'pages/settings/EventSubscriptionsSettings.tsx',
    'pages/ExecutorInstallWizardPage.tsx',
    'pages/AppDeploymentPage.tsx',
    'pages/ExecutionDetailPage.tsx',
  ];

  it('不再直接调用 navigator.clipboard.writeText', () => {
    for (const file of SITES) {
      const src = stripComments(read(file));
      expect(
        /navigator\.clipboard\??\.writeText/.test(src),
        `${file} 仍在直接调用 navigator.clipboard.writeText`,
      ).toBe(false);
    }
  });

  it('三处都改用 copyText 并按返回值分支（成功才置已复制）', () => {
    for (const file of SITES) {
      const src = stripComments(read(file));
      expect(src, `${file} 未使用 copyText`).toContain('copyText(');
      // 必须对返回值做分支——只 await 不看结果仍会假成功。
      expect(
        /if\s*\(\s*ok\s*\)/.test(src),
        `${file} 未按 copyText 的返回值分支`,
      ).toBe(true);
    }
  });

  it('两处密钥弹窗在失败分支给出可执行提示（不是静默）', () => {
    // 密钥明文只显示一次，失败必须告诉用户「手动选中复制」。
    const apiKeys = stripComments(read('pages/settings/ApiKeysSettings.tsx'));
    const eventSub = stripComments(read('pages/settings/EventSubscriptionsSettings.tsx'));
    expect(apiKeys).toContain('apiKeys.result.copyFail');
    expect(eventSub).toContain('eventSub.createResult.copyFail');
    // 且走 message.error（而非 success）
    expect(apiKeys).toMatch(/message\.error\(t\('apiKeys\.result\.copyFail'\)\)/);
    expect(eventSub).toMatch(
      /message\.error\(t\('eventSub\.createResult\.copyFail'\)\)/,
    );
  });

  it('D-P1-2：AppDeploymentPage 与 ExecutionDetailPage 复制失败分支显式报错（非静默）', () => {
    // 回归：AppDeploymentPage 此前是 try/await/navigator.clipboard.writeText +
    // 空 catch（失败零反馈）；ExecutionDetailPage 此前是 .then(onSuccess, onError)
    // 但非安全上下文下 navigator.clipboard 为 undefined，同步 TypeError 且
    // .then 链不建立。两处都必须走 copyText 并在失败时 message.error。
    const deploy = stripComments(read('pages/AppDeploymentPage.tsx'));
    const execDetail = stripComments(read('pages/ExecutionDetailPage.tsx'));

    for (const [src, label] of [[deploy, 'AppDeploymentPage'], [execDetail, 'ExecutionDetailPage']] as const) {
      expect(src, `${label} 未使用 copyText`).toContain('copyText(');
      expect(/if\s*\(\s*ok\s*\)/.test(src), `${label} 未按返回值分支`).toBe(true);
      expect(/navigator\.clipboard\??\.writeText/.test(src), `${label} 仍裸调 navigator.clipboard.writeText`).toBe(false);
      // 失败分支必须 message.error，不得静默吞掉
      expect(/message\.error\(/.test(src), `${label} 复制失败未 message.error`).toBe(true);
    }
    // 失败文案走已有共享/专属键（common.copyFailed / execDetail.copyFail）
    expect(deploy).toMatch(/message\.error\(t\('common\.copyFailed'\)\)/);
    expect(execDetail).toMatch(/message\.error\(t\('execDetail\.copyFail'\)\)/);
  });

  it('i18n：三个 copyFail 键在 zh/en 两套词条里都存在', () => {
    const zh = read('locales/zh.ts');
    const en = read('locales/en.ts');
    for (const key of [
      'apiKeys.result.copyFail',
      'eventSub.createResult.copyFail',
      'install.copyFail',
    ]) {
      expect(zh, `${key} 在 zh 词条缺失`).toContain(`'${key}'`);
      expect(en, `${key} 在 en 词条缺失`).toContain(`'${key}'`);
    }
  });
});
