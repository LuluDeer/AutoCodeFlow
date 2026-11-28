/**
 * IMPL-SOP-ADMIN · 领取事实源 / poll 上限 / 候选包诚实语义 / 远端执行器可见性。
 *
 * 级别说明：
 *  - offline describe：内联 fake 的 DTO/控制器契约测试（级别 2）。
 *  - live describe：显式给出 SOP_ADMIN_TEST_PG_PORT 时用真 PG + 真 Nest + 真 service
 *    实例验证持久化副作用（级别 3）；未给端口则跳过，避免误连宿主库。
 */
import { randomUUID } from "node:crypto";
import { type INestApplication, ValidationPipe } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { getQueueToken } from "@nestjs/bullmq";
import { Test } from "@nestjs/testing";
import { TypeOrmModule } from "@nestjs/typeorm";
import { DataSource, Repository } from "typeorm";

import { AGENT_QUEUE_NAME } from "../../agent/runtime/agent.processor";
import { AgentSessionService } from "../../agent/runtime/agent-session.service";
import { AGENT_CAPABILITIES_LEASE_MS } from "../../executor/executor-constants";
import {
  Executor,
  ExecutorStatus,
} from "../../executor/entities/executor.entity";
import { ExecutorService } from "../../executor/executor.service";
import { NotificationService } from "../../notification/notification.service";
import { SchedulerService } from "../../scheduler/scheduler.service";
import { Sop } from "../entities/sop.entity";
import { SopAssignment } from "../entities/sop-assignment.entity";
import { SopClarification } from "../entities/sop-clarification.entity";
import { SopVersion } from "../entities/sop-version.entity";
import {
  AgentCollabPollDto,
  SopCollabController,
} from "../sop-collab.controller";
import { POLL_ASSIGNMENTS_MAX, SopService } from "../sop.service";

const rawPgPort = process.env.SOP_ADMIN_TEST_PG_PORT;
const live = rawPgPort === undefined ? describe.skip : describe;

describe("SOP admin · poll 契约（offline）", () => {
  const pipe = new ValidationPipe({
    whitelist: true,
    transform: true,
    forbidNonWhitelisted: true,
  });

  it("poll 请求接受 capabilities/capabilityReport/effectiveProfile 且拒绝未知字段", async () => {
    await expect(
      pipe.transform(
        {
          address: "a:1",
          capabilities: ["agent:sop", "gui"],
          capabilityReport: { platform: "win32", capabilities: ["gui"] },
          effectiveProfile: "preset(ce=1,sb=0,ha=0,te=0)",
        },
        { type: "body", metatype: AgentCollabPollDto },
      ),
    ).resolves.toMatchObject({
      capabilities: ["agent:sop", "gui"],
      effectiveProfile: "preset(ce=1,sb=0,ha=0,te=0)",
    });
    await expect(
      pipe.transform({ address: "a:1", effectiveProfile: 42 } as never, {
        type: "body",
        metatype: AgentCollabPollDto,
      }),
    ).rejects.toBeTruthy();
  });

  it("poll 响应下发服务端 maxAssignmentsPerPoll，并把上报快照传给领取 CAS", async () => {
    const executor = { id: "exec-1", address: "a:1" };
    const executors = {
      validateTokenByAddress: jest.fn(async () => true),
      findByAddress: jest.fn(async () => executor),
      resolveCredentialExecutorId: jest.fn(async () => executor.id),
      findOne: jest.fn(async () => executor),
      isSharedToken: jest.fn(async () => false),
      getAgentCapabilities: jest.fn(async () => ["agent:sop"]),
    };
    const sops = {
      pollPending: jest.fn(async () => [] as unknown[]),
    };
    const ctl = new SopCollabController(
      executors as never,
      sops as never,
      {} as never,
      {} as never,
      { get: jest.fn(() => undefined) } as never,
      {} as never,
    );
    const out = await ctl.poll(
      Object.assign(new AgentCollabPollDto(), {
        address: "a:1",
        capabilities: ["agent:sop"],
        capabilityReport: { platform: "win32" },
        effectiveProfile: "preset(ce=1,sb=0,ha=0,te=0)",
      }),
      "Bearer t-1",
    );
    expect(out.maxAssignmentsPerPoll).toBe(POLL_ASSIGNMENTS_MAX);
    expect(POLL_ASSIGNMENTS_MAX).toBe(3);
    expect(sops.pollPending).toHaveBeenCalledWith(
      expect.objectContaining({
        executorId: "exec-1",
        claimContext: {
          capabilitySnapshotJson: {
            capabilities: ["agent:sop"],
            report: { platform: "win32" },
          },
          permissionProfileAtPull: "preset(ce=1,sb=0,ha=0,te=0)",
        },
      }),
    );
  });
});

live("SOP admin · 真 PG 事实源验收（级别 3）", () => {
  let app: INestApplication;
  let db: DataSource;
  let sopRepo: Repository<Sop>;
  let versionRepo: Repository<SopVersion>;
  let assignmentRepo: Repository<SopAssignment>;
  let executorRepo: Repository<Executor>;
  let sopService: SopService;

  const createdSopIds: string[] = [];
  const createdAssignmentIds: string[] = [];
  const createdExecutorIds: string[] = [];
  const runTag = `r400-int-${randomUUID().slice(0, 8)}`;
  const executorId = randomUUID();

  beforeAll(async () => {
    const port = Number(rawPgPort);
    if (!Number.isInteger(port) || port <= 0 || port > 65535 || port === 5432) {
      throw new Error(
        "SOP_ADMIN_TEST_PG_PORT must be an isolated mapped port (not 5432)",
      );
    }
    const database =
      process.env.SOP_ADMIN_TEST_PG_DB ?? "autoflow_sop_admin_test";
    if (!/(^|_)(test|e2e|r\d+)(_|$)/i.test(database)) {
      throw new Error(`Refusing to run against non-test database: ${database}`);
    }
    const moduleRef = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: "postgres",
          host: process.env.SOP_ADMIN_TEST_PG_HOST ?? "127.0.0.1",
          port,
          username: process.env.SOP_ADMIN_TEST_PG_USER ?? "autoflow",
          password: process.env.SOP_ADMIN_TEST_PG_PASSWORD ?? "test",
          database,
          entities: [
            Sop,
            SopVersion,
            SopAssignment,
            SopClarification,
            Executor,
          ],
          synchronize: false,
        }),
        TypeOrmModule.forFeature([
          Sop,
          SopVersion,
          SopAssignment,
          SopClarification,
          Executor,
        ]),
      ],
      providers: [
        SopService,
        {
          provide: ExecutorService,
          useValue: {
            getAgentCapabilities: jest.fn(async () => ["agent:sop"]),
            listSopCapableExecutors: jest.fn(async () => []),
            findByAddress: jest.fn(async () => null),
          },
        },
        {
          provide: AgentSessionService,
          useValue: {
            create: jest.fn(async () => ({ id: randomUUID() })),
            requireById: jest.fn(),
            findStatusByIds: jest.fn(async () => []),
          },
        },
        {
          provide: NotificationService,
          useValue: { notify: jest.fn(async () => undefined) },
        },
        {
          provide: SchedulerService,
          useValue: { getStats: () => ({ isLeader: false }) },
        },
        {
          provide: getQueueToken(AGENT_QUEUE_NAME),
          useValue: { add: jest.fn(async () => undefined) },
        },
        {
          provide: ConfigService,
          useValue: { get: jest.fn(() => undefined) },
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
    db = app.get(DataSource);
    sopRepo = db.getRepository(Sop);
    versionRepo = db.getRepository(SopVersion);
    assignmentRepo = db.getRepository(SopAssignment);
    executorRepo = db.getRepository(Executor);
    sopService = app.get(SopService);
  });

  afterAll(async () => {
    try {
      if (db?.isInitialized) {
        if (createdAssignmentIds.length > 0) {
          await db.query(
            `DELETE FROM sop_assignments WHERE id = ANY($1::uuid[])`,
            [createdAssignmentIds],
          );
        }
        if (createdExecutorIds.length > 0) {
          await db.query(`DELETE FROM executors WHERE id = ANY($1::uuid[])`, [
            createdExecutorIds,
          ]);
        }
        if (createdSopIds.length > 0) {
          await db.query(
            `DELETE FROM sop_versions WHERE "sopId" = ANY($1::uuid[])`,
            [createdSopIds],
          );
          await db.query(`DELETE FROM sops WHERE id = ANY($1::uuid[])`, [
            createdSopIds,
          ]);
        }
      }
    } finally {
      await app?.close();
    }
  });

  async function seedSop(suffix: string): Promise<Sop> {
    const sop = await sopRepo.save(
      sopRepo.create({
        slug: `${runTag}-${suffix}`,
        title: `SOP admin ${suffix}`,
        status: "published",
        currentVersion: "1.0.0",
        frontMatterJson: { acceptance: [], capabilities: [] },
        bodyMarkdown: "# SOP admin integration",
        createdBy: "user:9001",
      }),
    );
    createdSopIds.push(sop.id);
    await versionRepo.save(
      versionRepo.create({
        sopId: sop.id,
        version: "1.0.0",
        frontMatterJson: { acceptance: [], capabilities: [] },
        bodyMarkdown: "# SOP admin integration",
        changelog: "init",
        contentHash: randomUUID().replace(/-/g, ""),
        publishedBy: "user:9001",
        publishedAt: new Date(),
      }),
    );
    return sop;
  }

  async function seedAssignment(sopId: string): Promise<SopAssignment> {
    const row = await assignmentRepo.save(
      assignmentRepo.create({
        sopId,
        sopVersion: "1.0.0",
        targetExecutorId: executorId,
        status: "assigned",
        pulledAt: null,
        maxRounds: 5,
        attempt: 0,
        assignedBy: "user:9001",
      }),
    );
    createdAssignmentIds.push(row.id);
    return row;
  }

  it("首次领取 CAS 同事务写 capabilitySnapshotJson + permissionProfileAtPull", async () => {
    const sop = await seedSop("claim");
    const assignment = await seedAssignment(sop.id);
    const capabilitySnapshotJson = {
      capabilities: ["agent:sop", "gui"],
      report: { platform: "win32", capabilities: ["gui"] },
    };
    const permissionProfileAtPull = "preset(ce=1,sb=0,ha=0,te=0)";

    const items = await sopService.pollPending({
      executorId,
      claimContext: {
        capabilitySnapshotJson,
        permissionProfileAtPull,
      },
    });
    expect(items).toHaveLength(1);

    const persisted = await assignmentRepo.findOneOrFail({
      where: { id: assignment.id },
    });
    expect(persisted.pulledAt).toBeInstanceOf(Date);
    expect(persisted.status).toBe("in_progress");
    expect(persisted.capabilitySnapshotJson).toEqual(capabilitySnapshotJson);
    expect(persisted.permissionProfileAtPull).toBe(permissionProfileAtPull);
  });

  it("候选包 completed 回报在 resultJson 中如实标注 packageRef 与待部署/复核中", async () => {
    const sop = await seedSop("candidate");
    const assignment = await seedAssignment(sop.id);
    await assignmentRepo.update(
      { id: assignment.id },
      { status: "in_progress", pulledAt: new Date() },
    );

    const accepted = await sopService.completeAssignment({
      assignmentId: assignment.id,
      executorId,
      status: "completed",
      result: {
        packageId: "pkg-1",
        summary: "candidate built",
      },
    });
    expect(accepted.accepted).toBe(true);

    const persisted = await assignmentRepo.findOneOrFail({
      where: { id: assignment.id },
    });
    expect(persisted.status).toBe("completed");
    expect(persisted.resultJson).toMatchObject({
      packageId: "pkg-1",
      packageRef: "pkg-1",
      deploymentStatus: "pending_deploy",
      autoDeployed: false,
    });
    expect(String(persisted.resultJson?.deploymentNote)).toContain("待部署");
    expect(String(persisted.resultJson?.deploymentNote)).toContain("复核中");
  });

  it("listSopCapableExecutors 能看到排在前 100 台之后的 agent:sop 远端机器", async () => {
    const now = Date.now();
    for (let i = 0; i < 100; i += 1) {
      const row = await executorRepo.save(
        executorRepo.create({
          appName: `filler-${i}`,
          address: `${runTag}-filler-${i}:8002`,
          deviceFingerprint: randomUUID(),
          status: ExecutorStatus.ONLINE,
          lastHeartbeat: new Date(now - i * 1000),
          agentCapabilities: ["filesystem"],
          agentCapabilitiesUpdatedAt: new Date(now),
        }),
      );
      createdExecutorIds.push(row.id);
    }
    const target = await executorRepo.save(
      executorRepo.create({
        appName: "remote-sop-target",
        address: `${runTag}-remote:8002`,
        deviceFingerprint: randomUUID(),
        status: ExecutorStatus.ONLINE,
        // 旧实现按 lastHeartbeat DESC take(100) 时必然被截掉。
        lastHeartbeat: new Date(now - 1_000_000),
        agentCapabilities: ["agent:sop", "gui"],
        agentCapabilitiesUpdatedAt: new Date(
          now - AGENT_CAPABILITIES_LEASE_MS / 2,
        ),
      }),
    );
    createdExecutorIds.push(target.id);

    const harness = {
      repo: executorRepo,
      getAgentCapabilities: ExecutorService.prototype.getAgentCapabilities,
    } as unknown as ExecutorService;
    const listed =
      await ExecutorService.prototype.listSopCapableExecutors.call(harness);

    expect(listed.map((e) => e.id)).toContain(target.id);
    expect(listed.find((e) => e.id === target.id)?.agentCapabilities).toEqual(
      expect.arrayContaining(["agent:sop"]),
    );
  });
});
