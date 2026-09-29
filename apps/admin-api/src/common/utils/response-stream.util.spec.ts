/**
 * P1-2（ARCH-008）：响应下载流统一封装的行为契约。
 *
 * 覆盖：
 * 1. 正常路径：文件存在 → 可读、内容完整、不触发 error/warn；
 * 2. 竞态路径：文件在 existsSync 判定后、流 open 前被删（用不存在的路径
 *    模拟 open 失败）→ 'error' 事件被封装内的监听捕获（不再无监听冒泡为
 *    uncaughtException）、logger.warn 记录路径、流被 destroy 释放句柄。
 *
 * 本 spec 不直接调用裸 fs.createReadStream——守卫
 * （__tests__/response-stream-error-listener.guard.spec.ts）会扫描它。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createResponseReadStream } from "./response-stream.util";

describe("P1-2 createResponseReadStream — 下载流 error 监听封装", () => {
  let dir: string;
  let warn: jest.Mock;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "resp-stream-"));
    warn = jest.fn();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("文件存在：内容完整读出，零 error / 零 warn", async () => {
    const file = join(dir, "pkg.zip");
    writeFileSync(file, "package-bytes");

    const stream = createResponseReadStream(file, { warn });
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      stream.on("data", (c: string | Buffer) => chunks.push(Buffer.from(c)));
      stream.on("end", () => resolve());
      stream.on("error", reject);
    });

    expect(Buffer.concat(chunks).toString("utf-8")).toBe("package-bytes");
    expect(warn).not.toHaveBeenCalled();
  });

  it("文件缺失（判定后窗口期被删的竞态）：error 被监听捕获并降级为 warn + destroy", async () => {
    const missing = join(dir, "gone.bin");
    const stream = createResponseReadStream(missing, { warn });

    const err: unknown = await new Promise((resolve) => {
      // 第二个 error 监听：封装内的监听先注册（先执行），此处仅用于观测
      stream.once("error", resolve);
    });

    // 注意：--experimental-vm-modules 下 node:fs 抛出的 Error 属宿主 realm，
    // `err instanceof Error` 会是 false —— 只能断言其内容（code/message 串）。
    expect(String(err)).toContain("ENOENT");
    // 降级为 warn（带路径），而不是让 EventEmitter 无监听 error 冒泡
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain(missing);
    // 句柄释放：destroy 已被封装调用（open 失败场景流进入 destroyed 态）
    await new Promise((r) => setImmediate(r));
    expect(stream.destroyed).toBe(true);
  });
});
