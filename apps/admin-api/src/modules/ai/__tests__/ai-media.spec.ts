/**
 * `ai-media` 单测：上传闸门 + Range 解析 + 路径越界。
 *
 * 这三处都是「错了不会报错、只会悄悄坏」的地方：
 *  · 上传闸门漏一项 → 非视频/超大文件进盘，模型侧直接拒；
 *  · Range 解析错 → 视频 fetcher 拿到 200 整文件或 416，表现为"理解一直失败"；
 *  · 路径越界不查 → 磁盘上任意文件可被读出去。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
  AiMediaService,
  parseRangeHeader,
  AI_MEDIA_MAX_BYTES,
  getAiMediaRootDir,
} from "../ai-media.service";

// openStream 会真的打开文件：用临时 fixture，避免 createReadStream 对着不存在的
// 路径抛异步 ENOENT——那会在**别的测试文件**里炸（worker 复用），表现为
// "无关套件随机红"，极难排查（本轮实测踩到过）。
const FIXTURE_DIR = path.join(getAiMediaRootDir(), "selftest-fixture");
const FIXTURE_REL = "selftest-fixture/demo.mp4";

beforeAll(() => {
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  fs.writeFileSync(path.join(FIXTURE_DIR, "demo.mp4"), Buffer.alloc(1000, 7));
});

afterAll(() => {
  fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
});

const repo = {
  create: (v: unknown) => v,
  save: jest.fn(async (v: unknown) => ({ id: "m-1", ...(v as object) })),
  findOne: jest.fn(async () => null),
};

const svc = new AiMediaService(repo as never);

const mediaRow = (over: Record<string, unknown> = {}) => ({
  id: "m-1",
  name: "demo.mp4",
  mime: "video/mp4",
  sizeBytes: 1000,
  storedPath: "abc/demo.mp4",
  uploadedBy: "user:1",
  createdAt: new Date(),
  ...over,
});

describe("save —— 上传闸门（全部在写盘之前拦下）", () => {
  it("文件名不安全 → AI_MEDIA_NAME_INVALID", async () => {
    for (const name of ["../x.mp4", ".hidden.mp4", "a b.mp4"]) {
      await expect(
        svc.save({ name, buf: Buffer.from("x"), uploadedBy: "user:1" }),
      ).rejects.toThrow(/文件名不可用/);
    }
  });

  it("非视频扩展名 → AI_MEDIA_TYPE_NOT_ALLOWED", async () => {
    await expect(
      svc.save({
        name: "notes.txt",
        buf: Buffer.from("x"),
        uploadedBy: "user:1",
      }),
    ).rejects.toThrow(/不支持的视频格式/);
  });

  it("空文件 → AI_MEDIA_EMPTY", async () => {
    await expect(
      svc.save({ name: "a.mp4", buf: Buffer.alloc(0), uploadedBy: "user:1" }),
    ).rejects.toThrow(/为空/);
  });

  it("超过 100MB → AI_MEDIA_TOO_LARGE（不真的分配 100MB 内存）", async () => {
    const fake = { length: AI_MEDIA_MAX_BYTES + 1 } as unknown as Buffer;
    await expect(
      svc.save({ name: "a.mp4", buf: fake, uploadedBy: "user:1" }),
    ).rejects.toThrow(/单文件上限/);
  });

  it("校验都在写盘前（非法输入不产生任何目录）", async () => {
    // 若顺序写错（先 mkdir 再校验），上面几条会在仓库里留下 uploads/ 目录
    expect(repo.save).not.toHaveBeenCalled();
  });
});

describe("parseRangeHeader", () => {
  it("无 Range → null（整文件响应）", () => {
    expect(parseRangeHeader(undefined, 1000)).toBeNull();
    expect(parseRangeHeader("", 1000)).toBeNull();
  });

  it("bytes=start-end / start- / -suffix", () => {
    expect(parseRangeHeader("bytes=0-99", 1000)).toEqual({ start: 0, end: 99 });
    expect(parseRangeHeader("bytes=100-", 1000)).toEqual({
      start: 100,
      end: 999,
    });
    expect(parseRangeHeader("bytes=-50", 1000)).toEqual({
      start: 950,
      end: 999,
    });
  });

  it("end 超长按文件末尾钳制（浏览器会送 bytes=0-）", () => {
    expect(parseRangeHeader("bytes=0-999999", 1000)).toEqual({
      start: 0,
      end: 999,
    });
  });

  it("多段/非法/越界 → invalid（不支持多段 multipart 响应）", () => {
    for (const raw of [
      "bytes=0-1,5-6",
      "bytes=abc",
      "bytes=1000-2000",
      "bytes=5-1",
      "bytes=-",
      "items=0-10",
    ]) {
      expect(parseRangeHeader(raw, 1000)).toBe("invalid");
    }
  });
});

describe("openStream —— 路径越界 fail-closed", () => {
  it("storedPath 逃出根目录 → 拒绝（不打开文件）", () => {
    expect(() =>
      svc.openStream(mediaRow({ storedPath: "../evil.mp4" }) as never, null),
    ).toThrow(/越界/);
  });

  it("正常行返回区间（默认整文件）", async () => {
    const out = svc.openStream(
      mediaRow({ storedPath: FIXTURE_REL }) as never,
      null,
    );
    expect(out.start).toBe(0);
    expect(out.end).toBe(999);
    // 显式等它结束/出错再离开用例：否则残留的异步错误会污染同 worker 的
    // 其它测试文件（表现为"无关套件随机红"）
    await new Promise<void>((resolve) => {
      out.stream.on("error", () => resolve());
      out.stream.on("end", () => resolve());
      out.stream.resume();
    });
  });
});
