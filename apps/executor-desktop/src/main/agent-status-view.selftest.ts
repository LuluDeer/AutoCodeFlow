import * as assert from 'node:assert/strict';
import {
  agentActivityLabel,
  agentActivityState,
  agentOutcomeLabel,
  agentStatusSignature,
  type AgentStatusSnapshot,
} from './agent-status-view';
import { TRAY_TEXTS, type TrayLocale } from './tray-texts';

const base: AgentStatusSnapshot = {
  enabled: false,
  polling: false,
  working: false,
  lastAssignmentId: null,
  lastOutcome: null,
  processed: 0,
  lastEffectiveProfile: null,
};

// ── 状态快照 → 活动标签键（纯映射；NETOPT-DEBT 双语收尾后文案在表里） ──
assert.equal(agentActivityState(base), 'disabled');
assert.equal(agentActivityState({ ...base, enabled: true }), 'awaitingConfig');
assert.equal(agentActivityState({ ...base, enabled: true, polling: true }), 'polling');
assert.equal(agentActivityState({ ...base, enabled: true, polling: true, working: true }), 'working');
assert.equal(agentActivityState({ ...base, working: true }), 'workingAfterStop');

// ── 中文（缺省 locale：单参调用行为与收尾前完全一致） ──────────────────
assert.equal(agentActivityLabel(base), '未启用');
assert.equal(agentActivityLabel({ ...base, enabled: true }), '已启用，等待完成连接配置');
assert.equal(agentActivityLabel({ ...base, enabled: true, polling: true }), '已启用，正在轮询指派');
assert.equal(agentActivityLabel({ ...base, enabled: true, polling: true, working: true }), '正在处理指派');
// 关开关只停新单；当前任务仍在运行时不能向用户误报「未启用、无动作」。
assert.equal(agentActivityLabel({ ...base, working: true }), '正在处理当前指派（已停止接新单）');
assert.equal(agentOutcomeLabel('delivered'), '候选应用已交付');
assert.equal(agentOutcomeLabel('deliver_failed'), '候选应用交付失败');
assert.equal(agentOutcomeLabel('clarification_requested'), '已发起澄清');
assert.equal(agentOutcomeLabel(null), '暂无');
assert.equal(agentOutcomeLabel('future_outcome'), 'future_outcome');

// ── 英文（NETOPT-DEBT：文案本体在 TRAY_TEXTS.en，本模块只做键映射） ────
const en: TrayLocale = 'en';
assert.equal(agentActivityLabel(base, en), TRAY_TEXTS.en.agentActivity.disabled);
assert.equal(agentActivityLabel(base, en), 'Not enabled');
assert.equal(
  agentActivityLabel({ ...base, enabled: true }, en),
  'Enabled, waiting for connection setup',
);
assert.equal(
  agentActivityLabel({ ...base, enabled: true, polling: true }, en),
  'Enabled, polling for assignments',
);
assert.equal(
  agentActivityLabel({ ...base, enabled: true, polling: true, working: true }, en),
  'Working on an assignment',
);
assert.equal(
  agentActivityLabel({ ...base, working: true }, en),
  'Finishing current assignment (not accepting new ones)',
);
assert.equal(agentOutcomeLabel('delivered', en), 'Candidate app delivered');
assert.equal(agentOutcomeLabel('gate_stopped', en), 'Execution limit reached');
assert.equal(agentOutcomeLabel(null, en), 'None yet');
// 未知 outcome：两语言同策略原样透出（不炸、不误报）
assert.equal(agentOutcomeLabel('future_outcome', en), 'future_outcome');

// ── R5-T2：托盘刷新签名（全字段；早退条件只剩「签名相同」一条） ────────
const sig = agentStatusSignature(base);
assert.equal(agentStatusSignature(base), sig, '同一快照签名稳定');
// 关键反例：仅指派 ID 变化，旧早退条件五字段全等 → 菜单不刷新。
assert.notEqual(
  agentStatusSignature({ ...base, lastAssignmentId: 'asg-1' }),
  sig,
  'lastAssignmentId 变化必须触发托盘重绘',
);
assert.notEqual(
  agentStatusSignature({ ...base, lastEffectiveProfile: 'workspace-write' }),
  sig,
  'lastEffectiveProfile 变化必须触发托盘重绘',
);
assert.notEqual(
  agentStatusSignature({ ...base, lastOutcome: 'delivered' }),
  sig,
  '最近结果变化必须触发托盘重绘',
);
assert.notEqual(agentStatusSignature({ ...base, processed: 1 }), sig, '处理计数参与签名');
assert.notEqual(agentStatusSignature({ ...base, enabled: true }), sig, '开关参与签名');
assert.notEqual(agentStatusSignature({ ...base, polling: true }), sig, '轮询态参与签名');
assert.notEqual(agentStatusSignature({ ...base, working: true }), sig, '工作中参与签名');
// 无关字段：快照形状之外的附加元数据不进菜单/tooltip，签名必须保持不变。
const withExtra = { ...base, polledAt: '2026-11-24T10:00:00Z', traceToken: 'x' } as AgentStatusSnapshot;
assert.equal(agentStatusSignature(withExtra), sig, '快照外字段不影响签名');
// 分隔符合理：不同字段边界不得撞出同一个签名。
assert.notEqual(
  agentStatusSignature({ ...base, lastAssignmentId: 'ab', lastOutcome: 'c' }),
  agentStatusSignature({ ...base, lastAssignmentId: 'a', lastOutcome: 'bc' }),
  'NUL 分隔避免字段拼接碰撞',
);

console.log('agent-status-view selftest ok');
