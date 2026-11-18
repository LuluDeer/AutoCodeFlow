import { randomUUID } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { DataSource } from "typeorm";
import { AiService, type ToolCall } from "../src/modules/ai/ai.service";
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

  beforeAll(async () => {
    if (!/(^|_)(test|e2e)(_|$)/i.test(process.env.DB_DATABASE ?? "")) {
      throw new Error(
        "This journey requires an explicit test/e2e database (e.g. autoflow_test)",
      );
    }
    app = await createTestApp();
    db = app.get(DataSource);
    admin = await loginAsAdmin(app);
  });
  afterAll(async () => {
    jest.restoreAllMocks();
    try {
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
    jest
      .spyOn(app.get(AiService), "chatMultimodal")
      .mockImplementation(async ({ messages }) => {
        const n = messages.filter((m) => m.role === "tool").length;
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
      });
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
