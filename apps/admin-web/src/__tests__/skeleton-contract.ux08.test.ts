/**
 * UX-08（本轮体验审查）：UI-08 契约要求「骨架屏替代 Spin」，但仍有整页级
 * 加载态用的是裸 `<Spin />`。
 *
 * 契约原文（docs/DEVELOPMENT-PLAN-2026-09.md §6.2 UI-08）：
 *   「空态/加载态/错误态标准化 … **骨架屏替代 Spin**；错误态统一
 *    「重试 + 复制错误信息」」
 *
 * 为什么裸 Spin 比骨架屏差（不是审美问题）：
 *   · 裸 `<Spin />` 高度约 24px，加载完成后内容区突然撑开——**布局跳动**
 *     （CLS），用户刚要点的地方可能已经移位；
 *   · 骨架屏与最终形态同构，用户能预判"将要出现什么"，感知等待更短；
 *   · 全站其它页（TaskDetailPage / ApplicationDetailPage / Dashboard…）都已
 *     按契约接了 PageSkeleton，只有 settings 整页还停在 Spin，属**漏改**而非
 *     设计选择——同一产品里两种加载形态并存本身就是体验不一致。
 *
 * 修法：settings 的两处整页/整块加载改用 `PageSkeleton`。
 *
 * 本守卫的范围界定（重要）：**只钉整页级**加载态。页内小控件的 Spin
 * （按钮 loading、下拉加载、列表局部刷新、图表 canvas 等）**不在契约范围内**
 * ——那些场景下骨架屏反而更吵。故这里按「组件级加载态是否位于 return 顶层」
 * 来判定，而不是无差别禁止 `<Spin`。
 *
 * 反证：把 settings/index.tsx 的任一处 PageSkeleton 改回 `<Spin />`，对应
 * 用例立即变红。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(__dirname, '..');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf-8');
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('UX-08：整页级加载态必须用骨架屏，不得用裸 Spin', () => {
  const SETTINGS = stripComments(read('pages/settings/index.tsx'));

  it('settings 整页加载（isLoading 顶层 return）走 PageSkeleton', () => {
    // 顶层 return 形态：`if (isLoading) return <PageSkeleton .../>;`
    expect(SETTINGS).toMatch(/if \(isLoading\)\s*return\s*<PageSkeleton/);
    // 且不能再是裸 Spin
    expect(SETTINGS).not.toMatch(/if \(isLoading\)\s*return\s*<Spin\s*\/>/);
  });

  it('settings AI 配置块的加载分支也走 PageSkeleton', () => {
    // 三态写法：`{isLoading ? <PageSkeleton .../> : cfgError ? (...) : (...)}`
    expect(SETTINGS).toMatch(/\{isLoading \?\s*\(\s*<PageSkeleton/);
    expect(SETTINGS).not.toMatch(/\{isLoading \?\s*<Spin\s*\/>\s*:/);
  });

  it('已导入 PageSkeleton（不是写了标签却没引入）', () => {
    expect(SETTINGS).toContain("from '../../components/PageSkeleton'");
  });

  it('PageSkeleton 的 variant 是合法值（table | cards）', () => {
    // 防止传了不存在的 variant 而组件静默回落——那等于没有骨架。
    const skeleton = read('components/PageSkeleton.tsx');
    const variants = [...skeleton.matchAll(/SkeletonVariant\s*=\s*([^;]+);/g)]
      .flatMap((m) => [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]));
    expect(variants.length).toBeGreaterThanOrEqual(2); // 有齿：变体表不能为空
    for (const m of SETTINGS.matchAll(/<PageSkeleton[^>]*variant="([^"]+)"/g)) {
      expect(variants, `variant="${m[1]}" 不在 ${variants.join('|')} 内`).toContain(
        m[1],
      );
    }
  });
});

describe('UX-08 范围界定：页内小控件 Spin 不在契约内（防过度扩张）', () => {
  it('契约只针对整页/整块加载，页内局部 Spin 仍允许存在', () => {
    // 这条用例的存在是为了**防止后续把守卫扩大成"全仓禁止 Spin"**：那会
    // 误伤按钮 loading、局部刷新等正当用法，最终被绕过而失去意义。
    // 此处断言"仓库里确实还有合法的页内 Spin"，若哪天全没了，说明守卫可能
    // 被扩成了无差别禁令，需要复核。
    const artifacts = stripComments(read('components/ArtifactsList.tsx'));
    expect(artifacts).toContain('<Spin size="small" />');
  });
});
