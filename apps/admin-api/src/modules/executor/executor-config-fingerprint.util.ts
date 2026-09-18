import { createHash } from "crypto";
import { ConfigService } from "@nestjs/config";
import { Executor } from "./entities/executor.entity";

/**
 * E-1（中台↔执行器深度审查）：pull 模式执行器的配置热更新。
 *
 * 背景：执行器的配置热更新只有 admin 主动 POST /api/config/reload 一条通道；
 * pull 执行器（NAT 内、零入站）无法被推送，配置变更要等其重启才生效。方案：
 * pull 长轮询响应附带 `configVersion` 指纹，执行器检测到变化后主动
 * GET /api/executors/config 拉取全量配置（push 执行器行为不变）。
 *
 * 指纹覆盖「执行器侧生效配置」的同一字段集（与 reloadConfig 推送体一致）：
 * - maxConcurrentTasks：按执行器行（每执行器独立）——admin UI 推送该值时
 *   落的就是执行器行字段；
 * - heartbeatIntervalSeconds：全局 executor.heartbeatInterval；
 * - adminApiUrl：执行器可回连的 admin 对外基址（app.adminApiUrl，R-12 收编）。
 * 任一变化 → 指纹变化 → pull 执行器下一轮检测到并拉取。确定性：同配置在任何
 * 实例产出同指纹（便于对账）。sha256 截短 16 hex（32 位安全空间，非安全边界，
 * 仅作变更信号，不做认证）。
 */
export function buildExecutorConfigPayload(
  cfg: ConfigService,
  executor: Pick<Executor, "maxConcurrentTasks"> | null,
): Record<string, unknown> {
  const heartbeatIntervalMs =
    cfg.get<number>("executor.heartbeatInterval") ?? 30_000;
  const payload: Record<string, unknown> = {
    maxConcurrentTasks: executor?.maxConcurrentTasks ?? null,
    heartbeatIntervalSeconds: Math.max(
      1,
      Math.round(heartbeatIntervalMs / 1000),
    ),
  };
  // R12-fix（pull-mode 自检根因）：`app.adminApiUrl` 未配置时**省略**该字段，
  // 而不是回退为 ""。空字符串下发到执行器后，/config/reload 会把 adminApiUrl
  // 置空并重建 admin client 列表为 []——pull 执行器的长轮询/心跳从此全部
  // `Request failed after all retries`（retryCount=0 的兜底错误），执行器被
  // 误判 OFFLINE。未配置本就是「没这个信息」，不应下发一个破坏性空值。
  const adminApiUrl = cfg.get<string>("app.adminApiUrl");
  if (adminApiUrl && adminApiUrl.trim()) {
    payload.adminApiUrl = adminApiUrl;
  }
  return payload;
}

export function computeExecutorConfigFingerprint(
  cfg: ConfigService,
  executor: Pick<Executor, "maxConcurrentTasks"> | null,
): string {
  const payload = buildExecutorConfigPayload(cfg, executor);
  return createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex")
    .slice(0, 16);
}
