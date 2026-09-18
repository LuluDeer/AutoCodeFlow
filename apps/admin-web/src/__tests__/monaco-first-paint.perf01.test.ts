// @vitest-environment node
/**
 * PERF-01（本轮体验审查）：monaco 编辑器被拉进**首屏**，代价 651 KB gzip。
 *
 * 症状：构建产物 `dist/index.html`（= 浏览器首屏要拉的全部资源清单）里同时有
 *   <link rel="modulepreload" href="/assets/vendor-monaco-*.js">
 *   <link rel="stylesheet"    href="/assets/vendor-monaco-*.css">
 * 而 vendor-monaco 实测 2.53 MB raw / **651 KB gzip**，外加 74 KB 的
 * render-blocking CSS——是首屏最大的一笔，且登录页用户完全用不到。
 *
 * 根因：`vite.config.ts` 的 manualChunks 里有一行
 *   ['vendor-monaco', ['@monaco-editor/react', 'monaco-editor']]
 * 注释写着「monaco 主包不进首屏 chunk」，实际效果相反：把 monaco 提成**共享
 * chunk** 后，只要有任何静态可达模块与该 chunk 产生静态边，Vite 就会把整个
 * chunk 当作 entry 的静态依赖预加载——GlueEditor 是不是 lazy 已经不重要。
 *
 * 修法：删掉该 manualChunks 条目，走 Vite 默认分包（monaco 收进 lazy 的
 * GlueEditor chunk）。
 *
 * 本守卫直接读**构建产物**而不是读配置：配置怎么写、Vite 怎么解释、产物最终
 * 是什么样，三者可以不一致（本缺陷就是配置注释与产物行为完全相反）。只有读
 * 产物才能真正钉住「首屏不下 monaco」这个用户可见的结果。
 *
 * 反证：把 manualChunks 那行加回去并重新构建，本文件立即变红。
 *
 * 产物缺失时的行为（关键）：本地未构建时 **skip**（不该阻塞单测），但在 CI 里
 * **fail**。原因见下面 `describe` 上方的说明——一个「读不到产物就 skip」的守卫
 * 在 CI 步骤顺序被改回 test→build 时会**静默变成空转**（永远 skip、永远绿），
 * 而它要防的恰恰是只在产物里才看得见的回归。宁可红一次提醒排序，也不要一个
 * 看着在、其实不在的闸。
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DIST = join(__dirname, '..', '..', 'dist');
const INDEX_HTML = join(DIST, 'index.html');
const hasBuild = existsSync(INDEX_HTML);
const isCI = !!process.env.CI;

// 在 CI 里，产物必须存在：`.github/workflows/ci.yml` 的 admin-web-build job
// 已把 `npm run build` 排在 `npm test` **之前**。若这里读到 hasBuild=false，
// 说明该顺序被改回了 test→build（或 build 被删）——此时本守卫会变成空转，
// 必须显式报错而不是安静跳过。
if (isCI && !hasBuild) {
  throw new Error(
    'PERF-01 守卫无法执行：CI 里找不到 apps/admin-web/dist/index.html。' +
      '本守卫读构建产物断言「monaco 不进首屏」，请在 ci.yml 的 admin-web-build ' +
      'job 里把 `npm run build` 排在 `npm test` 之前。',
  );
}

/** 首屏资源 = index.html 里所有 modulepreload + stylesheet + module script。 */
function firstPaintRefs(): string[] {
  const html = readFileSync(INDEX_HTML, 'utf-8');
  const refs: string[] = [];
  for (const m of html.matchAll(
    /<link[^>]*rel="(?:modulepreload|stylesheet)"[^>]*href="([^"]+)"/g,
  )) {
    refs.push(m[1]);
  }
  for (const m of html.matchAll(/<script[^>]*type="module"[^>]*src="([^"]+)"/g)) {
    refs.push(m[1]);
  }
  return refs;
}

describe.skipIf(!hasBuild)('PERF-01：monaco 不得进入首屏', () => {
  it('index.html 的首屏资源清单里没有任何 monaco chunk / CSS', () => {
    const refs = firstPaintRefs();
    // 有齿：清单必须非空，否则「没有 monaco」是空洞成立。
    expect(refs.length).toBeGreaterThanOrEqual(5);
    const monaco = refs.filter((r) => /monaco/i.test(r));
    expect(
      monaco,
      `首屏仍在预加载 monaco：${monaco.join(', ')}`,
    ).toEqual([]);
  });

  it('monaco 确实被拆到了 GlueEditor 的 lazy chunk（不是被删掉/没打进包）', () => {
    // 「首屏没有 monaco」有两种可能：修好了，或者 monaco 根本没进构建产物
    // （那样功能就坏了）。必须同时证明它仍存在于某个**非首屏** chunk。
    const assets = readdirSync(join(DIST, 'assets'));
    const glue = assets.find((f) => /^GlueEditor-.*\.js$/.test(f));
    expect(glue, '找不到 GlueEditor chunk——monaco 可能根本没打进包').toBeTruthy();
    const glueJs = readFileSync(join(DIST, 'assets', glue!), 'utf-8');
    // monaco 的稳定特征串（Monarch 词法、编辑器 API）
    expect(glueJs).toMatch(/Monarch|tokenizer/);
    // 且该 chunk 体积确实是 monaco 量级（>1MB），防止"特征串在但内容被裁空"
    expect(glueJs.length).toBeGreaterThan(1_000_000);
  });

  it('GlueEditor chunk 不在首屏清单里（lazy 边界仍然成立）', () => {
    const refs = firstPaintRefs();
    expect(refs.filter((r) => /GlueEditor/i.test(r))).toEqual([]);
  });

  it('首屏 JS 总量有上界（防下一个"重量级依赖被提成共享 chunk"重演）', () => {
    // 首屏 JS = index.html 里所有 .js 资源去重后之和。当前实测约 1.3 MB raw；
    // 设 2.2 MB 上界：monaco（2.53 MB）一旦回来必然突破，而正常增长有余量。
    const refs = [...new Set(firstPaintRefs())].filter((r) => r.endsWith('.js'));
    expect(refs.length).toBeGreaterThanOrEqual(5);
    let total = 0;
    for (const r of refs) {
      const p = join(DIST, r.replace(/^\/+/, ''));
      if (existsSync(p)) total += readFileSync(p).length;
    }
    expect(total).toBeGreaterThan(500_000); // 有齿：不能因为读不到文件而恒 0
    expect(total).toBeLessThan(2_200_000);
  });
});

describe.skipIf(!hasBuild)('PERF-01 配置侧：manualChunks 不得再强制 monaco 分块', () => {
  it('vite.config.ts 的 manualChunks 里没有 vendor-monaco 条目', () => {
    const cfg = readFileSync(join(__dirname, '..', '..', 'vite.config.ts'), 'utf-8');
    // 只查 manualChunks 数组里是否还有这条规则（注释里的说明不算）
    const stripped = cfg
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(stripped).not.toMatch(
      /\[\s*['"]vendor-monaco['"]\s*,\s*\[/,
    );
  });
});
