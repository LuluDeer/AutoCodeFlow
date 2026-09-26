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
}) {
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  const llmQueue = [...opts.llmScript];
  const pollQueue = opts.pollScript ? [...opts.pollScript] : null;
  let assignmentSent = false;
  const ackCalls: string[] = [];
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
        reply({ ok: true, escalated: false, round: 1 });
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

  for (const d of workDirs) fs.rmSync(d, { recursive: true, force: true });
  assert.ok(true);
  console.log(failures ? `\n=== ${failures} 项失败 ===\n` : '\n=== agent-host selftest 全部通过 ===\n');
  process.exit(failures ? 1 : 0);
}

void main();
