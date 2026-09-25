import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * P5/P6（agent-and-deployment）：SOP 协议四张表。
 *
 *   sops               —— SOP 当前态（文档 + 契约，设计文档 04 §2.1）
 *   sop_versions       —— 不可变版本快照（contentHash 校验锚，04 §2.2）
 *   sop_assignments    —— 指派工单（04 §2.3 + 11 §4.1 细化列一次建齐）
 *   sop_clarifications —— 澄清对话（04 §2.4，跨 Agent 协作链的落点）
 *
 * ## 为什么 sop_versions 不可变
 * 执行器 Agent 按版本执行 SOP，出问题必须能定位「当时执行的是哪一份」。
 * 修订 = 发新版本（insert），永不 UPDATE。contentHash（sha256 覆盖
 * front-matter + 正文）供执行器侧校验「我手里这份和中台发布的是否一致」。
 *
 * ## 为什么 sop_assignments 现在就带 P7 的列
 * pulledAt / lastProgressAt / progressJson / attempt / capabilitySnapshotJson /
 * permissionProfileAtPull 是协作 API（11 §4.1）的存活判定与审计列——P5 的
 * 手工 HTTP 模拟执行器与 P7 的真执行器 Agent 走**同一张工单**，分两次加列
 * 只会让 P5 的形态先固化一遍再返工。
 *
 * ## 幂等与兼容
 * 全部为**新增表**，不触碰既有表；CREATE TABLE/INDEX IF NOT EXISTS；
 * down 逆序逐一 DROP。跨模块引用（executors/task_executions）存可空列
 * 不加 FK 约束（对齐 AddAgentRuntimeTables 先例）。
 */
export class AddSopTables1790000000041 implements MigrationInterface {
  name = "AddSopTables1790000000041";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── sops ──────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "sops" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "slug" character varying(128) NOT NULL,
        "title" character varying(255) NOT NULL,
        "currentVersion" character varying(32),
        "status" character varying(16) NOT NULL DEFAULT 'draft',
        "applicationId" uuid,
        "frontMatterJson" jsonb,
        "bodyMarkdown" text,
        "createdBy" character varying(128) NOT NULL,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_sops" PRIMARY KEY ("id"),
        CONSTRAINT "uq_sops_slug" UNIQUE ("slug")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_sops_status_updatedAt"
        ON "sops" ("status", "updatedAt")
    `);

    // ── sop_versions（不可变快照）──────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "sop_versions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "sopId" uuid NOT NULL,
        "version" character varying(32) NOT NULL,
        "frontMatterJson" jsonb NOT NULL,
        "bodyMarkdown" text NOT NULL,
        "changelog" text,
        "contentHash" character varying(64) NOT NULL,
        "publishedBy" character varying(128) NOT NULL,
        "publishedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_sop_versions" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_sop_versions_sopId_version"
        ON "sop_versions" ("sopId", "version")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_sop_versions_sopId_publishedAt"
        ON "sop_versions" ("sopId", "publishedAt")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_sop_versions_contentHash"
        ON "sop_versions" ("contentHash")
    `);

    // ── sop_assignments（工单）─────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "sop_assignments" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "sopId" uuid NOT NULL,
        "sopVersion" character varying(32) NOT NULL,
        "targetExecutorId" uuid,
        "targetAgentSessionId" character varying(128),
        "status" character varying(16) NOT NULL DEFAULT 'assigned',
        "clarificationRound" integer NOT NULL DEFAULT 0,
        "maxRounds" integer NOT NULL DEFAULT 5,
        "resultJson" jsonb,
        "parentSessionId" uuid,
        "pulledAt" TIMESTAMP WITH TIME ZONE,
        "lastProgressAt" TIMESTAMP WITH TIME ZONE,
        "progressJson" jsonb,
        "attempt" integer NOT NULL DEFAULT 0,
        "lastReplyDeliveredAt" TIMESTAMP WITH TIME ZONE,
        "capabilitySnapshotJson" jsonb,
        "permissionProfileAtPull" character varying(32),
        "assignedBy" character varying(128) NOT NULL,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_sop_assignments" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_sop_assignments_sopId"
        ON "sop_assignments" ("sopId")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_sop_assignments_targetExecutorId_status"
        ON "sop_assignments" ("targetExecutorId", "status")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_sop_assignments_status_createdAt"
        ON "sop_assignments" ("status", "createdAt")
    `);

    // ── sop_clarifications（澄清对话）──────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "sop_clarifications" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "clientClarificationId" character varying(64),
        "assignmentId" uuid NOT NULL,
        "round" integer NOT NULL,
        "question" text NOT NULL,
        "questionContextJson" jsonb,
        "answer" text,
        "resolution" character varying(32),
        "newSopVersion" character varying(32),
        "mediaRefsJson" jsonb,
        "reviewSessionId" uuid,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_sop_clarifications" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_sop_clarifications_assignmentId_round"
        ON "sop_clarifications" ("assignmentId", "round")
    `);
    // 幂等去重：客户端生成的 UUID 唯一（PG 唯一索引允许多行 NULL）
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_sop_clarifications_clientId"
        ON "sop_clarifications" ("clientClarificationId")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 逆序 DROP：依赖最少的先留到最后（澄清 → 工单 → 版本 → 主表）
    await queryRunner.query(
      `DROP INDEX IF EXISTS "uq_sop_clarifications_clientId"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_sop_clarifications_assignmentId_round"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "sop_clarifications"`);

    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_sop_assignments_status_createdAt"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_sop_assignments_targetExecutorId_status"`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_sop_assignments_sopId"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "sop_assignments"`);

    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_sop_versions_contentHash"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_sop_versions_sopId_publishedAt"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "uq_sop_versions_sopId_version"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "sop_versions"`);

    await queryRunner.query(`DROP INDEX IF EXISTS "idx_sops_status_updatedAt"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "sops"`);
  }
}
