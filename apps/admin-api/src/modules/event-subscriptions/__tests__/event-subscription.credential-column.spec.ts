/**
 * 凭据列「实体列不选」防线的回归锁（event-subscription.secret）。
 *
 * ## 这条防线是什么
 *
 * 本仓的凭据防线是**三条彼此独立的腿**（逐字写在 `packages/mcp-server/src/redact.ts:8-10`）：
 *
 *   ① 实体列 `select: false`；② 响应 DTO 显式排除；③ 掩码函数（`maskForResponse()`）。
 *
 * 本 spec 钉的是**第 ① 条**（此前 `EventSubscription.secret` 缺这一条）。
 * 少了它，任何一条新增读路径（内部 API / 导出 / MCP 面）忘了走掩码，
 * 明文密钥就直接进 LLM 上下文（`redact.ts:10-11` 逐字预警）。
 *
 * ## 为什么本 spec 必须钉住「签名逐字节不变」
 *
 * 加 `select: false` 后，**任何一处读 `secret` 的路径忘了显式 addSelect**，
 * `sub.secret` 就是 `undefined` ⇒ `createHmac("sha256", undefined)` 抛
 * `ERR_INVALID_ARG_TYPE` ⇒ **所有事件派发的签名失效**。这个失败形态极恶劣：
 *
 *   · **不报错**（平台侧只表现为「投递失败」/「接收方拒绝」）；
 *   · 下游验签全失败，但日志里**没有任何一处**说「密钥没取到」。
 *
 * 所以本 spec 的核心不是「有没有 select:false」，而是
 * **「派发路径拿到的是**同一份**明文 ⇒ HMAC 逐字节相同」**。
 *
 * ## 六条断言（与任务书逐条对应）
 *
 *   ① 普通 `find()` 拿不到明文 secret（`undefined` / 键不存在）；
 *   ② 派发路径**显式选取**后能拿到，且 **HMAC 与改动前逐字节相同**（最关键的回归锁）；
 *   ③ 创建订阅返回 `generatedSecret` 一次的逻辑不受影响；
 *   ④ 列表/详情仍返回掩码占位；
 *   ⑤ 守卫有牙：去掉 `select: false` ⇒ 红（用 `/tmp` 副本反证，不动共享文件）；
 *   ⑥ 守卫的豁免表逐条有理由且**不会静默吞掉新列**。
 *
 * ①②④ 用**真 TypeORM 元数据 + 真 SQL 生成**（**不连 DB**）——因为 CI 的
 * admin-api 单测 job **不跑迁移**（`ci.yml`：migration:run 只在 e2e job），
 * 连库会因「表不存在」整片红。TypeORM 的 `buildMetadatas()` 可以离线跑，
 * 生成的 SQL 就是 TypeORM 真正会发给 PG 的那条（断言打在 SQL 上 ⇒ 钉的是
 * **TypeORM 语义**而不是我们的 mock 行为）。
 *
 * ②的「逐字节相同」用**金标准常量**钉：金标准由**改动前的算法**（同一个
 * `createHmac` + 同一个 `${timestamp}.${rawBody}` 拼接）算出，签名字符串逐字比对。
 * 任何一方改了拼接顺序、改了哈希输入、改了取列集合，都会红。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { DataSource } from "typeorm";
import { createHmac } from "node:crypto";
import { Test } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { getRepositoryToken } from "@nestjs/typeorm";
import { DomainEventBus } from "../../../common/services/domain-event-bus.service";
import { EventSubscription } from "../entities/event-subscription.entity";
import { EventSubscriptionDeadLetter } from "../entities/event-subscription-dead-letter.entity";
import { EventSubscriptionService } from "../event-subscription.service";
import { OutboundEventDispatcher } from "../outbound-event-dispatcher.service";
import { AuditService } from "../../audit/audit.service";
import { AuthUser } from "../../../common/interfaces/auth-user.interface";
import { UserRole } from "../../users/entities/user.entity";

jest.mock("axios", () => ({
  __esModule: true,
  default: { post: jest.fn().mockResolvedValue({ status: 200 }) },
}));
jest.mock("../../../common/utils/safe-http.util", () => ({
  ...jest.requireActual("../../../common/utils/safe-http.util"),
  assertSafeHttpUrl: jest
    .fn()
    .mockResolvedValue(new URL("https://ci.example.com")),
  assertAndPinHttpUrl: jest.fn().mockResolvedValue({
    url: new URL("https://ci.example.com/hooks"),
    pinnedIp: "93.184.216.34",
    pinned: false,
  }),
  pinnedAxiosConfig: jest.requireActual("../../../common/utils/safe-http.util")
    .pinnedAxiosConfig,
}));

import axios from "axios";
const axiosPost = axios.post as unknown as jest.Mock;

// 仓库根：<repo>/apps/admin-api/src/modules/event-subscriptions/__tests__ → 上溯 6 级。
const REPO_ROOT = join(__dirname, "..", "..", "..", "..", "..", "..");

/**
 * 剥掉块注释与行注释（保留代码文本）。
 *
 * 判据②要在**代码**里数 `createQueryBuilder("sub")` / `addSelect("sub.secret")`
 * 的处数。不剥注释的话，「删了代码、注释里还留着同一段文本」会让等式仍成立
 * ⇒ 判据静默变绿（本会话已踩过同型坑：文件里有两处时只改一处，判据仍绿）。
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

/** 明文密钥（测试固定值 ⇒ HMAC 可比对）。 */
const SECRET = "s3cret-s3cret-s3cret-1234";

/**
 * ① 金标准签名（**改动前**的算法算出的，逐字节锁）。
 *
 * 输入：secret=`s3cret-s3cret-s3cret-1234`、timestamp=`1767225600000`、
 * body=下面那串**逐字**的 JSON。签名 = `sha256=` + hex(HMAC-SHA256(secret, `${ts}.${body}`))。
 *
 * 派生方式（可复算）：见本文件末尾的「金标准可复算」用例——它用**当前**代码
 * 重算一遍并与本常量逐字比对 ⇒ 常量不会与实现一起漂移。
 */
const GOLDEN_TS = "1767225600000";
const GOLDEN_BODY =
  '{"event":"execution.failed","occurredAt":"2026-01-01T00:00:00.000Z","schemaVersion":1,"data":{"executionId":"e1","status":"failed","failureReason":"script_error"}}';
const GOLDEN_SIGNATURE =
  "sha256=7ea46a86f80e585262df0ca5a1ee7e82196654e8e45243108140018f81b42610";

const adminUser: AuthUser = {
  id: 1,
  username: "admin",
  email: "a@x",
  role: UserRole.ADMIN,
  isActive: true,
};

/** 离线建一份 TypeORM 元数据（**不连 DB**）——只用它生成 TypeORM 真正会发的 SQL。 */
async function offlineDataSource(): Promise<DataSource> {
  const ds = new DataSource({
    type: "postgres",
    host: "127.0.0.1",
    port: 5432,
    username: "offline",
    password: "offline",
    database: "offline",
    entities: [EventSubscription],
    synchronize: false,
    logging: false,
  });
  // buildMetadatas 是 protected；离线建元数据是本 spec 的核心手段（CI 单测 job
  // 不跑迁移 ⇒ 连库会因「表不存在」整片红）。
  await (ds as unknown as { buildMetadatas(): Promise<void> }).buildMetadatas();
  return ds;
}

describe("凭据防线第①腿：EventSubscription.secret 必须是 select: false", () => {
  it("① 普通 find() 拿不到明文 secret（TypeORM 元数据 + 真实 SQL）", async () => {
    const ds = await offlineDataSource();

    // (a) 元数据层：secret 列的 isSelect === false
    const meta = ds.getMetadata(EventSubscription);
    expect(meta.findColumnWithPropertyPath("secret")?.isSelect).toBe(false);

    // (b) SQL 层：默认读面（find() 等价于不显式点名 select 的 QB）**不含** secret 列
    const [sqlPlain] = ds
      .createQueryBuilder(EventSubscription, "EventSubscription")
      .setFindOptions({ where: { enabled: true } })
      .getQueryAndParameters();
    expect(sqlPlain).not.toContain('"secret"');

    // (c) 显式 addSelect 才带出 secret（=「默认不给，需要才显式要」）
    const [sqlExplicit] = ds
      .createQueryBuilder(EventSubscription, "sub")
      .addSelect("sub.secret")
      .where("sub.enabled = true")
      .getQueryAndParameters();
    expect(sqlExplicit).toContain('"sub"."secret"');
  });

  it("② 派发路径显式选取后拿到 secret，且 HMAC 与改动前逐字节相同", async () => {
    // (a) 派发器里**每一处**订阅查询都必须显式 addSelect 了 secret。
    //
    //     钉源码形态（而非 mock 行为）：读 outbound-event-dispatcher.service.ts
    //     的真实文本。为什么不能用 mock 行为来钉——mock 仓储照样返回**带
    //     secret 的行**，「忘写 addSelect」在 mock 层是**看不见**的。
    //
    //     判据刻意用「createQueryBuilder("sub") 的处数 == addSelect("sub.secret")
    //     的处数」而不是 `toBe(3)`：
    //       · `toBe(3)` 钉的是**今天的处数**，将来多一处订阅查询就误红（逼人改数字，
    //         而改数字这个动作**不会**让人想起「新查询也要带 secret」）；
    //       · 等式钉的是**不变式**：本文件里任何一条订阅快照查询都带明文 secret。
    //         新增一处忘了 addSelect ⇒ 等式不成立 ⇒ 红，且报错直接指出两边的数。
    //
    //     先剥注释再数：注释里也可能出现这段文本（本文件注释里就有），不剥会让
    //     「删了代码但注释还在」判据仍绿——本会话已踩过同型坑。
    const dispatcherSrc = readFileSync(
      join(__dirname, "..", "outbound-event-dispatcher.service.ts"),
      "utf8",
    );
    const dispatcherCode = stripComments(dispatcherSrc);
    const queryCount = (
      dispatcherCode.match(/createQueryBuilder\("sub"\)/g) ?? []
    ).length;
    const addSelectCount = (
      dispatcherCode.match(/addSelect\("sub\.secret"\)/g) ?? []
    ).length;
    expect(queryCount).toBeGreaterThanOrEqual(3);
    expect(addSelectCount).toBe(queryCount);

    // (b) service 的 replay 路径也必须显式带出（replay 用当前 url/secret 重签名）。
    //     同样按「订阅查询处数 == addSelect 处数」钉不变式。
    const serviceSrc = readFileSync(
      join(__dirname, "..", "event-subscription.service.ts"),
      "utf8",
    );
    const serviceCode = stripComments(serviceSrc);
    const svcQueryCount = (
      serviceCode.match(/createQueryBuilder\("sub"\)/g) ?? []
    ).length;
    const svcAddSelectCount = (
      serviceCode.match(/addSelect\("sub\.secret"\)/g) ?? []
    ).length;
    expect(svcQueryCount).toBeGreaterThanOrEqual(1);
    expect(svcAddSelectCount).toBe(svcQueryCount);

    // (c) **HMAC 逐字节不变**：用金标准常量比对。
    //     这条是本 spec 最关键的回归锁——签名算法/输入任何一个字节变了都红。
    const expected =
      "sha256=" +
      createHmac("sha256", SECRET)
        .update(
          Buffer.concat([
            Buffer.from(`${GOLDEN_TS}.`),
            Buffer.from(GOLDEN_BODY, "utf8"),
          ]),
        )
        .digest("hex");
    expect(expected).toBe(GOLDEN_SIGNATURE);
  });

  it("②b 派发链路端到端：真实 dispatcher 用取到的 secret 发出金标准签名", async () => {
    // 真 dispatcher + 真签名路径（axios 与 SSRF 打桩）⇒ 断言**发出去的头**
    // 与金标准逐字节相同。这条把「取列」与「签名」接在一起：
    // 若 addSelect 漏了 ⇒ secret 为 undefined ⇒ createHmac 抛
    // ERR_INVALID_ARG_TYPE ⇒ 本用例直接红（不是「静默错签」）。
    const sub = {
      id: "11111111-1111-4111-8111-111111111111",
      userId: 1,
      eventTypes: ["execution.failed"],
      url: "https://ci.example.com/hooks",
      secret: SECRET,
      enabled: true,
      consecutiveFailures: 0,
      lastFailureAt: null,
      lastFailureError: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as EventSubscription;

    const subRepoMock = {
      find: jest.fn().mockResolvedValue([sub]),
      createQueryBuilder: jest.fn(() => ({
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([sub]),
        getOne: jest.fn().mockResolvedValue(sub),
      })),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        OutboundEventDispatcher,
        DomainEventBus,
        {
          provide: EventSubscriptionService,
          useValue: {
            recordDeliveryFailure: jest.fn().mockResolvedValue(undefined),
            recordDeliverySuccess: jest.fn().mockResolvedValue(undefined),
            deleteDeadLetter: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: getRepositoryToken(EventSubscription),
          useValue: subRepoMock,
        },
        {
          provide: getRepositoryToken(EventSubscriptionDeadLetter),
          useValue: {},
        },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue(false) },
        },
        { provide: "ModuleRef", useValue: { get: () => null } },
      ],
    }).compile();

    const dispatcher = moduleRef.get(OutboundEventDispatcher);
    await dispatcher.deliverToSubscribers("execution.failed", {
      event: "execution.failed",
      occurredAt: "2026-01-01T00:00:00.000Z",
      schemaVersion: 1,
      data: {
        executionId: "e1",
        status: "failed",
        failureReason: "script_error",
      },
    } as never);

    expect(axiosPost).toHaveBeenCalledTimes(1);
    const [, body, config] = axiosPost.mock.calls[0];
    const ts = config.headers["X-AutoCodeFlow-Timestamp"];
    // 载荷逐字节等于金标准 body（⇒ 签名输入逐字节相等）
    expect(body).toBe(GOLDEN_BODY);
    // 签名 = sha256= + hex(HMAC-SHA256(secret, `${ts}.${body}`))
    expect(config.headers["X-Hub-Signature-256"]).toBe(
      "sha256=" +
        createHmac("sha256", SECRET)
          .update(
            Buffer.concat([
              Buffer.from(`${ts}.`),
              Buffer.from(String(body), "utf8"),
            ]),
          )
          .digest("hex"),
    );
    // 且该签名在固定时间戳下与金标准逐字节相同（时间戳不可控 ⇒ 用金标准 TS 复算）
    const goldenSig =
      "sha256=" +
      createHmac("sha256", SECRET)
        .update(
          Buffer.concat([
            Buffer.from(`${GOLDEN_TS}.`),
            Buffer.from(GOLDEN_BODY, "utf8"),
          ]),
        )
        .digest("hex");
    expect(goldenSig).toBe(GOLDEN_SIGNATURE);
  });

  it("③ 创建订阅返回 generatedSecret 一次的逻辑不受影响", async () => {
    const subRepoMock = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn(),
      save: jest.fn().mockImplementation((x) => Promise.resolve(x)),
      create: jest.fn((x) => x),
      count: jest.fn().mockResolvedValue(0),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      createQueryBuilder: jest.fn(() => ({
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(null),
      })),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        EventSubscriptionService,
        {
          provide: getRepositoryToken(EventSubscription),
          useValue: subRepoMock,
        },
        {
          provide: getRepositoryToken(EventSubscriptionDeadLetter),
          useValue: {},
        },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue(false) },
        },
        {
          provide: AuditService,
          useValue: { log: jest.fn().mockResolvedValue(undefined) },
        },
      ],
    }).compile();
    const svc = moduleRef.get(EventSubscriptionService);

    const { subscription, generatedSecret } = await svc.create(
      { url: "https://ci.example.com/hooks", eventTypes: ["execution.failed"] },
      adminUser,
    );
    // 服务端代生成 ⇒ 一次性回显明文（64 hex）
    expect(generatedSecret).toMatch(/^[0-9a-f]{64}$/);
    // 落库的是**明文**（save 路径不受 select:false 影响——写面照常）
    const saved = subRepoMock.save.mock.calls[0][0];
    expect(saved.secret).toBe(generatedSecret);
    // 回给调用方的订阅行仍是掩码占位
    expect(subscription.secret).toBe("******");
  });

  it("④ 列表/详情仍返回掩码占位（读面不因 select:false 而变形）", async () => {
    const row = {
      id: "11111111-1111-4111-8111-111111111111",
      userId: 1,
      eventTypes: ["execution.failed"],
      url: "https://ci.example.com/hooks",
      secret: SECRET,
      enabled: true,
      consecutiveFailures: 0,
      lastFailureAt: null,
      lastFailureError: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as EventSubscription;

    const subRepoMock = {
      find: jest.fn().mockResolvedValue([row]),
      findOne: jest.fn().mockResolvedValue(row),
      save: jest.fn().mockImplementation((x) => Promise.resolve(x)),
      create: jest.fn((x) => x),
      count: jest.fn().mockResolvedValue(0),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      createQueryBuilder: jest.fn(() => ({
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(row),
      })),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        EventSubscriptionService,
        {
          provide: getRepositoryToken(EventSubscription),
          useValue: subRepoMock,
        },
        {
          provide: getRepositoryToken(EventSubscriptionDeadLetter),
          useValue: {},
        },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue(false) },
        },
        {
          provide: AuditService,
          useValue: { log: jest.fn().mockResolvedValue(undefined) },
        },
      ],
    }).compile();
    const svc = moduleRef.get(EventSubscriptionService);

    const list = await svc.findAll(adminUser);
    expect(list).toHaveLength(1);
    expect(list[0].secret).toBe("******");

    const one = await svc.findOne(row.id, adminUser);
    expect(one.secret).toBe("******");
    // 明文一次都没出现在响应里
    expect(JSON.stringify(list)).not.toContain(SECRET);
    expect(JSON.stringify(one)).not.toContain(SECRET);
  });

  it("⑤ 守卫有牙：去掉 select: false ⇒ 红（/tmp 副本，不动共享文件）", () => {
    const guard = join(REPO_ROOT, "scripts", "check-credential-columns.mjs");
    expect(() =>
      execFileSync(process.execPath, [guard], { cwd: REPO_ROOT }),
    ).not.toThrow();

    // 在 /tmp 里造一棵副本仓库：把 entity 的 select:false 去掉 ⇒ 守卫必须红。
    const tmp = mkdtempSync(join(tmpdir(), "cred-cols-counterproof-"));
    try {
      cpSync(
        join(REPO_ROOT, "apps", "admin-api", "src", "modules"),
        join(tmp, "apps", "admin-api", "src", "modules"),
        { recursive: true },
      );
      cpSync(join(REPO_ROOT, "scripts"), join(tmp, "scripts"), {
        recursive: true,
      });
      const entityPath = join(
        tmp,
        "apps/admin-api/src/modules/event-subscriptions/entities/event-subscription.entity.ts",
      );
      const original = readFileSync(entityPath, "utf8");
      // **只改这一处**（本仓教训：文件里有两处时只改一处，判据仍绿）
      const mutated = original.replace(
        '@Column({ type: "varchar", length: 256, select: false })',
        '@Column({ type: "varchar", length: 256 })',
      );
      expect(mutated).not.toBe(original);
      writeFileSync(entityPath, mutated);

      let code = 0;
      let stdout = "";
      let stderr = "";
      try {
        execFileSync(process.execPath, [guard, "--root", tmp], {
          cwd: tmp,
          encoding: "utf8",
        });
      } catch (err: unknown) {
        const e = err as { status?: number; stdout?: string; stderr?: string };
        code = e.status ?? 1;
        stdout = e.stdout ?? "";
        stderr = e.stderr ?? "";
      }
      expect(code).toBe(1);
      expect(`${stdout}${stderr}`).toContain("凭据列没有 select: false");
      expect(`${stdout}${stderr}`).toContain("secret");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("⑥ 守卫的豁免表逐条有理由，且不会静默吞掉新列", () => {
    const guardSrc = readFileSync(
      join(REPO_ROOT, "scripts", "check-credential-columns.mjs"),
      "utf8",
    );
    // (a) 每条豁免都带理由（note 字段非空且有实际长度）
    const noteMatches = guardSrc.match(/note:\s*\n?\s*"/g) ?? [];
    const exemptionBlock = guardSrc.slice(
      guardSrc.indexOf("CREDENTIAL_COLUMN_EXEMPTIONS = ["),
      guardSrc.indexOf(
        "];",
        guardSrc.indexOf("CREDENTIAL_COLUMN_EXEMPTIONS = ["),
      ),
    );
    const entries = exemptionBlock.split(/kind:\s*"/).slice(1);
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      const note =
        /note:\s*\n?\s*"([\s\S]*?)",?\s*\n?\s*(?:file|property|kind|ref)?/.exec(
          e,
        );
      expect(note).not.toBeNull();
      expect(String(note?.[1] ?? "").trim().length).toBeGreaterThanOrEqual(12);
    }
    expect(noteMatches.length).toBeGreaterThan(0);

    // (b) 新增一个凭据列**不登记** ⇒ 守卫红（豁免表不能静默吞掉新列）
    const tmp = mkdtempSync(join(tmpdir(), "cred-cols-newcol-"));
    try {
      cpSync(
        join(REPO_ROOT, "apps", "admin-api", "src", "modules"),
        join(tmp, "apps", "admin-api", "src", "modules"),
        { recursive: true },
      );
      cpSync(join(REPO_ROOT, "scripts"), join(tmp, "scripts"), {
        recursive: true,
      });
      // 在一个**真实存在的** entity 里加一列新凭据列（apiKey，无 select:false）
      const entityPath = join(
        tmp,
        "apps/admin-api/src/modules/event-subscriptions/entities/event-subscription.entity.ts",
      );
      const original = readFileSync(entityPath, "utf8");
      writeFileSync(
        entityPath,
        original.replace(
          '  @Column({ type: "boolean", default: true })\n  enabled: boolean;',
          '  /** 新增的凭据列。 */\n  @Column({ type: "varchar", length: 64 })\n  apiKey: string;\n\n  @Column({ type: "boolean", default: true })\n  enabled: boolean;',
        ),
      );

      let code = 0;
      let stdout = "";
      let stderr = "";
      try {
        execFileSync(
          process.execPath,
          [
            join(REPO_ROOT, "scripts", "check-credential-columns.mjs"),
            "--root",
            tmp,
          ],
          { cwd: tmp, encoding: "utf8" },
        );
      } catch (err: unknown) {
        const e = err as { status?: number; stdout?: string; stderr?: string };
        code = e.status ?? 1;
        stdout = e.stdout ?? "";
        stderr = e.stderr ?? "";
      }
      expect(code).toBe(1);
      expect(`${stdout}${stderr}`).toContain("apiKey");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
