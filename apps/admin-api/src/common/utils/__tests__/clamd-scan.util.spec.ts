/**
 * SEC-05: clamd INSTREAM client spec — protocol parsing + fail-closed
 * socket behavior against a local TCP fake. EICAR test string is used as
 * the sample payload (harmless by design, per EICAR convention).
 */
import * as net from "net";
import * as http from "http";
import { EICAR_STRING } from "./zip-samples";
import {
  isFailedVerdict,
  parseClamdReply,
  scanBufferWithClamd,
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
});

// Silence unused-import lint for the http module in strict CI configs.
void http;
