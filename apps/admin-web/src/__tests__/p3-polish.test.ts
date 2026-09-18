/**
 * 轮7 P3 打磨项的回归守护（DEEP_REVIEW 0ef3bbe §六 前端）：
 *  - F-27 失败次数整数化（pages/task-stats.ts）
 *  - F-28 fixed_rate 分钟/秒换算不再解析 i18n 文案（pages/fixed-rate.ts）
 *  - F-29 api/tasks.ts 死代码（TIMEOUT_ACTION_OPTIONS / executionsWithStatus）零引用
 *  - F-30 首帧主题脚本单一来源（tokens.ts 常量 + vite 注入，index.html 无副本）
 *  - F-31 vite define 死配置已移除
 *  - F-32 重试职责归一（Query 层 retry:false，重试只在传输层）
 *  - F-33 全站不再有 <a onClick> 无 href 的伪链接
 *  - F-36 执行器编辑弹窗字段白名单
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, afterEach } from 'vitest';
import { failedRunCount } from '../pages/task-stats';
import { fixedRateToMinutesLabel, parseFixedRateSeconds } from '../pages/fixed-rate';
import { tasksApi } from '../api/tasks';
import { TIMEOUT_ACTION_OPTIONS } from '../pages/timeout-policy';
import { THEME_INIT_SCRIPT } from '../theme/tokens';
import { createQueryClient } from '../api/queryClient';
import {
  EDITABLE_EXECUTOR_FIELDS,
  executorEditFormValues,
  pickExecutorEditPayload,
} from '../pages/executor-edit';
import type { Executor } from '../api/executors';
import { isMacPlatform, searchShortcutHint } from '../layouts/shortcut-hint';

// vitest 以项目根（apps/admin-web）为 cwd，直接以字符串路径读工程文件
const appRoot = process.cwd();

/** 去注释后扫描（避免注释里提到的 `<a onClick>`/`process.env.VITE_API_URL_*` 误报） */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

// jsdom 不实现 matchMedia（THEME_INIT_SCRIPT 的 system 分支需要）
if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

// ── F-27 ────────────────────────────────────────────────
describe('F-27 失败次数必须是整数', () => {
  it.each([
    [10, 85, 2], // 1.5 次 → 四舍五入 2（旧实现会渲染 "1.5"）
    [10, 100, 0],
    [3, 0, 3],
    [0, 50, 0],
    [7, 66.7, 2],
  ])('totalRuns=%i successRate=%i → %i', (total, rate, expected) => {
    expect(failedRunCount(total, rate)).toBe(expected);
  });

  it('任意合法输入都返回整数', () => {
    for (const rate of [0, 33.3, 66.7, 99.9, 100]) {
      expect(Number.isInteger(failedRunCount(7, rate))).toBe(true);
    }
  });

  it('非法输入不产生 NaN', () => {
    expect(failedRunCount(Number.NaN, 50)).toBe(0);
    expect(failedRunCount(10, Number.NaN)).toBe(0);
  });
});

// ── F-28 ────────────────────────────────────────────────
describe('F-28 fixed_rate 换算不依赖 i18n 文案', () => {
  it('中文/英文单位文本都能正确反解（旧实现按 minuteUnit 翻译文本 replace）', () => {
    expect(parseFixedRateSeconds('5 分钟')).toBe(300);
    expect(parseFixedRateSeconds('5 minutes')).toBe(300);
    expect(parseFixedRateSeconds('5')).toBe(300);
  });

  it('小数与千分位不影响解析', () => {
    expect(parseFixedRateSeconds('5.5 分钟')).toBe(330);
    expect(parseFixedRateSeconds('1,000 minutes')).toBe(60_000);
  });

  it('空/非法/零值回落到最小档 60s（与旧实现一致）', () => {
    expect(parseFixedRateSeconds('')).toBe(60);
    expect(parseFixedRateSeconds(undefined)).toBe(60);
    expect(parseFixedRateSeconds('0')).toBe(60);
    expect(parseFixedRateSeconds('abc')).toBe(60);
  });

  it('展示侧分钟数向下取整（与旧 formatter 一致）', () => {
    expect(fixedRateToMinutesLabel(300)).toBe(5);
    expect(fixedRateToMinutesLabel(359)).toBe(5);
  });

  // 本轮审计修复：表单值单位是秒、输入框以分钟呈现（formatter 向下取整）。
  // 秒不是 60 整数倍时（90s/45s/100s），仅按展示文本回读会把 90s 悄悄改成
  // 60s——用户只是聚焦后失焦（未改一个字符）就丢掉真实间隔。传当前表单值后
  // parser 能判定"是否跨分钟"：未跨分钟=用户没改，原样保留精确秒值。
  it('同一展示分钟内未改动：不把 90s 静默改写成 60s', () => {
    // 90s 展示为「1 分钟」；回读文本「1 分钟」时当前值仍是 90 → 保留 90
    expect(parseFixedRateSeconds('1 分钟', 90)).toBe(90);
    expect(parseFixedRateSeconds('1 minutes', 119)).toBe(119);
    expect(parseFixedRateSeconds('1', 100)).toBe(100);
    // 60 整数倍的值：解析结果与当前值一致，保留同样成立
    expect(parseFixedRateSeconds('5 分钟', 300)).toBe(300);
  });

  it('跨分钟（用户真改了）才采纳解析结果', () => {
    // 当前 90s（显示 1 分钟）→ 用户改为 3 分钟：跨分钟，采纳 180
    expect(parseFixedRateSeconds('3 分钟', 90)).toBe(180);
    // 当前 300s（5 分钟）→ 改为 7 分钟
    expect(parseFixedRateSeconds('7', 300)).toBe(420);
    // 小数（5.5 分钟）与当前 300s 跨分钟 → 采纳 330
    expect(parseFixedRateSeconds('5.5 分钟', 300)).toBe(330);
  });

  it('第二参缺省/非法时行为与修复前逐字节一致（纯文本 → 秒）', () => {
    expect(parseFixedRateSeconds('5 分钟')).toBe(300);
    expect(parseFixedRateSeconds('5 分钟', null)).toBe(300);
    expect(parseFixedRateSeconds('5 分钟', undefined)).toBe(300);
    expect(parseFixedRateSeconds('5 分钟', Number.NaN)).toBe(300);
    expect(parseFixedRateSeconds('')).toBe(60);
    expect(parseFixedRateSeconds('abc', 90)).toBe(60);
  });
});

// ── F-29 ────────────────────────────────────────────────
describe('F-29 死代码零引用守护', () => {
  it('api/tasks.ts 不再导出 TIMEOUT_ACTION_OPTIONS（唯一来源是 pages/timeout-policy）', () => {
    expect('TIMEOUT_ACTION_OPTIONS' in tasksApi).toBe(false);
    expect(TIMEOUT_ACTION_OPTIONS.map((o) => o.value)).toEqual([
      'kill',
      'kill_retry',
      'notify_only',
    ]);
  });

  it('与 executions 逐字节重复的 executionsWithStatus 已删除，executions 保留', () => {
    expect('executionsWithStatus' in tasksApi).toBe(false);
    expect(typeof tasksApi.executions).toBe('function');
  });
});

// ── F-30 ────────────────────────────────────────────────
describe('F-30 首帧主题脚本单一来源', () => {
  afterEach(() => {
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.style.colorScheme = '';
    localStorage.clear();
  });

  it('THEME_INIT_SCRIPT 依 localStorage 决定 data-theme（dark）', () => {
    localStorage.setItem('autoflow-theme', JSON.stringify({ state: { mode: 'dark' } }));
    new Function(THEME_INIT_SCRIPT)();
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(document.documentElement.style.colorScheme).toBe('dark');
  });

  it('THEME_INIT_SCRIPT 缺省/system 且系统非暗 → light', () => {
    new Function(THEME_INIT_SCRIPT)();
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('index.html 不再内联手写主题脚本（消除双事实源）', () => {
    const html = readFileSync(join(appRoot, 'index.html'), 'utf8');
    expect(html).not.toContain('autoflow-theme');
    expect(html).not.toContain('prefers-color-scheme');
    expect(html).toContain('/src/main.tsx');
  });
});

// ── F-31 ────────────────────────────────────────────────
describe('F-31 vite define 死配置已移除', () => {
  it('vite.config.ts 不再注入无消费方的 process.env.VITE_API_URL_*', () => {
    const cfg = stripComments(readFileSync(join(appRoot, 'vite.config.ts'), 'utf8'));
    expect(cfg).not.toMatch(/process\.env\.VITE_API_URL/);
  });
});

// ── F-32 ────────────────────────────────────────────────
describe('F-32 重试职责归一（单层）', () => {
  it('Query 层显式关闭重试——重试只在 axios 传输层发生，避免叠加放大', () => {
    const queries = createQueryClient().getDefaultOptions().queries;
    expect(queries?.retry).toBe(false);
    expect(queries?.staleTime).toBe(30_000);
    expect(queries?.refetchOnWindowFocus).toBe(false);
  });
});

// ── F-33 ────────────────────────────────────────────────
describe('F-33 伪链接（<a onClick> 无 href）零残留', () => {
  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full, out);
      else if (/\.tsx$/.test(entry.name)) out.push(full);
    }
    return out;
  }

  it('src 下不存在无 href 的 <a onClick>', () => {
    const offenders = walk(join(appRoot, 'src'))
      .filter((f) => !f.includes('__tests__'))
      .filter((f) => /<a\s[^>]*onClick/.test(stripComments(readFileSync(f, 'utf8'))));
    expect(offenders).toEqual([]);
  });
});

// ── F-24 / F-25 ─────────────────────────────────────────
// F-24（帮助占位按钮 + 恒亮 Badge 的移除）在 DOM 层的守护见
// a11y-focus.test.tsx「头部图标按钮全部具备可访问名」用例。
describe('F-25 搜索快捷键提示按平台判定', () => {
  it('macOS → ⌘K', () => {
    expect(isMacPlatform('MacIntel', 'Mozilla/5.0 (Macintosh; Intel Mac OS X)')).toBe(true);
    expect(searchShortcutHint(isMacPlatform('MacIntel', ''))).toBe('⌘K');
  });

  it('Windows / Linux → Ctrl K（不再对 Mac 用户显示 Ctrl K）', () => {
    expect(searchShortcutHint(isMacPlatform('Win32', 'Mozilla/5.0 (Windows NT 10.0)'))).toBe('Ctrl K');
    expect(searchShortcutHint(isMacPlatform('Linux x86_64', 'Mozilla/5.0 (X11; Linux)'))).toBe('Ctrl K');
  });

  it('iOS 设备（platform=iPhone/iPad）走 ⌘ 分支', () => {
    expect(isMacPlatform('iPhone', '')).toBe(true);
    expect(isMacPlatform('iPad', '')).toBe(true);
  });

  it('空/未知平台 → Ctrl K（安全回退）', () => {
    expect(isMacPlatform('', '')).toBe(false);
    expect(searchShortcutHint(isMacPlatform(null, null))).toBe('Ctrl K');
  });
});

// ── F-36 ────────────────────────────────────────────────
describe('F-36 执行器编辑字段白名单', () => {
  const executor = {
    id: 'e1',
    appName: 'app',
    address: '10.0.0.1:8002',
    status: 'online',
    cpuUsage: 12,
    memUsage: 34,
    runningTaskCount: 2,
    lastHeartbeat: '2026-01-01T00:00:00Z',
    groupName: 'edge',
    tags: ['gpu'],
    description: 'desc',
    maxConcurrentTasks: 5,
  } as Executor;

  it('回填只取可编辑四字段，不含只读字段', () => {
    const values = executorEditFormValues(executor);
    expect(values).toEqual({
      groupName: 'edge',
      tags: ['gpu'],
      description: 'desc',
      maxConcurrentTasks: 5,
    });
    for (const readonly of ['id', 'status', 'lastHeartbeat', 'cpuUsage', 'memUsage', 'appName']) {
      expect(readonly in values).toBe(false);
    }
  });

  it('null 字段回填为 undefined（走空态）', () => {
    const values = executorEditFormValues({ ...executor, groupName: null, tags: null } as Executor);
    expect(values.groupName).toBeUndefined();
    expect(values.tags).toBeUndefined();
  });

  it('提交前按白名单裁剪：只发可编辑字段', () => {
    const payload = pickExecutorEditPayload({
      ...executor,
      description: '',
      maxConcurrentTasks: 3,
    });
    expect(Object.keys(payload).sort()).toEqual([...EDITABLE_EXECUTOR_FIELDS].sort());
    expect(payload.description).toBe('');
    expect(payload.maxConcurrentTasks).toBe(3);
    expect('id' in payload).toBe(false);
    expect('status' in payload).toBe(false);
  });

  it('未提交的键不携带（PATCH 保留旧值语义）', () => {
    expect(pickExecutorEditPayload({ description: 'x' })).toEqual({ description: 'x' });
  });
});
