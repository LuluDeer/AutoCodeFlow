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
import * as path from "path";
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

/**
 * 启动判据必须是 **argv[1] === 本文件**，不能只看 `require.main === module`：
 * ts-jest 加载 `.spec.ts` 时也会把 module 当作 require.main（实测 CI
 * 46136854131：夹具在 Jest 进程里真的 listen 了，留下 open handle 让 Jest
 * 跑完不退出）。真 e2e 子进程由
 * `node -r ts-node/register/transpile-only <本文件绝对路径>` 启动，argv[1]
 * 正是 __filename；Jest 下 argv[1] 是 jest 的 bin，两者不会相等。
 * 不能用 JEST_WORKER_ID 判定——admin-api e2e 用 `...process.env` 起子进程，
 * 该变量会继承进去。
 */
const launchedAsFixtureCli =
  require.main === module &&
  typeof process.argv[1] === "string" &&
  path.resolve(process.argv[1]) === path.resolve(__filename);

if (launchedAsFixtureCli) {
  void main().catch((err: unknown) => {
    process.stderr.write(
      `EXECUTOR_FATAL ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
}

/**
 * 文件名以 `.spec.ts` 结尾，Jest 会把它当测试套件收进来，但本文件的主体是
 * 子进程夹具而非用例（空套件必红）。按仓库既有范式（参见
 * interpreters.integration.spec.ts 的 describeIf）显式挂一条 SKIP 用例，
 * 让 Jest 侧有明确判据且不会启动真实 server；真用例仍由 admin-api e2e 驱动。
 */
// Jest 运行时才有 describe/it；admin-api e2e 以 ts-node 直接执行本文件时
// 它们不存在，必须跳过这段注册，否则子进程在 main() 启动后立刻 ReferenceError。
if (typeof describe === "function" && typeof it === "function") {
  describe.skip("attemptSeq HTTP 子进程夹具（由 admin-api e2e 驱动）", () => {
    it("由 apps/admin-api/test/attemptseq-http.e2e-spec.ts 以子进程启动，Jest 内显式跳过", () => {
      expect(true).toBe(true);
    });
  });
}
