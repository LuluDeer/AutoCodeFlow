import { Test } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { NotFoundException } from "@nestjs/common";
import { ApiKeysService } from "../api-keys.service";
import { AuditService } from "../../audit/audit.service";
import { ApiKey } from "../entities/api-key.entity";
import { hashApiKey } from "../api-key.util";

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
});

const auditMock = () => ({ log: jest.fn(async () => undefined) });

describe("AUTH-03 ApiKeysService", () => {
  let svc: ApiKeysService;
  let repo: ReturnType<typeof repoMock>;
  let audit: ReturnType<typeof auditMock>;

  beforeEach(async () => {
    repo = repoMock();
    audit = auditMock();
    const moduleRef = await Test.createTestingModule({
      providers: [
        ApiKeysService,
        { provide: getRepositoryToken(ApiKey), useValue: repo },
        { provide: AuditService, useValue: audit },
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
      await svc.create({ userId: 1, name: "a", scope: "readonly", expiresInDays: 30 });
      const row = repo.create.mock.calls[0][0];
      expect(row.expiresAt.getTime()).toBeGreaterThanOrEqual(
        before + 30 * 86_400_000 - 1000,
      );
      await svc.create({ userId: 1, name: "b", scope: "manage" });
      expect(repo.create.mock.calls[1][0].expiresAt).toBeNull();
    });

    it("创建审计写点失败不阻断主流程（fail-open）", async () => {
      audit.log.mockRejectedValueOnce(new Error("db down"));
      const { plaintext } = await svc.create({ userId: 1, name: "x", scope: "readonly" });
      expect(plaintext).toMatch(/^acf_/);
    });
  });

  describe("listForUser", () => {
    it("只返回本人 key 且视图脱敏（无 keyHash）", async () => {
      repo.find.mockResolvedValueOnce([
        { id: 1, name: "k", keyPrefix: "acf_aa", scope: "readonly", expiresAt: null, revokedAt: null, lastUsedAt: null, createdAt: new Date(), keyHash: "h" },
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
      repo.findOne.mockResolvedValueOnce({ id: 9, userId: 42, name: "k", keyPrefix: "acf_aa", scope: "readonly", revokedAt: null });
      const row = await svc.revoke(9, 42, "alice");
      expect(row.revokedAt).toBeInstanceOf(Date);
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: "apikey.revoke", resourceId: "9" }),
      );
    });

    it("非属主 / 不存在 → null（控制器 404）", async () => {
      repo.findOne.mockResolvedValueOnce({ id: 9, userId: 99, revokedAt: null });
      expect(await svc.revoke(9, 42)).toBeNull();
      repo.findOne.mockResolvedValueOnce(null);
      expect(await svc.revoke(404, 42)).toBeNull();
    });

    it("幂等：已吊销 key 再 revoke 不重复审计", async () => {
      repo.findOne.mockResolvedValueOnce({ id: 9, userId: 42, revokedAt: new Date() });
      await svc.revoke(9, 42);
      expect(repo.save).not.toHaveBeenCalled();
      expect(audit.log).not.toHaveBeenCalled();
    });
  });

  describe("authenticate（guard 消费）", () => {
    it("sha256 命中 → 返回行并节流更新 lastUsedAt（首次写 + 首用审计）", async () => {
      const row = { id: 5, userId: 42, keyHash: hashApiKey("acf_k"), scope: "readonly", lastUsedAt: null };
      repo.findOne.mockResolvedValueOnce(row);
      const { apiKey, failure } = await svc.authenticate("acf_k");
      expect(failure).toBeUndefined();
      expect(apiKey.id).toBe(5);
      expect(repo.update).toHaveBeenCalledWith(5, expect.objectContaining({ lastUsedAt: expect.any(Date) }));
      expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "apikey.used", detail: expect.objectContaining({ firstUse: true }) }));
    });

    it("60 秒内重复使用不重复写库（防写放大）", async () => {
      const row = { id: 5, userId: 42, keyHash: hashApiKey("acf_k"), lastUsedAt: new Date(Date.now() - 30_000) };
      repo.findOne.mockResolvedValueOnce(row);
      await svc.authenticate("acf_k");
      expect(repo.update).not.toHaveBeenCalled();
    });

    it("未命中 → failure=unknown；吊销行 → failure=revoked；过期行 → failure=expired", async () => {
      repo.findOne.mockResolvedValueOnce(null);
      expect((await svc.authenticate("acf_x")).failure).toBe("unknown");
      repo.findOne.mockResolvedValueOnce({ id: 1, revokedAt: new Date() });
      expect((await svc.authenticate("acf_x")).failure).toBe("revoked");
      repo.findOne.mockResolvedValueOnce({ id: 1, revokedAt: null, expiresAt: new Date(Date.now() - 1000) });
      expect((await svc.authenticate("acf_x")).failure).toBe("expired");
    });

    it("lastUsedAt 写库失败不影响认证结果", async () => {
      repo.findOne.mockResolvedValueOnce({ id: 5, userId: 42, keyHash: hashApiKey("acf_k"), lastUsedAt: null });
      repo.update.mockRejectedValueOnce(new Error("write fail"));
      const { apiKey } = await svc.authenticate("acf_k");
      expect(apiKey.id).toBe(5);
    });
  });

  describe("auditAuthFailure", () => {
    it("写 auth_failure 审计（result=failure）", async () => {
      await svc.auditAuthFailure("acf_dead", "revoked", "1.2.3.4");
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: "apikey.auth_failure", result: "failure" }),
      );
    });
  });
});
