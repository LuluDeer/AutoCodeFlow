import * as assert from 'node:assert/strict';
import { agentActivityLabel, agentOutcomeLabel, type AgentStatusSnapshot } from './agent-status-view';

const base: AgentStatusSnapshot = {
  enabled: false,
  polling: false,
  working: false,
  lastAssignmentId: null,
  lastOutcome: null,
  processed: 0,
  lastEffectiveProfile: null,
};

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

console.log('agent-status-view selftest ok');
