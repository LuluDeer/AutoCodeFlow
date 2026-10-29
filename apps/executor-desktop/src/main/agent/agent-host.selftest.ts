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
 * P7d：澄清回复消费（answered → 续跑 → ACK）、升级回复终结、崩溃恢复
 * （awaiting_reply 重启续跑 / running 按单重发重跑）、ACK 失败重发去重。
 */
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { AgentHost, type AgentHostConfig } from './agent-host';
import { CollabClient } from './collab-client';
import {
  journalDirFor,
  loadAssignmentJournal,
  saveAssignmentJournal,
  clearAssignmentJournal,
  type AssignmentJournal,
} from './assignment-journal';

let failures = 0;
function check(name: string, cond: boolean, extra = ''): void {
  if (cond) console.log(`  \u2714 ${name}`);
  else {
    failures++;
    console.error(`  \u2718 ${name}${extra ? ` \u2014 ${extra}` : ''}`);
  }
}

const ASSIGNMENT_ID = 'aaaaaaaa-1111-2222-3333-444444444444';
// 第二轮下发/兄弟单用的 id（多指派与「在等答复」用例）
const ASSIGNMENT_ID_B = 'bbbbbbbb-1111-2222-3333-444444444444';
const MAIN_OK = "require('fs').writeFileSync('out.txt', 'fine');\n";
const MAIN_BAD = "process.exit(1);\n";
const VERIFY_OK = "const c = require('fs').readFileSync('out.txt', 'utf8');\nif (c !== 'fine') process.exit(2);\n";

const SOP_PAYLOAD = {
  slug: 'e2e-sop', title: 'T', version: '1.0.0', contentHash: 'h',
  frontMatter: {
    capabilities: ['filesystem'],
    acceptance: [{ kind: 'command', run: 'node verify.js' }],
    constraints: {},
  },
  bodyMarkdown: '# do',
};

/** 模拟中台：记录所有请求，按脚本回响应。assignment 只在首个 poll 发出。 */
function makeCenter(opts: {
  llmScript: string[];
  sopPolicy?: unknown;
  sopCapabilities?: string[];
  /** P7d：poll 响应脚本（逐次弹出；缺省沿用「首单 + 空」行为）。 */
  pollScript?: Array<{ items: unknown[]; sopPolicy?: unknown }>;
  /** P7d：首次 ACK 回 500（重发去重路径）。 */
  failFirstAck?: boolean;
  /** P7d：澄清上报前 N 次回 503（发送失败重试路径；N=2 才能观察跨 tick 重试）。 */
  failClarifyTimes?: number;
}) {
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  const llmQueue = [...opts.llmScript];
  const pollQueue = opts.pollScript ? [...opts.pollScript] : null;
  let assignmentSent = false;
  const ackCalls: string[] = [];
  const clarifyCalls: Array<Record<string, unknown>> = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      // candidate-package 是 multipart 二进制——JSON.parse 会炸，按 raw 记
      let body: Record<string, unknown> = { __raw: true };
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>;
      } catch {
        body = { __multipart: true, bytes: Buffer.concat(chunks).length };
      }
      const p = req.url ?? '/';
      requests.push({ path: p, body });
      const reply = (obj: unknown): void => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (p === '/api/agent-collab/poll') {
        if (pollQueue) {
          // 脚本模式：严格逐次弹出（耗尽回空），不落入缺省行为
          const next = pollQueue.shift();
          reply({
            sopPolicy: opts.sopPolicy ?? { permissionPolicy: 'standard', allowedProfiles: ['minimal', 'standard'] },
            ...(next ?? { items: [] }),
          });
          return;
        }
        if (!assignmentSent) {
          assignmentSent = true;
          reply({
            items: [{
              kind: 'assignment',
              assignmentId: ASSIGNMENT_ID,
              sop: {
                ...SOP_PAYLOAD,
                frontMatter: {
                  ...SOP_PAYLOAD.frontMatter,
                  capabilities: opts.sopCapabilities ?? ['filesystem'],
                },
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
      if (p.includes('/clarifications/ack')) {
        ackCalls.push(p);
        if (opts.failFirstAck && ackCalls.length === 1) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ message: 'ack boom' }));
          return;
        }
        reply({ ok: true });
        return;
      }
      if (p.includes('/candidate-package')) {
        // 模拟既有 executor-package 校验链（zip 魔数 PK）+ 建包
        const raw = body as { __multipart?: boolean; bytes?: number };
        reply(
          raw.__multipart && (raw.bytes ?? 0) > 2 && raw.bytes
            ? { packageId: 'pkg-1', name: 'sop-e2e-sop', version: '1.0.0+agent.x' }
            : { message: 'not an archive' },
        );
        return;
      }
      if (p === '/api/agent-collab/capability' || p.startsWith('/api/agent-collab/assignments/')) {
        reply({ ok: true, accepted: true });
        return;
      }
      if (p === '/api/agent-collab/clarifications') {
        clarifyCalls.push(body);
        const failTimes = opts.failClarifyTimes ?? 0;
        if (clarifyCalls.length <= failTimes) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ message: 'clarify boom' }));
          return;
        }
        reply({ ok: true, escalated: false, round: clarifyCalls.length });
        return;
      }
      reply({ ok: true });
    });
  });
  return {
    requests,
    ackCalls,
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

function makeConfig(baseUrl: string, over: Partial<AgentHostConfig> = {}): AgentHostConfig {
  return {
    agentEnabled: true, adminApiUrl: baseUrl, executorToken: 't',
    agent: { preset: 'standard' },
    ...over,
  };
}

const PLAN_BAD = JSON.stringify({ files: [{ path: 'main.js', content: MAIN_BAD }, { path: 'verify.js', content: VERIFY_OK }], entry: { interpreter: 'node', path: 'main.js' } });
const PLAN_OK = JSON.stringify({ files: [{ path: 'main.js', content: MAIN_OK }, { path: 'verify.js', content: VERIFY_OK }], entry: { interpreter: 'node', path: 'main.js' }, notes: 'n' });
const DIAG_CLARIFY = JSON.stringify({ action: 'clarify', question: 'SOP 没说要输出到哪里' });

function replyItem(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'clarification_reply',
    assignmentId: ASSIGNMENT_ID,
    clarificationId: 'srv-1',
    clientClarificationId: 'client-1',
    round: 1,
    resolution: 'answered',
    answer: '输出写到 out.txt，先跑 main 再跑 verify',
    newSopVersion: null,
    ...over,
  };
}

function seedJournal(workDir: string, over: Partial<AssignmentJournal> = {}): void {
  const journal: AssignmentJournal = {
    assignmentId: ASSIGNMENT_ID,
    sop: SOP_PAYLOAD,
    phase: 'running',
    pendingQuestion: null,
    asked: [],
    replies: [],
    counters: { iterations: 0, clarifications: 0, trialRuns: 0, dependencyInstalls: 0, startedAt: Date.now() },
    guiActionsUsed: 0,
    lastSendError: null,
    transientRequeues: 0,
    updatedAt: new Date().toISOString(),
    ...over,
  };
  saveAssignmentJournal(journalDirFor(workDir), journal);
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
    check('首次 poll 前先声明 agent:sop 能力',
      center.requests[0]?.path === '/api/agent-collab/capability' &&
      center.requests[1]?.path === '/api/agent-collab/poll');
    check('能力上报含 agent:sop', center.requests.some((q) => q.path === '/api/agent-collab/capability' && JSON.stringify(q.body.capabilities ?? '').includes('agent:sop')));
    check('浏览器能力按探测如实上报（本机未装二进制 → 无 browser）', (() => {
      const cap = center.requests.find((q) => q.path === '/api/agent-collab/capability');
      const caps = JSON.stringify(cap?.body.capabilities ?? []);
      return caps.includes('browser') || caps.includes('filesystem');
    })());
    const complete = center.requests.find((q) => q.path === `/api/agent-collab/assignments/${ASSIGNMENT_ID}/complete`);
    check('回报 completed', complete?.body.status === 'completed', `body=${JSON.stringify(complete?.body).slice(0, 120)}`);
    check('回报带 effectiveProfile（审计可见）', JSON.stringify(complete?.body).includes('effectiveProfile'));
    // P7d 前半：交付——候选包已上传，packageRef 进回报
    const cand = center.requests.find((q) => q.path?.includes('/candidate-package'));
    check('候选包已上传（multipart，>2 字节）', cand !== undefined && cand.body.__multipart === true && (cand.body.bytes as number) > 2);
    const result = complete?.body.result as { packageRef?: { packageId?: string } } | undefined;
    check('packageRef 进回报（中台据此走 deploy 通道）', result?.packageRef?.packageId === 'pkg-1', JSON.stringify(result?.packageRef ?? null));
    check('deploy-only 档交付不带直接执行证据（isolated-run 是显式档位行为）', (complete?.body.result as Record<string, unknown> | undefined)?.isolatedRun === undefined);
    check('lastOutcome 记录', host.stats.lastOutcome === 'delivered');
    check('工作区产物落盘', fs.existsSync(path.join(workDir, 'agent-workspace', ASSIGNMENT_ID, 'out.txt')));
    const capsBeforeRenew = center.requests.filter((q) => q.path === '/api/agent-collab/capability').length;
    (host as unknown as { lastCapabilityReportAt: number }).lastCapabilityReportAt -= 30_000;
    await host.tick();
    const capsAfterRenew = center.requests.filter((q) => q.path === '/api/agent-collab/capability').length;
    check('待命轮询会续报 Agent 能力租约', capsAfterRenew > capsBeforeRenew);
    config.agentEnabled = false;
    await host.withdrawCapabilities();
    const capRequests = center.requests.filter((q) => q.path === '/api/agent-collab/capability');
    const lastCap = capRequests[capRequests.length - 1];
    check('关闭托管后撤销 Agent 能力', Array.isArray(lastCap?.body.capabilities) && lastCap.body.capabilities.length === 0);
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
    const originalReport = client.reportCapability.bind(client);
    let releaseReport: (() => void) | undefined;
    const blockedReport = new Promise<void>((resolve) => { releaseReport = resolve; });
    client.reportCapability = async (...args) => {
      await blockedReport;
      return originalReport(...args);
    };
    const first = host.tick();
    const concurrent = await host.tick();
    check('能力上报尚未完成时再次 tick 会跳过', concurrent.worked === false &&
      (concurrent.detail ?? '').includes('single-flight'));
    releaseReport?.();
    await first;
    check('并发 tick 只领取一次', center.requests.filter((q) => q.path === '/api/agent-collab/poll').length === 1);
    // 手工置 working → tick 必须跳过
    (host as unknown as { working: boolean }).working = true;
    const r = await host.tick();
    check('处理中时 tick 跳过（单飞行）', r.worked === false && (r.detail ?? '').includes('single-flight'));
    await center.close();
  }

  console.log('-- 6. 能力续报与撤销串行 --');
  {
    const workDir = newWorkDir();
    const center = makeCenter({ llmScript: [] });
    const baseUrl = await center.listen();
    const client = new CollabClient({ baseUrl, token: 't', timeoutMs: 5000 });
    const config: AgentHostConfig = { agentEnabled: true, adminApiUrl: baseUrl, executorToken: 't', agent: { preset: 'minimal' } };
    const host = new AgentHost({ address: 'a:1', workDir, getConfig: () => config, client });
    const originalReport = client.reportCapability.bind(client);
    let reportStarted: (() => void) | undefined;
    let releaseReport: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { reportStarted = resolve; });
    const blocked = new Promise<void>((resolve) => { releaseReport = resolve; });
    let firstReport = true;
    client.reportCapability = async (...args) => {
      if (firstReport) {
        firstReport = false;
        reportStarted?.();
        await blocked;
      }
      return originalReport(...args);
    };
    const running = host.tick();
    await started;
    config.agentEnabled = false;
    const withdrawing = host.withdrawCapabilities();
    releaseReport?.();
    await Promise.all([running, withdrawing]);
    const capabilityReports = center.requests.filter((q) => q.path === '/api/agent-collab/capability');
    check('关闭时在途续报先落库，最终能力为撤销', capabilityReports.length >= 2 &&
      Array.isArray(capabilityReports[capabilityReports.length - 1].body.capabilities) &&
      (capabilityReports[capabilityReports.length - 1].body.capabilities as unknown[]).length === 0);
    await center.close();
  }

  console.log('-- 7. 中台策略收紧后拒绝旧能力指派 --');
  {
    const workDir = newWorkDir();
    const center = makeCenter({
      llmScript: [],
      sopCapabilities: ['gui'],
      sopPolicy: { permissionPolicy: 'standard', allowedProfiles: ['minimal', 'standard'] },
    });
    const baseUrl = await center.listen();
    const client = new CollabClient({ baseUrl, token: 't', timeoutMs: 5000 });
    const config: AgentHostConfig = {
      agentEnabled: true, adminApiUrl: baseUrl, executorToken: 't',
      agent: { preset: 'standard', hostAccess: 'app-scoped', allowedApps: ['notepad'] },
    };
    const host = new AgentHost({ address: 'a:1', workDir, getConfig: () => config, client });
    await host.tick();
    const complete = center.requests.find((q) => q.path === `/api/agent-collab/assignments/${ASSIGNMENT_ID}/complete`);
    check('最新策略撤销 gui 后明确回报权限不足', complete?.body.status === 'failed' &&
      (complete?.body.result as { outcome?: string })?.outcome === 'permission_denied');
    check('能力不足的工单不调用 LLM', !center.requests.some((q) => q.path === '/api/agent-collab/llm'));
    await center.close();
  }

  console.log('-- 8. 澄清回复消费：answered → 续跑 → 交付 → ACK --');
  {
    const workDir = newWorkDir();
    const center = makeCenter({
      llmScript: [PLAN_BAD, DIAG_CLARIFY, PLAN_OK],
      pollScript: [
        { items: [{ kind: 'assignment', assignmentId: ASSIGNMENT_ID, sop: SOP_PAYLOAD }] }, // 首次 poll 由缺省行为发工单——脚本从第二次 poll 开始接手
        { items: [replyItem()] },
      ],
    });
    const baseUrl = await center.listen();
    const client = new CollabClient({ baseUrl, token: 't', timeoutMs: 5000 });
    const host = new AgentHost({ address: 'a:1', workDir, getConfig: () => makeConfig(baseUrl), client });
    const r1 = await host.tick();
    check('第一轮：领单 → 澄清发出', r1.worked === true &&
      center.requests.some((q) => q.path === '/api/agent-collab/clarifications'));
    check('澄清后日志 phase=awaiting_reply（恢复锚点已落盘）',
      loadAssignmentJournal(journalDirFor(workDir), ASSIGNMENT_ID)?.phase === 'awaiting_reply');
    check('澄清后不回报终态', !center.requests.some((q) => q.path.endsWith('/complete')));
    const r2 = await host.tick();
    check('第二轮：回复被消费', r2.worked === true);
    const ack = center.requests.find((q) => q.path === `/api/agent-collab/assignments/${ASSIGNMENT_ID}/clarifications/ack`);
    check('续跑终态后才 ACK（幂等键回传中台推游标）',
      ack !== undefined && ack.body.clarificationId === 'srv-1');
    const complete = center.requests.find((q) => q.path.endsWith('/complete'));
    check('续跑跑通 → completed + 交付', complete?.body.status === 'completed');
    // 续跑的 plan（第 3 次 LLM 调用）必须能看到问答历史——否则会带着同样的疑问再问一遍
    const llmCalls = center.requests.filter((q) => q.path === '/api/agent-collab/llm');
    const continuationCtx = JSON.stringify(llmCalls[2]?.body ?? {});
    check('续跑上下文带澄清问答历史', continuationCtx.includes('out.txt，先跑 main') && continuationCtx.includes('clarificationHistory'));
    check('续跑日志已清（终态）', loadAssignmentJournal(journalDirFor(workDir), ASSIGNMENT_ID) === null);
    // 回复已在同一轮处理——不重发指派
    const polls = center.requests.filter((q) => q.path === '/api/agent-collab/poll');
    check('消费回复的 poll 未请求重发', polls.every((q) => q.body.resendAssignments === undefined));
    await center.close();
  }

  console.log('-- 9. 升级回复：escalated_to_human → 如实终结 --');
  {
    const workDir = newWorkDir();
    const center = makeCenter({
      llmScript: [PLAN_BAD, DIAG_CLARIFY],
      pollScript: [
        { items: [{ kind: 'assignment', assignmentId: ASSIGNMENT_ID, sop: SOP_PAYLOAD }] },
        { items: [replyItem({ resolution: 'escalated_to_human', answer: null })] },
      ],
    });
    const baseUrl = await center.listen();
    const client = new CollabClient({ baseUrl, token: 't', timeoutMs: 5000 });
    const host = new AgentHost({ address: 'a:1', workDir, getConfig: () => makeConfig(baseUrl), client });
    await host.tick();
    const r2 = await host.tick();
    check('升级回复被消费', r2.worked === true);
    const complete = center.requests.find((q) => q.path.endsWith('/complete'));
    check('升级后如实回报 failed（绝不挂着装等）',
      complete?.body.status === 'failed' &&
      (complete?.body.result as { outcome?: string })?.outcome === 'escalated_to_human');
    check('升级路径不调 LLM（无自动答复可续）',
      center.requests.filter((q) => q.path === '/api/agent-collab/llm').length === 2);
    check('终结后 ACK + 日志清理',
      center.ackCalls.length === 1 && loadAssignmentJournal(journalDirFor(workDir), ASSIGNMENT_ID) === null);
    await center.close();
  }

  console.log('-- 10. 崩溃恢复：awaiting_reply 重启后经新 host 续跑 --');
  {
    const workDir = newWorkDir();
    const center = makeCenter({
      llmScript: [PLAN_BAD, DIAG_CLARIFY, PLAN_OK],
      pollScript: [
        { items: [{ kind: 'assignment', assignmentId: ASSIGNMENT_ID, sop: SOP_PAYLOAD }] },
        { items: [replyItem()] },
      ],
    });
    const baseUrl = await center.listen();
    const client = new CollabClient({ baseUrl, token: 't', timeoutMs: 5000 });
    const host1 = new AgentHost({ address: 'a:1', workDir, getConfig: () => makeConfig(baseUrl), client });
    await host1.tick(); // 领单 → 澄清 → 「崩溃」（host1 不再使用）
    const host2 = new AgentHost({ address: 'a:1', workDir, getConfig: () => makeConfig(baseUrl), client });
    const r = await host2.tick(); // 重启实例：日志恢复 → 回复消费 → 续跑
    check('重启实例消费了回复并续跑', r.worked === true);
    const polls = center.requests.filter((q) => q.path === '/api/agent-collab/poll');
    check('awaiting_reply 恢复不需要重发（回复走投递）',
      JSON.stringify(polls[1]?.body ?? {}).includes('"resendAssignments"') === false);
    const complete = center.requests.find((q) => q.path.endsWith('/complete'));
    check('重启后续跑仍能交付', complete?.body.status === 'completed');
    check('续跑后 ACK', center.ackCalls.length === 1);
    await center.close();
  }

  console.log('-- 11. 崩溃恢复：running 阶段 → 按单重发重跑 --');
  {
    const workDir = newWorkDir();
    seedJournal(workDir, { phase: 'running' }); // 循环中途崩溃的现场
    const center = makeCenter({
      llmScript: [PLAN_OK],
      pollScript: [
        { items: [{ kind: 'assignment', assignmentId: ASSIGNMENT_ID, sop: SOP_PAYLOAD }] },
      ],
    });
    const baseUrl = await center.listen();
    const client = new CollabClient({ baseUrl, token: 't', timeoutMs: 5000 });
    const host = new AgentHost({ address: 'a:1', workDir, getConfig: () => makeConfig(baseUrl), client });
    const r = await host.tick();
    check('重启后重领了崩溃指派', r.worked === true);
    const poll = center.requests.find((q) => q.path === '/api/agent-collab/poll');
    check('poll 请求按 id 定向重发（数组形态）',
      JSON.stringify(poll?.body.resendAssignments ?? null) === JSON.stringify([ASSIGNMENT_ID]));
    const complete = center.requests.find((q) => q.path.endsWith('/complete'));
    check('重跑完成交付', complete?.body.status === 'completed');
    check('重跑后日志清理', loadAssignmentJournal(journalDirFor(workDir), ASSIGNMENT_ID) === null);
    await center.close();
  }

  console.log('-- 12. ACK 失败重发：不二次消费 --');
  {
    const workDir = newWorkDir();
    const center = makeCenter({
      llmScript: [PLAN_BAD, DIAG_CLARIFY, PLAN_OK],
      failFirstAck: true,
      pollScript: [
        { items: [{ kind: 'assignment', assignmentId: ASSIGNMENT_ID, sop: SOP_PAYLOAD }] },
        { items: [replyItem()] },
        { items: [replyItem()] }, // ACK 失败 → 中台重发同一条回复
      ],
    });
    const baseUrl = await center.listen();
    const client = new CollabClient({ baseUrl, token: 't', timeoutMs: 5000 });
    const host = new AgentHost({ address: 'a:1', workDir, getConfig: () => makeConfig(baseUrl), client });
    await host.tick();
    await host.tick(); // 消费回复 → 续跑交付 → ACK（首次失败）
    await host.tick(); // 重发到达 → 幂等去重 → 补 ACK
    const llmCalls = center.requests.filter((q) => q.path === '/api/agent-collab/llm');
    check('重发不触发第二次续跑（LLM 调用次数不变）', llmCalls.length === 3);
    const completes = center.requests.filter((q) => q.path.endsWith('/complete'));
    check('重发不产生第二次回报', completes.length === 1);
    check('ACK 重试成功（毒消息防护闭环）', center.ackCalls.length === 2);
    check('日志最终已清', loadAssignmentJournal(journalDirFor(workDir), ASSIGNMENT_ID) === null);
    await center.close();
  }

  console.log('-- 13. isolated-runner：交付附带直接执行证据 --');
  {
    const workDir = newWorkDir();
    const center = makeCenter({
      llmScript: [PLAN_OK],
      // 中台上限必须显式放宽到含 isolated-runner 的预设（developer+），
      // 否则 standard 档的 taskExecution 被钳回 deploy-only——与 GUI 同款
      // 「中台只能往下压」语义
      sopPolicy: { permissionPolicy: 'developer', allowedProfiles: ['standard', 'developer'] },
      pollScript: [
        { items: [{ kind: 'assignment', assignmentId: ASSIGNMENT_ID, sop: SOP_PAYLOAD }] },
      ],
    });
    const baseUrl = await center.listen();
    const client = new CollabClient({ baseUrl, token: 't', timeoutMs: 5000 });
    const config = makeConfig(baseUrl, { agent: { preset: 'standard', taskExecution: 'isolated-runner' } });
    const host = new AgentHost({ address: 'a:1', workDir, getConfig: () => config, client });
    const r = await host.tick();
    check('isolated-runner 档下交付完成', r.worked === true);
    const complete = center.requests.find((q) => q.path.endsWith('/complete'));
    check('回报 completed', complete?.body.status === 'completed');
    const result = complete?.body.result as {
      isolatedRun?: { source?: string; ok?: boolean; logPath?: string; seq?: number };
    } | undefined;
    check('回报附带直接执行证据（ok + 来源标记）',
      result?.isolatedRun?.ok === true && result.isolatedRun.source === 'agent:sop:a:1');
    check('证据留在工作区 isolated-runs/（打包排除，不污染候选包）',
      fs.existsSync(path.join(workDir, 'agent-workspace', ASSIGNMENT_ID, 'isolated-runs', 'run-1.log')));
    check('lastOutcome 记录 delivered', host.stats.lastOutcome === 'delivered');
    check('交付后日志清理', loadAssignmentJournal(journalDirFor(workDir), ASSIGNMENT_ID) === null);
    await center.close();
  }

  console.log('-- 14. running 中途 kill：计数已落盘，重启后闸门接续累计（不归零）--');
  {
    const workDir = newWorkDir();
    const center = makeCenter({
      llmScript: [PLAN_BAD, '{"action":"retry"}', PLAN_OK],
      pollScript: [
        { items: [{ kind: 'assignment', assignmentId: ASSIGNMENT_ID, sop: SOP_PAYLOAD }] },
        { items: [{ kind: 'assignment', assignmentId: ASSIGNMENT_ID, sop: SOP_PAYLOAD }] },
      ],
    });
    const baseUrl = await center.listen();
    const client = new CollabClient({ baseUrl, token: 't', timeoutMs: 5000 });
    // kill 模拟：第 3 次 LLM 中继（第 2 轮的 plan）永不返回——真实 kill 下
    // 循环没有机会走 error 收敛（不回报、不清日志），挂起即等价。此前每轮
    // 记账的计数必须已在磁盘上。
    let llmCalls = 0;
    const originalLlm = client.llmRelay.bind(client);
    client.llmRelay = async (address, input) => {
      llmCalls += 1;
      if (llmCalls === 3) await new Promise<void>(() => undefined); // 「被 kill」
      return originalLlm(address, input);
    };
    const host1 = new AgentHost({ address: 'a:1', workDir, getConfig: () => makeConfig(baseUrl), client });
    const running = host1.tick(); // 领单 → 第 1 轮完成 → 第 2 轮 plan 处挂起
    let killedJournal: AssignmentJournal | null = null;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const j = loadAssignmentJournal(journalDirFor(workDir), ASSIGNMENT_ID);
      if (j?.counters && j.counters.iterations >= 2) {
        killedJournal = j;
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    check('kill 前 running 计数已即时落盘（第 2 轮已记账）',
      killedJournal?.phase === 'running' &&
      killedJournal.counters?.iterations === 2 && killedJournal.counters?.trialRuns === 1,
      `journal=${JSON.stringify(killedJournal?.counters ?? null)}`);
    // 等第 3 次 LLM 调用真正挂起再重启：journal 落盘（同步）先于 llmCalls=3，
    // 不等这道栅栏，host2 的调用可能撞上 hang 分支把用例自己挂死。
    while (llmCalls < 3) await new Promise((r) => setTimeout(r, 10));
    // ── 重启：新 host 实例接手同一 workDir ──
    const host2 = new AgentHost({ address: 'a:1', workDir, getConfig: () => makeConfig(baseUrl), client });
    const r = await host2.tick();
    check('重启实例重领了崩溃指派', r.worked === true);
    const polls = center.requests.filter((q) => q.path === '/api/agent-collab/poll');
    check('恢复 poll 按单定向重发（running 恢复路径）',
      JSON.stringify(polls[1]?.body.resendAssignments ?? null) === JSON.stringify([ASSIGNMENT_ID]));
    const complete = center.requests.find((q) => q.path.endsWith('/complete'));
    const result = complete?.body.result as { iterations?: number; trialRuns?: number } | undefined;
    check('重启后续跑交付', complete?.body.status === 'completed');
    check('闸门从崩溃点接续（iterations=2+1=3，归零则是 1）',
      result?.iterations === 3, `iterations=${result?.iterations}`);
    check('试跑预算同样延续（trialRuns=1+1=2）', result?.trialRuns === 2, `trialRuns=${result?.trialRuns}`);
    check('续跑只补跑 1 轮 LLM（不从头重放历史）', llmCalls === 4, `llmCalls=${llmCalls}`);
    check('交付后日志清理', loadAssignmentJournal(journalDirFor(workDir), ASSIGNMENT_ID) === null);
    void running; // host1 的 tick 永远挂起（kill 现场），进程退出时一并消亡
    await center.close();
  }

  console.log('-- 14b. journal 带计数直接续跑：闸门从既有计数继续（对照 11 节加强版）--');
  {
    const workDir = newWorkDir();
    seedJournal(workDir, {
      phase: 'running',
      // 崩溃前已跑 2 轮 + 1 次试跑——重启后必须从 2 起跑，而不是从 0
      counters: { iterations: 2, clarifications: 0, trialRuns: 1, dependencyInstalls: 0, startedAt: Date.now() },
    });
    const center = makeCenter({
      llmScript: [PLAN_BAD, '{"action":"retry"}', PLAN_OK],
      pollScript: [
        { items: [{ kind: 'assignment', assignmentId: ASSIGNMENT_ID, sop: SOP_PAYLOAD }] },
      ],
    });
    const baseUrl = await center.listen();
    const client = new CollabClient({ baseUrl, token: 't', timeoutMs: 5000 });
    const host = new AgentHost({ address: 'a:1', workDir, getConfig: () => makeConfig(baseUrl), client });
    const r = await host.tick();
    check('带计数日志的重领成功', r.worked === true);
    const complete = center.requests.find((q) => q.path.endsWith('/complete'));
    const result = complete?.body.result as { iterations?: number; trialRuns?: number } | undefined;
    check('续跑交付', complete?.body.status === 'completed');
    check('迭代从 2 接续（iterations=2+2=4；忽略计数重跑只会是 2）',
      result?.iterations === 4, `iterations=${result?.iterations}`);
    check('试跑从 1 接续（trialRuns=1+2=3；忽略计数只会是 2）',
      result?.trialRuns === 3, `trialRuns=${result?.trialRuns}`);
    check('交付后日志清理', loadAssignmentJournal(journalDirFor(workDir), ASSIGNMENT_ID) === null);
    await center.close();
  }

  console.log('-- 15. 澄清发送失败：按幂等键重试（同 tick 快恢复 + 跨 tick 兜底）--');
  {
    const workDir = newWorkDir();
    const center = makeCenter({
      llmScript: [PLAN_BAD, DIAG_CLARIFY, PLAN_OK],
      failClarifyTimes: 2, // 连败两次：同 tick 重试也失败，才能观察跨 tick 持久化
      pollScript: [
        { items: [{ kind: 'assignment', assignmentId: ASSIGNMENT_ID, sop: SOP_PAYLOAD }] },
        { items: [] }, // 无待办——触发重试路径
        { items: [replyItem()] },
      ],
    });
    const baseUrl = await center.listen();
    const client = new CollabClient({ baseUrl, token: 't', timeoutMs: 5000 });
    const host = new AgentHost({ address: 'a:1', workDir, getConfig: () => makeConfig(baseUrl), client });
    await host.tick(); // 领单 → 澄清 → 发送失败 → 同 tick 重试仍失败
    const j1 = loadAssignmentJournal(journalDirFor(workDir), ASSIGNMENT_ID);
    check('两次失败都发生（同 tick 快恢复先试了一次）',
      center.requests.filter((q) => q.path === '/api/agent-collab/clarifications').length === 2);
    check('持续失败被记录（lastSendError 持久化）',
      j1?.phase === 'awaiting_reply' && (j1?.lastSendError ?? '').length > 0);
    check('两次失败沿用同一个幂等键',
      (center.requests.filter((q) => q.path === '/api/agent-collab/clarifications')[0]?.body.clientClarificationId) ===
      (center.requests.filter((q) => q.path === '/api/agent-collab/clarifications')[1]?.body.clientClarificationId));
    await host.tick(); // 无待办 tick → 跨 tick 重试（成功）
    const j2 = loadAssignmentJournal(journalDirFor(workDir), ASSIGNMENT_ID);
    const clarifies = center.requests.filter((q) => q.path === '/api/agent-collab/clarifications');
    check('跨 tick 重试发出第三次请求', clarifies.length === 3);
    check('三次请求同一个幂等键（服务端去重不产生第二条澄清）',
      clarifies[0]?.body.clientClarificationId === clarifies[2]?.body.clientClarificationId);
    check('成功后 lastSendError 清除', j2?.lastSendError === null);
    await host.tick(); // 回复到达 → 续跑交付
    const complete = center.requests.find((q) => q.path.endsWith('/complete'));
    check('重试成功后链路照常走完（completed）', complete?.body.status === 'completed');
    check('交付后日志清理', loadAssignmentJournal(journalDirFor(workDir), ASSIGNMENT_ID) === null);
    await center.close();
  }

  console.log('-- 15b. 瞬态 relay 失败 → 续跑通道（GAP-3）：journal 保留 + 下轮 poll **按 id** 重发重领 --');
  {
    const workDir = newWorkDir();
    // makeCenter 的 llm 端点恒 200（脚本控制内容），模拟 relay 5xx 需要注入
    // 替身 client：llmRelay / reportComplete 可控，poll 走真实本地 server。
    const workCenter = makeCenter({
      llmScript: [],
      pollScript: [
        { items: [{ kind: 'assignment', assignmentId: ASSIGNMENT_ID, sop: SOP_PAYLOAD }] },
        { items: [] },
      ],
    });
    const baseUrl = await workCenter.listen();
    const base = new CollabClient({ baseUrl, token: 't', timeoutMs: 5000 });
    let relayCalls = 0;
    const client = Object.create(base) as CollabClient;
    // 瞬态 5xx：chatJson 分类重试 3 次耗尽 → loop 收敛 outcome=error，
    // stopMessage 带 status=503（isRetryableRelayError 判 true）
    (client as unknown as { llmRelay: unknown }).llmRelay = async () => {
      relayCalls += 1;
      return { ok: false, error: 'llm relay failed (status=503)', content: '' };
    };
    const completes: Array<Record<string, unknown>> = [];
    (client as unknown as { reportComplete: unknown }).reportComplete = async (
      _a: string, _id: string, input: Record<string, unknown>,
    ) => {
      completes.push(input);
      return { ok: true, accepted: true };
    };
    const host = new AgentHost({ address: 'a:1', workDir, getConfig: () => makeConfig(baseUrl), client });
    await host.tick(); // 领单 → relay 3 次耗尽 → 瞬态续跑通道
    check('relay 重试耗尽（3 次尝试）', relayCalls === 3, `calls=${relayCalls}`);
    check('瞬态 error 不上报 failed（零 reportComplete）', completes.length === 0);
    const j1 = loadAssignmentJournal(journalDirFor(workDir), ASSIGNMENT_ID);
    check('journal 保留（恢复点未删）', j1 !== null && j1.phase === 'running');
    check('lastSendError 记录续跑等待态', (j1?.lastSendError ?? '').includes('transient relay failure'));
    // 缺陷 A（P2）：503 打满一轮 relay 退避重试**不吃**工作预算——这一轮
    // 模型什么都没产出（plan 抛错），loop 已回退那一轮的 iterate 记账。
    check('瞬态失败不吃迭代预算（落盘计数仍是 0 轮）',
      j1?.counters?.iterations === 0, `counters=${JSON.stringify(j1?.counters ?? null)}`);
    // 旧断言是 resendAssignmentsOnNextPoll === true（全局重发）。缺陷 B 修法
    // 把这条续跑通道改成与崩溃恢复同款的**按 id 定向**重发：全局重发会把
    // 该执行器名下所有 activeStatuses 一起投回，其中在等人工答复的单会被
    // 重建成 running（答复随后只能 ACK 丢弃）。语义变了，断言随之改。
    check('续跑请求是**定向**的（resendAssignmentIds 含本单）而非全局重发',
      JSON.stringify((host as unknown as { resendAssignmentIds: string[] }).resendAssignmentIds) ===
        JSON.stringify([ASSIGNMENT_ID]));
    check('不再置全局重发开关（缺陷 B 的根因写法）',
      !('resendAssignmentsOnNextPoll' in host));
    check('stats 如实记录续跑态', host.stats.lastOutcome === 'transient_error_requeue');
    await host.tick(); // 待命轮：只验下轮 poll 的请求体形态
    const pollsAfter = workCenter.requests.filter((q) => q.path === '/api/agent-collab/poll');
    check('下轮 poll 真的带上定向重发（数组，不是 true）',
      JSON.stringify(pollsAfter[pollsAfter.length - 1]?.body.resendAssignments ?? null) ===
        JSON.stringify([ASSIGNMENT_ID]),
      `body=${JSON.stringify(pollsAfter[pollsAfter.length - 1]?.body ?? null)}`);
    // 对照：确定性错误（401）必须维持 failed 终结（独立 center——pollScript
    // 是逐次弹出的共享队列，复用会被 503 实例消费成空页）
    const workDir2 = newWorkDir();
    relayCalls = 0;
    const workCenter2 = makeCenter({
      llmScript: [],
      pollScript: [
        { items: [{ kind: 'assignment', assignmentId: ASSIGNMENT_ID, sop: SOP_PAYLOAD }] },
        { items: [] },
      ],
    });
    const baseUrl2 = await workCenter2.listen();
    const base2 = new CollabClient({ baseUrl: baseUrl2, token: 't', timeoutMs: 5000 });
    const client2 = Object.create(base2) as CollabClient;
    (client2 as unknown as { llmRelay: unknown }).llmRelay = async () => {
      relayCalls += 1;
      return { ok: false, error: 'llm relay failed (status=401)', content: '' };
    };
    const completes2: Array<Record<string, unknown>> = [];
    (client2 as unknown as { reportComplete: unknown }).reportComplete = async (
      _a: string, _id: string, input: Record<string, unknown>,
    ) => {
      completes2.push(input);
      return { ok: true, accepted: true };
    };
    const host2 = new AgentHost({ address: 'a:1', workDir: workDir2, getConfig: () => makeConfig(baseUrl2), client: client2 });
    await host2.tick();
    check('确定性 401 → 如实 failed 终结（零重试）', relayCalls === 1 && completes2.length === 1 && completes2[0].status === 'failed');
    check('401 终结后 journal 清理', loadAssignmentJournal(journalDirFor(workDir2), ASSIGNMENT_ID) === null);
    await workCenter.close();
    await workCenter2.close();
  }

  console.log('-- 12. P3-2 畸形指派载荷：首跑前拦截，可判定失败回报 --');
  {
    const workDir = newWorkDir();
    const center = makeCenter({
      llmScript: [],
      pollScript: [
        {
          // slug 带换行（manifest 注入面）——字符集闸必须拦
          items: [{ kind: 'assignment', assignmentId: ASSIGNMENT_ID, sop: { ...SOP_PAYLOAD, slug: 'bad\nslug' } }],
        },
        {
          // frontMatter 缺失——此前会在 runWithJournal 里炸 TypeError
          items: [{ kind: 'assignment', assignmentId: ASSIGNMENT_ID, sop: { ...SOP_PAYLOAD, frontMatter: null } }],
        },
        {
          // assignmentId 带路径穿越字符——直接拼工作区路径的闸必须拦
          items: [{ kind: 'assignment', assignmentId: '../../escape', sop: SOP_PAYLOAD }],
        },
        { items: [] },
      ],
    });
    const baseUrl = await center.listen();
    const client = new CollabClient({ baseUrl, token: 't', timeoutMs: 5000 });
    const host = new AgentHost({ address: 'a:1', workDir, getConfig: () => makeConfig(baseUrl), client });
    for (let i = 0; i < 4; i++) await host.tick(); // 三个畸形指派 + 一轮收尾
    const completes = center.requests.filter((q) => q.path.includes('/complete'));
    check('每个畸形载荷各收敛为一次失败回报（3 个）', completes.length === 3, `completes=${completes.length}`);
    check('回报 status=failed', completes.every((q) => q.body.status === 'failed'));
    check(
      '回报 outcome=poll_payload_invalid（可判定，而非裸 host_error/TypeError）',
      completes.every((q) => (q.body.result as { outcome?: string } | undefined)?.outcome === 'poll_payload_invalid'),
    );
    check('畸形载荷绝不进 LLM 循环', !center.requests.some((q) => q.path === '/api/agent-collab/llm'));
    check('首跑前拦截：工作区从未创建', !fs.existsSync(path.join(workDir, 'agent-workspace')));
    check('首跑前拦截：本地日志从未写出', !fs.existsSync(path.join(workDir, 'agent-journal')));
    check('stats 记录最后结局', host.stats.lastOutcome === 'poll_payload_invalid');

    // 对照：合法载荷照常进循环（字符集闸不误伤既有链路）
    const center2 = makeCenter({
      llmScript: [PLAN_OK, '{"action":"escalate"}'],
      pollScript: [{ items: [{ kind: 'assignment', assignmentId: ASSIGNMENT_ID, sop: SOP_PAYLOAD }] }, { items: [] }],
    });
    const baseUrl2 = await center2.listen();
    const workDir2 = newWorkDir();
    const host2 = new AgentHost({ address: 'a:1', workDir: workDir2, getConfig: () => makeConfig(baseUrl2), client: new CollabClient({ baseUrl: baseUrl2, token: 't', timeoutMs: 5000 }) });
    await host2.tick();
    const okComplete = center2.requests.find((q) => q.path.includes('/complete'));
    check('合法载荷（e2e-sop）不误伤：进入循环并终态回报', okComplete?.body.status === 'completed' || okComplete?.body.status === 'failed');
    check('合法载荷的工作区被创建', fs.existsSync(path.join(workDir2, 'agent-workspace', ASSIGNMENT_ID)));
    await center2.close();
    await center.close();
  }

  console.log('-- 17. 缺陷 A：poll 一轮下发多张指派 → 第 1 张执行，其余按 id 定向延后 --');
  {
    const workDir = newWorkDir();
    const center = makeCenter({
      llmScript: [PLAN_OK, PLAN_OK],
      pollScript: [
        {
          items: [
            { kind: 'assignment', assignmentId: ASSIGNMENT_ID, sop: SOP_PAYLOAD },
            { kind: 'assignment', assignmentId: ASSIGNMENT_ID_B, sop: SOP_PAYLOAD },
          ],
        },
        // 中台按 id 定向重投被延后的那张（resendIds 命中已领取的 in_progress 单）
        { items: [{ kind: 'assignment', assignmentId: ASSIGNMENT_ID_B, sop: SOP_PAYLOAD }] },
        { items: [] },
      ],
    });
    const baseUrl = await center.listen();
    const client = new CollabClient({ baseUrl, token: 't', timeoutMs: 5000 });
    const host = new AgentHost({ address: 'a:1', workDir, getConfig: () => makeConfig(baseUrl), client });
    await host.tick();
    const completesA = center.requests.filter((q) => q.path === `/api/agent-collab/assignments/${ASSIGNMENT_ID}/complete`);
    check('第 1 张指派被执行并回报 completed', completesA.length === 1 && completesA[0].body.status === 'completed');
    check('第 2 张本轮不抢跑（零 LLM / 零回报）',
      center.requests.filter((q) => q.path === '/api/agent-collab/llm').length === 1 &&
      center.requests.filter((q) => q.path === `/api/agent-collab/assignments/${ASSIGNMENT_ID_B}/complete`).length === 0);
    check('被延后的 id 已进定向重发队列（不静默丢失）',
      JSON.stringify((host as unknown as { resendAssignmentIds: string[] }).resendAssignmentIds) ===
        JSON.stringify([ASSIGNMENT_ID_B]),
      `ids=${JSON.stringify((host as unknown as { resendAssignmentIds: string[] }).resendAssignmentIds)}`);
    await host.tick(); // 下一轮：中台按 id 重投第 2 张
    const polls = center.requests.filter((q) => q.path === '/api/agent-collab/poll');
    check('下一轮 poll 的 body.resendAssignments 含第 2 张（数组形态，不是全局 true）',
      JSON.stringify(polls[1]?.body.resendAssignments ?? null) === JSON.stringify([ASSIGNMENT_ID_B]),
      `body=${JSON.stringify(polls[1]?.body ?? null)}`);
    const completesB = center.requests.filter((q) => q.path === `/api/agent-collab/assignments/${ASSIGNMENT_ID_B}/complete`);
    check('延后的指派最终被处理并回报 completed', completesB.length === 1 && completesB[0].body.status === 'completed');
    check('两张指派各建独立工作区',
      fs.existsSync(path.join(workDir, 'agent-workspace', ASSIGNMENT_ID, 'out.txt')) &&
      fs.existsSync(path.join(workDir, 'agent-workspace', ASSIGNMENT_ID_B, 'out.txt')));
    check('两张终态后日志都清理',
      loadAssignmentJournal(journalDirFor(workDir), ASSIGNMENT_ID) === null &&
      loadAssignmentJournal(journalDirFor(workDir), ASSIGNMENT_ID_B) === null);
    await center.close();
  }

  console.log('-- 18. 缺陷 B：瞬态续跑定向重发 + 兄弟单 awaiting_reply 不被覆盖、答复仍被消费 --');
  {
    const workDir = newWorkDir();
    // B 的现场：已发澄清、等人工答复（未回复提问留在 asked 里）
    const askedB = { clientClarificationId: 'client-b1', round: 1, question: 'B 的输出写到哪里？' };
    seedJournal(workDir, {
      assignmentId: ASSIGNMENT_ID_B,
      phase: 'awaiting_reply',
      pendingQuestion: askedB.question,
      asked: [askedB],
      replies: [],
    });
    const journalBefore = JSON.stringify(loadAssignmentJournal(journalDirFor(workDir), ASSIGNMENT_ID_B));

    const center = makeCenter({
      llmScript: [PLAN_OK], // 留给 B 的澄清续跑
      pollScript: [
        {
          items: [
            { kind: 'assignment', assignmentId: ASSIGNMENT_ID, sop: SOP_PAYLOAD },
            { kind: 'assignment', assignmentId: ASSIGNMENT_ID_B, sop: SOP_PAYLOAD },
          ],
        },
        // 中台把「在等答复」的 B 也重投回来（全局 resend 旧行为 / 定向 resend 都可能命中）
        { items: [{ kind: 'assignment', assignmentId: ASSIGNMENT_ID_B, sop: SOP_PAYLOAD }] },
        { items: [replyItem({ assignmentId: ASSIGNMENT_ID_B, clarificationId: 'srv-b1', clientClarificationId: 'client-b1' })] },
        { items: [] },
      ],
    });
    const baseUrl = await center.listen();
    const base = new CollabClient({ baseUrl, token: 't', timeoutMs: 5000 });
    const client = Object.create(base) as CollabClient;
    let relayDown = true;
    let relayCalls = 0;
    (client as unknown as { llmRelay: unknown }).llmRelay = async (address: string, input: unknown) => {
      relayCalls += 1;
      if (relayDown) return { ok: false, error: 'llm relay failed (status=503)', content: '' };
      return (base as unknown as {
        llmRelay: (a: string, i: unknown) => Promise<{ ok: boolean; content: string; error?: string }>;
      }).llmRelay(address, input);
    };
    const host = new AgentHost({ address: 'a:1', workDir, getConfig: () => makeConfig(baseUrl), client });

    await host.tick(); // A 领单 → relay 恒 503 → 瞬态续跑；B 本轮被延后
    // 旧断言还带 `resendAssignmentsOnNextPoll === false`。缺陷 B（P3）修完
    // 后该字段**整体移除**（不只不改写），断言改为「字段不存在」。
    check('A 的瞬态续跑请求是定向的（A 的 id 进数组，全局开关已不存在）',
      JSON.stringify((host as unknown as { resendAssignmentIds: string[] }).resendAssignmentIds) ===
        JSON.stringify([ASSIGNMENT_ID, ASSIGNMENT_ID_B]) &&
      !('resendAssignmentsOnNextPoll' in host),
      `ids=${JSON.stringify((host as unknown as { resendAssignmentIds: string[] }).resendAssignmentIds)}`);
    check('B 的日志在第一轮完全未被触碰（延后 ≠ 覆盖）',
      JSON.stringify(loadAssignmentJournal(journalDirFor(workDir), ASSIGNMENT_ID_B)) === journalBefore);

    await host.tick(); // 中台重投 B → 必须命中 awaiting_reply 守卫
    const polls = center.requests.filter((q) => q.path === '/api/agent-collab/poll');
    const resendBody = polls[1]?.body.resendAssignments;
    check('重发请求按 id 定向（数组含 A 与 B），绝不是全局 true',
      Array.isArray(resendBody) && resendBody.includes(ASSIGNMENT_ID) &&
      resendBody.includes(ASSIGNMENT_ID_B) && polls.every((q) => q.body.resendAssignments !== true),
      `body=${JSON.stringify(resendBody ?? null)}`);
    const j2 = loadAssignmentJournal(journalDirFor(workDir), ASSIGNMENT_ID_B);
    check('B 的 journal 未被覆盖（phase 仍 awaiting_reply、提问完好）',
      j2?.phase === 'awaiting_reply' && j2?.pendingQuestion === askedB.question && j2?.asked.length === 1);
    check('B 的 journal 逐字未变（从未落盘重写 ⇒ 循环没重跑）',
      JSON.stringify(j2) === journalBefore);
    check('stats 如实记录「跳过重发」', host.stats.lastOutcome === 'awaiting_reply_skip_resend');
    check('B 在等答复期间零 LLM / 零回报',
      relayCalls === 3 &&
      center.requests.filter((q) => q.path === `/api/agent-collab/assignments/${ASSIGNMENT_ID_B}/complete`).length === 0);

    relayDown = false;
    const relayBefore = relayCalls;
    await host.tick(); // 人工答复到达 → 续跑（不是 ACK 丢弃）
    const polls3 = center.requests.filter((q) => q.path === '/api/agent-collab/poll');
    check('被跳过的重发只回排一次（等待期间不每轮空转请求）',
      JSON.stringify(polls3[2]?.body.resendAssignments ?? null) === JSON.stringify([ASSIGNMENT_ID_B]),
      `body=${JSON.stringify(polls3[2]?.body ?? null)}`);
    check('答复到达后 runWithJournal 真的续跑（LLM 被调用）', relayCalls > relayBefore);
    const completesB = center.requests.filter((q) => q.path === `/api/agent-collab/assignments/${ASSIGNMENT_ID_B}/complete`);
    check('B 续跑后交付 completed（ACK 丢弃分支会留着 awaiting_reply 且零回报）',
      completesB.length === 1 && completesB[0].body.status === 'completed');
    check('B 的澄清回复被 ACK（消费成功才 ACK）',
      center.ackCalls.some((p) => p.includes(ASSIGNMENT_ID_B)));
    check('B 终态后日志清理',
      loadAssignmentJournal(journalDirFor(workDir), ASSIGNMENT_ID_B) === null);
    await host.tick(); // 收尾轮：不应再请求重发 B（无永动机）
    const polls4 = center.requests.filter((q) => q.path === '/api/agent-collab/poll');
    check('收尾轮不再请求重发（无每 30s 空转的永动机）',
      polls4[polls4.length - 1]?.body.resendAssignments === undefined,
      `body=${JSON.stringify(polls4[polls4.length - 1]?.body ?? null)}`);
    await center.close();
  }

  console.log('-- 19. 缺陷 A：瞬态 relay 恒 503 不吃工作预算 + 链路持续不可用如实收敛 --');
  {
    // 现场：中台每轮都把这张单重投回来（按 id 定向重发的真实语义），
    // relay 恒 503（chatJson 3 次退避重试耗尽 → loop 收敛 outcome=error）。
    // 旧行为：每失败一次 iterations +1，第 16 次 checkGate('iterate') →
    // gate_stopped → 上报「迭代轮次已达上限（15 ≥ 15）」= 把 provider 抖动
    // 说成能力结论。新行为：①这一轮不吃预算；②连续未产出工作的瞬态失败
    // 封顶后如实说「LLM 链路持续不可用」。
    const workDir = newWorkDir();
    const assignmentItem = { kind: 'assignment', assignmentId: ASSIGNMENT_ID, sop: SOP_PAYLOAD };
    const center = makeCenter({
      llmScript: [],
      pollScript: [
        { items: [assignmentItem] },
        { items: [assignmentItem] },
        { items: [assignmentItem] },
        { items: [assignmentItem] },
      ],
    });
    const baseUrl = await center.listen();
    const base = new CollabClient({ baseUrl, token: 't', timeoutMs: 5000 });
    const client = Object.create(base) as CollabClient;
    let relayCalls = 0;
    (client as unknown as { llmRelay: unknown }).llmRelay = async () => {
      relayCalls += 1;
      return { ok: false, error: 'llm relay failed (status=503)', content: '' };
    };
    const completes: Array<Record<string, unknown>> = [];
    (client as unknown as { reportComplete: unknown }).reportComplete = async (
      _a: string, _id: string, input: Record<string, unknown>,
    ) => {
      completes.push(input);
      return { ok: true, accepted: true };
    };
    // 封顶调到 3：完整走完「连续瞬态 → 收敛」而不用等 20 轮 × 1.5s 退避。
    // 生产缺省仍是 20（deps 注释里写明），迭代上限 15 一处未动。
    const host = new AgentHost({
      address: 'a:1', workDir, getConfig: () => makeConfig(baseUrl), client,
      transientRequeueLimit: 3,
    });

    await host.tick();
    await host.tick();
    const jAfter2 = loadAssignmentJournal(journalDirFor(workDir), ASSIGNMENT_ID);
    check('两次 503 之后仍在跑（既没 gate_stopped 也没回报终态）',
      completes.length === 0 && jAfter2?.phase === 'running',
      `completes=${completes.length} phase=${jAfter2?.phase ?? 'null'}`);
    check('503 不吃工作预算（落盘 iterations 仍为 0；旧行为此处已是 2）',
      jAfter2?.counters?.iterations === 0,
      `counters=${JSON.stringify(jAfter2?.counters ?? null)}`);
    check('连续瞬态 streak 随日志落盘（跨重领延续，否则封顶永不触发）',
      jAfter2?.transientRequeues === 2, `streak=${jAfter2?.transientRequeues}`);
    check('每轮 tick 都真的打过 relay（3 次退避全耗尽）', relayCalls === 6, `relayCalls=${relayCalls}`);

    await host.tick(); // 第 3 次未产出工作的瞬态失败 → 封顶收敛
    const giveup = completes[0];
    const giveupResult = giveup?.result as {
      outcome?: string; stopMessage?: string; iterations?: number; transientRequeues?: number;
    } | undefined;
    check('封顶后如实上报 failed', completes.length === 1 && giveup?.status === 'failed',
      `completes=${completes.length} status=${String(giveup?.status)}`);
    check('stopMessage 说明「LLM 链路持续不可用」',
      (giveupResult?.stopMessage ?? '').includes('LLM 链路持续不可用'),
      `stopMessage=${String(giveupResult?.stopMessage)}`);
    check('★ 不再冒充「迭代轮次已达上限」',
      !(giveupResult?.stopMessage ?? '').includes('迭代轮次已达上限'));
    check('全链路从未出现过 gate_stopped / 迭代上限文案',
      completes.every((c) => !JSON.stringify(c).includes('迭代轮次已达上限')));
    check('回报里的计数如实（iterations=0，transientRequeues=3）',
      giveupResult?.iterations === 0 && giveupResult?.transientRequeues === 3,
      `iterations=${giveupResult?.iterations} streak=${giveupResult?.transientRequeues}`);
    check('收敛后日志清理（不留永动机）',
      loadAssignmentJournal(journalDirFor(workDir), ASSIGNMENT_ID) === null);
    check('收敛后不再重排该单',
      ((host as unknown as { resendAssignmentIds: string[] }).resendAssignmentIds ?? []).length === 0);

    // ── 反例（防止把闸门改废）：15 轮**真实产出**仍必须 gate_stopped ──
    const workDir2 = newWorkDir();
    const retryScript: string[] = [];
    for (let i = 0; i < 18; i += 1) retryScript.push(PLAN_BAD, '{"action":"retry"}');
    const center2 = makeCenter({
      llmScript: retryScript,
      pollScript: [{ items: [assignmentItem] }, { items: [] }],
    });
    const baseUrl2 = await center2.listen();
    const host2 = new AgentHost({
      address: 'a:1', workDir: workDir2, getConfig: () => makeConfig(baseUrl2),
      client: new CollabClient({ baseUrl: baseUrl2, token: 't', timeoutMs: 5000 }),
    });
    const r2 = await host2.tick();
    const c2 = center2.requests.find((q) => q.path.endsWith('/complete'));
    const res2 = c2?.body.result as {
      outcome?: string; stopReason?: string; stopMessage?: string; iterations?: number;
    } | undefined;
    check('反例：15 轮真实产出仍 gate_stopped（上限没被降、闸门没被改废）',
      r2.worked === true && c2?.body.status === 'failed' &&
      res2?.outcome === 'gate_stopped' && res2?.stopReason === 'iteration_limit',
      `outcome=${res2?.outcome} stopReason=${res2?.stopReason}`);
    check('反例：iterations 仍是 15', res2?.iterations === 15, `iterations=${res2?.iterations}`);
    check('反例：stopMessage 仍如实说「迭代轮次已达上限」',
      (res2?.stopMessage ?? '').includes('迭代轮次已达上限'),
      `stopMessage=${String(res2?.stopMessage)}`);
    check('反例：真实触顶绝不被误报成链路问题',
      !(res2?.stopMessage ?? '').includes('LLM 链路'));
    await center.close();
    await center2.close();
  }

  console.log('-- 20. 缺陷 B：poll 后 Agent 被关闭 + 回报失败 → 逐张按 id 入队（不是全局 true）--');
  {
    // 现场：poll 已经领到两张指派（服务端已标 in_progress），随后 Agent 被
    // 关闭；两张都如实回报 failed，但**回报本身失败**——必须留下重发锚点。
    // 旧代码置全局 resendAssignmentsOnNextPoll = true：下一轮 poll 会把该
    // 执行器名下全部 activeStatuses 投回（含正在等人工答复的单）。新代码
    // 与其它三处同一条按 id 定向通道，且逐张入队。
    const workDir = newWorkDir();
    const center = makeCenter({
      llmScript: [],
      pollScript: [
        {
          items: [
            { kind: 'assignment', assignmentId: ASSIGNMENT_ID, sop: SOP_PAYLOAD },
            { kind: 'assignment', assignmentId: ASSIGNMENT_ID_B, sop: SOP_PAYLOAD },
          ],
        },
        { items: [] },
        { items: [] },
      ],
    });
    const baseUrl = await center.listen();
    const base = new CollabClient({ baseUrl, token: 't', timeoutMs: 5000 });
    const client = Object.create(base) as CollabClient;
    const config = makeConfig(baseUrl);
    const originalPoll = base.poll.bind(base);
    let pollCount = 0;
    (client as unknown as { poll: unknown }).poll = async (
      address: string, opts: { waitMs?: number; resendAssignments?: boolean | string[] },
    ) => {
      const r = await originalPoll(address, opts);
      pollCount += 1;
      if (pollCount === 1) config.agentEnabled = false; // 领取之后立刻被关闭
      return r;
    };
    const completes: Array<Record<string, unknown>> = [];
    (client as unknown as { reportComplete: unknown }).reportComplete = async (
      _a: string, _id: string, input: Record<string, unknown>,
    ) => {
      completes.push(input);
      return { ok: false, error: 'complete endpoint down' }; // 回报失败 → 必须留锚点
    };
    const host = new AgentHost({ address: 'a:1', workDir, getConfig: () => config, client });
    await host.tick();

    check('两张指派都如实回报 failed（agent_disabled_during_poll）',
      completes.length === 2 &&
      completes.every((c) => c.status === 'failed' &&
        (c.result as { outcome?: string })?.outcome === 'agent_disabled_during_poll'),
      `completes=${completes.length}`);
    check('关闭期间不执行指派（零 LLM、不建工作区）',
      !center.requests.some((q) => q.path === '/api/agent-collab/llm') &&
      !fs.existsSync(path.join(workDir, 'agent-workspace')));
    check('回报失败的两张指派**逐张**进定向重发队列',
      JSON.stringify((host as unknown as { resendAssignmentIds: string[] }).resendAssignmentIds) ===
        JSON.stringify([ASSIGNMENT_ID, ASSIGNMENT_ID_B]),
      `ids=${JSON.stringify((host as unknown as { resendAssignmentIds: string[] }).resendAssignmentIds)}`);
    check('★ 全局重发开关已彻底移除（缺陷 B 的根因不可再表达）',
      !('resendAssignmentsOnNextPoll' in host));

    // 重新启用 → 下一轮 poll 的请求体必须是**数组**（含两张 id），绝不是 true
    config.agentEnabled = true;
    await host.tick();
    const polls = center.requests.filter((q) => q.path === '/api/agent-collab/poll');
    const lastBody = polls[polls.length - 1]?.body;
    const resend = lastBody?.resendAssignments;
    check('下一轮 poll 的 resendAssignments 是数组（含该 id），不是 true',
      Array.isArray(resend) && resend.includes(ASSIGNMENT_ID) && resend.includes(ASSIGNMENT_ID_B) &&
      polls.every((q) => q.body.resendAssignments !== true),
      `body=${JSON.stringify(lastBody ?? null)}`);
    await center.close();
  }

  for (const d of workDirs) fs.rmSync(d, { recursive: true, force: true });
  assert.ok(true);
  console.log(failures ? `\n=== ${failures} 项失败 ===\n` : '\n=== agent-host selftest 全部通过 ===\n');
  process.exit(failures ? 1 : 0);
}

void main();
