import * as os from "os";
import * as path from "path";

// 存储根在读 env（getEnvVar）后派生——每个用例一个独立临时目录（真写盘）。
jest.mock("../../../config/env", () => ({ getEnvVar: jest.fn() }));

// 只把 statSync 换成可编程的 mock（其余 fs API 走真实实现）。ESM 下 fs 的
// 命名空间不可重定义（jest.spyOn(fs, ...) 会 "Cannot redefine property"），
// 所以用模块工厂——先红后绿的反证正是靠它能强制 statSync 抛 ENOENT。
jest.mock("fs", () => {
  const actual = jest.requireActual("fs");
  return {
    ...actual,
    statSync: jest.fn((...args: unknown[]) =>
      (actual.statSync as (...a: unknown[]) => unknown)(...args),
    ),
  };
});

import * as fs from "fs";

import { getEnvVar } from "../../../config/env";
import { ErrorCode } from "../../../common/errors/error-codes";
import { SopMediaService } from "../sop-media.service";

const mockedGetEnvVar = getEnvVar as jest.MockedFunction<typeof getEnvVar>;
const statSyncMock = fs.statSync as unknown as jest.Mock;

/**
 * R34-A1（sop 审计 · 轴 3 · 媒体面并发）：**保留期整删 vs 单文件下载**。
 *
 * 现场：`agent-media-retention` 每日按 assignmentId **整目录** rm（
 * agent-media-retention.service.ts:96），而 `SopMediaService.openStream` 是
 * 「existsSync 判存在 → statSync 取大小/isFile → 建流」的三段读。两段之间
 * 目录被删掉时，裸 ENOENT 会冒泡成 **HTTP 500**——对一个「文件已按保留期
 * 回收」的请求，正确语义是 404（SOP_MEDIA_FILE_MISSING）。
 *
 * 这个窗口在单线程测试里永远绿（ADR-026 同款：并发缺陷只在并发下现身），
 * 所以用 statSync 抛 ENOENT 精确复现「判定为真之后文件消失」这一瞬间。
 */
describe("SopMediaService.openStream · 保留期整删与单文件读并发", () => {
  const ASG = "3f0f8b1a-0d2e-4c5f-9a7b-1c2d3e4f5a6b";
  let root: string;
  let svc: SopMediaService;

  const row = (storedPath: string) =>
    ({
      id: "media-race",
      name: "race.bin",
      mime: "image/png",
      sizeBytes: 1,
      storedPath,
    }) as never;

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

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "sop-media-race-"));
    mockedGetEnvVar.mockReturnValue(root);
    svc = new SopMediaService({ findOne: jest.fn() } as never);
    statSyncMock.mockClear();
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    jest.clearAllMocks();
  });

  it("statSync 时文件已被回收（ENOENT）→ SOP_MEDIA_FILE_MISSING（404），不是裸 ENOENT（500）", () => {
    const dir = path.join(root, ASG);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "race.bin"), Buffer.from("x"));

    statSyncMock.mockImplementationOnce(() => {
      const err = new Error(
        `ENOENT: no such file or directory, stat '${path.join(dir, "race.bin")}'`,
      ) as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    });

    expectErrorCode(
      () => svc.openStream(row(path.join(ASG, "race.bin"))),
      ErrorCode.SOP_MEDIA_FILE_MISSING,
    );
  });

  it("父目录被整体删除（ENOTDIR/ENOENT）同样收敛为 404，不冒泡原始异常", () => {
    statSyncMock.mockImplementationOnce(() => {
      const err = new Error(
        "ENOTDIR: not a directory",
      ) as NodeJS.ErrnoException;
      err.code = "ENOTDIR";
      throw err;
    });

    expectErrorCode(
      () => svc.openStream(row(path.join(ASG, "gone.bin"))),
      ErrorCode.SOP_MEDIA_FILE_MISSING,
    );
  });

  it("非 ENOENT 类错误（如 EACCES）不伪装成 404——原样抛出，避免把权限故障说成文件不存在", () => {
    statSyncMock.mockImplementationOnce(() => {
      const err = new Error(
        "EACCES: permission denied",
      ) as NodeJS.ErrnoException;
      err.code = "EACCES";
      throw err;
    });

    let caught: unknown;
    try {
      svc.openStream(row(path.join(ASG, "denied.bin")));
    } catch (err) {
      caught = err;
    }
    expect((caught as { code?: string }).code).toBe("EACCES");
    expect((caught as { errorCode?: string }).errorCode).toBeUndefined();
  });

  it("size 只取一次 stat（消除 isFile 判定与 size 取数之间的第二个竞态窗口）", () => {
    const dir = path.join(root, ASG);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "real.bin"), Buffer.from("12345"));

    const out = svc.openStream(row(path.join(ASG, "real.bin")));
    expect(out.size).toBe(5);
    expect(statSyncMock).toHaveBeenCalledTimes(1);
    out.stream.destroy();
  });
});
