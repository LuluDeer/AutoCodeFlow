import * as net from "net";
import { Logger } from "@nestjs/common";

/**
 * SEC-05: optional ClamAV (clamd) virus-scanning hook for the upload path.
 *
 * Protocol (clamd INSTREAM, TCP): client opens a connection and sends
 * `zINSTREAM\0`, then a sequence of chunks — each prefixed by a 4-byte
 * big-endian length — terminated by a zero-length chunk. clamd replies with
 * a single line: `stream: OK` when clean, or
 * `stream: <name> FOUND` / `stream: <error> ERROR` otherwise.
 *
 * Failure policy — FAIL-CLOSED (documented decision, security default):
 * when CLAMD_ENABLED=true and the scanner cannot be reached, times out, or
 * answers with anything other than an explicit OK, the upload is REJECTED.
 * Rationale: a scan hook that silently passes unverifiable content is worse
 * than no hook — the operator explicitly opted in, so absence of a verdict
 * must not become an implicit allow. Operators who prefer availability over
 * strictness can simply leave CLAMD_ENABLED=false (default; zero impact).
 */

export type ClamdVerdict =
  | { ok: true }
  | {
      ok: false;
      reason: "unreachable" | "timeout" | "infected" | "error";
      detail: string;
    };

export interface ClamdConfig {
  enabled: boolean;
  host: string;
  port: number;
  /** Per-upload socket/read timeout in ms (default 10 000). */
  timeoutMs: number;
}

export const CLAMD_DEFAULT_TIMEOUT_MS = 10_000;

export class ClamdUnavailableError extends Error {
  constructor(
    public readonly reason: "unreachable" | "timeout" | "error",
    message: string,
  ) {
    super(message);
    this.name = "ClamdUnavailableError";
  }
}

export class ClamdInfectionError extends Error {
  constructor(public readonly signature: string) {
    super(`Virus scan detected infection: ${signature}`);
    this.name = "ClamdInfectionError";
  }
}

/** Parse one clamd INSTREAM reply line into a verdict (pure, testable). */
export function parseClamdReply(reply: string): ClamdVerdict {
  const line = reply.trim();
  if (/^stream:\s*OK$/i.test(line)) {
    return { ok: true };
  }
  const found = line.match(/^stream:\s*(.+?)\s+FOUND$/i);
  if (found) {
    return { ok: false, reason: "infected", detail: found[1] };
  }
  const err = line.match(/^stream:\s*(.+?)\s+ERROR$/i);
  if (err) {
    return { ok: false, reason: "error", detail: err[1] };
  }
  return { ok: false, reason: "error", detail: line || "(empty reply)" };
}

/**
 * Stream a buffer to clamd via INSTREAM and resolve with the verdict.
 * Never throws — failures come back as { ok:false } so the caller maps them
 * to the right HTTP semantics (infection → 400, unavailability → 503).
 */
export async function scanBufferWithClamd(
  buf: Buffer,
  cfg: ClamdConfig,
  logger?: Pick<Logger, "warn" | "error">,
): Promise<ClamdVerdict> {
  if (!cfg.enabled) {
    // Disabled = hook absent, not "clean". The caller must not invoke this
    // path when disabled; returning ok keeps the type total.
    return { ok: true };
  }
  return new Promise<ClamdVerdict>((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const replyChunks: Buffer[] = [];

    const finish = (verdict: ClamdVerdict) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(verdict);
    };

    const timer = setTimeout(() => {
      logger?.warn?.(
        `clamd scan timed out after ${cfg.timeoutMs}ms (${cfg.host}:${cfg.port})`,
      );
      finish({ ok: false, reason: "timeout", detail: "clamd scan timed out" });
    }, cfg.timeoutMs);

    socket.once("error", (err: Error) => {
      clearTimeout(timer);
      logger?.warn?.(`clamd unreachable at ${cfg.host}:${cfg.port}: ${err.message}`);
      finish({
        ok: false,
        reason: "unreachable",
        detail: `clamd unreachable: ${err.message}`,
      });
    });

    socket.connect(cfg.port, cfg.host, () => {
      // Greeting then chunked body: <len:u32be><bytes> ... <0:u32be>.
      socket.write("zINSTREAM\0");
      const CHUNK = 32_768;
      for (let off = 0; off < buf.length; off += CHUNK) {
        const slice = buf.subarray(off, Math.min(off + CHUNK, buf.length));
        const prefix = Buffer.alloc(4);
        prefix.writeUInt32BE(slice.length, 0);
        socket.write(prefix);
        socket.write(slice);
      }
      const terminator = Buffer.alloc(4);
      terminator.writeUInt32BE(0, 0);
      socket.write(terminator);
      socket.end();
    });

    socket.on("data", (chunk: Buffer) => replyChunks.push(chunk));
    socket.on("close", () => {
      clearTimeout(timer);
      const reply = Buffer.concat(replyChunks).toString("utf8");
      const verdict = parseClamdReply(reply);
      if (isFailedVerdict(verdict) && verdict.reason !== "infected") {
        // Scanner-side ERROR / empty reply — surfaced as unavailability so
        // the fail-closed caller can distinguish 503 from 400.
        logger?.warn?.(`clamd scan error: ${verdict.detail}`);
      }
      finish(verdict);
    });
  });
}

/** Type guard: does this verdict carry failure details? */
export function isFailedVerdict(
  v: ClamdVerdict,
): v is Extract<ClamdVerdict, { ok: false }> {
  return v.ok === false;
}
