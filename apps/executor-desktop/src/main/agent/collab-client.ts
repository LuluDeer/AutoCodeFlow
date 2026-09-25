import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';

/**
 * P7a 续批（agent-and-deployment）：执行器 Agent ↔ 中台的协作 HTTP 客户端
 * （设计文档 11 §3 的客户端侧）。
 *
 * ## 为什么不用 fetch
 * desktop 主进程 tsconfig 的 lib 是 ES2020（无 DOM），Electron 44 内置
 * Node 24 虽有全局 fetch，但 selftest 的 tsc 编译面拿不到稳定类型。node:
 * http/https 是零类型摩擦、Electron/纯 node 双环境一致的确定性选择。
 *
 * ## 纪律
 * · 所有请求走 per-executor token（Bearer，与 pull/heartbeat 同一条机器
 *   身份链）+ body.address 双标识。
 * · 超时（默认 30s；poll 由调用方给更长）经 socket 销毁强制收敛——**绝不
 *   挂死**：Agent 循环是长任务，一次网络悬挂不该占死整个会话。
 * · 所有失败收敛为 `{ ok:false, error }`，**绝不抛**——调用方是循环/上报
 *   路径，网络抖动应被如实记录而不是打断状态机。
 */

export const COLLAB_DEFAULT_TIMEOUT_MS = 30_000;

/** 中台 relay 的规范化响应（对齐 admin-api MultimodalResponse 的子集）。 */
export interface LlmRelayResponse {
  ok: boolean;
  error?: string;
  content: string;
  toolCalls?: Array<Record<string, unknown>>;
  usage?: { tokensIn: number; tokensOut: number };
  model?: string;
}

export interface LlmRelayMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CollabClientOptions {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
  /** 自注 http 模块（selftest 用；生产为 node:http/https 按协议分流）。 */
  httpImpl?: typeof http;
  httpsImpl?: typeof https;
}

interface RawResult {
  ok: boolean;
  status: number | null;
  error?: string;
  body: string;
}

export class CollabClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly httpImpl: typeof http;
  private readonly httpsImpl: typeof https;

  constructor(opts: CollabClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.token = opts.token;
    this.timeoutMs = opts.timeoutMs ?? COLLAB_DEFAULT_TIMEOUT_MS;
    this.httpImpl = opts.httpImpl ?? http;
    this.httpsImpl = opts.httpsImpl ?? https;
  }

  /** 长轮询待办（指派 / 澄清回复）。waitMs 由服务端钳位 ≤25s。 */
  async poll(
    address: string,
    opts: { waitMs?: number; resendAssignments?: boolean } = {},
  ): Promise<{ ok: boolean; error?: string; items: unknown[]; sopPolicy?: unknown }> {
    const res = await this.post('/api/agent-collab/poll', address, {
      address,
      ...(opts.waitMs !== undefined ? { waitMs: opts.waitMs } : {}),
      ...(opts.resendAssignments ? { resendAssignments: true } : {}),
    }, Math.max(this.timeoutMs, (opts.waitMs ?? 0) + 10_000));
    if (!res.ok) return { ok: false, error: res.error ?? `poll failed (status=${res.status})`, items: [] };
    try {
      const parsed = JSON.parse(res.body) as { items?: unknown[]; sopPolicy?: unknown };
      return { ok: true, items: Array.isArray(parsed.items) ? parsed.items : [], sopPolicy: parsed.sopPolicy };
    } catch (err) {
      return { ok: false, error: `poll 响应非法 JSON: ${err instanceof Error ? err.message : String(err)}`, items: [] };
    }
  }

  /** 能力上报（覆盖式）。接 SOP 的机器必须显式含 `agent:sop`。 */
  async reportCapability(address: string, capabilities: string[], report?: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> {
    const res = await this.post('/api/agent-collab/capability', address, {
      address,
      capabilities,
      ...(report ? { report } : {}),
    });
    return res.ok ? { ok: true } : { ok: false, error: res.error ?? `capability failed (status=${res.status})` };
  }

  /** 发起澄清（幂等键 clientClarificationId 由调用方生成）。 */
  async sendClarification(
    address: string,
    input: {
      assignmentId: string;
      clientClarificationId: string;
      question: string;
      context?: Record<string, unknown>;
      mediaRefs?: Array<{ kind: string; url: string; note?: string }>;
      targetAgentSessionId?: string;
    },
  ): Promise<{ ok: boolean; error?: string; escalated?: boolean; round?: number }> {
    const res = await this.post('/api/agent-collab/clarifications', address, {
      address,
      assignmentId: input.assignmentId,
      clientClarificationId: input.clientClarificationId,
      question: input.question,
      ...(input.context ? { context: input.context } : {}),
      ...(input.mediaRefs ? { mediaRefs: input.mediaRefs } : {}),
      ...(input.targetAgentSessionId ? { targetAgentSessionId: input.targetAgentSessionId } : {}),
    });
    if (!res.ok) return { ok: false, error: res.error ?? `clarification failed (status=${res.status})` };
    try {
      const parsed = JSON.parse(res.body) as { escalated?: boolean; round?: number };
      return { ok: true, escalated: parsed.escalated === true, round: parsed.round };
    } catch {
      return { ok: true };
    }
  }

  /** 进度心跳。 */
  async reportProgress(
    address: string,
    assignmentId: string,
    input: { progressJson?: Record<string, unknown>; targetAgentSessionId?: string } = {},
  ): Promise<{ ok: boolean; error?: string }> {
    const res = await this.post(`/api/agent-collab/assignments/${encodeURIComponent(assignmentId)}/progress`, address, {
      address,
      ...(input.progressJson ? { progressJson: input.progressJson } : {}),
      ...(input.targetAgentSessionId ? { targetAgentSessionId: input.targetAgentSessionId } : {}),
    });
    return res.ok ? { ok: true } : { ok: false, error: res.error ?? `progress failed (status=${res.status})` };
  }

  /** 回报完成（幂等键 attempt）。 */
  async reportComplete(
    address: string,
    assignmentId: string,
    input: { status: 'completed' | 'failed'; result?: Record<string, unknown>; attempt?: number },
  ): Promise<{ ok: boolean; error?: string; accepted?: boolean }> {
    const res = await this.post(`/api/agent-collab/assignments/${encodeURIComponent(assignmentId)}/complete`, address, {
      address,
      status: input.status,
      ...(input.result ? { result: input.result } : {}),
      ...(input.attempt !== undefined ? { attempt: input.attempt } : {}),
    });
    if (!res.ok) return { ok: false, error: res.error ?? `complete failed (status=${res.status})` };
    try {
      const parsed = JSON.parse(res.body) as { accepted?: boolean };
      return { ok: true, accepted: parsed.accepted !== false };
    } catch {
      return { ok: true };
    }
  }

  /**
   * LLM relay：让中台代跑一次推理（API key 不出服务端；令牌消耗记在中台
   * 的 metrics 里）。content 为空 = 中台 LLM 未启用/不可用（fail-open 语义
   * 与 admin-api ai 模块一致）——调用方按「模型不可用」降级。
   */
  async llmRelay(address: string, input: { messages: LlmRelayMessage[]; tools?: unknown[] }): Promise<LlmRelayResponse> {
    const res = await this.post('/api/agent-collab/llm', address, {
      address,
      messages: input.messages,
      ...(input.tools ? { tools: input.tools } : {}),
    }, 120_000); // LLM 调用天然慢，超时独立放宽
    if (!res.ok) return { ok: false, error: res.error ?? `llm relay failed (status=${res.status})`, content: '' };
    try {
      const parsed = JSON.parse(res.body) as {
        content?: string;
        toolCalls?: Array<Record<string, unknown>>;
        usage?: { tokensIn: number; tokensOut: number };
        model?: string;
        error?: string;
      };
      return {
        ok: true,
        content: typeof parsed.content === 'string' ? parsed.content : '',
        toolCalls: parsed.toolCalls,
        usage: parsed.usage,
        model: parsed.model,
        error: parsed.error,
      };
    } catch (err) {
      return { ok: false, error: `relay 响应非法 JSON: ${err instanceof Error ? err.message : String(err)}`, content: '' };
    }
  }

  /**
   * 媒体回传（P7b）：把截图/录屏挂到指派上（multipart/form-data）。
   * 返回的 mediaPath（/api/agent-collab/media/<id>）是澄清 mediaRefs 的
   * 合法引用形态。
   */
  async uploadMedia(
    address: string,
    assignmentId: string,
    file: { name: string; mime: string; buf: Buffer },
  ): Promise<{ ok: boolean; error?: string; mediaPath?: string }> {
    // node:http 无 FormData——手工拼 multipart（字段一个：file）
    const boundary = `----acfagent${Date.now()}${Math.floor(Math.random() * 1e8)}`;
    const head = Buffer.from(
      [
        `--${boundary}`,
        `Content-Disposition: form-data; name="file"; filename="${file.name.replace(/[^\w.-]/g, '_')}"`,
        `Content-Type: ${file.mime}`,
        '',
        '',
      ].join('\r\n'),
      'utf8',
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
    const body = Buffer.concat([head, file.buf, tail]);

    const res = await this.rawRequest(
      'POST',
      `/api/agent-collab/assignments/${encodeURIComponent(assignmentId)}/media`,
      {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': String(body.length),
      },
      body,
      120_000, // 录屏可能上百 MB，放宽
    );
    if (!res.ok) return { ok: false, error: res.error ?? `media upload failed (status=${res.status})` };
    try {
      const parsed = JSON.parse(res.body) as { mediaPath?: string };
      return { ok: true, mediaPath: parsed.mediaPath };
    } catch {
      return { ok: false, error: 'media upload 响应非法 JSON' };
    }
  }

  /** 单发 POST（JSON）。所有错误收敛为 RawResult，不抛。 */
  private post(path: string, _address: string, body: unknown, timeoutMs?: number): Promise<RawResult> {
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    return this.rawRequest(
      'POST',
      path,
      {
        'Content-Type': 'application/json',
        'Content-Length': String(payload.length),
      },
      payload,
      timeoutMs,
    );
  }

  /** 底层单请求（JSON 与 multipart 共用）。所有错误收敛为 RawResult，不抛。 */
  private rawRequest(
    method: string,
    path: string,
    headers: Record<string, string>,
    payload: Buffer,
    timeoutMs?: number,
  ): Promise<RawResult> {
    return new Promise((resolve) => {
      let url: URL;
      try {
        url = new URL(`${this.baseUrl}${path}`);
      } catch (err) {
        resolve({ ok: false, status: null, error: `baseUrl 非法: ${err instanceof Error ? err.message : String(err)}`, body: '' });
        return;
      }
      const impl = url.protocol === 'https:' ? this.httpsImpl : this.httpImpl;
      const req = impl.request(
        {
          hostname: url.hostname,
          port: url.port || (url.protocol === 'https:' ? 443 : 80),
          path: `${url.pathname}${url.search}`,
          method,
          headers: {
            ...headers,
            Authorization: `Bearer ${this.token}`,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (c: Buffer) => {
            size += c.length;
            if (size <= 4 * 1024 * 1024) chunks.push(c);
          });
          res.on('end', () => {
            resolve({
              ok: (res.statusCode ?? 500) >= 200 && (res.statusCode ?? 500) < 300,
              status: res.statusCode ?? null,
              body: Buffer.concat(chunks).toString('utf8'),
            });
          });
          res.on('error', (err) => {
            resolve({ ok: false, status: res.statusCode ?? null, error: err.message, body: '' });
          });
        },
      );
      req.setTimeout(timeoutMs ?? this.timeoutMs, () => {
        req.destroy(new Error(`request timeout after ${timeoutMs ?? this.timeoutMs}ms`));
      });
      req.on('error', (err) => {
        resolve({ ok: false, status: null, error: err.message, body: '' });
      });
      req.write(payload);
      req.end();
    });
  }
}
