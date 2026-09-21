/**
 * D-设计审计 2026-09-22 分片A：任务族页面设计/交互修复的源码层守卫。
 *
 * 这些用例断言「源码形态」——把任一处改回旧写法，对应用例立即变红。
 * 与 behavior 测试互补：behavior 测渲染结果，这里钉住反模式不回流。
 *
 * 覆盖分片A 全部 9 条：
 *  D-P1-1  fixedRate≥60s 不再二次包裹「每 {{sec}} 秒」
 *  D-P2-01a DAG 两处 Alert 用 title=（antd 6.6.2 message= 已 deprecated）
 *  D-P2-02a runtime 列走 runtimeLabel（唯一事实源）
 *  D-P2-04 Dashboard SSE 状态点色走 SEMANTIC_COLORS
 *  D-P2-05 DAG 可点击节点键盘可达（tabIndex + Enter/Space）
 *  D-P2-06 DAG 当前节点阴影换品牌绿（不再旧 antd 蓝）
 *  D-P2-07 DAG 整 Tab 加载用 PageSkeleton（不再裸居中 Spin）
 *  D-P2-16 品牌渐变收 tokens.ts BRAND_GRADIENT（不再五处内联）
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(__dirname, '..');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf-8');
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const TASK_LIST = stripComments(read('pages/TaskListPage.tsx'));
const TASK_DETAIL = stripComments(read('pages/TaskDetailPage.tsx'));
const DAG = stripComments(read('components/TaskDependencyGraph.tsx'));
const DASHBOARD = stripComments(read('pages/DashboardPage.tsx'));
const MAIN_LAYOUT = stripComments(read('layouts/MainLayout.tsx'));
const LOGIN = stripComments(read('pages/LoginPage.tsx'));
const TOKENS = read('theme/tokens.ts');

describe('D-P1-1: fixedRate ≥60s 不再被「每 {{sec}} 秒」二次包裹', () => {
  it('≥60s 分支直接渲染 label，不再外层套 schedule.sec', () => {
    // 旧形态：return ...{t('taskList.schedule.sec', { sec: label })}
    expect(TASK_LIST).not.toMatch(/schedule\.sec',\s*\{\s*sec:\s*label\s*\}\)/);
    // 新形态：≥60s 分支渲染 label 本身
    expect(TASK_LIST).toMatch(/return <Text[^>]*>\{label\}<\/Text>/);
  });
});

describe('D-P2-01a: DAG Alert 用 title= 而非 deprecated 的 message=', () => {
  it('两处 depGraph Alert 均为 title=', () => {
    expect(DAG).not.toMatch(/message=\{t\('depGraph\./);
    expect(DAG).toContain("title={t('depGraph.cycleAlert')}");
    expect(DAG).toContain("title={t('depGraph.truncatedAlert'");
  });
});

describe('D-P2-02a: runtime 读面走唯一事实源 runtimeLabel', () => {
  it('TaskListPage 运行时列不再 <Tag>{v}</Tag> 直出裸值', () => {
    expect(TASK_LIST).not.toContain('<Tag>{v}</Tag>');
    expect(TASK_LIST).toContain('runtimeLabel(v, t)');
    expect(TASK_LIST).toContain("from '../utils/runtime-label'");
  });

  it('TaskDetailPage 运行时项与状态行均走映射（不裸出 task.runtime / task.status）', () => {
    expect(TASK_DETAIL).not.toContain('<Tag>{task.runtime}</Tag>');
    expect(TASK_DETAIL).toContain('runtimeLabel(task.runtime, t)');
    // 状态行 Badge：failed/inactive 不再裸落 task.status
    expect(TASK_DETAIL).not.toContain(': task.status}');
    expect(TASK_DETAIL).toContain('taskStatusLabels[task.status] ?? task.status');
    expect(TASK_DETAIL).toContain("from '../utils/runtime-label'");
  });
});

describe('D-P2-04: Dashboard SSE 状态点色走语义 token', () => {
  it('streamStatusBadge 不再硬编码 hex', () => {
    // 提取 streamStatusBadge 函数体，确认无裸 hex
    const fnStart = DASHBOARD.indexOf('export function streamStatusBadge');
    const fnEnd = DASHBOARD.indexOf('\n}', fnStart);
    const fn = DASHBOARD.slice(fnStart, fnEnd);
    expect(fn).not.toContain('#22c55e');
    expect(fn).not.toContain('#f59e0b');
    expect(fn).not.toContain('#94a3b8');
    expect(fn).toContain('SEMANTIC_COLORS.success');
    expect(fn).toContain('SEMANTIC_COLORS.warning');
    expect(fn).toContain('SEMANTIC_COLORS.neutral');
  });
});

describe('D-P2-05: DAG 可点击节点键盘可达', () => {
  it('节点 div 带 tabIndex 与 onKeyDown（Enter/Space 触发）', () => {
    expect(DAG).toContain('tabIndex={n.isCurrent ? -1 : 0}');
    expect(DAG).toContain('onKeyDown');
    expect(DAG).toContain("e.key === 'Enter'");
    expect(DAG).toContain("e.key === ' '");
  });
});

describe('D-P2-06: DAG 当前节点阴影为品牌绿，不再旧 antd 蓝', () => {
  it('不再出现旧蓝 rgba(22,119,255', () => {
    expect(DAG).not.toContain('rgba(22,119,255');
    expect(DAG).toContain('rgba(34,197,94,0.25)');
  });
});

describe('D-P2-07: DAG 整 Tab 加载用 PageSkeleton', () => {
  it('不再裸居中 Spin，改用 PageSkeleton table 变体', () => {
    expect(DAG).not.toMatch(/<div style=\{\{[^}]*textAlign: 'center'[^}]*\}>\s*<Spin \/>/);
    expect(DAG).toContain('<PageSkeleton variant="table" rows={6} />');
    expect(DAG).toContain("from './PageSkeleton'");
    // Spin 已从 antd import 移除
    expect(DAG).not.toMatch(/import\s*\{[^}]*\bSpin\b[^}]*\}\s*from 'antd'/);
  });
});

describe('D-P2-16: 品牌渐变收 tokens.ts BRAND_GRADIENT 单源', () => {
  it('tokens.ts 导出 BRAND_GRADIENT 常量', () => {
    expect(TOKENS).toContain('BRAND_GRADIENT');
    expect(TOKENS).toMatch(/BRAND_GRADIENT = 'linear-gradient\(135deg, #22c55e 0%, #16a34a 100%\)'/);
  });

  it('MainLayout / LoginPage 不再内联渐变字面量', () => {
    for (const [name, src] of [
      ['MainLayout', MAIN_LAYOUT],
      ['LoginPage', LOGIN],
    ] as const) {
      expect(src, `${name} 仍内联品牌渐变`).not.toContain('linear-gradient(135deg, #22c55e');
      expect(src, `${name} 未引用 BRAND_GRADIENT`).toContain('BRAND_GRADIENT');
    }
  });

  it('两文件均从 theme/tokens 导入 BRAND_GRADIENT', () => {
    expect(MAIN_LAYOUT).toContain("from '../theme/tokens'");
    expect(LOGIN).toContain("from '../theme/tokens'");
  });
});
