/**
 * R276：`agentSessionUrl.ts` 的三个纯函数 —— **此前零测试覆盖**。
 *
 * ## 为什么现在补（真实缺口，不是补覆盖率）
 *
 * `AgentSessionsPage.tsx:274` 是**唯一**把 URL 里的 `session` 参数喂给 API 路径的地方：
 * ```ts
 * const validId = sessionId !== null && isSessionPathSegment(sessionId) ? sessionId : null;
 * const { ... } = useAgentSessionDetail(validId);
 * ```
 * `validId` 为 `null` 时 `useAgentSessionDetail` **完全不发请求**
 * ⇒ **`isSessionPathSegment` 是那道闸本身**，而它此前**没有任何测试**。
 *
 * 它不是「内部工具函数」，而是**把不可信输入（URL query）变成 API 路径段**的边界。
 * 判据必须钉住三件事：
 *   ① **拒绝**穿越/分段字符（`/`、`\`、`.`、`..`、空白、非 ASCII）；
 *   ② **接受**后端真实会产生的 id 形态（字母数字 + `-` + `_`）；
 *   ③ **长度边界**（1..128）恰好在两侧封闭 —— 128 过、129 不过、空串不过。
 *
 * ## 另两个函数为什么也测
 * `agentSessionUrl()` 与 `agentSessionTab()` 此前只被**当作工具用**
 * （`agent-sessions-approvals.test.tsx` 里传参构造 URL），**从未断言过自己的输出**
 * ⇒ 参数名写错、默认值漏判、`tab=steps` 没省略，全都不会有测试红。
 */
import { describe, it, expect } from 'vitest';
import {
  agentSessionTab,
  agentSessionUrl,
  isSessionPathSegment,
} from '../utils/agentSessionUrl';

describe('isSessionPathSegment —— URL query 转 API 路径段的那道闸', () => {
  it('接受后端真实 id 形态（字母数字 + 连字符 + 下划线）', () => {
    for (const ok of ['abc', 'ABC', 'a-b_c', 'sess_123', 'a', 'x'.repeat(128)]) {
      expect(isSessionPathSegment(ok), `应接受 ${JSON.stringify(ok)}`).toBe(true);
    }
  });

  it('拒绝路径穿越与分段字符', () => {
    for (const bad of ['../etc/passwd', '..', '.', 'a/b', 'a\\b', 'a.b', '/etc', 'a%2Fb']) {
      expect(isSessionPathSegment(bad), `应拒绝 ${JSON.stringify(bad)}`).toBe(false);
    }
  });

  it('拒绝空白与非 ASCII（URL 解码后才到这里）', () => {
    for (const bad of ['', ' ', 'a b', 'a\tb', '中文', 'a\u0000b', '\n']) {
      expect(isSessionPathSegment(bad), `应拒绝 ${JSON.stringify(bad)}`).toBe(false);
    }
  });

  it('长度边界两侧都封闭：128 过、129 不过、0 不过', () => {
    expect(isSessionPathSegment('x'.repeat(128))).toBe(true);
    expect(isSessionPathSegment('x'.repeat(129))).toBe(false);
    expect(isSessionPathSegment('')).toBe(false);
  });
});

describe('agentSessionTab —— 未知值回落 steps（不抛错）', () => {
  it('合法 tab 原样返回', () => {
    for (const t of ['steps', 'tools', 'approvals', 'children', 'meta'] as const) {
      expect(agentSessionTab(t)).toBe(t);
    }
  });

  it('未知值 / null 回落 steps —— 不让坏 URL 把页面弄崩', () => {
    for (const bad of ['nope', 'STEPS', '', ' tools', null]) {
      expect(agentSessionTab(bad as string | null), `应回落 steps：${JSON.stringify(bad)}`).toBe('steps');
    }
  });
});

describe('agentSessionUrl —— 参数拼装（此前从没断言过自己的输出）', () => {
  it('只有 session 时省掉所有可选参数', () => {
    expect(agentSessionUrl('s1')).toBe('/agent-sessions?session=s1');
  });

  it('tab=steps 视为默认 ⇒ 不写进 URL（避免两套等价链接）', () => {
    expect(agentSessionUrl('s1', { tab: 'steps' })).toBe('/agent-sessions?session=s1');
    expect(agentSessionUrl('s1', { tab: 'tools' })).toBe('/agent-sessions?session=s1&tab=tools');
  });

  it('approvalKey 只在 tab=approvals 时携带（其他 tab 带了也不写）', () => {
    expect(agentSessionUrl('s1', { tab: 'approvals', approvalKey: 'k1' })).toBe(
      '/agent-sessions?session=s1&tab=approvals&approvalKey=k1',
    );
    expect(agentSessionUrl('s1', { tab: 'tools', approvalKey: 'k1' })).toBe(
      '/agent-sessions?session=s1&tab=tools',
    );
  });

  it('status 与 stalled 可叠加，stalled 落成 "1"', () => {
    expect(agentSessionUrl('s1', { status: 'pending', stalled: true })).toBe(
      '/agent-sessions?session=s1&status=pending&stalled=1',
    );
  });

  it('session 值经 URL 编码 → 解码后可还原（不丢字符）', () => {
    const url = agentSessionUrl('a b/c');
    const q = new URL(url, 'http://x').searchParams;
    expect(q.get('session')).toBe('a b/c');
  });
});
