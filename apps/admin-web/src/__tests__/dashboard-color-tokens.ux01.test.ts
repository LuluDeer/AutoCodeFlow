// @vitest-environment jsdom
/**
 * UX-01 / UX-03（本轮体验审查）：仪表盘语义色令牌误用。
 *
 * ── UX-01：次级文本用「表面色」当正文色，暗色下不可见 ──────────────────
 * `--color-secondary` 在 MASTER.md 里是 **Secondary 表面色** `#1E293B`，而
 * `index.css` 双主题都写成同一个 `#1E293B`（不随主题翻转）。把它当**正文色**
 * 用在 `var(--color-muted)` 卡面上（暗面 `#1A1E2F`）时对比度只有 **1.13:1**
 * ——Dashboard 是登录后的落地页，KPI 卡脚注 / 热力条百分比 / 空态文案全部
 * 糊成与卡片同色，等于看不见。
 *
 * 同页 `Text type="secondary"`（antd `colorTextSecondary`，暗面 #94A3B8）却
 * 清晰——同一视觉角色两套令牌，只有一套跟主题翻转。
 *
 * 修法：这 5 处改用主题感知的 `--chart-axis-text`（亮 #475569 / 暗 #94A3B8）。
 *
 * ── UX-03：「警告档」色阶取到品牌绿，告警语义丢失 ──────────────────────
 * 三处阈值色阶的中间档写的是 `var(--color-ring)`，而 `--color-ring` 双主题
 * 都是 `#22C55E`（品牌绿）——于是：
 *   ① 失败榜「失败 2 次」比「失败 1 次」（灰）看起来更健康；
 *   ② 调度 P99 300ms 显示绿色，值班者读成「正常」；
 *   ③ 执行器 CPU 70% 与 20% 同为绿色，高水位预警失效。
 *
 * 修法：三处改取 `--color-warning`（亮 #D97706 / 暗 #F59E0B，与
 * theme/tokens.ts 的 SEMANTIC_COLORS.warning 同源）。
 *
 * 反证：把任一处的 `--color-warning` 改回 `--color-ring`，对应用例立即变红。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { heatColor, HEAT_THRESHOLDS } from '../components/dashboard/ExecutorHeatBars';
import { latencyColor, LATENCY_THRESHOLDS } from '../components/dashboard/SchedulerLatencyCard';
import { failureCountColor } from '../components/dashboard/FailureTopList';

const SRC = join(__dirname, '..');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf-8');

/**
 * 去掉 CSS 注释后再解析。
 *
 * 必要性：本仓库的 CSS 注释里大量引用令牌名（含 `html[data-theme='dark']`
 * 这类示例文本），直接对原文做正则会让「注释里的第一次提及」冒充真正的声明
 * ——本文件初版就因此把亮面的 `--color-muted` 当成了暗面的值。
 */
const stripCssComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** 取某个主题块内某个变量的值（块边界用花括号配对，不靠 [^}] 猜）。 */
function tokenIn(block: 'root' | 'dark', name: string): string | undefined {
  const css = stripCssComments(read('index.css'));
  const header = block === 'dark' ? "html[data-theme='dark'] {" : ':root {';
  const start = css.indexOf(header);
  if (start < 0) return undefined;
  const end = css.indexOf('}', start);
  const body = css.slice(start + header.length, end);
  return body.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{3,6})`))?.[1].toLowerCase();
}

/** 品牌绿：出现在「警告档」即视为语义丢失。 */
const BRAND_GREEN = 'var(--color-ring)';

describe('UX-03：警告档必须是 warning 色，不能是品牌绿', () => {
  it('执行器热力条：≥65% 档返回 warning 而非品牌绿', () => {
    // 阈值内（黄档）
    expect(heatColor(HEAT_THRESHOLDS.warning)).toBe('var(--color-warning)');
    expect(heatColor(70)).toBe('var(--color-warning)');
    expect(heatColor(70)).not.toBe(BRAND_GREEN);
    // 临界档仍是红
    expect(heatColor(HEAT_THRESHOLDS.critical)).toBe('var(--color-destructive)');
    // 健康档仍是绿
    expect(heatColor(20)).toBe('var(--color-accent)');
    // 70% 与 20% 必须可区分——这正是原缺陷的核心（两者同为绿色）
    expect(heatColor(70)).not.toBe(heatColor(20));
  });

  it('调度延迟卡：250–1000ms 档返回 warning 而非品牌绿', () => {
    expect(latencyColor(LATENCY_THRESHOLDS.warning)).toBe('var(--color-warning)');
    expect(latencyColor(300)).toBe('var(--color-warning)');
    expect(latencyColor(300)).not.toBe(BRAND_GREEN);
    expect(latencyColor(LATENCY_THRESHOLDS.critical)).toBe('var(--color-destructive)');
    expect(latencyColor(50)).toBe('var(--color-accent)');
    // 300ms 与 50ms 必须可区分
    expect(latencyColor(300)).not.toBe(latencyColor(50));
  });

  it('失败榜：2 次档返回 warning，且比 1 次档（灰）更醒目', () => {
    expect(failureCountColor(2)).toBe('var(--color-warning)');
    expect(failureCountColor(2)).not.toBe(BRAND_GREEN);
    expect(failureCountColor(3)).toBe('var(--color-destructive)');
    // 1 次档是中性灰；2 次档必须与它不同（原缺陷里 2 次是绿、1 次是灰，
    // 「失败更多」反而更接近健康色）。
    expect(failureCountColor(1)).toBe('var(--chart-axis-text)');
    expect(failureCountColor(2)).not.toBe(failureCountColor(1));
  });

  it('CSS 里 --color-warning 双主题均有定义且不是品牌绿', () => {
    const light = tokenIn('root', '--color-warning');
    const dark = tokenIn('dark', '--color-warning');
    expect(light, '亮面缺少 --color-warning').toBeTruthy();
    expect(dark, '暗面缺少 --color-warning').toBeTruthy();
    for (const hex of [light, dark]) {
      expect(hex, `${hex} 不应是品牌绿 #22c55e`).not.toBe('#22c55e');
    }
    // 两主题取值应不同（亮面需要更深一档才够对比度）
    expect(light).not.toBe(dark);
  });
});

describe('UX-01：次级文本不得使用表面色令牌 --color-secondary', () => {
  // 这 5 个文件此前都把 --color-secondary 当正文色用（暗色下 1.13:1 不可见）。
  const FILES = [
    'pages/DashboardPage.tsx',
    'components/dashboard/KpiSparkline.tsx',
    'components/dashboard/ExecutorHeatBars.tsx',
    'components/dashboard/FailureTopList.tsx',
    'components/dashboard/SchedulerLatencyCard.tsx',
  ];

  it('源码里不再有把 --color-secondary 当 color 用的地方', () => {
    for (const file of FILES) {
      const src = read(file);
      // 只匹配 `color: 'var(--color-secondary)'` 形式（正文色用法）；
      // 注释里提到该令牌名不算违规。
      const misuse = src
        .split('\n')
        .filter((line) => /color:\s*'var\(--color-secondary\)'/.test(line));
      expect(misuse, `${file} 仍有把表面色当正文色的用法`).toEqual([]);
    }
  });

  it('这些位置改用主题感知的 --chart-axis-text（双主题各有一档）', () => {
    const light = tokenIn('root', '--chart-axis-text');
    const dark = tokenIn('dark', '--chart-axis-text');
    expect(light, '亮面缺少 --chart-axis-text').toBeTruthy();
    expect(dark, '暗面缺少 --chart-axis-text').toBeTruthy();
    expect(light).not.toBe(dark);
  });

  it('反证：--color-secondary 双主题同值，正是它不能当正文色的原因', () => {
    const light = tokenIn('root', '--color-secondary');
    const dark = tokenIn('dark', '--color-secondary');
    // 同值 ⇒ 落在会翻转的表面色（--color-muted）上时对比度不随主题改善。
    expect(light).toBe(dark);
    // 而它本身是深色（#1E293B），暗面卡面 #1A1E2F 与它几乎同亮度。
    expect(light).toBe('#1e293b');
    expect(tokenIn('dark', '--color-muted')).toBe('#1a1e2f');
  });
});
