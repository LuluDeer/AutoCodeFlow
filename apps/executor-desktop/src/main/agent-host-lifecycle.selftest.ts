import * as assert from 'node:assert/strict';
import {
  MAX_AGENT_HOST_DEFERS,
  agentHostIdentity,
  agentHostTransition,
} from './agent-host-lifecycle';

const base = { baseUrl: 'https://admin.example', token: 'secret-a', address: 'host:3000', workDir: 'C:\\work-a' };
const current = agentHostIdentity(base);
assert.equal(agentHostTransition(null, current, false), 'create');
assert.equal(agentHostTransition(current, current, false), 'keep');

for (const changed of [
  { baseUrl: 'https://other.example' },
  { token: 'secret-b' },
  { address: 'host:3001' },
  { workDir: 'C:\\work-b' },
]) {
  const next = agentHostIdentity({ ...base, ...changed });
  assert.notEqual(next, current);
  assert.equal(agentHostTransition(current, next, true), 'defer');
  assert.equal(agentHostTransition(current, next, false), 'replace');
}

// ── B：defer 封顶（绝不允许无限 defer）────────────────────────────────
// 反证：把 agentHostTransition 的 deferStreak 判定删掉（永远 defer），
// 下方「到顶必须 replace」两条断言立刻转红。
{
  const next = agentHostIdentity({ ...base, token: 'secret-rotated' });
  // 未到上限：仍在等 tick 结束
  assert.equal(agentHostTransition(current, next, true, 0), 'defer');
  assert.equal(agentHostTransition(current, next, true, MAX_AGENT_HOST_DEFERS - 1), 'defer');
  // 到顶/超顶：强制重建（不再无限 defer）
  assert.equal(agentHostTransition(current, next, true, MAX_AGENT_HOST_DEFERS), 'replace');
  assert.equal(agentHostTransition(current, next, true, MAX_AGENT_HOST_DEFERS + 100), 'replace');
  // 上限本身必须有限且量级合理（0 会让 defer 语义消失；过大等于没封顶）
  assert.ok(
    Number.isFinite(MAX_AGENT_HOST_DEFERS) && MAX_AGENT_HOST_DEFERS >= 2 && MAX_AGENT_HOST_DEFERS <= 120,
    `MAX_AGENT_HOST_DEFERS（${MAX_AGENT_HOST_DEFERS}）必须在 2–120 次（30s 轮询下 1–60 分钟）`,
  );
  // 同身份/无 tick 在飞时计数无关：不得因为计数残留而误替换
  assert.equal(agentHostTransition(current, current, true, MAX_AGENT_HOST_DEFERS + 5), 'keep');
  assert.equal(agentHostTransition(current, next, false, MAX_AGENT_HOST_DEFERS + 5), 'replace');
}

console.log('agent-host-lifecycle selftest ok');
