/**
 * SEC-05: clamd INSTREAM client spec — protocol parsing + fail-closed
 * socket behavior against a local TCP fake. EICAR test string is used as
 * the sample payload (harmless by design, per EICAR convention).
 */
import * as net from "net";
import * as http from "http";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { PassThrough } from "stream";
import { EICAR_STRING } from "./zip-samples";
import {
  isFailedVerdict,
  parseClamdReply,
  scanBufferWithClamd,
  scanStreamWithClamd,
} from "../clamd-scan.util";

/** Minimal fake clamd: asserts the INSTREAM framing, replies with canned text. */
function startFakeClamd(
  reply: string | null,
  opts: { delayMs?: number; dropConn?: boolean } = {},
): Promise<{ port: number; close: () => void; gotChunks: number[] }> {
  const server = net.createServer((socket) => {
    let greeted = false;
    const sizes: number[] = [];
    let pending: Buffer = Buffer.alloc(0);
    const tryRead = () => {
      // First 9 bytes: "zINSTREAM\0"
      if (!greeted) {
        if (pending.length < 10) return;
        const greet = pending.subarray(0, 10).toString("latin1");
        if (greet === "zINSTREAM\0") greeted = true;
        else socket.destroy();
        pending = pending.subarray(10);
      }
      while (greeted && pending.length >= 4) {
        const size = pending.readUInt32BE(0);
        if (size === 0) {
          if (reply === null && opts.dropConn) return socket.destroy();
          const send = () => {
            if (reply !== null) socket.write(reply);
            socket.end();
          };
          if (opts.delayMs) {
            setTimeout(send, opts.delayMs);
          } else {
            send();
          }
          return;
        }
        if (pending.length < 4 + size) return;
        sizes.push(size);
        pending = pending.subarray(4 + size);
      }
    };
    socket.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      tryRead();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as net.AddressInfo;
      resolve({
        port: addr.port,
        close: () => server.close(),
        gotChunks: [],
      });
    });
  });
}

describe("clamd-scan.util (SEC-05)", () => {
  describe("parseClamdReply", () => {
    it("stream: OK → clean", () => {
      expect(parseClamdReply("stream: OK")).toEqual({ ok: true });
      expect(parseClamdReply("stream:OK\n")).toEqual({ ok: true });
    });
    it("EICAR signature FOUND → infected with signature name", () => {
      const v = parseClamdReply("stream: Eicar-Signature FOUND");
      expect(v).toEqual({
        ok: false,
        reason: "infected",
        detail: "Eicar-Signature",
      });
    });
    it("scanner ERROR → error verdict", () => {
      const v = parseClamdReply("stream: lseek() FAILED ERROR");
      expect(isFailedVerdict(v)).toBe(true);
      if (isFailedVerdict(v)) {
        expect(v.reason).toBe("error");
      }
    });
    it("空/垃圾回复 → error（fail-closed 语义）", () => {
      expect(parseClamdReply("").ok).toBe(false);
      expect(parseClamdReply("garbage").ok).toBe(false);
    });
    it("isFailedVerdict 类型守卫", () => {
      expect(isFailedVerdict({ ok: true })).toBe(false);
      expect(isFailedVerdict({ ok: false, reason: "error", detail: "x" })).toBe(
        true,
      );
    });
  });

  describe("scanBufferWithClamd (真实 TCP 假服务器)", () => {
    const cfg = (port: number, timeoutMs = 5000) => ({
      enabled: true,
      host: "127.0.0.1",
      port,
      timeoutMs,
    });

    it("清洁回复 → ok（发送了 INSTREAM 分块帧）", async () => {
      const fake = await startFakeClamd("stream: OK\n");
      try {
        const v = await scanBufferWithClamd(
          Buffer.from(EICAR_STRING, "ascii"),
          cfg(fake.port),
        );
        expect(v).toEqual({ ok: true });
      } finally {
        fake.close();
      }
    });

    it("EICAR 检出 FOUND → infected 拒绝", async () => {
      const fake = await startFakeClamd("stream: Eicar-Test-Signature FOUND\n");
      try {
        const v = await scanBufferWithClamd(
          Buffer.from(EICAR_STRING, "ascii"),
          cfg(fake.port),
        );
        expect(v.ok).toBe(false);
        expect(isFailedVerdict(v) && v.reason).toBe("infected");
      } finally {
        fake.close();
      }
    });

    it("端口不可达 → unreachable（fail-closed）", async () => {
      const v = await scanBufferWithClamd(Buffer.from("x"), cfg(1, 2000));
      expect(v.ok).toBe(false);
      expect(isFailedVerdict(v) && v.reason).toBe("unreachable");
    });

    it("扫描超时/掐断 → fail-closed 拒绝", async () => {
      const fake = await startFakeClamd("stream: OK\n", { delayMs: 800 });
      try {
        const v = await scanBufferWithClamd(
          Buffer.from("x"),
          cfg(fake.port, 100),
        );
        expect(v.ok).toBe(false);
        // 定时器先触发→timeout；socket 在等待窗口内被 close（delayMs 未到
        // 时 fake 已 write 前 end 的路径）→error。两者均 fail-closed。
        expect(["timeout", "error"]).toContain(
          isFailedVerdict(v) ? v.reason : "ok",
        );
      } finally {
        fake.close();
      }
    });

    it("连接被扫描器半途掐断（空回复）→ error（fail-closed）", async () => {
      const fake = await startFakeClamd(null, { dropConn: true });
      try {
        const v = await scanBufferWithClamd(Buffer.from("x"), cfg(fake.port));
        expect(v.ok).toBe(false);
      } finally {
        fake.close();
      }
    });

    it("enabled=false → 不发流量直接放行（钩子关闭零影响）", async () => {
      const v = await scanBufferWithClamd(Buffer.from("x"), {
        enabled: false,
        host: "127.0.0.1",
        port: 1,
        timeoutMs: 100,
      });
      expect(v).toEqual({ ok: true });
    });
  });

  describe("scanStreamWithClamd", () => {
    const disabledCfg = {
      enabled: false,
      host: "127.0.0.1",
      port: 1,
      timeoutMs: 100,
    };
    const enabledCfg = (port: number, timeoutMs = 5000) => ({
      enabled: true,
      host: "127.0.0.1",
      port,
      timeoutMs,
    });

    it("enabled=false：挂一次性 error 监听并 destroy 流（fd 不泄漏）", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clamd-stream-"));
      try {
        const file = path.join(dir, "pkg.zip");
        fs.writeFileSync(file, "zip");
        const stream = fs.createReadStream(file);
        const v = await scanStreamWithClamd(stream, disabledCfg);
        expect(v).toEqual({ ok: true });
        expect(stream.destroyed).toBe(true);
        expect(stream.listenerCount("error")).toBeGreaterThanOrEqual(1);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it("ARCH-008 回归：禁用时遗留流的 error 有监听器，不再 uncaughtException", async () => {
      // 生产事故（2026-09-29）：controller 为禁用的扫描创建了
      // fs.createReadStream(tmpPath) 后无人消费——异步 open 失败（该文件
      // 随后被 rename 走）时 'error' 无监听器，Node 直接 throw 成
      // uncaughtException，整实例退出。这里用 emit 显式复现：无监听器时
      // EventEmitter.emit('error') 会同步 throw，本断言在修复前必失败。
      const stream = new PassThrough();
      const v = await scanStreamWithClamd(stream, disabledCfg);
      expect(v).toEqual({ ok: true });
      expect(() =>
        stream.emit("error", new Error("late async open failure")),
      ).not.toThrow();
    });

    it("enabled=true：文件流经 INSTREAM 分块发出，清洁回复 → ok", async () => {
      const fake = await startFakeClamd("stream: OK\n");
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clamd-stream-"));
      try {
        const file = path.join(dir, "pkg.zip");
        fs.writeFileSync(file, EICAR_STRING);
        const v = await scanStreamWithClamd(
          fs.createReadStream(file),
          enabledCfg(fake.port),
        );
        expect(v).toEqual({ ok: true });
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
        fake.close();
      }
    });

    it("enabled=true：源流 open 失败 → fail-closed 拒绝（不外抛）", async () => {
      const missing = path.join(
        os.tmpdir(),
        `clamd-missing-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      const v = await scanStreamWithClamd(
        fs.createReadStream(missing),
        enabledCfg(1, 2000),
      );
      expect(v.ok).toBe(false);
      // open 的 ENOENT 与 clamd 端口拒连存在竞态，两者均为 fail-closed 裁决。
      expect(["error", "unreachable"]).toContain(
        isFailedVerdict(v) ? v.reason : "ok",
      );
    });
  });
});

// Silence unused-import lint for the http module in strict CI configs.
void http;
