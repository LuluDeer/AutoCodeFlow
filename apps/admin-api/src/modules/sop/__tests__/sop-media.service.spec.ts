import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// 存储根在读 env（getEnvVar）后派生——替换成可控返回值，让每个用例拿到独立
// 临时目录（真写盘：盘上布局本身就是本档要钉住的不变量）。
jest.mock("../../../config/env", () => ({ getEnvVar: jest.fn() }));

import { getEnvVar } from "../../../config/env";
import { ErrorCode } from "../../../common/errors/error-codes";
import {
  MAX_AGENT_MEDIA_BYTES,
  SopMediaService,
  getAgentMediaRootDir,
} from "../sop-media.service";

const mockedGetEnvVar = getEnvVar as jest.MockedFunction<typeof getEnvVar>;

/** 合法 uuid 形态的指派 id（服务侧还会二次校验这个形态）。 */
const ASG = "3f0f8b1a-0d2e-4c5f-9a7b-1c2d3e4f5a6b";
const OTHER_ASG = "11111111-2222-3333-4444-555555555555";

function makeRepo() {
  return {
    create: jest.fn((row: Record<string, unknown>) => row),
    save: jest.fn(async (row: Record<string, unknown>) => ({
      ...row,
      id: "media-1",
    })),
    findOne: jest.fn(),
    find: jest.fn(async () => [] as unknown[]),
  };
}

type FakeRepo = ReturnType<typeof makeRepo>;

let root: string;
let svc: SopMediaService;
let repo: FakeRepo;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "sop-media-"));
  mockedGetEnvVar.mockReturnValue(root);
  repo = makeRepo();
  svc = new SopMediaService(repo as never);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  jest.clearAllMocks();
});

/**
 * 同步路径的错误码断言。AppError 用 Object.setPrototypeOf 挂到 Nest 内置异常类
 * 上（见 app-error.ts），故这里只钉错误码——状态码/文案由 catalog 统一决定，
 * 在单测里重复一遍等于把目录抄第二份。
 */
function expectErrorCode(fn: () => unknown, code: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeDefined();
  expect((caught as { errorCode?: string }).errorCode).toBe(code);
}

const bytes = (s: string) => Buffer.from(s);

/**
 * P7b 媒体落盘的全部边界。
 *
 * 为什么值得单独一档：本服务是**唯一**把执行器上传的字节写到中台盘上的收口点，
 * 四道「看起来像小校验」的闸分别对应四类真实事故：
 * ① 文件名带路径语义 → 任意写（`../` 覆盖 .env、覆盖别人的媒体）；
 * ② 空/超大字节 → 0 字节垃圾行，或整盘打满（100MB 是与 artifacts 对齐的实上界）；
 * ③ assignmentId 不校验形态 → 目录穿越变体绕过 <assignmentId> 分层；
 * ④ openStream 不做根内终检 → 下载端点变成任意本地文件读取原语。
 */
describe("SopMediaService.save · 文件名封闭字符集（不承担路径语义）", () => {
  it.each([
    ["父目录穿越", "../evil.png"],
    ["反斜杠穿越", "..\\evil.png"],
    ["子目录意图", "a/b.png"],
    ["反斜杠子目录", "a\\b.png"],
    ["纯点点", ".."],
    ["空串", ""],
    ["首字符非字母数字", "-lead.png"],
    ["含空格", "na me.png"],
    ["超长 256", "x".repeat(256)],
  ])("%s（%s）→ SOP_MEDIA_NAME_INVALID 且零副作用", async (_label, name) => {
    await expect(
      svc.save({ assignmentId: ASG, name, buf: bytes("x"), uploadedBy: "e-1" }),
    ).rejects.toMatchObject({ errorCode: ErrorCode.SOP_MEDIA_NAME_INVALID });
    // 闸在第一道：拒绝路径必须零副作用（不建目录、不写文件、不登记行）
    expect(repo.save).not.toHaveBeenCalled();
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it("可用字符集不被误杀（字母数字 . _ - 合法）", async () => {
    const out = await svc.save({
      assignmentId: ASG,
      name: "shot-2024_01.02.png",
      buf: bytes("x"),
      uploadedBy: "e-1",
    });
    expect(out.name).toBe("shot-2024_01.02.png");
  });
});

describe("SopMediaService.save · 字节上限（0 拒 / >100MB 拒）", () => {
  it("空 buffer（length=0）→ SOP_MEDIA_EMPTY（不留 0 字节垃圾行）", async () => {
    await expect(
      svc.save({
        assignmentId: ASG,
        name: "shot.png",
        buf: Buffer.alloc(0),
        uploadedBy: "e-1",
      }),
    ).rejects.toMatchObject({ errorCode: ErrorCode.SOP_MEDIA_EMPTY });
    expect(repo.save).not.toHaveBeenCalled();
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it("buf 缺失（undefined）→ SOP_MEDIA_EMPTY（不是 TypeError）", async () => {
    await expect(
      svc.save({
        assignmentId: ASG,
        name: "shot.png",
        buf: undefined as never,
        uploadedBy: "e-1",
      }),
    ).rejects.toMatchObject({ errorCode: ErrorCode.SOP_MEDIA_EMPTY });
  });

  it("超过 MAX_AGENT_MEDIA_BYTES 1 字节 → SOP_MEDIA_TOO_LARGE，params.max 如实，且写盘前就拒", async () => {
    // 真 Buffer：这个数值与控制器 multer limits 同源（MEDIA_UPLOAD_LIMITS），
    // 必须按真值守——它一旦漂移，拦截器与业务判定就会各说一套。
    const tooBig = Buffer.allocUnsafe(MAX_AGENT_MEDIA_BYTES + 1);
    await expect(
      svc.save({
        assignmentId: ASG,
        name: "screen.mp4",
        buf: tooBig,
        uploadedBy: "e-1",
      }),
    ).rejects.toMatchObject({
      errorCode: ErrorCode.SOP_MEDIA_TOO_LARGE,
      params: { max: MAX_AGENT_MEDIA_BYTES },
    });
    // 关键：拒绝发生在 writeFileSync 之前——「先整包落盘再判大小」等于给
    // DoS 留一条把磁盘打满的路径。
    expect(fs.readdirSync(root)).toEqual([]);
    expect(repo.save).not.toHaveBeenCalled();
  });
});

describe("SopMediaService.save · assignmentId 形态二次校验（防目录穿越变体）", () => {
  it.each([
    ["非 uuid 短串", "asg-1"],
    ["恰好 35 位", "3f0f8b1a-0d2e-4c5f-9a7b-1c2d3e4f5a6"],
    ["含穿越片段", "../../etc/passwd"],
    ["36 位但非 hex", "zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz"],
  ])("%s → SOP_MEDIA_ASSIGNMENT_ID_INVALID", async (_label, assignmentId) => {
    await expect(
      svc.save({
        assignmentId,
        name: "shot.png",
        buf: bytes("x"),
        uploadedBy: "e-1",
      }),
    ).rejects.toMatchObject({
      errorCode: ErrorCode.SOP_MEDIA_ASSIGNMENT_ID_INVALID,
    });
    expect(fs.readdirSync(root)).toEqual([]);
  });
});

describe("SopMediaService.save · 落盘布局与登记（<assignmentId>/<uuid>-<name>）", () => {
  it("字节真写到 <root>/<assignmentId>/<uuid>-<name>，登记行带相对根的 storedPath", async () => {
    const out = await svc.save({
      assignmentId: ASG,
      name: "shot.png",
      buf: bytes("PNGDATA"),
      uploadedBy: "executor:exec-1",
    });

    // mediaPath 是 mediaRefs 的唯一合法引用形态（澄清提问里的外链门已关死）
    expect(out).toEqual({
      id: "media-1",
      name: "shot.png",
      mime: null,
      sizeBytes: 7,
      // R35-A1：必须指向真实的下载端点（@Get("media/:mediaId")），
      // 旧值 /api/agent-collab/media/<id> 从不是路由（另见
      // sop-media.path-endpoint.contract.spec.ts 的端到端反证）。
      mediaPath: "/api/sop/media/media-1",
    });

    const dir = path.join(root, ASG);
    const files = fs.readdirSync(dir);
    expect(files).toHaveLength(1);
    // uuid 前缀：盘上名不沿用客户端名（同名覆盖与保留期整删都靠它）
    expect(files[0]).toMatch(/^[0-9a-f-]{36}-shot\.png$/);
    expect(fs.readFileSync(path.join(dir, files[0]), "utf8")).toBe("PNGDATA");

    expect(repo.create).toHaveBeenCalledWith({
      assignmentId: ASG,
      name: "shot.png",
      mime: null,
      sizeBytes: 7,
      storedPath: path.join(ASG, files[0]),
      uploadedBy: "executor:exec-1",
    });
  });

  it("同名两次上传落成两个不同文件（uuid 前缀防覆盖，内容互不踩）", async () => {
    await svc.save({
      assignmentId: ASG,
      name: "shot.png",
      buf: bytes("one"),
      uploadedBy: "e-1",
    });
    await svc.save({
      assignmentId: ASG,
      name: "shot.png",
      buf: bytes("two"),
      uploadedBy: "e-1",
    });

    const files = fs.readdirSync(path.join(root, ASG));
    expect(files).toHaveLength(2);
    expect(new Set(files).size).toBe(2);
    for (const f of files) expect(f).toMatch(/-shot\.png$/);
    const contents = files
      .map((f) => fs.readFileSync(path.join(root, ASG, f), "utf8"))
      .sort();
    expect(contents).toEqual(["one", "two"]);
  });

  it("mime 显式给出时原样登记（中心侧多模态判定依赖它）", async () => {
    const out = await svc.save({
      assignmentId: ASG,
      name: "screen.mp4",
      mime: "video/mp4",
      buf: bytes("MP4"),
      uploadedBy: "e-1",
    });
    expect(out.mime).toBe("video/mp4");
    expect(out.sizeBytes).toBe(3);
  });

  it("只按 assignmentId 分层：同指派同目录、不同指派不同目录（保留期整删的前提）", async () => {
    await svc.save({
      assignmentId: ASG,
      name: "a.png",
      buf: bytes("a"),
      uploadedBy: "e-1",
    });
    await svc.save({
      assignmentId: ASG,
      name: "b.png",
      buf: bytes("b"),
      uploadedBy: "e-1",
    });
    await svc.save({
      assignmentId: OTHER_ASG,
      name: "c.png",
      buf: bytes("c"),
      uploadedBy: "e-1",
    });

    expect(fs.readdirSync(path.join(root, ASG))).toHaveLength(2);
    expect(fs.readdirSync(path.join(root, OTHER_ASG))).toHaveLength(1);
  });
});

describe("SopMediaService.requireById · 缺行即 404（不回落空对象）", () => {
  it("缺行 → SOP_MEDIA_NOT_FOUND，params 带 id（定位脏链接）", async () => {
    repo.findOne.mockResolvedValueOnce(null);
    await expect(svc.requireById("media-404")).rejects.toMatchObject({
      errorCode: ErrorCode.SOP_MEDIA_NOT_FOUND,
      params: { id: "media-404" },
    });
    expect(repo.findOne).toHaveBeenCalledWith({ where: { id: "media-404" } });
  });

  it("命中 → 返回登记行本身（不做二次查询）", async () => {
    const entity = { id: "media-1", storedPath: "x" };
    repo.findOne.mockResolvedValueOnce(entity);
    await expect(svc.requireById("media-1")).resolves.toBe(entity);
  });
});

describe("SopMediaService.openStream · 越界 / 丢失 / 大小取自磁盘", () => {
  const row = (storedPath: string, extra?: Record<string, unknown>) =>
    ({
      id: "media-1",
      name: "shot.png",
      mime: "image/png",
      // 登记值刻意给错，用于验证 size 不取用它
      sizeBytes: 999,
      storedPath,
      ...extra,
    }) as never;

  it("storedPath 解析后跳不出根 → SOP_MEDIA_STORAGE_PATH_ESCAPED", () => {
    expectErrorCode(
      () => svc.openStream(row("../outside.bin")),
      ErrorCode.SOP_MEDIA_STORAGE_PATH_ESCAPED,
    );
    expectErrorCode(
      () => svc.openStream(row(path.join("..", "..", "etc", "passwd"))),
      ErrorCode.SOP_MEDIA_STORAGE_PATH_ESCAPED,
    );
  });

  it("文件不存在 / 不是普通文件 → SOP_MEDIA_FILE_MISSING", () => {
    expectErrorCode(
      () => svc.openStream(row(path.join(ASG, "missing.bin"))),
      ErrorCode.SOP_MEDIA_FILE_MISSING,
    );
    // 存在的**目录**也必须拒：existsSync 为真但 statSync().isFile() 为假
    fs.mkdirSync(path.join(root, ASG, "adir"), { recursive: true });
    expectErrorCode(
      () => svc.openStream(row(path.join(ASG, "adir"))),
      ErrorCode.SOP_MEDIA_FILE_MISSING,
    );
  });

  it("size 取磁盘真实大小而非登记的 sizeBytes（Content-Length 不许说谎）", () => {
    const dir = path.join(root, ASG);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "real.bin"), bytes("12345"));

    const out = svc.openStream(row(path.join(ASG, "real.bin")));
    expect(out.size).toBe(5); // 登记的是 999
    expect(out.name).toBe("shot.png");
    expect(out.mime).toBe("image/png");
    // 句柄必须可收（forceExit 不掩盖 fd 泄漏）
    out.stream.destroy();
  });
});

describe("SopMediaService.listByAssignment · 展示面查询有界", () => {
  it("按 assignmentId 过滤 + createdAt DESC + take 100（防无界拉取）", async () => {
    await expect(svc.listByAssignment(ASG)).resolves.toEqual([]);
    expect(repo.find).toHaveBeenCalledWith({
      where: { assignmentId: ASG },
      order: { createdAt: "DESC" },
      take: 100,
    });
  });
});

describe("getAgentMediaRootDir · env 归一（空白必须回退默认根）", () => {
  const DEFAULT_ROOT = path.join(process.cwd(), "uploads", "agent-media");

  it("未配置 → <cwd>/uploads/agent-media", () => {
    mockedGetEnvVar.mockReturnValue(undefined);
    expect(getAgentMediaRootDir()).toBe(DEFAULT_ROOT);
  });

  it("纯空白 → 回退默认根（把 '' 当根会让所有路径都不在根内）", () => {
    mockedGetEnvVar.mockReturnValue("   ");
    expect(getAgentMediaRootDir()).toBe(DEFAULT_ROOT);
  });

  it("有值 → 去首尾空白后使用", () => {
    mockedGetEnvVar.mockReturnValue("  /var/lib/acf/media  ");
    expect(getAgentMediaRootDir()).toBe("/var/lib/acf/media");
  });
});
/**
 * WEB-IO-01：落盘必须**异步 + 原子发布**。
 *
 * 反证（本组用例的存在理由）：此前是 `mkdirSync` + `writeFileSync`。单文件上限
 * 100 MiB，且控制器走 FileInterceptor 的 memoryStorage（整包已在内存），所以一次
 * 上传要同步按住事件循环把整个文件写完——期间同一副本上的 pull 长轮询与终态回调
 * 全部停摆（两者都有 TTL 语义，一次大写入足以让它们虚假超时）。
 * 第二条同样真实：非原子写会让 openStream 读到半截文件——盘上结构按 assignmentId
 * 分目录、保留期清理整目录删，没有别的机制把半截文件挡在外面。
 */
describe("SOP 媒体落盘：异步写入 + rename 原子发布（WEB-IO-01）", () => {
  const save = (name = "a.png", body = "123") =>
    svc.save({ assignmentId: ASG, name, buf: bytes(body), uploadedBy: "agent:sop:x" });

  it("字节走 fs.promises.writeFile（异步接口），不是 writeFileSync", async () => {
    // 钉法说明：Node 的 fs 命名空间属性不可重定义（jest.spyOn(fs,"writeFileSync")
    // 会抛 Cannot redefine property），故反向钉住「异步那条路**确实被走了**」——
    // 一旦有人改回 writeFileSync，本用例立刻红。
    const asyncWrite = jest.spyOn(fs.promises, "writeFile");

    await save();

    expect(asyncWrite).toHaveBeenCalledTimes(1);
    expect(fs.readdirSync(path.join(root, ASG))).toHaveLength(1);
    asyncWrite.mockRestore();
  });

  it("写盘失败（ENOSPC）时不留半截可见文件、也不写 DB 行", async () => {
    const write = jest
      .spyOn(fs.promises, "writeFile")
      .mockRejectedValueOnce(
        Object.assign(new Error("no space left on device"), { code: "ENOSPC" }),
      );

    await expect(save()).rejects.toThrow(/no space left on device/);

    // DB 行是「已经落盘」的登记，写失败就不能有它
    expect(repo.save).not.toHaveBeenCalled();
    // rename 从未发生 ⇒ 目录里不该出现任何非 tmp 文件（可见文件 = 可被下载的半截）
    const dir = path.join(root, ASG);
    const visible = fs.existsSync(dir)
      ? fs.readdirSync(dir).filter((e) => !e.startsWith("."))
      : [];
    expect(visible).toEqual([]);
    write.mockRestore();
  });

  it("发布后没有残留 tmp 文件，且盘上名就是登记的 storedPath 基名", async () => {
    const stored = await save("shot.png", "12345");

    const entries = fs.readdirSync(path.join(root, ASG));
    expect(entries).toHaveLength(1);
    expect(entries[0]).not.toContain(".tmp-");

    const row = (repo.save.mock.calls[0] as unknown[])[0] as { storedPath: string };
    expect(entries[0]).toBe(path.basename(row.storedPath));
    expect(stored.sizeBytes).toBe(5);
  });
});

