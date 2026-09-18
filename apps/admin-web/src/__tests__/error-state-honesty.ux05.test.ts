// @vitest-environment jsdom
/**
 * UX-05（本轮体验审查）：读取失败被谎报成「暂无数据」。
 *
 * 三处形态（都在 ApplicationDetailPage）：
 *  ① TasksTab：catch 里只 `message.error(...)`，tasks 保持 []，于是渲染分支
 *     `tasks.length === 0 && !loading` 命中 → 显示「暂无任务」+「创建第一个任务」
 *     引导按钮。**把读取失败谎报成"这个应用确实没有任务"**，用户很可能据此
 *     重复创建；
 *  ② VersionHistoryTab：同形——catch 只弹 message，records 保持 []，表格
 *     emptyText 显示「暂无版本历史」；
 *  ③ 页面级 fetchApp：**任何**错误（含 500 / 网络抖动 / 超时）都
 *     `message.error` + `nav('/applications')` 强制跳走，用户正在看的页面突然
 *     消失，原因只是一条几秒后消失的 toast。只有 404 才该离开。
 *
 * 修法：三处都记录失败态并在原位渲染 StateError（带重试）；页面级用
 * isNotFoundError 区分 404 与其它错误。
 *
 * 反证：把任一处改回「只弹 message、失败态不入 state」，对应断言立即变红。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isNotFoundError } from '../utils/error';

const SRC = join(__dirname, '..');
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const APP = stripComments(readFileSync(join(SRC, 'pages/ApplicationDetailPage.tsx'), 'utf-8'));

describe('UX-05 工具：isNotFoundError 只认 404', () => {
  it('axios 形态 404 → true', () => {
    expect(isNotFoundError({ response: { status: 404 } })).toBe(true);
  });

  it('500 / 网络错误 / 无响应 → false（这些应留在原位重试，不该跳走）', () => {
    expect(isNotFoundError({ response: { status: 500 } })).toBe(false);
    expect(isNotFoundError({ response: { status: 503 } })).toBe(false);
    expect(isNotFoundError(new Error('Network Error'))).toBe(false);
    expect(isNotFoundError(undefined)).toBe(false);
    expect(isNotFoundError(null)).toBe(false);
    expect(isNotFoundError('boom')).toBe(false);
  });
});

describe('UX-05 源码层：三处失败态必须在页内可见（带重试）', () => {
  it('① TasksTab：失败写入 state 而非只弹 message，且渲染 StateError', () => {
    // 失败态 state 存在
    expect(APP).toContain('const [loadError, setLoadError] = useState<unknown>(null);');
    // 且列表渲染前先判失败态（否则空列表仍会被读成「暂无任务」）
    expect(APP).toMatch(/loadError \? \([\s\S]{0,400}?<StateError/);
    // 带重试入口
    expect(APP).toMatch(/onRetry=\{\(\) => fetchTasks\(page\)\}/);
  });

  it('② VersionHistoryTab：失败渲染 StateError 并带重试，不再退化成空表', () => {
    expect(APP).toMatch(/onRetry=\{fetchVersions\}/);
    expect(APP).toContain("title={t('appDetail.history.loadFail')}");
  });

  it('③ 页面级：只有 404 才 nav 回列表，其余错误留在页内', () => {
    // isNotFoundError 必须真的参与分支判断
    expect(APP).toMatch(/if \(isNotFoundError\(err\)\)/);
    // 404 分支才允许 nav('/applications')
    const notFoundBranch = APP.slice(
      APP.indexOf('if (isNotFoundError(err))'),
      APP.indexOf('if (isNotFoundError(err))') + 200,
    );
    expect(notFoundBranch).toContain("nav('/applications')");
    // 失败态渲染 StateError + 重试 fetchApp
    expect(APP).toMatch(/onRetry=\{fetchApp\}/);
  });

  it('三处都引用 StateError 组件（页内错误态标准块，UI-08 契约）', () => {
    expect(APP).toContain("from '../components/StateError'");
    // 至少三处使用点（① ② ③）
    const uses = APP.match(/<StateError/g) ?? [];
    expect(uses.length).toBeGreaterThanOrEqual(3);
  });

  it('失败态不再依赖会消失的 message 作为唯一反馈', () => {
    // 三个 fetch 的 catch 里都不应只剩 message.error 而没有 setLoadError
    for (const fn of ['fetchTasks', 'fetchVersions', 'fetchApp']) {
      const start = APP.indexOf(`const ${fn} = useCallback`);
      expect(start, `找不到 ${fn}`).toBeGreaterThan(-1);
      const body = APP.slice(start, start + 1200);
      expect(body, `${fn} 未记录失败态`).toContain('setLoadError(err)');
    }
  });
});
