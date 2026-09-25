import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * P2（agent-and-deployment）：中台 Agent 运行时底座的三张表。
 *
 * 背景：设计文档 02 §3 定义的会话/步骤/工具调用模型。这是**第一次让 LLM
 * 长驻在中台里**，因此三张表的职责边界刻意划清：
 *
 *   agent_sessions     —— 一次 Agent 任务（多轮推理的容器）
 *   agent_steps        —— 一轮「消息 → 模型响应」（推理循环的持久化载体）
 *   agent_tool_calls   —— 一次工具调用（按工具维度的风控与统计）
 *
 * ## 为什么 steps 必须全量落库
 * 推理循环要**可重入**：会话会在两种情况下中断并从 DB 重建上下文——
 *   ① `waiting_input` 挂起（等审批 / 等执行器澄清）后 resume；
 *   ② admin-api 重启（进程内 state 全丢）。
 * 没有全量 steps，重启后会话只能作废；有了它，run() 每次从 DB 重建 messages
 * 再继续，语义与中断前一致。这也是「审计与复盘」的基础。
 *
 * ## 为什么 tool_calls 独立于 steps
 * 「哪个工具失败率最高」「边界闸门拦了多少次」必须能 SQL 聚合；塞在 step 的
 * jsonb 里就只能全表扫。且两者保留策略不同（写/危险 tier 需 >= 180 天以对齐
 * 审计保留期，只读可 30 天），分表才能独立清理。
 *
 * ## 兼容性
 * 全部为**新增表**，不触碰任何既有表结构（唯一例外见下），故存量部署升级后
 * 行为零变化。三张表的 `NULL` 语义均与项目既有纪律一致（可空列如实表达
 * 「未提供」而非造一个魔法默认值）。
 *
 * ### 同批附加：task_executions.agentSessionId
 * 设计文档 10 §缺口6：Agent 触发一次任务后，产生的执行行需能反查会话。
 * 加**可空** uuid 列（存量行 NULL = 非 Agent 触发），配套 `triggerType='agent'`
 * ——后者复用**既有**的 `task_executions.triggerType`（varchar 自由串，已在用
 * manual/cron/dependency/rollback/api），无需迁移即生效，故此处不建索引以外
 * 的结构改动。
 *
 * 幂等：CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS（对齐
 * AddExecutorReservedSlots 等先例）；down 逐一 DROP。
 */
export class AddAgentRuntimeTables1790000000040 implements MigrationInterface {
  name = "AddAgentRuntimeTables1790000000040";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── agent_sessions ────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "agent_sessions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "kind" character varying(32) NOT NULL,
        "status" character varying(32) NOT NULL DEFAULT 'pending',
        "title" character varying(255),
        "triggerSource" character varying(128) NOT NULL,
        "parentSessionId" uuid,
        "contextJson" jsonb,
        "scopeJson" jsonb,
        "budgetJson" jsonb,
        "resultJson" jsonb,
        "summary" text,
        "errorMessage" text,
        "totalSteps" integer NOT NULL DEFAULT 0,
        "totalTokensIn" integer NOT NULL DEFAULT 0,
        "totalTokensOut" integer NOT NULL DEFAULT 0,
        "totalToolCalls" integer NOT NULL DEFAULT 0,
        "waitingFor" character varying(255),
        "startedAt" TIMESTAMP WITH TIME ZONE,
        "finishedAt" TIMESTAMP WITH TIME ZONE,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_agent_sessions" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_agent_sessions_status_createdAt"
        ON "agent_sessions" ("status", "createdAt")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_agent_sessions_kind_createdAt"
        ON "agent_sessions" ("kind", "createdAt")
    `);
    // P6：按父会话反查子会话（执行器 Agent 的澄清链）
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_agent_sessions_parentSessionId"
        ON "agent_sessions" ("parentSessionId")
    `);

    // ── agent_steps ───────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "agent_steps" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "sessionId" uuid NOT NULL,
        "seq" integer NOT NULL,
        "role" character varying(16) NOT NULL,
        "content" text,
        "reasoning" text,
        "toolCallsJson" jsonb,
        "toolCallId" character varying(128),
        "tokensIn" integer NOT NULL DEFAULT 0,
        "tokensOut" integer NOT NULL DEFAULT 0,
        "latencyMs" integer NOT NULL DEFAULT 0,
        "provider" character varying(32),
        "model" character varying(64),
        "summary" text,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_agent_steps" PRIMARY KEY ("id")
      )
    `);

    // 会话内按 seq 顺序读取是唯一高频访问模式（重建 messages / UI 时间线）。
    // unique 约束同时保证「按 seq 重建顺序」不歧义——重复 seq 会让重放乱序。
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_agent_steps_sessionId_seq"
        ON "agent_steps" ("sessionId", "seq")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_agent_steps_createdAt"
        ON "agent_steps" ("createdAt")
    `);

    // ── agent_tool_calls ──────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "agent_tool_calls" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "sessionId" uuid NOT NULL,
        "stepId" uuid,
        "toolName" character varying(64) NOT NULL,
        "tier" character varying(16) NOT NULL,
        "argsJson" jsonb,
        "resultJson" jsonb,
        "resultTruncated" boolean NOT NULL DEFAULT false,
        "status" character varying(24) NOT NULL DEFAULT 'ok',
        "errorMessage" text,
        "approvalId" uuid,
        "durationMs" integer NOT NULL DEFAULT 0,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_agent_tool_calls" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_agent_tool_calls_toolName_createdAt"
        ON "agent_tool_calls" ("toolName", "createdAt")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_agent_tool_calls_sessionId"
        ON "agent_tool_calls" ("sessionId")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_agent_tool_calls_tier_createdAt"
        ON "agent_tool_calls" ("tier", "createdAt")
    `);

    // ── task_executions.agentSessionId（缺口6：Agent 触发与执行的关联）──
    // 可空是刻意的：存量执行行 NULL = 非 Agent 触发，行为与引入前一致。
    await queryRunner.query(
      `ALTER TABLE "task_executions" ADD COLUMN IF NOT EXISTS "agentSessionId" uuid NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "task_executions" DROP COLUMN IF EXISTS "agentSessionId"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "agent_tool_calls"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "agent_steps"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "agent_sessions"`);
  }
}
