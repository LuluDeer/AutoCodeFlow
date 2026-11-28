/**
 * 业务用户「运行我的草稿」—— 真 PG 进程内 e2e（AGENTS §4.4 第 3 级）。
 *
 * 验收口径是**落库副作用 + 队列 job**，不是「接口 2xx」：
 *  ① 两个真用户（ADMIN 建号 → 真登录拿 JWT）；draft SOP 归属 user A；
 *  ② A 能 POST /workbench/sessions 建会话 + GET 读回；agent_sessions 行
 *     kind=sop_authoring / scopeJson={sops:[sopId]} / createdBy=user:<A.id>
 *     / triggerSource=workbench；agent-jobs 队列多一个 job（jobId=sessionId）；
 *  ③ B 建同 SOP 会话 → 403；B 读 A 的会话 → 404；B 读回时 A 的会话行不变；
 *  ④ 非 draft SOP → 400；越权字段（kind/scope）→ 400（whitelist）；
 *  ⑤ afterAll 精确清理 users / sops / agent_sessions / agent_events /
 *     agent_steps / agent_tool_calls / agent_approvals / queue job，并复查 0 残留。
 *
 * 注意：本用例在真实 AppModule 上跑，依赖 .env 的 PG/Redis；DB_DATABASE 必须
 * 含 test/e2e 字样（与 cost-conversion.e2e-spec.ts 同款保护）。
 */
import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { DataSource } from "typeorm";
import { Queue } from "bullmq";
import { getQueueToken } from "@nestjs/bullmq";

import { createTestApp, loginAsAdmin } from "./helpers/app.helper";
import { AGENT_QUEUE_NAME } from "../src/modules/agent/runtime/agent.processor";

describe("Workbench business-user session (real PG e2e)", () => {
  let app: INestApplication;
  let db: DataSource;
  let adminToken: string;
  let queue: Queue;

  const runId = randomUUID().replace(/-/g, "").slice(0, 12);
  const userA = {
    username: `wb-sess-a-${runId}`,
    email: `wb-sess-a-${runId}@e2e.local`,
    password: "E2eStr0ng!Pass",
  };
  const userB = {
    username: `wb-sess-b-${runId}`,
    email: `wb-sess-b-${runId}@e2e.local`,
    password: "E2eStr0ng!Pass",
  };
  const sopId = randomUUID();
  const publishedSopId = randomUUID();
  let tokenA: string;
  let tokenB: string;
  let idA: number;
  let idB: number;
  const sessionIds: string[] = [];
  const createdUserIds: number[] = [];
  const createdSopIds: string[] = [];
  const enqueuedJobIds: string[] = [];

  const auth = (token: string) => `Bearer ${token}`;
  const unwrap = (body: any) => body?.data ?? body;

  const createUser = async (dto: typeof userA): Promise<number> => {
    const res = await request(app.getHttpServer())
      .post("/users")
      .set("Authorization", auth(adminToken))
      .send({ ...dto, role: "user" });
    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(300);
    const id = Number(unwrap(res.body).id);
    expect(Number.isFinite(id)).toBe(true);
    createdUserIds.push(id);
    return id;
  };

  const login = async (dto: typeof userA): Promise<string> => {
    const res = await request(app.getHttpServer())
      .post("/auth/login")
      .send({ username: dto.username, password: dto.password })
      .expect(201);
    const token: string = res.body?.accessToken ?? res.body?.data?.accessToken;
    expect(token).toBeTruthy();
    return token;
  };

  const insertSop = async (
    id: string,
    slug: string,
    createdBy: string,
    status: string,
  ) => {
    await db.query(
      `INSERT INTO sops (id, slug, title, status, "createdBy", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, now(), now())`,
      [id, slug, `wb e2e ${runId}`, status, createdBy],
    );
    createdSopIds.push(id);
  };

  const sessionRow = async (id: string) =>
    db
      .query(
        `SELECT id, kind, status, "triggerSource", "createdBy", "scopeJson", "contextJson"
         FROM agent_sessions WHERE id = $1`,
        [id],
      )
      .then((r) => r[0] ?? r.rows?.[0]);

  const jobCount = async (id: string) => {
    // jobId 即 sessionId；BullMQ getJob 不依赖 worker 是否已消费。
    const job = await queue.getJob(id);
    return job ? 1 : 0;
  };

  beforeAll(async () => {
    const dbName = process.env.DB_DATABASE ?? "";
    if (!/(^|_)(test|e2e)(_|$)/i.test(dbName)) {
      throw new Error(
        `workbench session e2e 需要显式 test/e2e 库（收到 ${dbName || "<empty>"}）`,
      );
    }
    app = await createTestApp();
    db = app.get(DataSource);
    queue = app.get(getQueueToken(AGENT_QUEUE_NAME));
    adminToken = await loginAsAdmin(app);

    idA = await createUser(userA);
    idB = await createUser(userB);
    tokenA = await login(userA);
    tokenB = await login(userB);

    await insertSop(sopId, `wb-sess-draft-${runId}`, `user:${idA}`, "draft");
    await insertSop(
      publishedSopId,
      `wb-sess-published-${runId}`,
      `user:${idA}`,
      "published",
    );
  });

  afterAll(async () => {
    try {
      if (db) {
        // 精确清理本 runId 的数据；按外键顺序先子后父。
        await db.query(
          'DELETE FROM agent_events WHERE "sessionId" = ANY($1::uuid[])',
          [sessionIds],
        );
        await db.query(
          'DELETE FROM agent_tool_calls WHERE "sessionId" = ANY($1::uuid[])',
          [sessionIds],
        );
        await db.query(
          'DELETE FROM agent_approvals WHERE "sessionId" = ANY($1::uuid[])',
          [sessionIds],
        );
        await db.query(
          'DELETE FROM agent_steps WHERE "sessionId" = ANY($1::uuid[])',
          [sessionIds],
        );
        for (const jid of enqueuedJobIds) {
          try {
            await queue.getJob(jid).then((j) => j?.remove());
          } catch {
            // job 可能已被 worker 消费并 removeOnComplete；忽略。
          }
        }
        await db.query(
          "DELETE FROM agent_sessions WHERE id = ANY($1::uuid[])",
          [sessionIds],
        );
        await db.query("DELETE FROM sops WHERE id = ANY($1::uuid[])", [
          createdSopIds,
        ]);
        await db.query("DELETE FROM users WHERE id = ANY($1::int[])", [
          createdUserIds,
        ]);

        const left = await Promise.all([
          db.query(
            "SELECT count(*)::int AS n FROM agent_sessions WHERE id = ANY($1::uuid[])",
            [sessionIds],
          ),
          db.query(
            "SELECT count(*)::int AS n FROM sops WHERE id = ANY($1::uuid[])",
            [createdSopIds],
          ),
          db.query(
            "SELECT count(*)::int AS n FROM users WHERE id = ANY($1::int[])",
            [createdUserIds],
          ),
        ]);
        const counts = left.map((r) => Number((r[0] ?? r.rows?.[0])?.n ?? -1));
        console.log(
          `[wb-session] runId=${runId} cleanup remaining: sessions=${counts[0]} sops=${counts[1]} users=${counts[2]}`,
        );
        expect(counts).toEqual([0, 0, 0]);
      }
    } finally {
      await app?.close();
    }
  });

  const createSession = (token: string, body: Record<string, unknown>) =>
    request(app.getHttpServer())
      .post("/workbench/sessions")
      .set("Authorization", auth(token))
      .send(body);

  it("① A 建自己的草稿会话：kind/scope/creator/trigger 落库正确，队列入 job", async () => {
    const res = await createSession(tokenA, {
      sopId,
      goal: "按草稿汇总昨日订单异常并推送日报",
      expectedCardHash: "0123456789abcdef",
    }).expect(201);
    const body = unwrap(res.body);
    expect(typeof body.sessionId).toBe("string");
    expect(body.status).toBe("pending");
    sessionIds.push(String(body.sessionId));

    const row = await sessionRow(body.sessionId);
    expect(row).toBeDefined();
    expect(row.kind).toBe("sop_authoring");
    expect(row.triggerSource).toBe("workbench");
    expect(row.createdBy).toBe(`user:${idA}`);
    expect(row.scopeJson).toEqual({ sops: [sopId] });
    expect(row.contextJson).toMatchObject({
      sopId,
      goal: body.goal ?? "按草稿汇总昨日订单异常并推送日报",
    });

    expect(await jobCount(body.sessionId)).toBe(1);
    enqueuedJobIds.push(String(body.sessionId));
  });

  it("② A 读回自己的会话：状态/步骤/审批摘要可达", async () => {
    const res = await request(app.getHttpServer())
      .get(`/workbench/sessions/${sessionIds[0]}`)
      .set("Authorization", auth(tokenA))
      .expect(200);
    const body = unwrap(res.body);
    expect(body.sessionId).toBe(sessionIds[0]);
    expect(body.kind).toBe("sop_authoring");
    // 真 worker 已消费 job，状态可能已从 pending 前进（读面回读库内当前值）。
    expect([
      "pending",
      "running",
      "waiting_input",
      "succeeded",
      "failed",
      "aborted",
      "budget_exceeded",
    ]).toContain(body.status);
    expect(body.scope).toEqual({ sops: [sopId] });
    expect(Array.isArray(body.steps)).toBe(true);
    expect(typeof body.approvals).toBe("object");
  });

  it("③ B 不能建 A 的草稿会话（403），也不能读 A 的会话（404）", async () => {
    await createSession(tokenB, {
      sopId,
      goal: "越权运行他人草稿",
      expectedCardHash: "0123456789abcdef",
    }).expect(403);

    await request(app.getHttpServer())
      .get(`/workbench/sessions/${sessionIds[0]}`)
      .set("Authorization", auth(tokenB))
      .expect(404);

    // B 的越权尝试没有产生任何会话行（对账：本 runId 仍只有 1 条会话）。
    const rows = await db.query(
      'SELECT count(*)::int AS n FROM agent_sessions WHERE "createdBy" = ANY($1::text[])',
      [[`user:${idA}`, `user:${idB}`]],
    );
    const n = Number((rows[0] ?? rows.rows?.[0])?.n ?? -1);
    expect(n).toBe(sessionIds.length);
  });

  it("④ 非 draft SOP → 400；越权字段 kind/scope → 400（DTO whitelist）", async () => {
    await createSession(tokenA, {
      sopId: publishedSopId,
      goal: "运行已发布的 SOP",
      expectedCardHash: "0123456789abcdef",
    }).expect(400);

    const res = await createSession(tokenA, {
      sopId,
      goal: "试图注入越权 kind",
      expectedCardHash: "0123456789abcdef",
      kind: "incident",
      scope: { apps: ["*"] },
    });
    expect(res.status).toBe(400);
    // whitelist + forbidNonWhitelisted：body 里绝不能把 kind/scope 透传到服务端
    // （响应 400 即证明 ValidationPipe 在 handler 之前拦下）。
    expect(res.body?.message ?? unwrap(res.body)?.message).toBeTruthy();
  });

  it("⑤ ADMIN 可读任意工作台会话（管理面例外，读面不越权）", async () => {
    await request(app.getHttpServer())
      .get(`/workbench/sessions/${sessionIds[0]}`)
      .set("Authorization", auth(adminToken))
      .expect(200);
  });
});
