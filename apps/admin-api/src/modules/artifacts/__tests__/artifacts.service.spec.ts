import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import {
  BadRequestException,
  ForbiddenException,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { ConfigService } from "@nestjs/config";
import { ArtifactsService } from "../artifacts.service";
import { ArtifactsController } from "../artifacts.controller";
import { isArtifactPathWithin } from "../artifacts.constants";
import { TaskExecution } from "../../task/entities/task-execution.entity";
import { SystemConfigService } from "../../config/config.service";
import { ExecutorService } from "../../executor/executor.service";

// 机器鉴权走的是共享 token 校验工具，这里 mock 掉具体实现，只测编排逻辑。
jest.mock("../../../common/utils/verify-executor-token.util", () => ({
  verifyExecutorToken: jest.fn(),
  getExecutorSharedToken: jest.fn(),
}));
import { verifyExecutorToken } from "../../../common/utils/verify-executor-token.util";

const EXEC_ID = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
// SEC-1：「他人的执行」用独立 execId（各自独立目录，便于断言"没有写入"）。
const OTHER_EXEC_1 = "9b2f6f8c-1b0f-4d0e-9a55-3b1d2c4e5f60";
const OTHER_EXEC_2 = "0c9a51d2-7d67-4a6b-8f13-2a5e9c7b4d31";
const OTHER_EXEC_3 = "5e7c2a94-3f18-4b0d-a6c2-8d1f0e9b7a45";
const sha = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex");

describe("ArtifactsService（FEAT-05）", () => {
  let svc: ArtifactsService;
  let tmpRoot: string;
  let findOne: jest.Mock;
  let validateTokenByAddress: jest.Mock;
  /** SEC-1 迁移开关的读取面（`configService.get("EXECUTOR_ARTIFACT_ALLOW_SHARED_TOKEN")`）。 */
  let configGet: jest.Mock;
  /** logger.warn 的探针（兼容模式必须每次都喊）。 */
  let warnSpy: jest.SpyInstance;
  /**
   * ADR-017 阶段 3：产物上传鉴权改用「同址任一行匹配即通过」
   * （`validateTokenByAddressAnyRow`）。委派给 validateTokenByAddress，
   * 既有打桩与断言语义逐字节保留（改的是走哪个方法，不是判定强度）。
   */
  let validateTokenByAddressAnyRow: jest.Mock;
  const originalLogArtifactDir = process.env.LOG_ARTIFACT_DIR;

  beforeAll(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "acf-artifacts-"));
    process.env.LOG_ARTIFACT_DIR = tmpRoot;

    findOne = jest.fn();
    validateTokenByAddress = jest.fn();
    validateTokenByAddressAnyRow = jest.fn((addr: string, token: string) =>
      validateTokenByAddress(addr, token),
    );
    configGet = jest.fn();
    const moduleRef = await Test.createTestingModule({
      providers: [
        ArtifactsService,
        { provide: getRepositoryToken(TaskExecution), useValue: { findOne } },
        { provide: ConfigService, useValue: { get: configGet } },
        { provide: SystemConfigService, useValue: { findOne: jest.fn() } },
        {
          provide: ExecutorService,
          useValue: { validateTokenByAddress, validateTokenByAddressAnyRow },
        },
      ],
    }).compile();
    svc = moduleRef.get(ArtifactsService);
  });

  afterAll(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    if (originalLogArtifactDir === undefined)
      delete process.env.LOG_ARTIFACT_DIR;
    else process.env.LOG_ARTIFACT_DIR = originalLogArtifactDir;
  });

  beforeEach(() => {
    (verifyExecutorToken as jest.Mock).mockReset();
    findOne.mockReset();
    validateTokenByAddress.mockReset();
    // 默认：开关未设 = false（SEC-1 的默认姿态）。任何用到它的用例显式覆盖。
    configGet.mockReset();
    configGet.mockReturnValue(undefined);
    warnSpy = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => {});
    warnSpy.mockClear();
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  describe("resolveArtifactPath 防路径穿越", () => {
    it("裸安全文件名解析到 <root>/<execId>/<name>", () => {
      const p = svc.resolveArtifactPath(EXEC_ID, "screenshot_01.png");
      expect(p).toBe(path.join(tmpRoot, EXEC_ID, "screenshot_01.png"));
    });
    it("拒绝 ../ 穿越", () => {
      expect(() => svc.resolveArtifactPath(EXEC_ID, "../evil.sh")).toThrow(
        BadRequestException,
      );
    });
    it("拒绝含路径分隔符的名字", () => {
      expect(() => svc.resolveArtifactPath(EXEC_ID, "a/b.png")).toThrow(
        BadRequestException,
      );
      expect(() => svc.resolveArtifactPath(EXEC_ID, "a\\b.png")).toThrow(
        BadRequestException,
      );
    });
    it("拒绝前导点/绝对路径/空名", () => {
      expect(() => svc.resolveArtifactPath(EXEC_ID, ".hidden")).toThrow(
        BadRequestException,
      );
      expect(() => svc.resolveArtifactPath(EXEC_ID, "/etc/passwd")).toThrow(
        BadRequestException,
      );
      expect(() => svc.resolveArtifactPath(EXEC_ID, "")).toThrow(
        BadRequestException,
      );
    });
    it("非 UUID executionId 抛 BadRequest", () => {
      expect(() => svc.resolveArtifactPath("not-a-uuid", "a.png")).toThrow(
        BadRequestException,
      );
    });
  });

  /**
   * R31：原先这里第二层守卫是**死的**——`if (full !== path.join(base, name) || ...)`
   * 的第一个合取项恒为假（两个表达式逐字相同、纯函数），于是注释宣称的「基名 +
   * 拼接双保险」实际只有 startsWith 在起作用。抽成纯函数后可以直接钉住那层
   * 「万一正则被放宽」的最后一道网：`..` / `.` 目前确实被 SAFE_ARTIFACT_NAME_RE
   * 挡在外面，所以它们正是只靠正则时覆盖不到的形态。
   */
  describe("isArtifactPathWithin（纵深防御：正则被放宽时的最后一道网）", () => {
    // 纯函数判定不依赖真实落盘目录（tmpRoot 在用例内才赋值），用独立常量即可。
    const ROOT = path.join(os.tmpdir(), "acf-artifact-path-tests");
    const base = path.join(ROOT, EXEC_ID);

    it("裸文件名落在 base 之下 → true", () => {
      expect(isArtifactPathWithin(base, "screenshot_01.png")).toBe(true);
      expect(isArtifactPathWithin(base, "a.b-c_d.txt")).toBe(true);
    });

    it("父目录上跳（..）→ false（拼接后的父目录不再是 base）", () => {
      expect(isArtifactPathWithin(base, "..")).toBe(false);
      expect(isArtifactPathWithin(base, "../evil.sh")).toBe(false);
    });

    it("当前目录（.）→ false（拼出来的落点就是 base 本身，不是 base 下的文件）", () => {
      expect(isArtifactPathWithin(base, ".")).toBe(false);
    });

    it("含分隔符 / 绝对路径 / 空名 → false", () => {
      expect(isArtifactPathWithin(base, "a/b.png")).toBe(false);
      expect(isArtifactPathWithin(base, "/etc/passwd")).toBe(false);
      expect(isArtifactPathWithin(base, "")).toBe(false);
    });

    it("前缀相近的兄弟目录不会被误判为「在 base 之下」", () => {
      // 反例形态：<root>/<execId>xxx —— 字符串前缀命中但**不是**目录前缀
      const siblingLike = path.join(ROOT, EXEC_ID + "xxx");
      expect(isArtifactPathWithin(siblingLike, "..")).toBe(false);
      expect(isArtifactPathWithin(base, "a.png")).toBe(true);
    });
  });

  describe("saveArtifact / openArtifact 落盘回环", () => {
    it("写入后可读回，字节/大小/sha 一致，并回显清单条目", async () => {
      const buf = Buffer.from("hello-artifact-payload");
      const item = await svc.saveArtifact(EXEC_ID, "report.csv", buf, sha(buf));
      expect(item).toEqual({
        name: "report.csv",
        size: buf.length,
        sha256: sha(buf),
      });

      const { stream, fileSize, contentType, sha256 } = await svc.openArtifact(
        EXEC_ID,
        "report.csv",
      );
      const chunks: Buffer[] = [];
      for await (const c of stream) chunks.push(c as Buffer);
      expect(Buffer.concat(chunks).equals(buf)).toBe(true);
      expect(fileSize).toBe(buf.length);
      expect(contentType).toBe("text/csv");
      // E-P2-P6：openArtifact 返回实际字节 sha256（下载路由据此写 X-SHA256 头）。
      expect(sha256).toBe(sha(buf));
    });
    it("sha256 不符抛 BadRequest 且不留脏文件", async () => {
      const buf = Buffer.from("genuine");
      await expect(
        svc.saveArtifact(
          EXEC_ID,
          "tampered.bin",
          buf,
          sha(Buffer.from("other")),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(fs.existsSync(path.join(tmpRoot, EXEC_ID, "tampered.bin"))).toBe(
        false,
      );
    });
    it("openArtifact 缺文件抛 NotFound", async () => {
      await expect(
        svc.openArtifact(EXEC_ID, "missing.txt"),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe("verifyUploadAuth（复用回调鉴权形态）", () => {
    it("执行行不存在 → NotFound", async () => {
      findOne.mockResolvedValue(null);
      await expect(
        svc.verifyUploadAuth(EXEC_ID, "Bearer x"),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
    /**
     * SEC-1（破坏性）：**共享令牌默认不再放行**产物上传。
     *
     * 旧行为（本用例在改动前断言的正是它）：共享令牌一命中就 `return exec`，
     * 而 exec 只按路径参数查出 ⇒ 持共享令牌者可写任意 execId 的产物目录。
     */
    it("共享 token 默认拒绝 → 403 ARTIFACT_UPLOAD_REQUIRES_EXECUTOR_TOKEN（不再放行）", async () => {
      findOne.mockResolvedValue({
        id: EXEC_ID,
        executorAddress: "1.2.3.4:9000",
      });
      (verifyExecutorToken as jest.Mock).mockResolvedValue(undefined);
      const err = await svc
        .verifyUploadAuth(EXEC_ID, "Bearer shared")
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ForbiddenException);
      expect((err as { errorCode: string }).errorCode).toBe(
        "ARTIFACT_UPLOAD_REQUIRES_EXECUTOR_TOKEN",
      );
      expect((err as { getStatus(): number }).getStatus()).toBe(403);
      expect((err as { params: Record<string, unknown> }).params).toEqual(
        expect.objectContaining({ execId: EXEC_ID, reason: "shared_token" }),
      );
      expect(
        String((err as { params: Record<string, unknown> }).params.nextStep),
      ).toContain("EXECUTOR_ARTIFACT_ALLOW_SHARED_TOKEN");
      // 默认姿态下绝不能落到 per-executor 渠道（否则共享令牌会从那条路进来）。
      expect(validateTokenByAddress).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
    });
    it("开关 EXECUTOR_ARTIFACT_ALLOW_SHARED_TOKEN=true → 保留旧行为且每次 warn", async () => {
      findOne.mockResolvedValue({
        id: EXEC_ID,
        executorAddress: "1.2.3.4:9000",
      });
      configGet.mockImplementation((key: string) =>
        key === "EXECUTOR_ARTIFACT_ALLOW_SHARED_TOKEN" ? "true" : undefined,
      );
      (verifyExecutorToken as jest.Mock).mockResolvedValue(undefined);
      const exec = await svc.verifyUploadAuth(EXEC_ID, "Bearer shared");
      expect(exec.id).toBe(EXEC_ID);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0][0])).toContain(
        "EXECUTOR_ARTIFACT_ALLOW_SHARED_TOKEN",
      );
      expect(String(warnSpy.mock.calls[0][0])).toContain(EXEC_ID);
    });
    it('开关取值非布尔真（"1" / "TRUE " 之外的任意值）不开启兼容模式', async () => {
      findOne.mockResolvedValue({
        id: EXEC_ID,
        executorAddress: "1.2.3.4:9000",
      });
      configGet.mockReturnValue("yes");
      (verifyExecutorToken as jest.Mock).mockResolvedValue(undefined);
      await expect(
        svc.verifyUploadAuth(EXEC_ID, "Bearer shared"),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
    it("共享无效但每执行器动态 token 有效 → 放行", async () => {
      findOne.mockResolvedValue({
        id: EXEC_ID,
        executorAddress: "1.2.3.4:9000",
      });
      (verifyExecutorToken as jest.Mock).mockRejectedValue(new Error("nope"));
      validateTokenByAddress.mockResolvedValue(true);
      const exec = await svc.verifyUploadAuth(EXEC_ID, "Bearer dynamic");
      expect(exec.id).toBe(EXEC_ID);
      expect(validateTokenByAddress).toHaveBeenCalledWith(
        "1.2.3.4:9000",
        "dynamic",
      );
    });
    it("两条凭据均失败 → Unauthorized", async () => {
      findOne.mockResolvedValue({
        id: EXEC_ID,
        executorAddress: "1.2.3.4:9000",
      });
      (verifyExecutorToken as jest.Mock).mockRejectedValue(new Error("nope"));
      validateTokenByAddress.mockResolvedValue(false);
      await expect(
        svc.verifyUploadAuth(EXEC_ID, "Bearer bad"),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });
    /**
     * SEC-1 要求 3：执行行没有 executorAddress 时，per-executor 令牌无处绑定
     * ⇒ fail-closed 403（不是 401，也不会"跳过行身份校验"式放行）。
     */
    it("执行行无 executorAddress + per-executor 令牌 → fail-closed 403（不查令牌）", async () => {
      findOne.mockResolvedValue({ id: EXEC_ID, executorAddress: null });
      (verifyExecutorToken as jest.Mock).mockRejectedValue(new Error("nope"));
      const err = await svc
        .verifyUploadAuth(EXEC_ID, "Bearer per-executor")
        .catch((e: unknown) => e);
      expect((err as { getStatus(): number }).getStatus()).toBe(403);
      expect((err as { errorCode: string }).errorCode).toBe(
        "ARTIFACT_UPLOAD_REQUIRES_EXECUTOR_TOKEN",
      );
      expect((err as { params: Record<string, unknown> }).params).toEqual(
        expect.objectContaining({
          execId: EXEC_ID,
          reason: "executor_address_unbound",
        }),
      );
      expect(validateTokenByAddress).not.toHaveBeenCalled();
    });
    it("完全没带凭据 → 仍是 401（与「带了但无效」同档，不泄漏执行行状态）", async () => {
      findOne.mockResolvedValue({
        id: EXEC_ID,
        executorAddress: "1.2.3.4:9000",
      });
      (verifyExecutorToken as jest.Mock).mockRejectedValue(new Error("nope"));
      await expect(
        svc.verifyUploadAuth(EXEC_ID, undefined),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });
  });

  /**
   * SEC-1 端到端（PUT 语义）：产物上传必须能定位到「哪台执行器」。
   *
   * 为什么把用例打在 **controller.upload** 上而不是只测 `verifyUploadAuth`：
   * 本条的安全性质是「**目录里没有写入**」。只看 `verifyUploadAuth` 抛错无法
   * 证明"写入发生了没有"——必须让真实 `ArtifactsService`（真实落盘到 tmpRoot）
   * 走一遍 `verifyUploadAuth → saveArtifact` 的编排，再断言磁盘。
   * 因此这里用**真实** service + 打桩 repo/executor，构造 controller 直接调
   * `upload`（`FileInterceptor` 是装饰器，裸调用不生效，正好模拟 multer 已把
   * 文件读进内存的形态）。
   */
  describe("SEC-1：共享令牌不得跨执行器写产物（PUT /executions/:execId/artifacts/:name）", () => {
    const payload = Buffer.from("attacker-controlled-artifact");

    /** execId → executorAddress（null = 无身份锚点的历史行）。 */
    const execRows = (overrides: Record<string, string | null> = {}) => {
      const rows: Record<string, string | null> = {
        [EXEC_ID]: "10.0.0.1:9000",
        [OTHER_EXEC_1]: "10.0.0.2:9000",
        [OTHER_EXEC_2]: "10.0.0.3:9000",
        [OTHER_EXEC_3]: "10.0.0.4:9000",
        ...overrides,
      };
      findOne.mockImplementation(
        async (opts: { where: { id: string } } | undefined) => {
          const id = opts?.where?.id;
          if (!id || !(id in rows)) return null;
          return { id, executorAddress: rows[id] };
        },
      );
    };

    const makeController = () =>
      new ArtifactsController(svc as never, undefined);

    const put = (
      execId: string,
      auth: string | undefined,
      name: string,
      sha256?: string,
    ) =>
      makeController().upload(execId, name, auth, sha256, {
        buffer: payload,
      } as unknown as Express.Multer.File);

    const artifactFile = (execId: string, name: string) =>
      path.join(tmpRoot, execId, name);

    it("共享令牌 + 他人的 execId → 403，且产物目录里没有写入（旧行为：201 且落盘）", async () => {
      execRows();
      (verifyExecutorToken as jest.Mock).mockResolvedValue(undefined);

      const err = await put(OTHER_EXEC_1, "Bearer shared", "evil.bin").catch(
        (e: unknown) => e,
      );

      expect(err).toBeInstanceOf(ForbiddenException);
      expect((err as { errorCode: string }).errorCode).toBe(
        "ARTIFACT_UPLOAD_REQUIRES_EXECUTOR_TOKEN",
      );
      expect(fs.existsSync(artifactFile(OTHER_EXEC_1, "evil.bin"))).toBe(false);
      // 目录都不该被创建（saveArtifact 里才 mkdir）。
      expect(fs.existsSync(path.join(tmpRoot, OTHER_EXEC_1))).toBe(false);
    });

    it("共享令牌 + 自己的 execId（默认）→ 仍 403：共享令牌不携带身份，刻意不区分对象", async () => {
      execRows();
      (verifyExecutorToken as jest.Mock).mockResolvedValue(undefined);

      const err = await put(EXEC_ID, "Bearer shared", "own.bin").catch(
        (e: unknown) => e,
      );

      expect(err).toBeInstanceOf(ForbiddenException);
      expect((err as { params: Record<string, unknown> }).params).toEqual(
        expect.objectContaining({ execId: EXEC_ID }),
      );
      expect(fs.existsSync(artifactFile(EXEC_ID, "own.bin"))).toBe(false);
    });

    it("开关 true + 共享令牌 → 201（旧行为）且 warn（兼容模式必须留痕）", async () => {
      execRows();
      configGet.mockImplementation((key: string) =>
        key === "EXECUTOR_ARTIFACT_ALLOW_SHARED_TOKEN" ? "true" : undefined,
      );
      (verifyExecutorToken as jest.Mock).mockResolvedValue(undefined);

      const res = await put(
        OTHER_EXEC_2,
        "Bearer shared",
        "legacy.bin",
        sha(payload),
      );

      expect(res.ok).toBe(true);
      expect(fs.existsSync(artifactFile(OTHER_EXEC_2, "legacy.bin"))).toBe(
        true,
      );
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0][0])).toContain(
        "EXECUTOR_ARTIFACT_ALLOW_SHARED_TOKEN",
      );
    });

    it("per-executor 令牌 + 自己的 execId → 201（回归护栏：正常链路不受 SEC-1 影响）", async () => {
      execRows();
      (verifyExecutorToken as jest.Mock).mockRejectedValue(new Error("nope"));
      validateTokenByAddress.mockResolvedValue(true);

      const res = await put(EXEC_ID, "Bearer per-executor-token", "own.bin");

      expect(res.ok).toBe(true);
      expect(validateTokenByAddress).toHaveBeenCalledWith(
        "10.0.0.1:9000",
        "per-executor-token",
      );
      expect(fs.existsSync(artifactFile(EXEC_ID, "own.bin"))).toBe(true);
    });

    /**
     * 行身份回归护栏：per-executor 令牌仍是"按该执行行的地址"校验，换 execId
     * 就用不了别人的令牌。
     *
     * 状态码刻意保持 401 `EXECUTOR_CREDENTIAL_INVALID`（**不是** 403）：这条是
     * 「凭据本身对该行无效」的既有契约（改动前后逐字一致，`EXECUTOR_CREDENTIAL_INVALID`
     * 在 catalog 里就是 401，且被回调面共用）。SEC-1 收紧的是**共享令牌**那一支；
     * 这一支只做回归，不改状态码——该行有地址时"令牌不匹配"与"令牌乱写"无法区分，
     * 一律按凭据无效处理（否则等于给攻击者一个"这枚令牌属于某台执行器"的预言机）。
     */
    it("per-executor 令牌 + 他人的 execId → 拒绝（401 EXECUTOR_CREDENTIAL_INVALID，不落盘）", async () => {
      execRows();
      (verifyExecutorToken as jest.Mock).mockRejectedValue(new Error("nope"));
      validateTokenByAddress.mockResolvedValue(false);

      const err = await put(
        OTHER_EXEC_3,
        "Bearer other-executor-token",
        "evil.bin",
      ).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(UnauthorizedException);
      expect((err as { errorCode: string }).errorCode).toBe(
        "EXECUTOR_CREDENTIAL_INVALID",
      );
      expect(validateTokenByAddress).toHaveBeenCalledWith(
        "10.0.0.4:9000",
        "other-executor-token",
      );
      expect(fs.existsSync(artifactFile(OTHER_EXEC_3, "evil.bin"))).toBe(false);
    });
  });

  describe("getManifest", () => {
    it("返回行内存清单，缺省为 []", async () => {
      findOne.mockResolvedValue({
        id: EXEC_ID,
        artifacts: [{ name: "a.png", size: 1, sha256: "x" }],
      });
      expect(await svc.getManifest(EXEC_ID)).toHaveLength(1);
      findOne.mockResolvedValue({ id: EXEC_ID, artifacts: null });
      expect(await svc.getManifest(EXEC_ID)).toEqual([]);
    });
  });
});
