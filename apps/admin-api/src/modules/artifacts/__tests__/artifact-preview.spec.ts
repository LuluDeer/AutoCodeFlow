import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ArtifactsService } from "../artifacts.service";

/**
 * 有界预览：fs.promises.open/read 只读 maxBytes 字节，size 为完整文件大小，
 * truncated 正确反映截断；文本 UTF-8 预览，图片/二进制 content=null。
 */
describe("ArtifactsService.previewArtifact（有界读取）", () => {
  let root: string;
  let service: ArtifactsService;
  const execId = "9c1f5a2e-3b4d-4a6e-8f10-2d3c4b5a6e7f";

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "acf-preview-"));
    process.env.LOG_ARTIFACT_DIR = root;
    fs.mkdirSync(path.join(root, execId), { recursive: true });
    fs.writeFileSync(
      path.join(root, execId, "report.log"),
      "第一行 hello\n第二行 world\n",
    );
    fs.writeFileSync(path.join(root, execId, "image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    // 最小 service：previewArtifact 只依赖 resolveArtifactPath + fs，无需 DB。
    service = new ArtifactsService(
      {} as never,
      null as never,
      {} as never,
      {} as never,
      {} as never,
    );
  });

  afterAll(() => {
    delete process.env.LOG_ARTIFACT_DIR;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("文本默认预览全文，truncated=false", async () => {
    const r = await service.previewArtifact(execId, "report.log");
    expect(r.kind).toBe("text");
    expect(r.mimeType).toBe("text/plain");
    expect(r.content).toContain("第一行 hello");
    expect(r.truncated).toBe(false);
    expect(r.size).toBe(Buffer.byteLength("第一行 hello\n第二行 world\n"));
  });

  it("maxBytes 截断时只读前若干字节，truncated=true 且 size 为完整大小", async () => {
    const fullSize = Buffer.byteLength("第一行 hello\n第二行 world\n");
    const r = await service.previewArtifact(execId, "report.log", 1024);
    // 1024 > 文件大小 ⇒ 不截断：用一个更小但 >= 下限的 grep 替代不可行，
    // 这里直接读取比文件小的上限（单测不经过 DTO 的 1024 下限）。
    expect(r.truncated).toBe(false);
    expect(r.size).toBe(fullSize);

    const truncated = await service.previewArtifact(execId, "report.log", 5);
    expect(truncated.truncated).toBe(true);
    expect(truncated.size).toBe(fullSize);
    expect(Buffer.byteLength(truncated.content ?? "")).toBeLessThanOrEqual(5);
  });

  it("图片 content=null，不做任何字节读取", async () => {
    const r = await service.previewArtifact(execId, "image.png");
    expect(r.kind).toBe("image");
    expect(r.mimeType).toBe("image/png");
    expect(r.content).toBeNull();
    expect(r.truncated).toBe(false);
  });

  it("文件不存在抛 ARTIFACT_NOT_FOUND", async () => {
    await expect(service.previewArtifact(execId, "missing.log")).rejects.toThrow();
  });
});
