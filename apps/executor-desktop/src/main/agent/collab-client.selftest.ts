/**
 * P7a 续批 self-check：协作 HTTP 客户端的请求形状与错误收敛。
 * Run via: npm run test:main
 *
 * 反证锚点：
 *   · 每个端点的路径 / 方法 / 鉴权头 / body 字段形状（11 §3 的客户端契约）；
 *   · 网络失败 / 非 2xx / 非 JSON 一律收敛为 {ok:false}——绝不抛；
 *   · LLM relay 的响应解析与空 content（中台 fail-open）透传。
 */
import * as assert from 'node:assert';
import * as http from 'node:http';
import { CollabClient } from './collab-client';

let failures = 0;
function check(name: string, cond: boolean, extra = ''): void {
  if (cond) console.log(`  \u2714 ${name}`);
  else {
    failures++;
    console.error(`  \u2718 ${name}${extra ? ` \u2014 ${extra}` : ''}`);
  }
}

interface CapturedRequest {
  path: string;
  method: string;
  auth: string;
  body: Record<string, unknown>;
}

/** 起一个本地 http server：记录请求，按注册的 handler 回响应。 */
function makeServer(handler: (req: CapturedRequest, res: http.ServerResponse) => void): Promise<{
  server: http.Server;
  requests: CapturedRequest[];
  url: string;
  close: () => Promise<void>;
}> {
  return new Promise((resolveServer) => {
    const requests: CapturedRequest[] = [];
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>;
        const captured: CapturedRequest = {
          path: req.url ?? '/',
          method: req.method ?? '',
          auth: req.headers.authorization ?? '',
          body,
        };
        requests.push(captured);
        handler(captured, res);
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolveServer({
        server,
        requests,
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

async function main(): Promise<void> {
  console.log('\n=== collab-client selftest ===\n');

  // ── 1. 请求形状（11 §3 客户端契约）──
  console.log('-- 1. 请求形状 --');
  {
    const s = await makeServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ items: [{ kind: 'assignment' }], sopPolicy: { permissionPolicy: 'standard' } }));
    });
    const client = new CollabClient({ baseUrl: s.url, token: 'tok-123' });
    const poll = await client.poll('office-pc:8002', { waitMs: 100 });
    check('poll ok 且 items 透传', poll.ok === true && Array.isArray(poll.items) && poll.items.length === 1);
    const r = s.requests[0];
    check('poll 路径与方法', r.path === '/api/agent-collab/poll' && r.method === 'POST');
    check('Bearer 鉴权头', r.auth === 'Bearer tok-123');
    check('poll body 携带 address + waitMs', r.body.address === 'office-pc:8002' && r.body.waitMs === 100);
    check('sopPolicy 透传', (poll.sopPolicy as Record<string, unknown>).permissionPolicy === 'standard');

    const cap = await client.reportCapability('office-pc:8002', ['agent:sop', 'filesystem'], { os: 'win' });
    check('capability ok', cap.ok === true);
    const r2 = s.requests[1];
    check('capability 路径 + capabilities + report', r2.path === '/api/agent-collab/capability' && JSON.stringify(r2.body.capabilities) === '["agent:sop","filesystem"]' && (r2.body.report as Record<string, unknown>).os === 'win');

    const clar = await client.sendClarification('office-pc:8002', {
      assignmentId: 'asg-1',
      clientClarificationId: 'clr-uuid-1',
      question: '按钮找不到',
      context: { step: 3 },
    });
    check('clarification ok', clar.ok === true);
    const r3 = s.requests[2];
    check('clarification 幂等键在 body', r3.path === '/api/agent-collab/clarifications' && r3.body.clientClarificationId === 'clr-uuid-1' && r3.body.assignmentId === 'asg-1');

    const prog = await client.reportProgress('office-pc:8002', 'asg-1', { progressJson: { step: 4 } });
    check('progress ok + 路径带 assignmentId', prog.ok === true && s.requests[3].path === '/api/agent-collab/assignments/asg-1/progress');

    const done = await client.reportComplete('office-pc:8002', 'asg-1', { status: 'completed', result: { ok: true }, attempt: 1 });
    check('complete ok + accepted 透传', done.ok === true && done.accepted === true);
    check('complete 路径 + status', s.requests[4].path === '/api/agent-collab/assignments/asg-1/complete' && s.requests[4].body.status === 'completed');

    await s.close();
  }

  // ── 2. LLM relay ──
  console.log('-- 2. LLM relay --');
  {
    const s = await makeServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ content: '{"files":[]}', usage: { tokensIn: 10, tokensOut: 5 }, model: 'qwen-vl-max' }));
    });
    const client = new CollabClient({ baseUrl: s.url, token: 't' });
    const r = await client.llmRelay('a:1', { messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'go' }] });
    check('relay ok + content/usage/model 透传', r.ok === true && r.content === '{"files":[]}' && r.usage?.tokensOut === 5 && r.model === 'qwen-vl-max');
    check('relay 消息条数原样', (s.requests[0].body.messages as unknown[]).length === 2);
    await s.close();

    // 中台 fail-open（provider 未启用）→ content 空串但 ok=true，调用方自行降级
    const s2 = await makeServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ content: '', usage: { tokensIn: 0, tokensOut: 0 }, model: '' }));
    });
    const client2 = new CollabClient({ baseUrl: s2.url, token: 't' });
    const empty = await client2.llmRelay('a:1', { messages: [{ role: 'user', content: 'x' }] });
    check('中台 fail-open 透传（content 空、不造成功假象）', empty.ok === true && empty.content === '');
    await s2.close();
  }

  // ── 3. 错误收敛（绝不抛）──
  console.log('-- 3. 错误收敛 --');
  {
    // 非 2xx
    const s = await makeServer((_req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'Invalid executor token' }));
    });
    const client = new CollabClient({ baseUrl: s.url, token: 'bad' });
    const r = await client.poll('a:1');
    check('401 → ok:false + error', r.ok === false && (r.error ?? '').includes('401'));
    await s.close();

    // 非 JSON 响应
    const s2 = await makeServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html>oops</html>');
    });
    const client2 = new CollabClient({ baseUrl: s2.url, token: 't' });
    const r2 = await client2.poll('a:1');
    check('非 JSON → ok:false（不抛）', r2.ok === false && (r2.error ?? '').includes('JSON'));
    await s2.close();

    // 连接拒绝（服务已关）
    const client3 = new CollabClient({ baseUrl: 'http://127.0.0.1:1', token: 't', timeoutMs: 2000 });
    const r3 = await client3.poll('a:1');
    check('连接失败 → ok:false（不抛）', r3.ok === false && r3.items.length === 0);

    // baseUrl 非法
    const client4 = new CollabClient({ baseUrl: 'not a url', token: 't' });
    const r4 = await client4.poll('a:1');
    check('非法 baseUrl → ok:false（不抛）', r4.ok === false);
  }

  console.log(failures ? `\n=== ${failures} 项失败 ===\n` : '\n=== collab-client selftest 全部通过 ===\n');
  process.exit(failures ? 1 : 0);
}

void main();
