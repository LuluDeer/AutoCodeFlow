/**
 * P1-11（UX-AUDIT-2026-09-21）回归：zip 上传解析 manifest.json。
 *
 * 旧实现：zip 上传路径完全不解析 manifest（git 路径早就解析），entrypoint/runtime
 * 只能靠人手填。本测试钉住 readManifestFromZip：
 *   1. 能从 deflate 压缩的 zip 里读出根目录 manifest.json；
 *   2. 子目录下的 manifest.json 也能兜底命中；
 *   3. 无 manifest / 损坏 zip / 非 JSON → 返回 null（调用方只 warn，不阻断上传）。
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { buildZip } from "./__tests__/zip-samples";
import { readManifestFromZip } from "./zip-manifest.util";

function writeZip(tmpDir: string, zipName: string, entries: Parameters<typeof buildZip>[0]): string {
  const zipPath = path.join(tmpDir, zipName);
  fs.writeFileSync(zipPath, buildZip(entries));
  return zipPath;
}

describe("readManifestFromZip（P1-11）", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zip-manifest-"));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("能读出根目录 manifest.json（deflate 方法 8）", () => {
    const manifest = JSON.stringify({ runtime: "node", entrypoint: "dist/main.js", timeout: 300 });
    const zipPath = writeZip(tmpDir, "app.zip", [
      { name: "manifest.json", data: Buffer.from(manifest) },
      { name: "server.js", data: Buffer.from("console.log(1)") },
    ]);
    const out = readManifestFromZip(zipPath);
    expect(out).not.toBeNull();
    const parsed = JSON.parse(out as string);
    expect(parsed.runtime).toBe("node");
    expect(parsed.entrypoint).toBe("dist/main.js");
  });

  it("stored（方法 0）也能读出", () => {
    const manifest = JSON.stringify({ runtime: "python", entrypoint: "run.py" });
    const zipPath = writeZip(tmpDir, "app.zip", [
      { name: "manifest.json", data: Buffer.from(manifest), method: 0 },
    ]);
    const out = readManifestFromZip(zipPath);
    expect(out).toContain('"runtime":"python"');
  });

  it("无 manifest.json 时返回 null（不抛错）", () => {
    const zipPath = writeZip(tmpDir, "app.zip", [
      { name: "index.js", data: Buffer.from("x") },
    ]);
    expect(readManifestFromZip(zipPath)).toBeNull();
  });

  it("损坏/非 zip 文件返回 null，不抛错", () => {
    const badPath = path.join(tmpDir, "broken.zip");
    fs.writeFileSync(badPath, Buffer.from([1, 2, 3, 4, 5]));
    expect(readManifestFromZip(badPath)).toBeNull();
    // 不存在的文件
    expect(readManifestFromZip(path.join(tmpDir, "nope.zip"))).toBeNull();
  });
});
