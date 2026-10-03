// @vitest-environment jsdom
/**
 * UX-06（本轮体验审查）：页面直接渲染后端裸枚举。
 *
 * 具体漏点（同一张表里状态列已走 t() 显示中文，旁边列却是裸 token）：
 *  - ApplicationDetailPage 任务列表「触发方式」列：`<Tag>{r.triggerType}</Tag>`
 *  - ApplicationDetailPage 版本历史「状态」列：`<Tag>{v}</Tag>`
 *  - TaskDetailPage 任务列表「触发方式」列：`{v || '-'}`
 *  - TaskDetailPage 基本信息「触发方式」项：`<Tag>{task.triggerType}</Tag>`
 *
 * 危害：非英语用户在界面上看到 `cron` / `fixed_rate` / `deployed` 这类后端
 * token，中英混排；且各页各写一份内联映射，新增取值必然漏改几处。
 *
 * 修法：收敛到 utils/trigger-label.ts 的唯一事实源，四处分派到它。
 *
 * 反证：把任一处改回裸枚举渲染，对应的源码层断言立即变红。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import zh from '../locales/zh';
import en from '../locales/en';
import {
  triggerLabel,
  releaseStatusLabel,
  TRIGGER_T_KEYS,
  RELEASE_STATUS_T_KEYS,
} from '../utils/trigger-label';
import {
  agentStatusLabel,
  agentKindLabel,
  agentToolStatusLabel,
  agentStepRoleLabel,
  agentToolTierLabel,
  AGENT_STATUS_T_KEYS,
  AGENT_KIND_T_KEYS,
  AGENT_TOOL_STATUS_T_KEYS,
  AGENT_STEP_ROLE_T_KEYS,
  AGENT_TOOL_TIER_T_KEYS,
} from '../utils/agent-label';

const SRC = join(__dirname, '..');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf-8');
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** 恒等 t：断言的是「查表命中了哪个 key」，而不是文案本身。 */
const identity = (k: string) => k;

describe('UX-06 纯函数：已知取值查表、未知取值回退原始 token', () => {
  it('四个已知 triggerType 都映射到 i18n key', () => {
    for (const v of ['manual', 'cron', 'fixed_rate', 'dependency']) {
      expect(triggerLabel(v, identity)).toBe(TRIGGER_T_KEYS[v]);
      expect(TRIGGER_T_KEYS[v]).toBeTruthy();
    }
  });

  it('未知 triggerType 回退原始 token（不显示「未知」，保留可诊断信息）', () => {
    expect(triggerLabel('some_new_trigger', identity)).toBe('some_new_trigger');
  });

  it('空值返回空串，交由调用方决定占位符', () => {
    expect(triggerLabel(null, identity)).toBe('');
    expect(triggerLabel(undefined, identity)).toBe('');
    expect(triggerLabel('', identity)).toBe('');
  });

  it('版本状态：已知查表、未知回退', () => {
    expect(releaseStatusLabel('released', identity)).toBe('appDetail.history.status.released');
    expect(releaseStatusLabel('deploying', identity)).toBe('appDetail.history.status.deploying');
    expect(releaseStatusLabel('brand_new_status', identity)).toBe('brand_new_status');
    expect(releaseStatusLabel(null, identity)).toBe('');
  });

  it('每个映射到的 i18n key 在 zh/en 两套词条里都真实存在', () => {
    const zhDict = zh as Record<string, string>;
    const enDict = en as Record<string, string>;
    const keys = [...Object.values(TRIGGER_T_KEYS), ...Object.values(RELEASE_STATUS_T_KEYS)];
    expect(keys.length).toBeGreaterThanOrEqual(11); // 有齿：映射表不能被清空
    for (const k of keys) {
      expect(zhDict[k], `${k} 缺 zh 词条`).toBeTruthy();
      expect(enDict[k], `${k} 缺 en 词条`).toBeTruthy();
    }
  });
});

describe('UX-06 源码层：调用点不得再渲染裸枚举', () => {
  const APP = stripComments(read('pages/ApplicationDetailPage.tsx'));
  const TASK = stripComments(read('pages/TaskDetailPage.tsx'));
  // P1-17（UX 审计）：执行记录页触发方式列此前 `{v || '-'}` 直接输出后端 token
  // （cron/manual/fixed_rate），是排查失败最常落地的页面。现收敛到同一事实源。
  const EXEC = stripComments(read('pages/ExecutionsPage.tsx'));

  it('ApplicationDetailPage 任务列表触发方式列：不再 <Tag>{r.triggerType}</Tag>', () => {
    expect(APP).not.toMatch(/<Tag>\{r\.triggerType\}<\/Tag>/);
    expect(APP).toContain('triggerLabel(r.triggerType, t)');
  });

  it('ApplicationDetailPage 版本历史状态列：不再直接渲染 {v}', () => {
    expect(APP).toContain('releaseStatusLabel(v, t)');
    // 旧形态是 colorMap 后直接 `>{v}<`，钉住它不回来
    expect(APP).not.toMatch(/\}\[v\] \|\| 'default'\}>\{v\}</);
  });

  it('TaskDetailPage 两处：列表列与基本信息项都走 triggerLabel', () => {
    expect(TASK).not.toMatch(/<Tag>\{task\.triggerType\}<\/Tag>/);
    expect(TASK).toContain('triggerLabel(v, t)');
    expect(TASK).toContain('triggerLabel(task.triggerType, t)');
  });

  it('两页都从 utils/trigger-label 导入（唯一事实源，不再各写内联映射）', () => {
    for (const [name, src] of [
      ['ApplicationDetailPage', APP],
      ['TaskDetailPage', TASK],
    ] as const) {
      expect(src, `${name} 未从 utils/trigger-label 导入`).toContain("from '../utils/trigger-label'");
    }
  });

  it('P1-17 ExecutionsPage 触发方式列走 triggerLabel，不再渲染 {v || \'-\'} 裸枚举', () => {
    expect(EXEC, 'ExecutionsPage 未从 utils/trigger-label 导入').toContain(
      "from '../utils/trigger-label'",
    );
    expect(EXEC).toContain('triggerLabel(v, t)');
    // 旧形态是触发列 `render: (v) => <Text>{v || '-'}</Text>`——钉住它不回来。
    // （该文件内触发列是唯一 `{v || '-'}` 直出处。）
    expect(EXEC).not.toContain("{v || '-'}");
  });
});

describe('UX-06 AgentSessionsPage：会话/工具/步骤枚举收敛到 utils/agent-label', () => {
  const AGENT = stripComments(read('pages/AgentSessionsPage.tsx'));

  it('七个已知会话状态都映射到 i18n key', () => {
    for (const v of [
      'pending',
      'running',
      'waiting_input',
      'succeeded',
      'failed',
      'aborted',
      'budget_exceeded',
    ]) {
      expect(agentStatusLabel(v, identity)).toBe(AGENT_STATUS_T_KEYS[v]);
      expect(AGENT_STATUS_T_KEYS[v]).toBeTruthy();
    }
  });

  it('六个已知会话类型都映射到 i18n key', () => {
    for (const v of ['ops_watch', 'incident', 'sop_authoring', 'sop_review', 'app_scaffold', 'chat']) {
      expect(agentKindLabel(v, identity)).toBe(AGENT_KIND_T_KEYS[v]);
      expect(AGENT_KIND_T_KEYS[v]).toBeTruthy();
    }
  });

  it('工具状态/步骤角色/工具层级：已知查表命中、未知回退原始 token', () => {
    expect(agentToolStatusLabel('denied', identity)).toBe('agents.toolStatus.denied');
    expect(agentToolStatusLabel('circuit_open', identity)).toBe('agents.toolStatus.circuitOpen');
    expect(agentStepRoleLabel('assistant', identity)).toBe('agents.role.assistant');
    expect(agentToolTierLabel('dangerous', identity)).toBe('agents.tier.dangerous');
    expect(agentToolStatusLabel('brand_new_tool_status', identity)).toBe('brand_new_tool_status');
    expect(agentStepRoleLabel('brand_new_role', identity)).toBe('brand_new_role');
    expect(agentToolTierLabel(null, identity)).toBe('');
  });

  it('agent 全部枚举 key 在 zh/en 两套词条里都真实存在（7+6+6+4+3=26 个）', () => {
    const zhDict = zh as Record<string, string>;
    const enDict = en as Record<string, string>;
    const keys = [
      ...Object.values(AGENT_STATUS_T_KEYS),
      ...Object.values(AGENT_KIND_T_KEYS),
      ...Object.values(AGENT_TOOL_STATUS_T_KEYS),
      ...Object.values(AGENT_STEP_ROLE_T_KEYS),
      ...Object.values(AGENT_TOOL_TIER_T_KEYS),
    ];
    expect(keys.length).toBe(26); // 有齿：映射表不能被清空
    for (const k of keys) {
      expect(zhDict[k], `${k} 缺 zh 词条`).toBeTruthy();
      expect(enDict[k], `${k} 缺 en 词条`).toBeTruthy();
    }
  });

  it('状态 Tag 不再裸渲染 {status}/{c.status}，kind 不再裸渲染', () => {
    expect(AGENT, 'AgentSessionsPage 未从 utils/agent-label 导入').toContain(
      "from '../utils/agent-label'",
    );
    expect(AGENT).toContain('agentStatusLabel(status, t)');
    expect(AGENT).not.toMatch(/\{status\}<\/Tag>/);
    expect(AGENT).not.toContain('<Tag>{c.status}</Tag>');
    expect(AGENT).toContain('agentToolStatusLabel(c.status, t)');
    expect(AGENT).not.toContain('<Tag>{detail.kind}</Tag>');
    expect(AGENT).toContain('agentKindLabel(detail.kind, t)');
    // 列表/子会话行的 kind 列与标题兜底也走词表
    expect(AGENT).toContain('agentKindLabel(v, t)');
    expect(AGENT).not.toContain('{s.title ?? s.kind}');
  });

  it('列题不再是原始串（kind/role/tok/ms/tier/args → agents.col.*）', () => {
    expect(AGENT).toContain("t('agents.col.kind')");
    expect(AGENT).toContain("t('agents.col.role')");
    expect(AGENT).toContain("t('agents.col.tok')");
    expect(AGENT).toContain("t('agents.col.latency')");
    expect(AGENT).toContain("t('agents.col.duration')");
    expect(AGENT).toContain("t('agents.col.tier')");
    expect(AGENT).toContain("t('agents.col.args')");
    // 旧形态钉住不回来：列题直接写后端 token/原始缩写
    expect(AGENT).not.toMatch(/title: '(kind|role|tok|ms|tier|args)'/);
  });
});
