jest.setTimeout(120_000);

import { randomUUID } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { DataSource } from "typeorm";
import { APPROVAL_POLICY_FINGERPRINT_KEYS } from "../src/modules/agent/runtime/agent-approvals.service";
import { AiService, type ToolCall } from "../src/modules/ai/ai.service";
import { SystemConfigService } from "../src/modules/config/config.service";
import { createTestApp, loginAsAdmin } from "./helpers/app.helper";

// Runs in the regular admin-api e2e suite with a migrated test DB and Redis.
// Only the model's answer is scripted. Tickets, worker claims, tool invocation,
// PostgreSQL constraints and the two resulting manual task rows are real.
describe("Agent session · successive approvals (e2e)", () => {
  let app: INestApplication;
  let db: DataSource;
  let admin: string;
  const createdPaths: string[] = [];
  const key = `agent-e2e-${randomUUID().slice(0, 12)}`;
  const names = [`${key}-first`, `${key}-second`];
  const result = "Both requests were executed";
  /** 与 APPROVAL_POLICY_FINGERPRINT_KEYS 一一对应的最小策略值，避免假阴/假阳。 */
  const MINIMAL_POLICY: Record<
    (typeof APPROVAL_POLICY_FINGERPRINT_KEYS)[number],
    string
  > = {
    "agent.policy.writeRequiresApproval": "false",
    "agent.policy.dangerousRequiresApproval": "true",
    "agent.policy.allowDangerous": "false",
    "agent.policy.executableSourceGate": "true",
  };
  /** beforeAll 前的原值；afterAll 精确恢复，null 表示原本不存在 ⇒ 删除。 */
  const policyBackup: { key: string; value: string | null }[] = [];

  beforeAll(async () => {
    if (!/(^|_)(test|e2e)(_|$)/i.test(process.env.DB_DATABASE ?? "")) {
      throw new Error(
        "This journey requires an explicit test/e2e database (e.g. autoflow_test)",
      );
    }
    app = await createTestApp();
    db = app.get(DataSource);
    // APPROVAL_POLICY_FINGERPRINT_KEYS 四键的最小策略种子：自带并在 afterAll 恢复/删除，
    // 不依赖其它 suite 的管理配置种子。注：当前 ConfigService 不读 system_configs，
    // 本 suite 的真实阻断点在下方 LLM 流式替身（invokeLlm → chatMultimodalStream）。
    const systemConfig = app.get(SystemConfigService);
    for (const key of APPROVAL_POLICY_FINGERPRINT_KEYS) {
      const before = await systemConfig.findOne(key).catch(() => null);
      policyBackup.push({ key, value: before?.value ?? null });
      await systemConfig.upsert({
        key,
        value: MINIMAL_POLICY[key],
        valueType: "boolean",
        description: "agent approval e2e minimal policy fixture",
      });
    }
    admin = await loginAsAdmin(app);
  });
  afterAll(async () => {
    jest.restoreAllMocks();
    try {
      const systemConfig = app?.get(SystemConfigService);
      if (systemConfig) {
        for (const { key, value } of policyBackup) {
          if (value === null) {
            await systemConfig.remove(key).catch(() => undefined);
          } else {
            await systemConfig
              .upsert({ key, value, valueType: "boolean" })
              .catch(() => undefined);
          }
        }
      }
      if (admin) {
        const tasks: { id: string }[] = await db.query(
          "SELECT id FROM tasks WHERE name IN ($1, $2)",
          names,
        );
        for (const path of [
          ...tasks.map((row) => `/tasks/${row.id}`),
          ...createdPaths.reverse(),
        ]) {
          await request(app.getHttpServer())
            .delete(path)
            .set("Authorization", `Bearer ${admin}`)
            .expect(200);
        }
      }
    } finally {
      await app?.close();
    }
  });

  async function post(path: string, body: object, token = admin) {
    const r = await request(app.getHttpServer())
      .post(path)
      .set("Authorization", `Bearer ${token}`)
      .send(body)
      .expect(201);
    return r.body.data ?? r.body;
  }
  async function get(path: string) {
    const r = await request(app.getHttpServer())
      .get(path)
      .set("Authorization", `Bearer ${admin}`)
      .expect(200);
    return r.body.data ?? r.body;
  }
  async function tasksCreated() {
    const rows: { name: string }[] = await db.query(
      "SELECT name FROM tasks WHERE name IN ($1, $2) ORDER BY name",
      names,
    );
    return rows.map((row) => row.name);
  }
  async function waitForStep(id: string, n: number, status: string) {
    const deadline = Date.now() + 8_000;
    let last:
      | { totalSteps: number; status: string; errorMessage: string | null }
      | undefined;
    do {
      [last] = await db.query(
        'SELECT "totalSteps", status, "errorMessage" FROM agent_sessions WHERE id = $1',
        [id],
      );
      if (last?.status === status && last.totalSteps === n) return;
      if (last?.status === "failed")
        throw new Error(last.errorMessage ?? "Agent session failed");
      await wait(50);
    } while (Date.now() < deadline);
    throw new Error(
      `Expected ${status} at step ${n}, last state: ${JSON.stringify(last)}`,
    );
  }

  it("waits for each approval and produces a third step after the second grant", async () => {
    // A separate administrator also works on deployments enforcing four eyes.
    const password = `Aa1!${randomUUID()}`;
    const reviewerAccount = await post("/users", {
      username: key,
      password,
      email: `${key}@example.invalid`,
      role: "admin",
    });
    createdPaths.push(`/users/${reviewerAccount.id}`);
    const login = await request(app.getHttpServer())
      .post("/auth/login")
      .send({ username: key, password })
      .expect(201);
    const reviewer: string = (login.body.data ?? login.body).accessToken;
    expect(reviewer).toBeTruthy();
    const template = await post("/task-templates", {
      key,
      name: key,
      config: { runtime: "shell", triggerType: "manual" },
    });
    createdPaths.push(`/task-templates/${template.id}`);
    const respond = async (
      req: Parameters<AiService["chatMultimodal"]>[0],
    ): ReturnType<AiService["chatMultimodal"]> => {
      const n = req.messages.filter((m) => m.role === "tool").length;
      const calls: ToolCall[] =
        n < names.length
          ? [
              {
                type: "function",
                id: `call-${n}`,
                function: {
                  name: "create_task_from_template",
                  arguments: JSON.stringify({
                    template: template.id,
                    name: names[n],
                  }),
                },
              },
            ]
          : [];
      return {
        model: "local-script",
        content: calls.length ? "" : result,
        toolCalls: calls,
        usage: { tokensIn: 2, tokensOut: 1 },
      };
    };
    // 生产在 AgentEventStreamService 在场时走 chatMultimodalStream（invokeLlm），
    // 只 mock chatMultimodal 会让真实 disabled 路由返回空响应 ⇒ 会话 failed。
    // 两个入口同一份脚本化答复：不削弱任何断言，只补齐被新路径绕过的替身。
    const ai = app.get(AiService);
    jest.spyOn(ai, "chatMultimodal").mockImplementation(respond);
    jest.spyOn(ai, "chatMultimodalStream").mockImplementation(respond);
    const { id } = await post("/agent/sessions", {
      kind: "chat",
      context: { question: key },
    });
    const session = `/agent/sessions/${id}`;
    const granted = new Set<string>();
    for (let n = 1; n <= 2; n++) {
      await waitForStep(id, n, "waiting_input");
      const approvals: { approvalKey: string; status: string }[] = await get(
        `${session}/approvals`,
      );
      const pending = approvals.filter((a) => a.status === "pending");
      expect(pending).toHaveLength(1);
      const ticket = pending[0].approvalKey;
      expect(granted.has(ticket)).toBe(false);
      const detail = await get(session);
      expect(detail.toolCalls).toContainEqual(
        expect.objectContaining({
          toolCallId: `call-${n - 1}`,
          approvalId: ticket,
          status: "awaiting_approval",
        }),
      );
      expect(await tasksCreated()).toEqual(names.slice(0, n - 1));
      const grant = await post(
        `${session}/approvals/${ticket}/grant`,
        {},
        reviewer,
      );
      expect(grant).toMatchObject({ ok: true, resumed: true });
      granted.add(ticket);
    }
    await waitForStep(id, 3, "succeeded");
    const final = await get(session);
    expect(final.session.resultJson.conclusion).toBe(result);
    expect(final.steps.map((s: { seq: number }) => s.seq)).toEqual([1, 2, 3]);
    expect(final.toolCalls.map((c: { status: string }) => c.status)).toEqual([
      "ok",
      "ok",
    ]);
    expect(await tasksCreated()).toEqual(names);
    expect(
      (await get(`${session}/approvals`)).map(
        (a: { status: string }) => a.status,
      ),
    ).toEqual(["consumed", "consumed"]);
  });
});
