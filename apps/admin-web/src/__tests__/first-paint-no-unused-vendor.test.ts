// @vitest-environment node
/**
 * 首屏 preload 白名单守卫：**用不到的重量级 vendor 不得进首屏**。
 *
 * 本文件由 PERF-01 的 `monaco-first-paint.perf01.test.ts` 扩展而来（WEB-1，第 3 轮
 * web-ux 审计 §4 WEB-1「配套」）：同一类缺陷在本仓已是**第二次**出现，而旧守卫只
 * 钉 monaco、不钉 charts，于是 recharts 沿着完全相同的路径漏进了首屏。
 *
 * 两次事故的共同机理（`vite.config.ts` 里两处注释逐字写了）：
 *   manualChunks 把某库提成**共享 chunk** 后，只要有任何静态可达模块与该 chunk
 *   产生静态边，Vite 就把整个 chunk 当作 entry 的静态依赖 **modulepreload**——
 *   库的消费方是不是路由级 lazy 已经不重要。
 *
 *   ① PERF-01：`['vendor-monaco', [...]]` → vendor-monaco 2.53 MB raw / 651 KB gz
 *      + 74 KB render-blocking CSS 进了首屏（登录页用户永不执行）；
 *   ② WEB-1：`['vendor-charts', ['recharts']]` → vendor-charts 391.20 kB raw /
 *      112.12 kB gz 进了首屏（实测 20 条 modulepreload 之一）。recharts 的三个
 *      消费方 DashboardPage / ExecutorDetailPage / KpiSparkline 全部是 lazy。
 *
 * 因此本守卫的判据不是"某个库名"，而是产物里的**事实**：
 *   · index.html（= 首屏完整资源清单）里不得出现 vendor-charts / recharts /
 *     GlueEditor / monaco；
 *   · 但那些库必须**仍然存在于某个非首屏 chunk**（否则是"没打进包"的功能故障，
 *     不是性能修复）——两条一起才既防回归又防误伤；
 *   · 首屏 JS 总量有上界：任何形态的重演（被提成共享 chunk、被并进 entry、
 *     被别的新依赖拖进来）最终都会撑破这个上界。
 *
 * 读产物而不是读配置：配置怎么写、Vite 怎么解释、产物最终什么样，三者可以不一致
 * （PERF-01 的配置注释与产物行为曾经**完全相反**）。只有读产物才能钉住用户可见的结果。
 *
 * 反证：把 `['vendor-charts', ['recharts']]`（或 vendor-monaco 那行）加回
 * vite.config.ts 并重新构建，本文件立即变红。
 *
 * 产物缺失时的行为（关键）：本地未构建时 **skip**（不该阻塞单测），但在 CI 里
 * **fail**。原因见下面 `describe` 上方的说明——一个「读不到产物就 skip」的守卫
 * 在 CI 步骤顺序被改回 test→build 时会**静默变成空转**（永远 skip、永远绿），
 * 而它要防的恰恰是只在产物里才看得见的回归。宁可红一次提醒排序，也不要一个
 * 看着在、其实不在的闸。
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const DIST = join(__dirname, '..', '..', 'dist');
const ASSETS = join(DIST, 'assets');
const INDEX_HTML = join(DIST, 'index.html');
const hasBuild = existsSync(INDEX_HTML);
const isCI = !!process.env.CI;

// 在 CI 里，产物必须存在：`.github/workflows/ci.yml` 的 admin-web-build job
// 已把 `npm run build` 排在 `npm test` **之前**。若这里读到 hasBuild=false，
// 说明该顺序被改回了 test→build（或 build 被删）——此时本守卫会变成空转，
// 必须显式报错而不是安静跳过。
if (isCI && !hasBuild) {
  throw new Error(
    '首屏 preload 守卫无法执行：CI 里找不到 apps/admin-web/dist/index.html。' +
      '本守卫读构建产物断言「用不到的重量级 vendor 不进首屏」，请在 ci.yml 的 ' +
      'admin-web-build job 里把 `npm run build` 排在 `npm test` 之前。',
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

/** 首屏之外的全部 JS chunk（assets/*.js，排除首屏清单里的）。 */
function nonFirstPaintChunks(): Array<{ file: string; size: number; body: string }> {
  const firstPaint = new Set(firstPaintRefs().map((r) => r.split('/').pop() ?? ''));
  return readdirSync(ASSETS)
    .filter((f) => f.endsWith('.js') && !firstPaint.has(f))
    .map((f) => {
      const p = join(ASSETS, f);
      return { file: f, size: statSync(p).size, body: readFileSync(p, 'utf-8') };
    });
}

describe.skipIf(!hasBuild)('首屏 preload 白名单（PERF-01 monaco / WEB-1 recharts）', () => {
  it('清单非空且不含 vendor-charts / recharts（WEB-1 逐字回归点）', () => {
    const refs = firstPaintRefs();
    // 有齿：清单必须非空，否则「没有 charts」是空洞成立。
    expect(refs.length).toBeGreaterThanOrEqual(5);
    const charts = refs.filter((r) => /vendor-charts|recharts/i.test(r));
    expect(charts, `首屏仍在预加载 recharts：${charts.join(', ')}`).toEqual([]);
  });

  it('index.html 文本里不出现 vendor-charts（改回 manualChunk 即转红）', () => {
    expect(readFileSync(INDEX_HTML, 'utf-8')).not.toContain('vendor-charts');
  });

  it('清单非空且不含 monaco（PERF-01 原断言）', () => {
    const refs = firstPaintRefs();
    expect(refs.length).toBeGreaterThanOrEqual(5);
    const monaco = refs.filter((r) => /monaco/i.test(r));
    expect(monaco, `首屏仍在预加载 monaco：${monaco.join(', ')}`).toEqual([]);
  });

  it('GlueEditor chunk 不在首屏清单里（lazy 边界仍然成立）', () => {
    const refs = firstPaintRefs();
    expect(refs.filter((r) => /GlueEditor/i.test(r))).toEqual([]);
  });

  it('monaco 确实被拆到了 GlueEditor 的 lazy chunk（不是被删掉/没打进包）', () => {
    // 「首屏没有 monaco」有两种可能：修好了，或者 monaco 根本没进构建产物
    // （那样功能就坏了）。必须同时证明它仍存在于某个**非首屏** chunk。
    const glue = readdirSync(ASSETS).find((f) => /^GlueEditor-.*\.js$/.test(f));
    expect(glue, '找不到 GlueEditor chunk——monaco 可能根本没打进包').toBeTruthy();
    const glueJs = readFileSync(join(ASSETS, glue!), 'utf-8');
    // monaco 的稳定特征串（Monarch 词法、编辑器 API）
    expect(glueJs).toMatch(/Monarch|tokenizer/);
    // 且该 chunk 体积确实是 monaco 量级（>1MB），防止"特征串在但内容被裁空"
    expect(glueJs.length).toBeGreaterThan(1_000_000);
  });

  it('recharts 仍在包里，但只在首屏之外的 lazy chunk（不是被删掉）', () => {
    // 同 monaco 的理由：删掉 recharts 也能让上面的断言变绿，可 Dashboard /
    // 执行器详情页就废了。这里要求「某个首屏之外的 chunk 里有一份**库级**
    // recharts」——用 recharts 内部的组件类型名 `categoricalChart` 做特征
    // （`recharts` 这个字面串会被页面的 displayName / 类名命中，识别度不够）。
    const chartsChunk = nonFirstPaintChunks().find(
      (c) =>
        c.size > 200_000 &&
        /categoricalChart/.test(c.body) &&
        /recharts-wrapper|ResponsiveContainer/.test(c.body),
    );
    expect(
      chartsChunk,
      '首屏之外找不到 recharts 库（>200KB 且含 categoricalChart）——recharts 可能根本没打进包',
    ).toBeTruthy();
  });

  it('首屏 JS 总量有上界（防下一个"重量级依赖被提成共享 chunk"重演）', () => {
    // 首屏 JS = index.html 里所有 .js 资源去重后之和。WEB-1 修复后实测约
    // 1.56 MB raw（19 条资源，gz 合计 523.9 KB）。上界设 1.8 MB：recharts
    // （391.20 kB raw）一旦以任何形态回到首屏必然突破（1.56 + 0.39 = 1.95 MB），
    // 而正常业务增长仍有余量。
    const refs = [...new Set(firstPaintRefs())].filter((r) => r.endsWith('.js'));
    expect(refs.length).toBeGreaterThanOrEqual(5);
    let total = 0;
    for (const r of refs) {
      const p = join(DIST, r.replace(/^\/+/, ''));
      if (existsSync(p)) total += readFileSync(p).length;
    }
    expect(total).toBeGreaterThan(500_000); // 有齿：不能因为读不到文件而恒 0
    expect(total).toBeLessThan(1_800_000);
  });
});

describe.skipIf(!hasBuild)(
  '首屏 preload 配置侧：manualChunks 不得再强制 monaco / recharts 分块',
  () => {
    /** 去掉注释后的 vite.config.ts（注释里的说明不算配置）。 */
    const strippedConfig = () => {
      const cfg = readFileSync(join(__dirname, '..', '..', 'vite.config.ts'), 'utf-8');
      return cfg.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    };

    it('没有 vendor-monaco 条目', () => {
      expect(strippedConfig()).not.toMatch(/\[\s*['"]vendor-monaco['"]\s*,\s*\[/);
    });

    it('没有 vendor-charts 条目（WEB-1：与 vendor-monaco 同一条判据）', () => {
      expect(strippedConfig()).not.toMatch(/\[\s*['"]vendor-charts['"]\s*,\s*\[/);
    });
  },
);
