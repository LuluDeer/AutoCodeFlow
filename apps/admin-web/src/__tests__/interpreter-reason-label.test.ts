/**
 * 回归：解释器失败分因 → i18n 标签的映射必须**收全**且**词条存在**。
 *
 * 缺陷背景：`INTERPRETER_REASON_T_KEY` 漏收了 `mirror_unreachable` 与
 * `download_timeout`。消费处（ExecutionDetailPage）写作
 * `INTERPRETER_REASON_T_KEY[reason] ? t(key) : reason`——漏收录不会报错，
 * 只是把一条**裸 token**（`mirror_unreachable`）渲染给运维。
 *
 * 为什么这两条尤其不能漏：它们正是私有化/内网镜像部署下最需要立刻分辨的
 * 失败（"镜像不可达" vs "下载慢到超预算" vs "版本不可下载"），处置动作完全
 * 不同（换源 / 调预算 / 离线预填）。退化成裸 token 等于把分因白做了。
 *
 * 本用例同时钉住**反向**：映射里的键必须是真执行器真的会产出的分因，
 * 否则就是又一个"幽灵分因"（历史上 `cache_miss` 就是——两个执行器都不产出
 * 它，却占着一条映射与两条词条，让读者以为存在"缓存未命中"这个分类）。
 */
import { describe, it, expect } from 'vitest';
import { INTERPRETER_REASON_T_KEY } from '../pages/interpreter-context';
import zh from '../locales/zh';
import en from '../locales/en';

/**
 * 两个执行器实际会产出的 `InterpreterUnavailable.reason` 全集。
 *
 * 事实源：
 *  - python `interpreters.py:118-119` 的类文档串
 *    （`download_failed | download_timeout | not_downloadable | corrupt |
 *     mirror_unreachable | uv_missing`）；
 *  - node `interpreters.ts` 的 6 个 `new InterpreterUnavailableError(...)` 抛出点
 *    （uv_missing / not_downloadable / download_timeout / corrupt / download_failed）。
 */
const REAL_REASONS = [
  'uv_missing',
  'not_downloadable',
  'download_failed',
  'download_timeout',
  'mirror_unreachable',
  'corrupt',
];

describe('解释器失败分因标签映射', () => {
  it('两个执行器会产出的每个分因都有标签键（漏了会露出裸 token）', () => {
    for (const reason of REAL_REASONS) {
      expect(
        INTERPRETER_REASON_T_KEY[reason],
        `分因 ${reason} 缺少 i18n 标签键 —— 详情页会把它原样当文案渲染`,
      ).toBeTruthy();
    }
  });

  it('每个标签键在 zh 与 en 两套词条里都存在（只加键会露出 key 本身）', () => {
    const zhKeys = zh as Record<string, string>;
    const enKeys = en as Record<string, string>;
    for (const [reason, key] of Object.entries(INTERPRETER_REASON_T_KEY)) {
      expect(zhKeys[key], `${reason} → ${key} 在 zh 词条缺失`).toBeTruthy();
      expect(enKeys[key], `${reason} → ${key} 在 en 词条缺失`).toBeTruthy();
    }
  });

  it('不含幽灵分因 cache_miss（两个执行器都不产出它）', () => {
    // `cache_miss` 曾是本表的一项，但 python 的类文档串与 node 的抛出点都没有
    // 这个取值——它会让读者以为存在"缓存未命中"这一独立分类。缓存缺失的真实
    // 表现是"池里没有 → 走下载 → 下载失败/超时"，落到 download_* 上。
    expect(INTERPRETER_REASON_T_KEY.cache_miss).toBeUndefined();
    expect(REAL_REASONS).not.toContain('cache_miss');
  });
});
