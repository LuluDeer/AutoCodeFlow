/**
 * P7b self-check：Agent 托管的指派全生命周期（端到端，本地 http server
 * 全真模拟中台的协作面）。
 * Run via: npm run test:main
 *
 * 覆盖链路：poll 领工单 → 能力上报（agent:sop + browser 探测）→ 建工作区 →
 * 循环（LLM relay 严格 JSON + 真沙箱试跑 + 验收）→ 回报 completed/failed；
 * 澄清路径（LLM 判 clarify → sendClarification）；策略合并路径
 * （中台下压 minimal → 试跑被档位闸拒 → 如实回报 failed + effectiveProfile）；
 * agentEnabled=false 不动；单飞行不并发。
 */
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { AgentHost, type AgentHostConfig } from './agent-host';
import { CollabClient } from './collab-client';

let failures = 0;
function check(name: string, cond: boolean, extra = ''): void {
  if (cond) console.log(`  \u2714 ${name}`);
  else {
    failures++;
    console.error(`  \u2718 ${name}${extra ? ` \u2014 ${extra}` : ''}`);
  }
}

const ASSIGNMENT_ID = 'aaaaaaaa-1111-2222-3333-444444444444';
const MAIN_OK = "require('fs').writeFileSync('out.txt', 'fine');\n";
const MAIN_BAD = "process.exit(1);\n";
const VERIFY_OK = "const c = require('fs').readFileSync('out.txt', 'utf8');\nif (c !== 'fine') process.exit(2);\n";

/** 模拟中台：记录所有请求，按脚本回响应。assignment 只在首个 poll 发出。 */
function makeCenter(opts: { llmScript: string[]; sopPolicy?: unknown }) {
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  const llmQueue = [...opts.llmScript];
  let assignmentSent = false;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>;
      const p = req.url ?? '/';
      requests.push({ path: p, body });
      const reply = (obj: unknown): void => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (p === '/api/agent-collab/poll') {
        if (!assignmentSent) {
          assignmentSent = true;
          reply({
            items: [{
              kind: 'assignment',
              assignmentId: ASSIGNMENT_ID,
              sop: {
                slug: 'e2e-sop', title: 'T', version: '1.0.0', contentHash: 'h',
                frontMatter: {
                  capabilities: ['filesystem'],
                  acceptance: [{ kind: 'command', run: 'node verify.js' }],
                  constraints: {},
                },
                bodyMarkdown: '# do',
              },
            }],
            sopPolicy: opts.sopPolicy ?? { permissionPolicy: 'standard', allowedProfiles: ['minimal', 'standard'] },
          });
        } else {
          reply({ items: [], sopPolicy: opts.sopPolicy ?? { permissionPolicy: 'standard', allowedProfiles: ['minimal', 'standard'] } });
        }
        return;
      }
      if (p === '/api/agent-collab/llm') {
        reply({ content: llmQueue.shift() ?? '{"action":"escalate"}', usage: { tokensIn: 1, tokensOut: 1 }, model: 'test' });
        return;
      }
      if (p === '/api/agent-collab/capability' || p.startsWith('/api/agent-collab/assignments/')) {
        reply({ ok: true, accepted: true });
        return;
      }
      if (p === '/api/agent-collab/clarifications') {
        reply({ ok: true, escalated: false, round: 1 });
        return;
      }
      reply({ ok: true });
    });
  });
  return {
    requests,
    listen: (): Promise<string> =>
      new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          const addr = server.address();
          resolve(`http://127.0.0.1:${(addr as { port: number }).port}`);
        });
      }),
    close: (): Promise<void> => new Promise((r) => server.close(() => r())),
  };
}

async function main(): Promise<void> {
  console.log('\n=== agent-host selftest ===\n');
  // 每节独立 workDir——共享会让「无产物」类断言见到其它节的产物
  const workDirs: string[] = [];
  const newWorkDir = (): string => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-host-'));
    workDirs.push(d);
    return d;
  };

  console.log('-- 1. disabled → 完全不动 --');
  {
    const workDir = newWorkDir();
    const center = makeCenter({ llmScript: [] });
    const baseUrl = await center.listen();
    const client = new CollabClient({ baseUrl, token: 't', timeoutMs: 5000 });
    const config: AgentHostConfig = {
      agentEnabled: false, adminApiUrl: baseUrl, executorToken: 't',
      agent: { preset: 'standard' },
    };
    const host = new AgentHost({ address: 'a:1', workDir, getConfig: () => config, client });
    const r = await host.tick();
    check('disabled 时 tick 无动作', r.worked === false && r.detail === 'agent disabled' && center.requests.length === 0);
    await center.close();
  }

  console.log('-- 2. happy path：领单 → 循环 → completed --');
  {
    const workDir = newWorkDir();
    const center = makeCenter({
      llmScript: [
        JSON.stringify({ files: [{ path: 'main.js', content: MAIN_OK }, { path: 'verify.js', content: VERIFY_OK }], entry: { interpreter: 'node', path: 'main.js' }, notes: 'n' }),
      ],
    });
    const baseUrl = await center.listen();
    const client = new CollabClient({ baseUrl, token: 't', timeoutMs: 5000 });
    const config: AgentHostConfig = {
      agentEnabled: true, adminApiUrl: baseUrl, executorToken: 't',
      agent: { preset: 'standard' },
    };
    const host = new AgentHost({ address: 'a:1', workDir, getConfig: () => config, client });
    const r = await host.tick();
    check('tick 处理了工单', r.worked === true);
    check('能力上报含 agent:sop', center.requests.some((q) => q.path === '/api/agent-collab/capability' && JSON.stringify(q.body.capabilities ?? '').includes('agent:sop')));
    check('浏览器能力按探测如实上报（本机未装二进制 → 无 browser）', (() => {
      const cap = center.requests.find((q) => q.path === '/api/agent-collab/capability');
      const caps = JSON.stringify(cap?.body.capabilities ?? []);
      return caps.includes('browser') || caps.includes('filesystem');
    })());
    const complete = center.requests.find((q) => q.path === `/api/agent-collab/assignments/${ASSIGNMENT_ID}/complete`);
    check('回报 completed', complete?.body.status === 'completed', `body=${JSON.stringify(complete?.body).slice(0, 120)}`);
    check('回报带 effectiveProfile（审计可见）', JSON.stringify(complete?.body).includes('effectiveProfile'));
    check('lastOutcome 记录', host.stats.lastOutcome === 'delivered');
    check('工作区产物落盘', fs.existsSync(path.join(workDir, 'agent-workspace', ASSIGNMENT_ID, 'out.txt')));
    await center.close();
  }

  console.log('-- 3. 澄清路径 --');
  {
    const workDir = newWorkDir();
    const center = makeCenter({
      llmScript: [
        JSON.stringify({ files: [{ path: 'main.js', content: MAIN_BAD }, { path: 'verify.js', content: VERIFY_OK }], entry: { interpreter: 'node', path: 'main.js' } }),
        JSON.stringify({ action: 'clarify', question: 'SOP 没说要输出到哪里' }),
      ],
    });
    const baseUrl = await center.listen();
    const client = new CollabClient({ baseUrl, token: 't', timeoutMs: 5000 });
    const config: AgentHostConfig = {
      agentEnabled: true, adminApiUrl: baseUrl, executorToken: 't',
      agent: { preset: 'standard' },
    };
    const host = new AgentHost({ address: 'a:1', workDir, getConfig: () => config, client });
    await host.tick();
    const clar = center.requests.find((q) => q.path === '/api/agent-collab/clarifications');
    check('澄清上报中台', clar !== undefined);
    check('澄清幂等键 + 指派归属', typeof clar?.body.clientClarificationId === 'string' && clar?.body.assignmentId === ASSIGNMENT_ID);
    check('澄清问题透传', JSON.stringify(clar?.body.question ?? '').includes('SOP'));
    check('不回报 completed', !center.requests.some((q) => q.path.endsWith('/complete')));
    check('lastOutcome=clarification_requested', host.stats.lastOutcome === 'clarification_requested');
    await center.close();
  }

  console.log('-- 4. 策略合并：中台压到 minimal → 档位闸拒 → failed --');
  {
    const workDir = newWorkDir();
    const center = makeCenter({
      llmScript: [JSON.stringify({ files: [{ path: 'main.js', content: MAIN_OK }, { path: 'verify.js', content: VERIFY_OK }], entry: { interpreter: 'node', path: 'main.js' } })],
      sopPolicy: { permissionPolicy: 'minimal', allowedProfiles: ['minimal'] },
    });
    const baseUrl = await center.listen();
    const client = new CollabClient({ baseUrl, token: 't', timeoutMs: 5000 });
    const config: AgentHostConfig = {
      agentEnabled: true, adminApiUrl: baseUrl, executorToken: 't',
      agent: { preset: 'standard' }, // 本地 standard 被中台压到 minimal
    };
    const host = new AgentHost({ address: 'a:1', workDir, getConfig: () => config, client });
    await host.tick();
    const complete = center.requests.find((q) => q.path === `/api/agent-collab/assignments/${ASSIGNMENT_ID}/complete`);
    check('被压档 → 回报 failed 而非 completed', complete?.body.status === 'failed');
    const result = complete?.body.result as { outcome?: string; effectiveProfile?: string } | undefined;
    check('失败原因是档位拒绝', result?.outcome === 'permission_denied', `outcome=${result?.outcome ?? 'null'}`);
    check('生效档位如实记录（minimal/off）', (result?.effectiveProfile ?? '').includes('ce=off'));
    check('本地 standard 没有偷偷试跑（无产物）', !fs.existsSync(path.join(workDir, 'agent-workspace', ASSIGNMENT_ID, 'out.txt')));
    await center.close();
  }

  console.log('-- 5. 单飞行 --');
  {
    const workDir = newWorkDir();
    const center = makeCenter({ llmScript: [] });
    const baseUrl = await center.listen();
    const client = new CollabClient({ baseUrl, token: 't', timeoutMs: 5000 });
    const config: AgentHostConfig = { agentEnabled: true, adminApiUrl: baseUrl, executorToken: 't', agent: { preset: 'minimal' } };
    const host = new AgentHost({ address: 'a:1', workDir, getConfig: () => config, client });
    // 手工置 working → tick 必须跳过
    (host as unknown as { working: boolean }).working = true;
    const r = await host.tick();
    check('处理中时 tick 跳过（单飞行）', r.worked === false && (r.detail ?? '').includes('single-flight'));
    await center.close();
  }

  for (const d of workDirs) fs.rmSync(d, { recursive: true, force: true });
  assert.ok(true);
  console.log(failures ? `\n=== ${failures} 项失败 ===\n` : '\n=== agent-host selftest 全部通过 ===\n');
  process.exit(failures ? 1 : 0);
}

void main();
