import { Test } from "@nestjs/testing";
import { ConflictException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { getRepositoryToken } from "@nestjs/typeorm";
import { ApiKeysService } from "../api-keys.service";
import { AuditService } from "../../audit/audit.service";
import { ApiKey } from "../entities/api-key.entity";
import { hashApiKey } from "../api-key.util";
import { UsersService } from "../../users/users.service";

/**
 * AUTH-03: CRUD 服务专项——明文仅创建响应回显一次、keyHash 持久化、
 * 属主校验、软删吊销、lastUsedAt 节流、审计 fail-open。
 */

const repoMock = () => ({
  create: jest.fn((x) => ({ id: 1, revokedAt: null, lastUsedAt: null, ...x })),
  save: jest.fn(async (x) => ({ ...x, id: x.id ?? 1 })),
  find: jest.fn(async () => []),
  findOne: jest.fn(),
  update: jest.fn(async () => undefined),
  // A-9: 配额闸按属主统计活跃 key（默认 0 = 未达上限）
  count: jest.fn(async () => 0),
});

const auditMock = () => ({ log: jest.fn(async () => undefined) });

// R32-A4: 认证面复核属主账号状态（存在 + 未禁用）——默认给出活跃属主，
// 「禁用/删除」用例单独覆写。
const usersMock = () => ({
  findByIdOrNull: jest.fn(async () => ({ id: 42, isActive: true })),
});

describe("AUTH-03 ApiKeysService", () => {
  let svc: ApiKeysService;
  let repo: ReturnType<typeof repoMock>;
  let audit: ReturnType<typeof auditMock>;
  let users: ReturnType<typeof usersMock>;

  beforeEach(async () => {
    repo = repoMock();
    audit = auditMock();
    users = usersMock();
    const moduleRef = await Test.createTestingModule({
      providers: [
        ApiKeysService,
        { provide: getRepositoryToken(ApiKey), useValue: repo },
        { provide: AuditService, useValue: audit },
        { provide: UsersService, useValue: users },
        // A-9: ConfigService 缺席（@Optional）→ maxActiveKeysPerUser 回落常量
      ],
    }).compile();
    svc = moduleRef.get(ApiKeysService);
  });

  describe("create", () => {
    it("生成 acf_ 前缀明文（64 hex）、keyPrefix 前 8 位、sha256 落库，明文仅回显一次", async () => {
      const { apiKey, plaintext } = await svc.create({
        userId: 42,
        name: "ci",
        scope: "trigger",
      });
      expect(plaintext).toMatch(/^acf_[0-9a-f]{64}$/);
      expect(apiKey.keyPrefix).toBe(plaintext.slice(0, 8));
      const created = repo.create.mock.calls[0][0];
      expect(created.keyHash).toBe(hashApiKey(plaintext));
      expect(created.scope).toBe("trigger");
      expect((apiKey as any).keyHash).toBeUndefined(); // 视图不含 hash
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: "apikey.create", userId: 42 }),
      );
    });

    it("expiresInDays 换算 expiresAt；不传为 null（永不过期）", async () => {
      const before = Date.now();
      await svc.create({
        userId: 1,
        name: "a",
        scope: "readonly",
        expiresInDays: 30,
      });
      const row = repo.create.mock.calls[0][0];
      expect(row.expiresAt.getTime()).toBeGreaterThanOrEqual(
        before + 30 * 86_400_000 - 1000,
      );
      await svc.create({ userId: 1, name: "b", scope: "manage" });
      expect(repo.create.mock.calls[1][0].expiresAt).toBeNull();
    });

    it("创建审计写点失败不阻断主流程（fail-open）", async () => {
      audit.log.mockRejectedValueOnce(new Error("db down"));
      const { plaintext } = await svc.create({
        userId: 1,
        name: "x",
        scope: "readonly",
      });
      expect(plaintext).toMatch(/^acf_/);
    });
  });

  // ─── A-9（R3-A 审计）: 每用户活跃 key 配额 ───────────────────────────────
  describe("create — per-user active-key quota (A-9)", () => {
    it("达到默认上限（20）→ 409 ConflictException，不落库不签发", async () => {
      repo.count.mockResolvedValue(20);
      await expect(
        svc.create({ userId: 42, name: "one-too-many", scope: "readonly" }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(repo.save).not.toHaveBeenCalled();
      expect(repo.create).not.toHaveBeenCalled();
      expect(audit.log).not.toHaveBeenCalled();
    });

    it("未达上限 → 正常创建；计数口径为「属主 + 未吊销」", async () => {
      repo.count.mockResolvedValue(19);
      await expect(
        svc.create({ userId: 42, name: "ok", scope: "readonly" }),
      ).resolves.toHaveProperty("plaintext");
      const countArg = (repo.count as jest.Mock).mock.calls[0][0] as {
        where: Record<string, unknown>;
      };
      expect(countArg.where).toMatchObject({ userId: 42 });
      // revokedAt: IsNull() —— 已吊销 key 不占配额
      expect(
        (countArg.where.revokedAt as { useParameter?: boolean }).useParameter,
      ).toBe(false);
    });

    it("上限可经配置 apiKeys.maxActivePerUser 覆盖", async () => {
      const configMock = { get: jest.fn().mockReturnValue(2) };
      const moduleRef = await Test.createTestingModule({
        providers: [
          ApiKeysService,
          { provide: getRepositoryToken(ApiKey), useValue: repo },
          { provide: AuditService, useValue: audit },
          { provide: UsersService, useValue: users },
          { provide: ConfigService, useValue: configMock },
        ],
      }).compile();
      const configured = moduleRef.get(ApiKeysService);

      repo.count.mockResolvedValue(2);
      await expect(
        configured.create({ userId: 7, name: "third", scope: "readonly" }),
      ).rejects.toBeInstanceOf(ConflictException);
      repo.count.mockResolvedValue(1);
      await expect(
        configured.create({ userId: 7, name: "second", scope: "readonly" }),
      ).resolves.toHaveProperty("plaintext");
    });
  });

  describe("listForUser", () => {
    it("只返回本人 key 且视图脱敏（无 keyHash）", async () => {
      repo.find.mockResolvedValueOnce([
        {
          id: 1,
          name: "k",
          keyPrefix: "acf_aa",
          scope: "readonly",
          expiresAt: null,
          revokedAt: null,
          lastUsedAt: null,
          createdAt: new Date(),
          keyHash: "h",
        },
      ]);
      const rows = await svc.listForUser(42);
      expect(repo.find).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: 42 } }),
      );
      expect(rows).toHaveLength(1);
      expect((rows[0] as any).keyHash).toBeUndefined();
    });
  });

  describe("revoke（软删）", () => {
    it("属主吊销：revokedAt 置位 + 审计", async () => {
      repo.findOne.mockResolvedValueOnce({
        id: 9,
        userId: 42,
        name: "k",
        keyPrefix: "acf_aa",
        scope: "readonly",
        revokedAt: null,
      });
      const row = await svc.revoke(9, 42, "alice");
      expect(row.revokedAt).toBeInstanceOf(Date);
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: "apikey.revoke", resourceId: "9" }),
      );
    });

    it("非属主 / 不存在 → null（控制器 404）", async () => {
      repo.findOne.mockResolvedValueOnce({
        id: 9,
        userId: 99,
        revokedAt: null,
      });
      expect(await svc.revoke(9, 42)).toBeNull();
      repo.findOne.mockResolvedValueOnce(null);
      expect(await svc.revoke(404, 42)).toBeNull();
    });

    it("幂等：已吊销 key 再 revoke 不重复审计", async () => {
      repo.findOne.mockResolvedValueOnce({
        id: 9,
        userId: 42,
        revokedAt: new Date(),
      });
      await svc.revoke(9, 42);
      expect(repo.save).not.toHaveBeenCalled();
      expect(audit.log).not.toHaveBeenCalled();
    });

    // R32-C1（类别 2「整行 save 实体 vs 列级 update」）：
    // 本文件两个写面此前口径相反——touchLastUsed 列级只写 lastUsedAt（刻意，
    // 避免写放大），revoke 却整行 save（把 findOne 读到的快照整体回写）。
    // 整行回写的受害者是**并发写入的列**：吊销发生在一次 authenticate 的
    // lastUsedAt 刷新之后时，快照里的 lastUsedAt（null/旧时间）被写回去 →
    // 下一请求又判「首次使用」→ 重复落 apikey.used firstUse 审计行。
    // 反证方式：忠实模拟 TypeORM 的两种写（save=整行覆盖 / update=只写给出的
    // 列），并让 revoke 读到**并发写之前**的快照。改回 save(row) 本用例即转红。
    it("列级写：只更新 revokedAt，不回滚并发写入的 lastUsedAt", async () => {
      const db = new Map<number, Record<string, any>>();
      db.set(9, {
        id: 9,
        userId: 42,
        name: "k",
        keyPrefix: "acf_aa",
        scope: "readonly",
        keyHash: "h",
        expiresAt: null,
        revokedAt: null,
        lastUsedAt: null,
        createdAt: new Date(0),
      });
      // revoke 里的 findOne 读到的是「并发写之前」的那一行（读快照）。
      repo.findOne.mockResolvedValueOnce({ ...db.get(9) });
      repo.save.mockImplementation(async (e: any) => {
        db.set(Number(e.id), { ...e });
        return e;
      });
      repo.update.mockImplementation((async (criteria: any, patch: any) => {
        const id = Number(criteria?.id);
        db.set(id, { ...db.get(id), ...patch });
        return { affected: 1 };
      }) as any);

      // 并发：认证面刚把 lastUsedAt 写进去（touchLastUsed 走列级 update）。
      const usedAt = new Date(Date.UTC(2026, 0, 2, 3, 4, 5));
      // （repoMock 的 update 是零参签名，这里按真实 TypeORM 形状调用。）
      await (repo.update as any)({ id: 9 }, { lastUsedAt: usedAt });

      const view = await svc.revoke(9, 42);

      // 语义不变：吊销生效、返回视图是吊销后的值。
      expect(view.revokedAt).toBeInstanceOf(Date);
      expect(db.get(9)!.revokedAt).toBeInstanceOf(Date);
      // 反证点（先断言**数据**，让红态直接指向回滚本身而不是调用形状）：
      // 整行回写会把它打回快照里的 null。
      expect(db.get(9)!.lastUsedAt).toEqual(usedAt);
      // 修复点：写面只碰 revokedAt 一列（不是整行）。
      expect(repo.update).toHaveBeenLastCalledWith(
        { id: 9 },
        { revokedAt: expect.any(Date) },
      );
    });
  });

  describe("authenticate（guard 消费）", () => {
    it("sha256 命中 → 返回行并节流更新 lastUsedAt（首次写 + 首用审计）", async () => {
      const row = {
        id: 5,
        userId: 42,
        keyHash: hashApiKey("acf_k"),
        scope: "readonly",
        lastUsedAt: null,
      };
      repo.findOne.mockResolvedValueOnce(row);
      const { apiKey, failure } = await svc.authenticate("acf_k");
      expect(failure).toBeUndefined();
      expect(apiKey.id).toBe(5);
      expect(repo.update).toHaveBeenCalledWith(
        5,
        expect.objectContaining({ lastUsedAt: expect.any(Date) }),
      );
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "apikey.used",
          detail: expect.objectContaining({ firstUse: true }),
        }),
      );
    });

    it("60 秒内重复使用不重复写库（防写放大）", async () => {
      const row = {
        id: 5,
        userId: 42,
        keyHash: hashApiKey("acf_k"),
        lastUsedAt: new Date(Date.now() - 30_000),
      };
      repo.findOne.mockResolvedValueOnce(row);
      await svc.authenticate("acf_k");
      expect(repo.update).not.toHaveBeenCalled();
    });

    it("未命中 → failure=unknown；吊销行 → failure=revoked；过期行 → failure=expired", async () => {
      repo.findOne.mockResolvedValueOnce(null);
      expect((await svc.authenticate("acf_x")).failure).toBe("unknown");
      repo.findOne.mockResolvedValueOnce({ id: 1, revokedAt: new Date() });
      expect((await svc.authenticate("acf_x")).failure).toBe("revoked");
      repo.findOne.mockResolvedValueOnce({
        id: 1,
        revokedAt: null,
        expiresAt: new Date(Date.now() - 1000),
      });
      expect((await svc.authenticate("acf_x")).failure).toBe("expired");
    });

    // R32-A4: 活性判定的第三条腿——属主账号状态。此前只看 key 自身两列，
    // 禁用/删除用户对已签发的 API Key 完全无效（长效旁路）。
    describe("属主账号状态（R32-A4）", () => {
      const activeRow = () => ({
        id: 5,
        userId: 42,
        name: "ci-key",
        keyPrefix: "acf_aaaa",
        keyHash: hashApiKey("acf_k"),
        scope: "readonly",
        revokedAt: null,
        expiresAt: null,
        lastUsedAt: null,
      });

      it("属主被禁用 → 不认证（failure=owner_inactive），且不刷新 lastUsedAt", async () => {
        repo.findOne.mockResolvedValueOnce(activeRow());
        users.findByIdOrNull.mockResolvedValueOnce({ id: 42, isActive: false });

        const { apiKey, failure, row } = await svc.authenticate("acf_k");

        expect(apiKey).toBeNull();
        expect(failure).toBe("owner_inactive");
        // 命中的行要带出来（供审计定位到具体 key）
        expect(row?.id).toBe(5);
        expect(repo.update).not.toHaveBeenCalled();
      });

      it("属主已被删除（findByIdOrNull → null）→ 同样拒绝", async () => {
        repo.findOne.mockResolvedValueOnce(activeRow());
        users.findByIdOrNull.mockResolvedValueOnce(null);

        expect((await svc.authenticate("acf_k")).failure).toBe(
          "owner_inactive",
        );
      });

      it("每次请求都现读属主（无缓存）：先放行，禁用后同一 key 立刻失效", async () => {
        repo.findOne.mockResolvedValue(activeRow());
        users.findByIdOrNull
          .mockResolvedValueOnce({ id: 42, isActive: true })
          .mockResolvedValueOnce({ id: 42, isActive: false });

        expect((await svc.authenticate("acf_k")).apiKey?.id).toBe(5);
        expect((await svc.authenticate("acf_k")).apiKey).toBeNull();
        expect(users.findByIdOrNull).toHaveBeenCalledTimes(2);
      });

      it("属主活跃 → 正常认证（回归）", async () => {
        repo.findOne.mockResolvedValueOnce(activeRow());
        const { apiKey, failure } = await svc.authenticate("acf_k");
        expect(failure).toBeUndefined();
        expect(apiKey?.id).toBe(5);
      });
    });

    // R32-A4（审计轴 4「作用域与过期是否在每次请求生效（含缓存）、撤销是否
    // 即时」）：认证面**没有**任何缓存层——每次 authenticate 现查库。本例钉住
    // 它与「吊销即时生效」之间的因果关系：同一个 service 实例的两次调用之间
    // 把行改成 revokedAt 已置位，第二次必须立刻失败（有缓存即会放过）。
    it("无缓存：两次认证之间行被吊销 → 第二次立即失败（吊销即时生效）", async () => {
      const row = {
        id: 5,
        userId: 42,
        keyHash: hashApiKey("acf_k"),
        scope: "readonly",
        revokedAt: null,
        expiresAt: null,
        lastUsedAt: new Date(),
      };
      repo.findOne
        .mockResolvedValueOnce(row)
        .mockResolvedValueOnce({ ...row, revokedAt: new Date() });

      expect((await svc.authenticate("acf_k")).apiKey?.id).toBe(5);
      expect((await svc.authenticate("acf_k")).failure).toBe("revoked");
      expect(repo.findOne).toHaveBeenCalledTimes(2);
    });

    // R32-A4（审计轴 4「key 前缀碰撞与查找是否唯一」）：查找键只有 sha256
    // 全哈希（唯一索引），keyPrefix（acf_ + 4 hex ≈ 16 bit）纯粹是展示/审计
    // 字段。两把前缀相同的 key 必须各自命中自己的行——若有人把查找改成按
    // 前缀（"反正前缀也唯一"），本例如红。
    it("前缀碰撞不影响查找：命中只由全哈希决定", async () => {
      const keyA = {
        id: 1,
        userId: 42,
        keyPrefix: "acf_aaaa",
        keyHash: hashApiKey("acf_" + "a".repeat(64)),
        scope: "readonly",
        revokedAt: null,
        expiresAt: null,
        lastUsedAt: new Date(),
      };
      const keyB = {
        ...keyA,
        id: 2,
        keyHash: hashApiKey("acf_" + "b".repeat(64)),
      };
      repo.findOne.mockResolvedValueOnce(keyA).mockResolvedValueOnce(keyB);

      expect((await svc.authenticate("acf_" + "a".repeat(64))).apiKey?.id).toBe(
        1,
      );
      expect((await svc.authenticate("acf_" + "b".repeat(64))).apiKey?.id).toBe(
        2,
      );
      // 两次查询的 where 都是完整哈希，从未用 keyPrefix 定位
      const wheres = repo.findOne.mock.calls.map(
        (c: any[]) => c[0].where,
      ) as Array<Record<string, unknown>>;
      expect(wheres[0].keyHash).toBe(hashApiKey("acf_" + "a".repeat(64)));
      expect(wheres[1].keyHash).toBe(hashApiKey("acf_" + "b".repeat(64)));
      expect(wheres[0].keyPrefix).toBeUndefined();
    });

    it("lastUsedAt 写库失败不影响认证结果", async () => {
      repo.findOne.mockResolvedValueOnce({
        id: 5,
        userId: 42,
        keyHash: hashApiKey("acf_k"),
        lastUsedAt: null,
      });
      repo.update.mockRejectedValueOnce(new Error("write fail"));
      const { apiKey } = await svc.authenticate("acf_k");
      expect(apiKey.id).toBe(5);
    });
  });

  describe("auditAuthFailure", () => {
    it("未命中（unknown）→ 审计退化为前缀（库里没有行，只能记前缀）", async () => {
      await svc.auditAuthFailure("acf_dead", "unknown", "1.2.3.4");
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "apikey.auth_failure",
          result: "failure",
          resourceId: "acf_dead",
          detail: expect.objectContaining({ keyPrefix: "acf_dead" }),
        }),
      );
    });

    // R32-A4: 命中行时必须指向**具体 key**——前缀只有 16 bit，既不唯一也
    // 反查不到属主，安全排查（"吊销后还在用的那把是谁的"）就断了。
    it("命中行（revoked/expired/owner_inactive）→ 审计记录行 id + 属主", async () => {
      const hit = {
        id: 9,
        userId: 42,
        name: "ci-key",
        keyPrefix: "acf_dead",
        scope: "readonly",
      } as ApiKey;
      await svc.auditAuthFailure("acf_dead", "revoked", "1.2.3.4", hit);
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "apikey.auth_failure",
          result: "failure",
          resourceId: "9",
          userId: 42,
          detail: expect.objectContaining({
            keyPrefix: "acf_dead",
            failure: "revoked",
            apiKeyId: 9,
            name: "ci-key",
            ownerId: 42,
          }),
        }),
      );
    });
  });
});
