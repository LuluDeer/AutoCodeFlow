import * as assert from 'node:assert/strict';
import {
  agentActivityLabel,
  agentActivityState,
  agentOutcomeLabel,
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

console.log('agent-status-view selftest ok');
