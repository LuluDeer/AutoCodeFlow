/**
 * R35-A1：`mediaPath` 是一条**契约承诺**——它必须指向真实存在的下载路由。
 *
 * ## 缺陷（R34-A1 遗留①）
 * `SopMediaService.save()` 曾返回 `/api/agent-collab/media/<id>`，而全仓没有
 * 这条 GET 路由：`agent-collab` 控制器只有 POST（poll / capability /
 * clarifications / progress / complete / media 上传 …），真正的下载端点是
 * `SopController` 的 `@Get("media/:mediaId")`（全局前缀 `api` ⇒
 * `/api/sop/media/<id>`，类级 JwtAuthGuard + Roles(ADMIN)）。于是这条「唯一
 * 合法引用形态」被写进澄清 mediaRefs 后，按地址取只会 404——浏览器侧之所以
 * 还能看，只是因为 admin-web 的 viewClarificationMedia 自己剥了尾部 id 再打
 * `/sop/media/<id>`，路径前缀从未被真正验证过。
 *
 * ## 本套件的判据（不写死路径前缀，只钉「承诺能不能兑现」）
 * ① 拿 `save()` 真返回的 mediaPath，直接对**同一个 Nest 应用**发 GET：
 *    200 + 原字节 ⇒ 该路径确由某个 @Get 路由提供；
 * ② 反证：旧形态 `/api/agent-collab/media/<id>` 在同一应用上**必须 404**
 *    （agent-collab 的路由已全部注册，因此这个 404 是「真没有」而非「没挂载」）；
 * ③ 鉴权形态：下载路由非 @Public、类级 @Roles(ADMIN) + JwtAuthGuard——
 *    与消费方（admin-web 浏览器带 ADMIN JWT 取 blob）匹配。
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import request from "supertest";
import { ConfigService } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";

// 存储根经 getEnvVar 派生：替换成可控返回值，让用例拿到独立临时目录（真写盘）。
jest.mock("../../../config/env", () => ({ getEnvVar: jest.fn() }));

import { getEnvVar } from "../../../config/env";
import { JwtAuthGuard } from "../../../common/guards/jwt-auth.guard";
import { ROLES_KEY } from "../../../common/decorators/roles.decorator";
import { IS_PUBLIC_KEY } from "../../../common/decorators/public.decorator";
import { UserRole } from "../../users/entities/user.entity";
import { SopController } from "../sop.controller";
import { SopCollabController } from "../sop-collab.controller";
import { SopService } from "../sop.service";
import { SopMediaService } from "../sop-media.service";
import { ExecutorService } from "../../executor/executor.service";
import { ExecutorPackageService } from "../../executor-package/executor-package.service";
import { AiService } from "../../ai/ai.service";

const mockedGetEnvVar = getEnvVar as jest.MockedFunction<typeof getEnvVar>;

/** 合法 uuid 形态的指派 id（服务侧还会二次校验这个形态）。 */
const ASG = "3f0f8b1a-0d2e-4c5f-9a7b-1c2d3e4f5a6b";

/** 带最小内存台账的仓储假体：save 落一行、requireById 能按 id 取回。 */
function makeRepo() {
  const rows = new Map<string, Record<string, unknown>>();
  let seq = 0;
  return {
    create: jest.fn((row: Record<string, unknown>) => row),
    save: jest.fn(async (row: Record<string, unknown>) => {
      const saved = { ...row, id: `media-${++seq}` };
      rows.set(saved.id as string, saved);
      return saved;
    }),
    findOne: jest.fn(async (opts: { where?: { id?: string } }) => {
      return rows.get(opts?.where?.id ?? "") ?? null;
    }),
    find: jest.fn(async () => [] as unknown[]),
  };
}

/** supertest 的二进制响应体（parse 成 Buffer / 退化成 text 两种都要吃得下）。 */
function bytesOf(res: { body?: unknown; text?: string }): Buffer {
  const body = res.body;
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  return Buffer.from(res.text ?? "", "binary");
}

let root: string;
let repo: ReturnType<typeof makeRepo>;
let media: SopMediaService;
let app: INestApplication;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "sop-media-path-"));
  mockedGetEnvVar.mockReturnValue(root);
  repo = makeRepo();
  media = new SopMediaService(repo as never);

  // 两个控制器都挂上：只有 agent-collab 的路由全部在场，
  // 下面的「旧形态 404」才证明是「该 GET 不存在」而不是「整个控制器没注册」。
  const moduleRef = await Test.createTestingModule({
    controllers: [SopController, SopCollabController],
    providers: [
      { provide: SopService, useValue: {} },
      { provide: SopMediaService, useValue: media },
      { provide: ExecutorService, useValue: {} },
      { provide: ExecutorPackageService, useValue: {} },
      { provide: ConfigService, useValue: { get: () => undefined } },
      { provide: AiService, useValue: {} },
    ],
  })
    // ADMIN 面鉴权本体在 jwt-auth.guard 的用例里已覆盖；本档只验「路由存在 +
    // 鉴权形态声明正确」，故放行守卫以便请求真打到 handler。
    .overrideGuard(JwtAuthGuard)
    .useValue({ canActivate: () => true })
    .compile();

  app = moduleRef.createNestApplication();
  app.setGlobalPrefix("api"); // 与 main.ts:328 一致
  await app.init();
});

afterEach(async () => {
  await app?.close();
  fs.rmSync(root, { recursive: true, force: true });
  jest.clearAllMocks();
});

describe("mediaPath 契约：承诺的路径必须由真实 @Get 路由兑现", () => {
  it("save() 返回的 mediaPath 直接 GET 得 200 + 原字节（404 = 承诺了不存在的端点）", async () => {
    const out = await media.save({
      assignmentId: ASG,
      name: "shot.png",
      mime: "application/octet-stream",
      buf: Buffer.from("PNGDATA"),
      uploadedBy: "executor:exec-1",
    });

    expect(out.mediaPath.startsWith("/api/")).toBe(true);
    const res = await request(app.getHttpServer()).get(out.mediaPath);
    expect({ mediaPath: out.mediaPath, status: res.status }).toEqual({
      mediaPath: out.mediaPath,
      status: 200,
    });
    expect(bytesOf(res).toString("utf8")).toBe("PNGDATA");
    // 端点语义：Content-Length 来自真实字节数（不是 0 / 不是字符串）
    expect(res.headers["content-length"]).toBe("7");
  });

  it("反证：旧形态 /api/agent-collab/media/<id> 在同一应用上 404（agent-collab 只有 POST）", async () => {
    const out = await media.save({
      assignmentId: ASG,
      name: "shot.png",
      mime: "application/octet-stream",
      buf: Buffer.from("PNGDATA"),
      uploadedBy: "executor:exec-1",
    });

    const legacy = `/api/agent-collab/media/${out.id}`;
    expect(out.mediaPath).not.toBe(legacy);
    await request(app.getHttpServer()).get(legacy).expect(404);
  });

  it("鉴权形态匹配消费方：下载路由非 @Public、类级 Roles(ADMIN) + JwtAuthGuard", () => {
    // 消费方 = admin-web 浏览器（ADMIN JWT 取 blob）；契约里的路径必须是同一形态，
    // 不能指向需要执行器令牌的机器面（也没有这样的机器面端点）。
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, SopController)).toBeUndefined();
    expect(Reflect.getMetadata(ROLES_KEY, SopController)).toEqual([
      UserRole.ADMIN,
    ]);
    const guards = (Reflect.getMetadata("__guards__", SopController) ?? [])
      .flat()
      .map((g: unknown) => (g as { name?: string })?.name);
    expect(guards).toContain(JwtAuthGuard.name);
  });
});
