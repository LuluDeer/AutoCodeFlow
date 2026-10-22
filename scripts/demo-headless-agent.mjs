#!/usr/bin/env node
/**
 * Headless desktop-agent demo: a real SOP assignment → real model → trial run →
 * acceptance → completion, without Electron.
 *
 * It registers a short-lived executor, drafts/publishes a small SOP, assigns it
 * to that executor, then runs the SAME `AgentHost` used by the desktop app
 * (poll → capability → permission merge → runAgentLoop → complete).
 *
 * Requires:
 *   - a running admin-api (default http://127.0.0.1:3105)
 *   - AI_PROVIDER configured (e.g. qwen + an OpenAI-compatible endpoint)
 *   - the compiled desktop selftest modules (the demo script builds them if
 *     needed): apps/executor-desktop/dist-selftest/agent/*.js
 *
 * Credentials are read from .env.demo (gitignored) unless env vars are set:
 *   ACF_BASE_URL, ACF_ADMIN_PASSWORD, ACF_EXECUTOR_SECRET
 *
 * Usage:
 *   ./scripts/demo-headless-agent.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'apps/executor-desktop/dist-selftest/agent');
const { AgentHost } = require(path.join(dist, 'agent-host.js'));
const { CollabClient } = require(path.join(dist, 'collab-client.js'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line || line.trimStart().startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i <= 0) continue;
    out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

const env = readEnvFile(path.join(root, '.env.demo'));
const base = (process.env.ACF_BASE_URL || 'http://127.0.0.1:3105').replace(/\/+$/, '');
const adminPassword = process.env.ACF_ADMIN_PASSWORD || env.INITIAL_ADMIN_PASSWORD;
const executorSecret = process.env.ACF_EXECUTOR_SECRET || env.EXECUTOR_SECRET;
if (!adminPassword || !executorSecret) {
  console.error('✗ missing ACF_ADMIN_PASSWORD / ACF_EXECUTOR_SECRET (or .env.demo)');
  process.exit(1);
}

async function api(pathname, { method = 'GET', token, auth, body } = {}) {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(auth ? { authorization: auth } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let raw;
  try { raw = JSON.parse(text); } catch { raw = text; }
  if (!res.ok) {
    throw new Error(`${method} ${pathname} -> ${res.status}: ${String(text).slice(0, 500)}`);
  }
  return raw && typeof raw === 'object' && 'data' in raw ? raw.data : raw;
}

const status = (text) => console.log(`→ ${text}`);

(async () => {
  if (!fs.existsSync(path.join(dist, 'agent-host.js'))) {
    console.error('✗ desktop selftest modules missing; run:');
    console.error('  cd apps/executor-desktop && npx tsc -p tsconfig.selftest.json');
    process.exit(1);
  }

  status('admin login');
  const login = await api('/api/auth/login', {
    method: 'POST',
    body: { username: 'admin', password: adminPassword },
  });
  const adminToken = login.accessToken;
  if (!adminToken) throw new Error('login returned no accessToken');

  const suffix = Date.now().toString(36);
  const address = `headless-agent-${suffix}:8010`;
  status(`register executor ${address}`);
  const registered = await api('/api/executors/register', {
    method: 'POST',
    auth: `Bearer ${executorSecret}`,
    body: {
      appName: `headless-agent-${suffix}`,
      address,
      type: 'node',
      version: '0.0.0-demo',
      capabilities: ['node', 'shell'],
      runtime: ['node'],
      dispatchMode: 'pull',
      maxConcurrentTasks: 1,
      startupId: crypto.randomUUID(),
    },
  });
  const executorToken = registered?.perExecutorToken;
  if (!executorToken) throw new Error('register returned no perExecutorToken');

  const slug = `headless-smoke-${suffix}`;
  const frontMatterYaml = [
    'target:',
    '  runtime: node',
    'capabilities:',
    '  - filesystem',
    'acceptance:',
    '  - kind: command',
    '    run: node verify.js',
    'constraints:',
    '  maxDurationSec: 600',
    'clarification:',
    '  owner: human',
    '  maxRounds: 2',
  ].join('\n');
  const bodyMarkdown = [
    '# 目标',
    '',
    '在工作区写 `main.js`：把字符串 `fine` 写入 `out.txt`。',
    '再写 `verify.js`：读取 `out.txt`，内容不是 `fine` 就 exit 1。',
    '',
    '## 验收',
    '- 平台执行 `node verify.js` 必须退出 0。',
    '',
    '## 约束',
    '- 只能用 node；不要访问工作区外路径。',
  ].join('\n');

  status(`draft SOP ${slug}`);
  const sop = await api('/api/sop', {
    method: 'POST',
    token: adminToken,
    body: { slug, title: 'Headless agent smoke', frontMatterYaml, bodyMarkdown },
  });
  await api(`/api/sop/${sop.id}/publish`, {
    method: 'POST',
    token: adminToken,
    body: {},
  });

  if (process.env.ACF_DEBUG_AGENT === '1') {
    const originalProcess = AgentHost.prototype.processAssignment;
    AgentHost.prototype.processAssignment = async function (item) {
      console.log(`  [agent] assignment start ${item.assignmentId} sop=${item.sop?.slug}`);
      try {
        const result = await originalProcess.call(this, item);
        console.log('  [agent] assignment finished');
        return result;
      } catch (err) {
        console.error('  [agent] assignment error:', err instanceof Error ? err.message : err);
        throw err;
      }
    };
    const originalLlm = CollabClient.prototype.llmRelay;
    CollabClient.prototype.llmRelay = async function (...args) {
      console.log('  [agent] llmRelay start');
      try {
        const result = await originalLlm.apply(this, args);
        console.log(`  [agent] llmRelay end ok=${result.ok} chars=${(result.content || '').length}`);
        return result;
      } catch (err) {
        console.error('  [agent] llmRelay error:', err instanceof Error ? err.message : err);
        throw err;
      }
    };
  }

  if (process.env.ACF_DEBUG_AGENT === '1') {
    const originalTick = AgentHost.prototype.tick;
    AgentHost.prototype.tick = async function (...args) {
      console.log('  [agent] tick start');
      try { const r = await originalTick.apply(this, args); console.log('  [agent] tick end', JSON.stringify(r)); return r; }
      catch (e) { console.error('  [agent] tick error', e); throw e; }
    };
    const originalAdvertise = AgentHost.prototype.advertiseCapabilities;
    AgentHost.prototype.advertiseCapabilities = async function (...args) {
      console.log('  [agent] advertise start');
      try { const r = await originalAdvertise.apply(this, args); console.log('  [agent] advertise end', JSON.stringify(r)); return r; }
      catch (e) { console.error('  [agent] advertise error', e); throw e; }
    };
    const originalPoll = CollabClient.prototype.poll;
    CollabClient.prototype.poll = async function (...args) {
      console.log('  [agent] poll start');
      try { const r = await originalPoll.apply(this, args); console.log('  [agent] poll end ok=' + r.ok + ' items=' + JSON.stringify((r.items || []).map((i) => i && i.kind)) + ' policy=' + JSON.stringify(r.sopPolicy)); return r; }
      catch (e) { console.error('  [agent] poll error', e); throw e; }
    };
  }

  const workDir = fs.mkdtempSync(path.join('/tmp', 'acf-headless-agent-'));
  const client = new CollabClient({ baseUrl: base, token: executorToken });
  const host = new AgentHost({
    address,
    workDir,
    client,
    getConfig: () => ({
      agentEnabled: true,
      adminApiUrl: base,
      executorToken,
      agent: {
        preset: 'standard',
        allowedApps: [],
        allowedDomains: [],
      },
      mediaBaseUrl: process.env.ACF_MEDIA_BASE_URL || undefined,
    }),
    limits: {
      maxIterations: 4,
      maxTrialRuns: 4,
      maxWallClockMs: 8 * 60 * 1000,
      maxClarificationRounds: 1,
      maxDependencyInstalls: 0,
    },
  });

  // The assign endpoint checks the executor's **advertised** agent:sop
  // capability. AgentHost advertises it on its first tick (before poll), so
  // tick once before creating the assignment.
  status('advertise agent:sop capability');
  const preflight = await host.tick();
  if (process.env.ACF_DEBUG_AGENT === '1') {
    console.log(`  capability tick: ${JSON.stringify(preflight)}`);
    const execs = await api('/api/executors', { token: adminToken });
    const execRow = (Array.isArray(execs) ? execs : execs.list ?? execs.items ?? []).find(
      (e) => e.address === address,
    );
    console.log(`  executor: status=${execRow?.status ?? '?'}`);
  }

  status('assign SOP to headless executor');
  const assignment = await api(`/api/sop/${sop.id}/assign`, {
    method: 'POST',
    token: adminToken,
    body: { executorAddress: address },
  });
  const assignmentId = assignment?.id ?? assignment?.assignmentId;
  if (!assignmentId) throw new Error('assign returned no assignment id');

  status('poll / execute / report (real AgentHost)');
  let lastStatus = '';
  for (let i = 0; i < 150; i += 1) {
    const tick = await host.tick();
    if (tick.worked) console.log(`  tick: ${tick.detail ?? 'worked'}`);
    const detail = await api(`/api/sop/assignments/${assignmentId}`, { token: adminToken });
    const current = detail?.assignment?.status ?? detail?.status ?? '';
    if (current && current !== lastStatus) {
      lastStatus = current;
      console.log(`  assignment status: ${current}`);
    }
    if (['completed', 'failed', 'cancelled', 'rejected'].includes(current)) {
      console.log(`  outcome: ${current}`);
      console.log(`  assignment: ${assignmentId}`);
      console.log(`  workDir: ${workDir}`);
      if (current !== 'completed') {
        console.log(`  assignment: ${JSON.stringify(detail?.assignment ?? detail).slice(0, 1200)}`);
        process.exit(1);
      }
      console.log('✓ headless SOP assignment closed loop passed');
      return;
    }
    await sleep(2000);
  }
  throw new Error('timeout waiting for assignment to finish');
})().catch((err) => {
  console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
