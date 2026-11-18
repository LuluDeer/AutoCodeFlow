/**
 * R277：`status-color.ts` —— **全站「状态 → 颜色」的单一事实源**，此前零测试。
 *
 * ## 为什么值得测（这不是「补覆盖率」）
 *
 * 该文件收口了此前散落 5 处的「状态→色」知识：
 * `TaskDetailPage.STATUS_COLOR` / `ExecutionRetryChain.RETRY_STATUS_COLOR` /
 * `AgentSessionsPage.STATUS_COLORS` / `ApplicationDetailPage.*` /
 * `SopsPage`（经 `sop-label`）。收敛纪律是**只搬运、不改值**。
 *
 * 而它的表全是 `Record<string, …>` **宽键** —— 调用点用 `?? 'default'` 兜底。
 * 这带来两个**静默**失败模式，编译器都拦不住：
 *
 *   ① **迁移错值**：搬运时把 `killed` 的 Tag 从 `volcano` 写成 `red`，
 *      类型完全合法 ⇒ 用户看到的颜色变了，但没有任何东西会红；
 *   ② **键集漂移**：后端新增一个状态（如新的 session status），
 *      前端表没跟上 ⇒ 该状态**静默渲染成中性色**（看起来「正常」，实际是「未知」）。
 *
 * ⇒ 本测试钉两件事：
 *   · **对拍**：`AGENT_SESSION_STATUS_COLOR` / `AGENT_APPROVAL_STATUS_COLOR`
 *     的键集必须**等于** `api/agent.ts` 的规范枚举（上面 ② 的正向检查）；
 *   · **逐字取值**：每条映射的取値按「用户看到的颜色」断言（上面 ① 的检查）。
 *
 * ## 为什么取值断言要写死而不是「非空即可」
 *
 * 「非空」对 ① 完全无效 —— 错值也是非空。故对**有语义区分度的**条目写死：
 * 成功=green、失败=red、超时/熔断=volcano、在途=gold。这些不是审美偏好，
 * 而是「用户靠它一眼判断状态」的约定，改了就是行为变更。
 */
import { describe, it, expect } from 'vitest';
import {
  AGENT_APPROVAL_STATUS_COLOR,
  AGENT_SESSION_STATUS_COLOR,
  AGENT_TOOL_STATUS_COLOR,
  APPLICATION_STATUS_COLOR,
  EXECUTION_BADGE_STATUS,
  EXECUTION_TAG_COLOR,
  RELEASE_DEPLOY_STATUS_COLOR,
  SOP_ASSIGNMENT_STATUS_COLOR,
  SOP_STATUS_COLOR,
} from '../status-color';
import {
  AGENT_APPROVAL_STATUSES,
  AGENT_SESSION_STATUSES,
} from '../../api/agent';

describe('status-color：键集必须与规范枚举**双向相等**（新增状态不许静默变中性色）', () => {
  it('Agent 会话状态：表的键集 == AGENT_SESSION_STATUSES', () => {
    expect(Object.keys(AGENT_SESSION_STATUS_COLOR).sort()).toEqual(
      [...AGENT_SESSION_STATUSES].sort(),
    );
  });

  it('Agent 审批状态：表的键集 == AGENT_APPROVAL_STATUSES', () => {
    expect(Object.keys(AGENT_APPROVAL_STATUS_COLOR).sort()).toEqual(
      [...AGENT_APPROVAL_STATUSES].sort(),
    );
  });

  it('每张表都非空（空表会让整页静默退成默认色）', () => {
    const tables = {
      EXECUTION_BADGE_STATUS,
      EXECUTION_TAG_COLOR,
      AGENT_SESSION_STATUS_COLOR,
      AGENT_TOOL_STATUS_COLOR,
      AGENT_APPROVAL_STATUS_COLOR,
      APPLICATION_STATUS_COLOR,
      RELEASE_DEPLOY_STATUS_COLOR,
      SOP_STATUS_COLOR,
      SOP_ASSIGNMENT_STATUS_COLOR,
    };
    for (const [name, t] of Object.entries(tables)) {
      expect(Object.keys(t).length, `${name} 不应为空`).toBeGreaterThan(0);
    }
  });

  it('每张表的取值都是非空字符串（缺值会让 antd 渲染成无样式）', () => {
    const tables = [
      EXECUTION_BADGE_STATUS,
      EXECUTION_TAG_COLOR,
      AGENT_SESSION_STATUS_COLOR,
      AGENT_TOOL_STATUS_COLOR,
      AGENT_APPROVAL_STATUS_COLOR,
      APPLICATION_STATUS_COLOR,
      RELEASE_DEPLOY_STATUS_COLOR,
      SOP_STATUS_COLOR,
      SOP_ASSIGNMENT_STATUS_COLOR,
    ];
    for (const t of tables) {
      for (const [k, v] of Object.entries(t)) {
        expect(typeof v === 'string' && v.length > 0, `${k} 的取值应非空`).toBe(true);
      }
    }
  });
});

describe('status-color：有语义区分度的取值逐字钉住（防「迁移错值」）', () => {
  it('执行状态：成功=success/green、失败=error/red、超时=warning/orange', () => {
    expect(EXECUTION_BADGE_STATUS.success).toBe('success');
    expect(EXECUTION_BADGE_STATUS.failed).toBe('error');
    expect(EXECUTION_BADGE_STATUS.timeout).toBe('warning');
    expect(EXECUTION_TAG_COLOR.success).toBe('green');
    expect(EXECUTION_TAG_COLOR.failed).toBe('red');
    expect(EXECUTION_TAG_COLOR.timeout).toBe('orange');
  });

  it('killed 在两张表里**故意不同**（Badge=error / Tag=volcano）—— 收口时不许合并', () => {
    // 这条是设计意图：单一取值无法同时表达两个渲染目标，合并会让某一侧变色。
    expect(EXECUTION_BADGE_STATUS.killed).toBe('error');
    expect(EXECUTION_TAG_COLOR.killed).toBe('volcano');
  });

  it('Agent 工具：在途用 gold（不是失败，也不是成功）', () => {
    expect(AGENT_TOOL_STATUS_COLOR.in_flight).toBe('gold');
    expect(AGENT_TOOL_STATUS_COLOR.ok).toBe('green');
    expect(AGENT_TOOL_STATUS_COLOR.denied).toBe('red');
    expect(AGENT_TOOL_STATUS_COLOR.circuit_open).toBe('volcano');
  });

  it('Agent 审批：consumed=blue（一次性放行，与 granted 不同色）', () => {
    expect(AGENT_APPROVAL_STATUS_COLOR.granted).toBe('green');
    expect(AGENT_APPROVAL_STATUS_COLOR.consumed).toBe('blue');
    expect(AGENT_APPROVAL_STATUS_COLOR.denied).toBe('red');
    expect(AGENT_APPROVAL_STATUS_COLOR.expired).toBe('default');
  });

  it('Agent 会话：budget_exceeded=volcano（超预算不是普通失败）', () => {
    expect(AGENT_SESSION_STATUS_COLOR.succeeded).toBe('green');
    expect(AGENT_SESSION_STATUS_COLOR.failed).toBe('red');
    expect(AGENT_SESSION_STATUS_COLOR.budget_exceeded).toBe('volcano');
    expect(AGENT_SESSION_STATUS_COLOR.waiting_input).toBe('orange');
  });

  it('SOP 工单：stalled=volcano（卡住 ≠ 失败）', () => {
    expect(SOP_ASSIGNMENT_STATUS_COLOR.stalled).toBe('volcano');
    expect(SOP_ASSIGNMENT_STATUS_COLOR.failed).toBe('red');
    expect(SOP_ASSIGNMENT_STATUS_COLOR.completed).toBe('green');
  });
});
