/**
 * attemptSeq HTTP e2e 的 executor-node 真进程夹具。
 *
 * 这不是 Jest 用例：它由 apps/admin-api/test/attemptseq-http.e2e-spec.ts
 * 以 `node -r ts-node/register/transpile-only` 子进程启动，直接挂载产品代码里的
 * `executeRouter` + `verifyToken` + 回调线程，不复制/伪造路由逻辑。
 *
 * 进程协议（stdout，父进程按行解析）：
 *   EXECUTOR_READY <port> <address> <pid>
 *   DISPATCH_OBSERVED <json>        # 每条真 HTTP /api/execute 打一行
 */
import express from "express";
import { initAdminClients } from "./admin-client";
import { startCallbackThread, stopCallbackThread } from "./callback";
import { verifyToken } from "./middleware/auth";
import { executeRouter } from "./routes/execute";

function observed(body: unknown): Record<string, unknown> {
  const value = (body ?? {}) as Record<string, unknown>;
  const task = (value.task ?? {}) as Record<string, unknown>;
  return {
    executionId: value.executionId ?? null,
    attemptSeq: value.attemptSeq ?? null,
    bodyKeys: Object.keys(value).sort(),
    taskName: task.name ?? null,
  };
}

async function main(): Promise<void> {
  const port = Number(process.env.ATTEMPTSEQ_HTTP_EXEC_PORT || "0");
  const bind = process.env.ATTEMPTSEQ_HTTP_BIND || "0.0.0.0";
  const address = process.env.EXECUTOR_ADDRESS_PUBLIC || `${bind}:${port}`;
  const adminUrl = process.env.ADMIN_API_URL || "http://127.0.0.1:3105";

  initAdminClients([adminUrl]);
  startCallbackThread();

  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use((req, _res, next) => {
    if (req.method === "POST" && req.url.startsWith("/api/execute")) {
      process.stdout.write(`DISPATCH_OBSERVED ${JSON.stringify(observed(req.body))}\n`);
    }
    next();
  });
  // 真执行器中间件链：动态/静态令牌校验 + 产品 executeRouter。
  app.use("/api", verifyToken, executeRouter);

  const server = app.listen(port, bind, () => {
    const actualPort = (server.address() as { port: number }).port;
    process.stdout.write(
      `EXECUTOR_READY ${actualPort} ${address} ${process.pid}\n`,
    );
  });

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    const finish = (): void => {
      void stopCallbackThread()
        .catch(() => undefined)
        .finally(() => process.exit(0));
      setTimeout(() => process.exit(0), 3_000).unref();
    };
    server.close(finish);
    setTimeout(finish, 3_000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

if (require.main === module) {
  void main().catch((err: unknown) => {
    process.stderr.write(
      `EXECUTOR_FATAL ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
}
