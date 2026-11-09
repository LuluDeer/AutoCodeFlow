import { Logger } from "@nestjs/common";
import { AppError } from "../../common/errors/app-error";
import {
  DISPATCH_PARAM_KEY_PATTERN,
  filterDispatchParamKeys,
  summarizeRejectedParamKeys,
} from "./dispatch-params-keys.util";
import {
  buildInterpreterMismatchMessage,
  hasRequestedVersion,
  interpreterSatisfies,
} from "./interpreter-match.util";
import { isOnlineDownloadable } from "../task/runtime-version.util";
import type { Executor } from "./entities/executor.entity";
import type { Task } from "../task/entities/task.entity";
import type { TaskExecution } from "../task/entities/task-execution.entity";

/**
 * T1-B3a：**派发载荷与候选过滤的纯计算**协作者。
 *
 * ## 边界：只搬「算什么」，不搬「什么时候算」
 *
 * 本类只收三件事：
 *   ① 派发载荷的**合并与解密**（params + secrets）；
 *   ② 解释器候选过滤（硬过滤 + 失败消息构造）；
 *   ③ traceparent 头值构造。
 *
 * 三件事都是**纯计算 / 零 DB 往返 / 零事务**，因此搬出对行为面零影响
 * （唯一的外部副作用是 logger.warn 与抛错，形态逐字保留）。
 *
 * ## 为什么 `failInterpreterUnavailable` 的**抛点留 Facade**
 *
 * 跨文件（`common/failure-classification/failure-patterns.ts` 与
 * `task/task.processor.ts`）把「失败堆栈帧含 `ExecutorService.failInterpreterUnavailable`」
 * 当作**分类链顺序保护**的依据写进了注释与断言（见 `failure-patterns.ts` ②：
 * `EXECUTOR_OFFLINE_PATTERN` 的 `/executor.*(offline|unavailable)/i` 会从
 * `ExecutorService...Unavailable` 命中并把解释器缺失误判成 executor_offline）。
 *
 * 那些文件**不在本簇的写入范围**（跨模块边界），且它们依赖的是**堆栈帧的函数名**。
 * 若把抛点搬进协作者，堆栈帧名变成 `ExecutorDispatchPayload.failInterpreterUnavailable`
 * —— 分类结果**恰好不变**（消息里 `[interpreter_unavailable]` token 已由规则②
 * 先命中，码化优先也先行），但那 4 个跨模块文件的注释与断言依据会**静默漂移**
 * （读起来像在描述一个已不存在的栈帧）。
 *
 * ⇒ 抛点**留在 Facade**（方法名逐字不变），本类只提供「消息构造」这一半。
 * Facade 的方法体是 `throw`，不是转发 ⇒ `jest.spyOn` 依然拦得到，
 * 堆栈帧仍是 `ExecutorService.failInterpreterUnavailable`。
 */

/** 解密派发用（Facade 的 `secretsCrypto`；本类只用到这一个方法）。 */
export interface DispatchSecretsDecryptor {
  decryptForDispatch(
    secrets: Record<string, unknown> | null | undefined,
  ): Record<string, unknown> | null | undefined;
}

/** traceparent 构造（Facade 的 `tracing`；可缺席 ⇒ 零注入）。 */
export interface DispatchTraceparentBuilder {
  buildTraceparentFromTraceId(
    traceId: string | null | undefined,
  ): string | null;
}

/** 协作者依赖（全部最小面）。 */
export interface ExecutorDispatchPayloadDeps {
  /** 解密服务（SEC-02）。 */
  secretsCrypto: DispatchSecretsDecryptor;
  /** 追踪服务（可缺席 ⇒ traceparent 恒 null）。 */
  tracing: DispatchTraceparentBuilder | null;
  /** 日志（**必须是 Facade 的实例**——既有 spec spy 的是它）。 */
  logger: Logger;
}

export class ExecutorDispatchPayload {
  private readonly secretsCrypto: DispatchSecretsDecryptor;
  private readonly tracing: DispatchTraceparentBuilder | null;
  private readonly logger: Logger;

  constructor(deps: ExecutorDispatchPayloadDeps) {
    this.secretsCrypto = deps.secretsCrypto;
    this.tracing = deps.tracing;
    this.logger = deps.logger;
  }

  /**
   * SEC-02: build the executor-bound `params` payload = execution params
   * merged with decrypted task.secrets. Secrets WIN over params (a credential
   * set at task level must not be shadowable by a per-trigger param of the
   * same name — executors map every entry to AUTOFLOW_<KEY> env vars). The
   * merged map lives only on the dispatch HTTP payload: it is never persisted
   * back to TaskExecution.params, so plaintext never re-enters the database.
   * A decryption failure (e.g. key missing/rotated away) surfaces as a
   * dispatch error and the execution fails with a clear message instead of
   * silently running without its credentials.
   */
  buildDispatchParams(
    task: Task,
    execution: TaskExecution,
  ): Record<string, unknown> {
    const params = (execution.params ?? task.params ?? {}) as Record<
      string,
      unknown
    >;
    let decrypted: Record<string, unknown> | null | undefined;
    try {
      decrypted = this.secretsCrypto.decryptForDispatch(task.secrets);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new AppError("TASK_SECRET_DECRYPT_FAILED", {
        detail: message,
      });
    }
    // P2-2（2026-10-26 执行器域审计）：params 键名闸（源头主闸）。非法键
    // skip + warn（不 400——params 来自用户配置面，跳过坏键保留好键；与
    // secrets 的 skip-and-warn 同策），规则 SSOT 见
    // dispatch-params-keys.util.ts 头注（protocol.json params 段；执行器
    // node/python 两侧还有同款纵深闸）。任务面可观测：warn 带 taskId/
    // executionId，坏键清单截断防刷屏。secrets 合并在**其后**且不受影响
    // （secrets 键名有自己的更严规则，由执行器侧 secret-env 闸负责）。
    const { kept, rejected } = filterDispatchParamKeys(params);
    if (rejected.length > 0) {
      this.logger.warn(
        `Dispatch params key gate (P2-2): dropped ${rejected.length} param ` +
          `key(s) that cannot become AUTOFLOW_<KEY> env names (pattern ` +
          `${DISPATCH_PARAM_KEY_PATTERN}): ` +
          `${summarizeRejectedParamKeys(rejected)} ` +
          `[task ${task.id} execution ${execution.id}]`,
      );
    }
    return { ...kept, ...(decrypted ?? {}) };
  }

  /**
   * SEC-02 续（生产故障）：把解密后的 secrets **单独**作为派发载荷的 `secrets`
   * 字段下发，供执行器按**原名**注入子进程 env。
   *
   * 为什么需要单独一份（而不是只走既有的 params 合并）：此前 secrets 与 params
   * 合并后统一加 `AUTOFLOW_` 前缀，于是"配置 FEISHU_APP_ID"实际注入的是
   * `AUTOFLOW_FEISHU_APP_ID`——脚本按提示读裸名永远取不到（生产实证），而
   * **第三方 SDK 认的就是规范名**（boto3 的 AWS_ACCESS_KEY_ID、openai 的
   * OPENAI_API_KEY），加前缀后脚本无法改写，凭据等于不可用。
   *
   * 兼容性（关键）：secrets **仍然**合并进 params（`buildDispatchParams`
   * 不动），所以：
   *   · 旧执行器（不认识 `secrets` 字段）行为与今日**逐字节一致**——它们照旧
   *     只读 params，照旧注入 `AUTOFLOW_<KEY>`；
   *   · 新执行器额外按原名注入一份，两种读法并存。
   * 因此本字段是**纯增量**，无需协议版本门禁（不 bump PROTOCOL_VERSION：没有
   * 任何行为依赖"对方是否认识它"）。这与 v2 `commands` 的情形不同——那里必须
   * 门禁，因为 v1 执行器会静默丢弃命令、中台却会误判投递成功。
   *
   * 解密失败与 `buildDispatchParams` 同策：抛错让派发失败，绝不静默裸跑。
   */
  buildDispatchSecrets(task: Task): Record<string, unknown> | null {
    try {
      return this.secretsCrypto.decryptForDispatch(task.secrets) ?? null;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new AppError("TASK_SECRET_DECRYPT_FAILED", {
        detail: message,
      });
    }
  }

  /**
   * python_task_multiversion（WS2 · CONTRACT §2.3）：解释器缓存池过滤。
   *
   * 三个调度站点（`selectLeastLoaded` / `dispatch` / `dispatchBroadcast`）共享同一
   * 实现，杜绝三份漂移（对齐 `executor-score.util` 的抽取先例）。
   *
   * 语义全部由 `interpreter-match.util` 承载（NFR-08：纯内存、O(清单长度)、
   * **零** DB/网络往返）；本方法只做「过滤 + 失败时构造含快照的消息」。
   *
   * 返回 `{ kept, message }`：`message` 非 null 表示过滤后无候选，调用方按各自
   * 既有异常类型抛出（`ServiceUnavailableException` vs `Error` 的语义不变）。
   * `message` 里含**过滤前**每个候选执行器的已缓存解释器快照（AC-09b）。
   *
   * 未声明 `runtimeVersion` 时零过滤（`hasRequestedVersion` 判定）——存量任务
   * 的调度路径逐字节不变（兼容性红线 1）。
   */
  applyInterpreterFilter(
    executors: Executor[],
    requested: string | null | undefined,
  ): { kept: Executor[]; message: string | null } {
    if (!hasRequestedVersion(requested)) {
      return { kept: executors, message: null };
    }
    const requestedVersion = (requested as string).trim();
    const kept = executors.filter((e) =>
      interpreterSatisfies(e.interpreters, requestedVersion),
    );
    if (kept.length > 0) return { kept, message: null };
    // 在线可下载版本（3.8+，CONTRACT §1.1 ONLINE_DOWNLOAD_MIN）：缓存缺失不拦——
    // 派到任意在线执行器，执行器侧 ensureVersion() 会用 `uv python install` 按需
    // 下载并缓存（执行器已内嵌 uv，见 bundle-executor.sh ACF_UV_REQUIRED=1）。
    // 前端 interpreterFleetAdvisory 对在线层同样只提示不阻断，此处对齐。
    // 仅离线层（3.7，uv 无法在线下载）才硬拦——必须由部署方预填缓存卷。
    if (isOnlineDownloadable(requestedVersion)) {
      return { kept: executors, message: null };
    }
    return {
      kept,
      message: buildInterpreterMismatchMessage(
        requestedVersion,
        executors.map((e) => ({
          appName: e.appName,
          interpreters: e.interpreters,
        })),
      ),
    };
  }

  /**
   * OBS-01: 由执行行上的 traceId 构造回传/透传 traceparent 头值。
   * traceId 为 null（追踪未开启）或非法时返回 null——injectContext 不注入。
   */
  buildExecutionTraceparent(
    execution: Pick<TaskExecution, "traceId">,
  ): string | null {
    return this.tracing?.buildTraceparentFromTraceId(execution.traceId) ?? null;
  }
}
