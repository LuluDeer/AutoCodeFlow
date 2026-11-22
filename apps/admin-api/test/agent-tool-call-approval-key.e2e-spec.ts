import { randomUUID } from "node:crypto";
import { DataSource, QueryRunner } from "typeorm";
import { AddAgentRuntimeTables1790000000040 } from "../src/migrations/1790000000040-AddAgentRuntimeTables";
import { CreateAgentApprovals1790000000067 } from "../src/migrations/1790000000067-CreateAgentApprovals";
import { AlignAgentToolCallApprovalKey1790000000100 } from "../src/migrations/1790000000100-AlignAgentToolCallApprovalKey";
import { AgentApproval } from "../src/modules/agent/entities/agent-approval.entity";
import { AgentToolCall } from "../src/modules/agent/entities/agent-tool-call.entity";

// 同 CI 的 PG e2e 入口；每例独占事务/schema，使用真正的 0040/0067 DDL。
// search_path 不包含 public；旧迁移所需的 uuid_generate_v4 用 pg_catalog 内置函数适配。
describe("0100: agent_tool_calls.approvalId (PostgreSQL)", () => {
  const migration = new AlignAgentToolCallApprovalKey1790000000100();
  const sessionId = randomUUID();
  const legacyId = randomUUID();
  const orphanId = randomUUID();
  const key = `apr-${sessionId}-0123456789abcdef`;
  let db: DataSource;
  let qr: QueryRunner;
  let schema: string;

  beforeAll(async () => {
    db = await new DataSource({
      type: "postgres",
      host: process.env.DB_HOST ?? "localhost",
      port: Number(process.env.DB_PORT ?? "5432"),
      username: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_DATABASE,
      entities: [AgentToolCall, AgentApproval],
      installExtensions: false,
      synchronize: false,
    }).initialize();
  });
  afterAll(async () => {
    if (db?.isInitialized) await db.destroy();
  });

  beforeEach(async () => {
    schema = `approval_key_${randomUUID().replaceAll("-", "")}`;
    qr = db.createQueryRunner();
    await qr.startTransaction();
    await qr.query(`CREATE SCHEMA "${schema}"`);
    await qr.query(`SET LOCAL search_path TO "${schema}"`);
    await qr.query(`CREATE FUNCTION uuid_generate_v4() RETURNS uuid
      LANGUAGE SQL AS 'SELECT pg_catalog.gen_random_uuid()'`);
    await qr.query(`CREATE TABLE task_executions (id uuid PRIMARY KEY)`);
    await new AddAgentRuntimeTables1790000000040().up(qr);
    await new CreateAgentApprovals1790000000067().up(qr);
    await qr.query(
      `INSERT INTO agent_approvals (id, "sessionId", "approvalKey", "toolName", reason)
       VALUES ($1, $2, $3, 'fixture', 'fixture')`,
      [legacyId, sessionId, key],
    );
    await qr.query(
      `INSERT INTO agent_tool_calls ("sessionId", "toolName", tier, "approvalId")
       VALUES ($1, '1-null', 'read', NULL), ($1, '2-match-id', 'write', $2), ($1, '3-orphan', 'write', $3)`,
      [sessionId, legacyId, orphanId],
    );
  });
  afterEach(async () => {
    try {
      if (qr.isTransactionActive) await qr.rollbackTransaction();
    } finally {
      await qr.release();
    }
  });

  const shape = () =>
    qr.query(
      `SELECT data_type, character_maximum_length AS length, is_nullable FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'agent_tool_calls' AND column_name = 'approvalId'`,
      [schema],
    );
  // 比较完整行而非仅 count：真匹配的主键、无匹配的 UUID、NULL 与旁列都要留下。
  const rows = () =>
    qr.query(`SELECT * FROM agent_tool_calls ORDER BY "toolName"`);
  const uuidShape = [{ data_type: "uuid", length: null, is_nullable: "YES" }];
  const keyShape = [
    { data_type: "character varying", length: 128, is_nullable: "YES" },
  ];

  it("UUID（含命中审批主键及孤立值）和 NULL 经 up/down 无损往返", async () => {
    const before = await rows();
    expect(before.map((r: AgentToolCall) => r.approvalId)).toEqual([
      null,
      legacyId,
      orphanId,
    ]);
    expect(await shape()).toEqual(uuidShape);
    await migration.up(qr);
    expect(await shape()).toEqual(keyShape);
    expect(await rows()).toEqual(before);
    await migration.down(qr);
    expect(await shape()).toEqual(uuidShape);
    expect(await rows()).toEqual(before);
  });

  it.each([
    ["业务键", key],
    ["可被 PG 转成 UUID 但拼写会改变", "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA"],
  ])("%s 可写入但阻止降级；列、审批单和每条调用均保留", async (_, value) => {
    await migration.up(qr);
    const column = db
      .getMetadata(AgentToolCall)
      .findColumnWithPropertyName("approvalId");
    const approval = db
      .getMetadata(AgentApproval)
      .findColumnWithPropertyName("approvalKey");
    expect(column).toMatchObject({
      type: "varchar",
      length: "128",
      isNullable: true,
    });
    expect(approval).toMatchObject({
      type: column!.type,
      length: column!.length,
    });
    await qr.query(
      `INSERT INTO agent_tool_calls ("sessionId", "toolName", tier, status, "approvalId")
       VALUES ($1, '4-new', 'write', 'awaiting_approval', $2)`,
      [sessionId, value],
    );
    if (value === key) {
      expect(
        await qr.query(`SELECT a.id FROM agent_tool_calls c JOIN agent_approvals a
        ON a."approvalKey" = c."approvalId" WHERE c."toolName" = '4-new'`),
      ).toEqual([{ id: legacyId }]);
    }
    const before = await rows();
    await qr.query("SAVEPOINT before_down");
    await expect(migration.down(qr)).rejects.toMatchObject({
      code: "22P02",
      message: expect.stringContaining("1790000000100 rollback blocked"),
    });
    await qr.query("ROLLBACK TO SAVEPOINT before_down");
    expect(await shape()).toEqual(keyShape);
    expect(await rows()).toEqual(before);
    expect(
      await qr.query(`SELECT id, "approvalKey" FROM agent_approvals`),
    ).toEqual([{ id: legacyId, approvalKey: key }]);
  });
});
