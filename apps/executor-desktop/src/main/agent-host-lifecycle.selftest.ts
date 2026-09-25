import * as assert from 'node:assert/strict';
import { agentHostIdentity, agentHostTransition } from './agent-host-lifecycle';

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

console.log('agent-host-lifecycle selftest ok');
