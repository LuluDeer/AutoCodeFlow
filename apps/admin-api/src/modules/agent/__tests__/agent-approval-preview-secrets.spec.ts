import { ConfigService } from "@nestjs/config";

import { ToolExecutorService } from "../tools/tool-executor.service";
import { AgentBoundaryService } from "../boundary/agent-boundary.service";
import { computeApprovalPolicyFingerprint } from "../runtime/agent-approvals.service";
import type { AgentSession } from "../entities/agent-session.entity";

/**
 * R289-C1（OPEN-DECISIONS.md C1）：审批单 `preview` 与台账 `argsJson` 值级脱敏贯通验证。
 *
 * 覆盖真实漏网场景：
 *   ① 无害键名（`note`/`content`/`url`/`body`）下且 ≤200 字符的敏感凭据
 *      （PEM 多行/JSON 转义 `\n`/未闭合、裸 JWT、供应商前缀、空用户名 URL、
 *       Authorization: Basic、高熵词元通道 A/B）→ `agent_approvals.preview`
 *      与 `agent_tool_calls.argsJson` 均零明文；
 *   ② `executableSourceFields`（480 字符代码头，如 `overrides.glueSource`）内嵌凭据
 *      被打码，且正常代码行完整可读；
 *   ③ `SECRET_KEYS_RE` 扩展键名（`api-key`/`accessKey`/`private_key`）整键脱敏，
 *      且 `publicKey`/`approvalKey` 不被误伤；
 *   ④ 正常业务值（UUID/ISO 时间戳/cron/路径/安全 URL/中文说明/公钥证书）原样保留。
 */
function harness() {
  const boundary = new AgentBoundaryService({
    get: () => undefined,
  } as unknown as ConfigService);

  const currentPolicyFingerprint = computeApprovalPolicyFingerprint({
    writeRequiresApproval: false,
    dangerousRequiresApproval: true,
    allowDangerous: false,
    executableSourceGate: true,
  });

  const toolCalls: Array<Record<string, unknown>> = [];
  const sessions = {
    findToolCall: jest.fn(async () => null),
    recordToolCall: jest.fn(async (v: Record<string, unknown>) => {
      toolCalls.push(v);
      return v;
    }),
    updateToolCallByToolCallId: jest.fn(async () => true),
    settleToolCallByApprovalId: jest.fn(async () => 0),
    listToolCalls: jest.fn(async () => []),
    markWaiting: jest.fn(async () => undefined),
  };
  const api = {
    invoke: jest.fn(async () => ({ data: { id: "task-1" }, isError: false })),
  };
  const notify = { approvalRequested: jest.fn(async () => undefined) };
  const sops = {
    getBySlug: jest.fn(async () => ({ id: "sop-1" })),
    getClarificationScopeInfo: jest.fn(async () => null),
  };
  const approvals = {
    request: jest.fn(async (v: unknown) => v),
    buildKey: (
      sessionId: string,
      toolName: string,
      args: Record<string, unknown> | null,
    ) => `apr-${sessionId}-${toolName}-${JSON.stringify(args ?? null).length}`,
    findByKey: jest.fn(async () => null),
    findActiveSessionGrant: jest.fn(async () => null),
    consume: jest.fn(async () => true),
    explainConsumeFailure: jest.fn(async () => "not_granted"),
  };

  const svc = new ToolExecutorService(
    boundary,
    sessions as never,
    api as never,
    notify as never,
    approvals as never,
    sops as never,
  );
  return { svc, approvals, toolCalls, currentPolicyFingerprint };
}

function chatSession(): AgentSession {
  return {
    id: "s-c1",
    kind: "chat",
    scopeJson: { unrestricted: true },
  } as unknown as AgentSession;
}

const call = (name: string, args: Record<string, unknown>) => ({
  id: "call-c1",
  function: { name, arguments: JSON.stringify(args) },
});

function persistedPreviewAndArgs(h: ReturnType<typeof harness>) {
  const approvalReq = (h.approvals.request as jest.Mock).mock.calls[0][0] as {
    preview: string | null;
  };
  expect(approvalReq.preview).not.toBeNull();
  const rawPreview = approvalReq.preview as string;
  const envelope = JSON.parse(rawPreview) as {
    truncated: boolean;
    args: string;
  };
  const previewObj = JSON.parse(envelope.args) as Record<string, unknown>;
  const ledgerArgs = JSON.stringify(h.toolCalls[0]?.args ?? null);
  return { rawPreview, previewObj, ledgerArgs };
}

describe("R289-C1 · agent_approvals.preview 与 agent_tool_calls.argsJson 值级脱敏", () => {
  it("无害键（note/content/url/body ≤200 字符）中的全部 C1 敏感形态均零明文", async () => {
    const secrets = {
      pemBody: "MIIEpAIBAAKCAQEA1234",
      pemEscapedBody: "b3BlbnNzaC1rZXktdjE=",
      jwt: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
      ghPat: "github_pat_11ABCDEFG0123456789_abcdefghijklmnop123456",
      awsAkia: "AKIAIOSFODNN7EXAMPLE",
      slackBot: "xoxb-123456789012-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx",
      redisPass: "myRedisPass99",
      basicB64: "dXNlcjpzZWNyZXRwYXNz",
      entropyA: "k8J2mP9qR4sT6vW1xY3zA5bC7dE9fG2h",
      awsSecret: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    };

    const h = harness();
    const out = await h.svc.execute(
      chatSession(),
      call("update_task", {
        taskId: "550e8400-e29b-41d4-a716-446655440000",
        patch: {
          note: `-----BEGIN RSA PRIVATE KEY-----\n${secrets.pemBody}\n-----END RSA PRIVATE KEY-----\nfor staging`,
          content: `-----BEGIN OPENSSH PRIVATE KEY-----\\n${secrets.pemEscapedBody}`,
          body: `${secrets.jwt} ${secrets.ghPat} ${secrets.awsAkia}`,
          url: `redis://:${secrets.redisPass}@cache.internal:6379/0`,
          headerNote: `Authorization: Basic ${secrets.basicB64}`,
          slackNote: `notify ${secrets.slackBot}`,
          extraA: `val ${secrets.entropyA}`,
          extraB: `val ${secrets.awsSecret}`,
        },
      }),
      null,
    );

    expect(out.needsApproval).toBe(true);
    const { rawPreview, previewObj, ledgerArgs } = persistedPreviewAndArgs(h);

    for (const secret of Object.values(secrets)) {
      expect(rawPreview).not.toContain(secret);
      expect(ledgerArgs).not.toContain(secret);
    }

    const patch = previewObj.patch as Record<string, string>;
    expect(patch.note).toBe("[REDACTED_PEM]\nfor staging");
    expect(patch.content).toBe("[REDACTED_PEM]");
    expect(patch.url).toBe("redis://:[REDACTED]@cache.internal:6379/0");
    expect(patch.extraA).toBe("val [REDACTED_HIGH_ENTROPY]");
    expect(patch.extraB).toBe("val [REDACTED_HIGH_ENTROPY]");
    // 正常 UUID 与尾部说明保留
    expect(previewObj.taskId).toBe("550e8400-e29b-41d4-a716-446655440000");
  });

  it("executableSourceFields（480 字符代码头）内嵌凭据被打码，正常脚本语句保持可读", async () => {
    const awsKey = "AKIAIOSFODNN7EXAMPLE";
    const redisPass = "myRedisPass99";
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const script = [
      "import os",
      `endpoint = "redis://:${redisPass}@cache.internal:6379/0"`,
      `aws_id = "${awsKey}"`,
      `jwt_val = "${jwt}"`,
      'print("health ok")',
      "# padding " + "check status ".repeat(20),
    ].join("\n");
    expect(script.length).toBeGreaterThan(200);

    const h = harness();
    const out = await h.svc.execute(
      chatSession(),
      call("create_task_from_template", {
        template: "health_check",
        name: "c1-code-head",
        overrides: { glueSource: script },
      }),
      null,
    );

    expect(out.needsApproval).toBe(true);
    const { rawPreview, previewObj, ledgerArgs } = persistedPreviewAndArgs(h);

    for (const s of [awsKey, redisPass, jwt]) {
      expect(rawPreview).not.toContain(s);
      expect(ledgerArgs).not.toContain(s);
    }
    const glueHead = String(
      (previewObj.overrides as Record<string, unknown>).glueSource,
    );
    expect(glueHead).toMatch(
      /^\[executable code len=\d+ lines=\d+ sha256=[0-9a-f]{16}\]\n/,
    );
    expect(glueHead).toContain("import os");
    expect(glueHead).toContain('print("health ok")');
    expect(glueHead).toContain("redis://:[REDACTED]@cache.internal:6379/0");
    expect(glueHead).toContain("[REDACTED_JWT]");
  });

  it("SECRET_KEYS_RE 新增键名脱敏（api-key/accessKey/private_key），不误伤 publicKey/approvalKey 及正常业务值", async () => {
    const h = harness();
    const out = await h.svc.execute(
      chatSession(),
      call("update_task", {
        taskId: "550e8400-e29b-41d4-a716-446655440000",
        patch: {
          "api-key": "short-val-1",
          accessKey: "short-val-2",
          private_key: "short-val-3",
          publicKey: "ssh-ed25519-pub-id",
          approvalKey: "apr-s-1-stop_deployment-x",
          cron: "*/15 0-23 * * 1-5",
          updatedAt: "2026-11-20T15:34:02.123Z",
          path: "/srv/app/worker.py",
          cert: "-----BEGIN CERTIFICATE-----\nMIIBIjANBgkq\n-----END CERTIFICATE-----",
          title: "请确认是否暂停 nightly-etl-prod-v2 调度任务",
        },
      }),
      null,
    );

    expect(out.needsApproval).toBe(true);
    const { rawPreview, previewObj, ledgerArgs } = persistedPreviewAndArgs(h);

    for (const s of ["short-val-1", "short-val-2", "short-val-3"]) {
      expect(rawPreview).not.toContain(s);
      expect(ledgerArgs).not.toContain(s);
    }
    const patch = previewObj.patch as Record<string, unknown>;
    expect(patch["api-key"]).toBe("[REDACTED]");
    expect(patch.accessKey).toBe("[REDACTED]");
    expect(patch.private_key).toBe("[REDACTED]");
    // 不误伤非凭据键名与正常值
    expect(patch.publicKey).toBe("ssh-ed25519-pub-id");
    expect(patch.approvalKey).toBe("apr-s-1-stop_deployment-x");
    expect(patch.cron).toBe("*/15 0-23 * * 1-5");
    expect(patch.updatedAt).toBe("2026-11-20T15:34:02.123Z");
    expect(patch.path).toBe("/srv/app/worker.py");
    expect(patch.cert).toBe(
      "-----BEGIN CERTIFICATE-----\nMIIBIjANBgkq\n-----END CERTIFICATE-----",
    );
    expect(patch.title).toBe("请确认是否暂停 nightly-etl-prod-v2 调度任务");
  });
});
