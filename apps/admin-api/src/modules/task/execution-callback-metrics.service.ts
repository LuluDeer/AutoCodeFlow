import { Injectable } from "@nestjs/common";

/**
 * N32 (round-9, 交接 #3): per-execution callback 401 分类观测。
 *
 * 背景：per-execution `v1.` 回调 token（N23/N26/N27）落地后，生产排障需要
 * 区分 401 的具体原因——token 过期、executionId 绑定错、签名错、共享 token
 * 不匹配、缺 token、缺 executorAddress——而不是只看到一条 Unauthorized。
 *
 * 设计对齐 SchedulerMetricsService（R4-§5.5）的轻量进程内计数模式：
 * - 零新依赖（prom-client 只在抓取侧的 PrometheusMetricsService 里做映射，
 *   热路径只碰内存计数器）；
 * - 单调计数、永不重置，快照是唯一事实来源；PrometheusMetricsService 在
 *   每次 render 时 reset+inc 按快照绝对值重建 series（counter 语义成立）；
 * - per-process 计数，多实例部署由 Prometheus per-target 抓取天然区分。
 *
 * 埋点位置取舍：token 校验的纯函数层（execution-callback-token.util.ts）
 * 刻意保持无 Nest 依赖——它是与 executor-node 签名端共享的算法（测试向量
 * 双向钉死），不注入 service。分类计数因此收回 controller 层：失败分支的
 * 消息本就在此抛出，expired 与 bad-signature 的区分通过结构重解析
 * （parseExecutionCallbackToken，无 HMAC 重算）派生，成本可忽略。
 */

/** 认证结果分类：ok + 六类失败原因（与 controller 的抛错分支一一对应）。 */
export const EXECUTION_CALLBACK_AUTH_RESULTS = [
  /** 认证通过（v1 token 或 legacy per-address/共享 token） */
  "ok",
  /** `v1.` token 已过期（expiresAt <= now，fail-closed） */
  "v1_expired",
  /** `v1.` token 有效但 batch 中某 item 的 executionId 与绑定不符 */
  "v1_binding_mismatch",
  /** `v1.` token 签名不被任何候选 secret（fleet 全局 / per-executor）接受，或结构畸形 */
  "v1_bad_signature",
  /** legacy 路径：per-address 校验失败且共享 token 兜底也失败 */
  "legacy_shared_invalid",
  /** 请求完全没带 bearer token */
  "missing_token",
  /** legacy 路径：某 callback item 缺 executorAddress */
  "bad_address",
] as const;

export type ExecutionCallbackAuthResult =
  (typeof EXECUTION_CALLBACK_AUTH_RESULTS)[number];

export interface ExecutionCallbackMetricsSnapshot {
  /** 各认证结果的单调累计计数（缺失分类以 0 呈现，series 集合稳定） */
  auth: Record<ExecutionCallbackAuthResult, number>;
  /** 进程启动时间（ISO），供速率计算与实例区分 */
  startedAt: string;
}

@Injectable()
export class ExecutionCallbackMetricsService {
  private readonly startedAt = new Date();
  private readonly auth = new Map<ExecutionCallbackAuthResult, number>();

  /** 记录一次回调认证结果（成功或某一失败分类）。 */
  recordAuthResult(result: ExecutionCallbackAuthResult): void {
    this.auth.set(result, (this.auth.get(result) ?? 0) + 1);
  }

  get snapshot(): ExecutionCallbackMetricsSnapshot {
    const counts = {} as Record<ExecutionCallbackAuthResult, number>;
    for (const result of EXECUTION_CALLBACK_AUTH_RESULTS) {
      counts[result] = this.auth.get(result) ?? 0;
    }
    return { auth: counts, startedAt: this.startedAt.toISOString() };
  }
}
