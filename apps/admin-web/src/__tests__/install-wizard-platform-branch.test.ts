/**
 * DEEP-AUDIT B·1.2 / B·1.4：安装向导第 4 步平台分支 + 检测超时窗口。
 *
 * ## 这条守的是什么
 *
 * install.sh 依赖 systemd 与 POSIX 路径，**仅支持 Linux**——非 Linux 环境
 * 一进来就 `exit 1` 并打印手动部署指引。向导此前无差别展示 curl|bash 一键
 * 命令：windows/darwin 用户照抄得到一条**必然失败**的命令。
 *
 * 修复：第 4 步按所选安装包平台分支——windows/darwin 展示「桌面安装包下载 +
 * 手动部署指引」，仅 linux 展示一键脚本；检测窗口 60s→300s（artifact 下载、
 * npm 依赖安装、弱网首心跳都可能超过 60s，旧窗口把正常安装中段误报成超时）。
 *
 * ## 为什么用纯函数 + 源码契约断言
 *
 * 走完整向导需要依次选类型/平台/包（多层 gating），与本缺陷无关且脆弱；
 * 分支口径收敛在 classifyOneClickPlatform 纯函数里可直接断言，渲染面与
 * locale 键用源码契约钉住（同 install-wizard-network-mode.test.ts 惯例）。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import * as path from 'node:path';
import {
  classifyOneClickPlatform,
} from '../pages/ExecutorInstallWizardPage';

function findRepoRoot(from: string): string {
  let dir = from;
  for (let i = 0; i < 12; i++) {
    if (existsSync(path.join(dir, 'apps', 'executor-node', 'src', 'config.ts'))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  throw new Error(`repo root not found above ${from}`);
}

const ROOT = findRepoRoot(__dirname);
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf-8');
const WIZARD = 'apps/admin-web/src/pages/ExecutorInstallWizardPage.tsx';
const INSTALL_SH = 'scripts/install.sh';
const ZH = 'apps/admin-web/src/locales/zh.ts';
const EN = 'apps/admin-web/src/locales/en.ts';

describe('B·1.2: classifyOneClickPlatform 平台归类', () => {
  it('windows_* → windows（手动部署面板）', () => {
    expect(classifyOneClickPlatform('windows_amd64')).toBe('windows');
  });

  it('darwin_* → darwin（手动部署面板）', () => {
    expect(classifyOneClickPlatform('darwin_amd64')).toBe('darwin');
    expect(classifyOneClickPlatform('darwin_arm64')).toBe('darwin');
  });

  it('linux_* → linux（一键脚本可用）', () => {
    expect(classifyOneClickPlatform('linux_amd64')).toBe('linux');
    expect(classifyOneClickPlatform('linux_arm64')).toBe('linux');
  });

  it('未选平台 → unknown（维持既有一键脚本展示，不武断拦截）', () => {
    expect(classifyOneClickPlatform(undefined)).toBe('unknown');
    expect(classifyOneClickPlatform('')).toBe('unknown');
    expect(classifyOneClickPlatform('freebsd_x64')).toBe('unknown');
  });
});

describe('B·1.2: 第 4 步渲染分支（源码契约）', () => {
  const src = read(WIZARD);

  it('分支依据是所选安装包平台（selectedPackage.platform 优先）', () => {
    expect(src).toContain(
      'classifyOneClickPlatform(selectedPackage?.platform ?? selectedPlatform)',
    );
  });

  it('一键脚本块仅在非手动平台渲染；手动平台渲染指引 + 下载 + 分平台步骤', () => {
    expect(src).toMatch(/!\s*isManualPlatform && \(/);
    expect(src).toMatch(/isManualPlatform && \(/);
    // 手动面板三要素：平台警示、安装包下载按钮、手动步骤列表
    expect(src).toContain("t('install.manualPlatform.title'");
    expect(src).toContain('handleDownloadPackage');
    expect(src).toContain("t('install.manualPlatform.step3Win'");
    expect(src).toContain("t('install.manualPlatform.step3Mac'");
  });

  it('install.sh 对非 Linux 平台 exit 1（一键脚本在 windows/darwin 必失败的事实依据）', () => {
    const sh = read(INSTALL_SH);
    expect(sh).toMatch(/case "\$\(uname -s\)"/);
    expect(sh).toMatch(/Linux\*\) ;;/);
    expect(sh).toContain('一键安装脚本仅支持 Linux');
    expect(sh).toMatch(/exit 1 ;;/);
  });

  it('locale 键 zh/en 成对存在（手动面板全部文案）', () => {
    const keys = [
      'install.manualPlatform.title',
      'install.manualPlatform.desc',
      'install.manualPlatform.pkgTitle',
      'install.manualPlatform.download',
      'install.manualPlatform.stepsTitle',
      'install.manualPlatform.step1',
      'install.manualPlatform.step2',
      'install.manualPlatform.step3Win',
      'install.manualPlatform.step3Mac',
    ];
    const zh = read(ZH);
    const en = read(EN);
    for (const k of keys) {
      expect(zh).toContain(`'${k}':`);
      expect(en).toContain(`'${k}':`);
    }
  });
});

describe('B·1.4: 检测超时窗口 60s → 300s', () => {
  it('POLL_TIMEOUT_MS 为 300000（300s）', () => {
    const src = read(WIZARD);
    expect(src).toMatch(/const POLL_TIMEOUT_MS = 300000;/);
  });

  it('第 5 步文案同步为「最长等待 5 分钟」', () => {
    expect(read(ZH)).toMatch(/最长等待 5 分钟/);
    expect(read(EN)).toMatch(/waiting up to 5 minutes/);
  });
});
