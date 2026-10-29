import {
  Controller,
  Logger,
  Post,
  Body,
  Headers,
  Param,
  ParseArrayPipe,
  Optional,
  Inject,
  forwardRef,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBody,
  ApiOkResponse,
} from "@nestjs/swagger";
import { ConfigService } from "@nestjs/config";
import { Public } from "../../common/decorators/public.decorator";
// LANG-ERR-01：用户可见失败抛稳定码 + 参数（文案由前端按用户语言翻译）。
import { AppError } from "../../common/errors/app-error";
import { TaskService } from "./task.service";
import { SystemConfigService } from "../config/config.service";
import { verifyExecutorToken } from "../../common/utils/verify-executor-token.util";
import {
  EXECUTION_CALLBACK_TOKEN_PREFIX,
  parseExecutionCallbackToken,
  verifyExecutionCallbackToken,
  ExecutionCallbackTokenClaims,
} from "./execution-callback-token.util";
import { ExecutionCallbackMetricsService } from "./execution-callback-metrics.service";
import { CallbackItemDto } from "./dto/execution-callback.dto";
import { AppendLogChunkDto } from "./dto/append-log-chunk.dto";
import { ExecutorService } from "../executor/executor.service";
// QA-05：回调档限流提为可配（解析语义与 throttle-profiles 同源）
import { positiveInt } from "../../config/throttle-profiles";
// OBS-01: 回调链路追踪——执行器回传 traceparent 头关联（disabled 时短路）。
import { TracingService } from "../../common/tracing/tracing.service";
import { WriteGuard } from "../../common/decorators/write-guard.decorator";
import {
  CallbackItemResultDto,
  LogChunkAckDto,
} from "../../common/dto/misc-2xx-response.dto";

/**
 * F-5: this controller used to be fully @SkipThrottle()'d — an unauthenticated
 * caller who knew (or guessed) a registered executor address could force
 * bcrypt compares + 55 MB JSON parsing with zero rate limiting. Restore a
 * RELAXED limit instead (heartbeats/callbacks legitimately arrive at ~2/min
 * per executor; 60/min gives 30x headroom) so abuse is still bounded.
 *
 * SEC-09: 机器回调面（executor → admin-api）语义保持不变——60/min 独立于
 * 人操作面的 strict/ops 档位（回调速率由 executor 心跳节奏决定，档位收紧
 * 只会误杀；分域矩阵见 src/config/throttle-profiles.ts 头注）。
 */
const CALLBACK_THROTTLE = {
  default: {
    // QA-05 回调档实测暴露：60/min 是**按 IP** 计的，而生产里大量执行器常位于
    // 同一出口 IP（NAT/机房 NAT/容器同宿主）之后，回调速率叠加后极易触顶——
    // 满批（100 条/请求）单 IP 上限 6000 条/分钟，10k 档根本达不到；执行器侧
    // 有文件级重试（不丢结果，但上报被推迟，可能与 stale sweep 的失败判定赛跑）。
    // 因此提为可配（默认仍 60，行为零变化）：多执行器同出口的部署按
    // 「执行器数 × 批次数/分钟 × 安全系数」调高。
    limit: positiveInt("THROTTLE_CALLBACK_LIMIT", 60),
    ttl: positiveInt("THROTTLE_CALLBACK_TTL", 60_000),
  },
};

const LOG_STREAM_THROTTLE = {
  default: {
    limit: positiveInt("THROTTLE_LOG_STREAM_LIMIT", 120),
    ttl: positiveInt("THROTTLE_LOG_STREAM_TTL", 60_000),
  },
};

@ApiTags("Execution Callback")
@Controller("executions")
export class ExecutionCallbackController {
  private readonly logger = new Logger(ExecutionCallbackController.name);

  constructor(
    private readonly taskService: TaskService,
    private readonly configService: ConfigService,
    private readonly systemConfigService: SystemConfigService,
    // 跨 task↔executor 模块环的 provider 注入：模块级 forwardRef 配套。
    @Inject(forwardRef(() => ExecutorService))
    private readonly executorService: ExecutorService,
    // N32: 401 分类观测计数（进程内，Prometheus 经快照映射暴露）。
    private readonly callbackMetrics: ExecutionCallbackMetricsService,
    // OBS-01: 回调 traceparent 头解析（@Optional 仅为既有单测装配兼容；
    // disabled/缺失时 extractContext 恒 null）。
    @Optional()
    private readonly tracing: TracingService | null,
  ) {}

  @WriteGuard("execution", {
    scope: "token",
    reason: "执行器持 per-execution HMAC 令牌回调执行结果",
  })
  @Post("callback")
  @Public()
  // F-5: relaxed-but-finite rate limit (see CALLBACK_THROTTLE above).
  @Throttle(CALLBACK_THROTTLE)
  @ApiOperation({
    description:
      "任务完成后由执行器（或持有本次执行 AUTOFLOW_CALLBACK_TOKEN 的任务代码）调用，用于上报执行结果。可使用执行器共享令牌/按地址令牌，或绑定到该批次 executionId 的本次执行 `v1.` HMAC 令牌（N23）。",
    summary: "执行结果回调",
  })
  @ApiOkResponse({
    type: [CallbackItemResultDto],
    description:
      "逐项受理结果（{executionId, success, error?}）；HTTP 200 由 @HttpCode 决定",
  })
  @ApiResponse({ status: 400, description: "请求体非法" })
  @ApiResponse({ status: 401, description: "共享令牌无效" })
  @ApiBody({
    type: [CallbackItemDto],
    description: "执行回调条目数组（最多 100 条）",
  })
  async callback(
    @Headers("authorization") auth: string | undefined,
    @Headers("traceparent") traceparent: string | undefined,
    @Body(new ParseArrayPipe({ items: CallbackItemDto, whitelist: true }))
    callbacks: CallbackItemDto[],
  ) {
    if (callbacks.length > 100) {
      throw new AppError("EXECUTION_CALLBACK_BATCH_TOO_LARGE");
    }
    if (callbacks.length === 0) {
      throw new AppError("EXECUTION_CALLBACK_BATCH_EMPTY");
    }
    const token = auth?.startsWith("Bearer ") ? auth.slice(7) : auth;
    if (!token) {
      // N32: 完全没带 token —— 与"带了但校验失败"区分开。
      this.callbackMetrics.recordAuthResult("missing_token");
      throw new AppError("EXECUTION_CALLBACK_TOKEN_MISSING");
    }

    // N23: per-execution callback token — minted by executor-node (HMAC
    // over executionId + expiry, keyed by the executor shared secret) and
    // injected into task subprocesses as AUTOFLOW_CALLBACK_TOKEN. It is a
    // one-shot authorization for EXACTLY one executionId, so task code can
    // call back without ever holding the shared token (SEC-01 preserved).
    // Any other bearer string keeps flowing down the legacy per-address /
    // shared-token path unchanged (backward compatibility).
    if (token.startsWith(EXECUTION_CALLBACK_TOKEN_PREFIX)) {
      await this.verifyPerExecutionCallbackToken(token, callbacks);
      // N32: 认证通过即计 ok（业务层 per-item 结果不属于认证维度）。
      this.callbackMetrics.recordAuthResult("ok");
      // OBS-01: 解析执行器回传的 traceparent 头关联链路（disabled=恒 null）。
      const cbTraceId = this.tracing?.extractContext(traceparent) ?? null;
      const endSpan = this.tracing?.startSpan(cbTraceId, "callback.receive", {
        items: callbacks.length,
      });
      try {
        const results = await this.taskService.handleCallback(callbacks);
        endSpan?.();
        return { results };
      } catch (err: unknown) {
        endSpan?.(err instanceof Error ? err.message : String(err));
        throw err;
      }
    }

    // TASK-001: per-item per-address token check — a single shared token
    // must NOT be allowed to confirm callbacks for executions belonging
    // to multiple executors, since that would bypass per-executor auth.
    // Each item carries its own executorAddress; we verify the bearer
    // token against the executor's stored hash and additionally ensure
    // every claimed executorAddress actually matches an execution row
    // (the service layer enforces the latter with executionAddress guards).
    //
    // ADR-017 阶段 3（复查补口）：鉴权时顺带解析**所持凭据属于哪一行**
    // （`credentialExecutorIdByAddress`），供 service 层做行身份判定。为什么
    // 在这里算：令牌是本请求的输入，凭据归属是**服务端推导**的事实——绝不
    // 能经 DTO 字段让调用方自报（那等于把不可伪造的判据交给伪造方）。
    //
    // ADR-017 阶段 3（协议 v6，方案 C 补口）：**行身份三级阶梯**——回调载荷
    // 现可携带 `deviceFingerprint`（与 register/heartbeat 同一稳定安装身份），
    // 它正好补上「共享令牌不绑定任何行」这个缺口：
    //   ① 指纹（v6 执行器上报的**真实**安装身份，服务端查库校验存在性）；
    //   ② 凭据归属行（presented token 的 bcrypt 命中行；per-executor 令牌专有）；
    //   ③ 地址（唯一时；legacy 兜底）。
    // 三级都拿不到 → 回落既有的地址相等判据（行为与引入前一致）。
    //
    // 为什么指纹不能单独作数（如实声明安全边界）：指纹是**自报值**，且随
    // ExecutorResponseDto 对任何登录用户可见（与 executorAddress 同等可探知）
    // ——故它不提升对抗**已持共享令牌**攻击者的强度（那类攻击者的强度上限本就
    // 由「共享令牌是全机队单一密钥」决定，是独立议题）。它解决的是**诚实执行器
    // 的归属**：同址多行时第二台如实上报自己的指纹，admin 据此把它与派发目标
    // 正确区分开，而不是靠「地址碰巧相等」误判成功。
    const seenAddresses = new Set<string>();
    const credentialExecutorIdByAddress = new Map<string, string | null>();
    // 指纹 → 行 id，**按 executionId 分键**（见下方为何不能按 address）。
    const fingerprintExecutorIdByExecution = new Map<string, string | null>();
    for (const item of callbacks) {
      const addr = item.executorAddress?.trim();
      if (!addr) {
        // N32: legacy 路径缺 executorAddress —— 归为 bad_address。
        this.callbackMetrics.recordAuthResult("bad_address");
        throw new AppError("EXECUTION_CALLBACK_ADDRESS_REQUIRED");
      }
      // ADR-017 阶段 3（协议 v6）：**行身份第一级**——回调自报的指纹经服务端
      // 规范化后查库解析到行。未上报/形态非法/查不到行 → null（视为未上报），
      // 由下一级（凭据归属行）与地址判据承接。
      //
      // **按 executionId 分键，而不是按 address**（这一点是刻意的）：同一批次
      // 里可以有两个同址但**不同行**的执行（pull 模式同址多行并存，ADR-017
      // §5）——它们各自上报自己的指纹。若按 address 分键（且落在下面的
      // `seenAddresses` 去重守卫之后），只会有第一条被解析，第二条会被拿
      // 第一条的行去做判定 → **误拒合法回调**。凭据归属行按 address 分键是
      // 对的（凭据本就是「该地址上的哪一行」），指纹不是。
      //
      // 注意这里只做「规范化 + 查库」两件事，**不做校验**：指纹不是凭据，
      // 它的价值是给诚实执行器一条可精确归属的通道，而不是提高对抗强度
      //（该字段是自报值，见上方大段注释的安全边界声明）。
      fingerprintExecutorIdByExecution.set(
        item.executionId,
        await this.executorService.resolveExecutorIdByFingerprint(
          item.deviceFingerprint,
        ),
      );
      if (seenAddresses.has(addr)) continue;
      seenAddresses.add(addr);
      // ADR-017 阶段 3：回调 DTO 不带指纹（执行行只记地址），故用「同址任一行
      // 匹配即通过」——同址多行并存时按第一行取会误拒合法执行器（401 → 执行
      // 卡在 RUNNING 直到 stale sweep）。判定强度不变：每个候选都走完整比对。
      const isValid = await this.executorService.validateTokenByAddressAnyRow(
        addr,
        token,
      );
      if (!isValid) {
        // Fall back to the shared/legacy token sources only when there is
        // exactly ONE unique executor in the batch. Multi-executor batches
        // can never use a shared token.
        if (seenAddresses.size === 1) {
          try {
            await verifyExecutorToken(
              auth,
              this.configService,
              this.systemConfigService,
            );
          } catch (err) {
            // N32: per-address 校验失败且共享 token 兜底也失败。
            this.callbackMetrics.recordAuthResult("legacy_shared_invalid");
            throw err;
          }
        } else {
          this.callbackMetrics.recordAuthResult("legacy_shared_invalid");
          throw new AppError("EXECUTION_CALLBACK_ADDRESS_TOKEN_INVALID", {
            address: addr,
          });
        }
      }
      // ADR-017 阶段 3：凭据归属行 = 该地址上 tokenHash 匹配的那一行。
      // 共享令牌路径返回 null（共享令牌不绑定任何行）→ service 回落地址判据。
      credentialExecutorIdByAddress.set(
        addr,
        await this.executorService.resolveCredentialExecutorId(addr, token),
      );
    }
    // N32: legacy 路径认证通过。
    this.callbackMetrics.recordAuthResult("ok");
    // OBS-01: legacy 回调路径同样解析 traceparent（disabled=短路）。
    const cbTraceId = this.tracing?.extractContext(traceparent) ?? null;
    const endSpan = this.tracing?.startSpan(cbTraceId, "callback.receive", {
      items: callbacks.length,
    });
    try {
      const results = await this.taskService.handleCallback(
        callbacks,
        credentialExecutorIdByAddress,
        fingerprintExecutorIdByExecution,
      );
      endSpan?.();
      return { results };
    } catch (err: unknown) {
      endSpan?.(err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  /**
   * N23: validate a `v1.` per-execution callback token.
   *
   * Rules (all fail-closed with 401):
   * - signature + TTL must verify against one of the candidate secrets
   *   (EXECUTION_CALLBACK_SECRET → DB executor.sharedToken → env
   *   executor.sharedToken, mirroring verifyExecutorToken's sources);
   * - N26 (round-8): when every fleet-global candidate fails, fall back to
   *   the PER-EXECUTOR credential — for each unique executorAddress in the
   *   batch, the executor's stored tokenHash (the same value the executor
   *   received at register time and uses as its HMAC source secret) is
   *   tried as the key. Lookups ride ExecutorService's 60s positive cache,
   *   mirroring the per-address token-validation pattern;
   * - every callback item's executionId must equal the executionId the
   *   token is bound to — a token authorizes its own execution only;
   * - N27 (round-8): items no longer need to carry executorAddress — the
   *   token is already execution-bound and the service layer
   *   (task.service.handleCallback) still compares any provided address
   *   against the execution row, so requiring it here only broke task code
   *   that cannot know the address.
   */
  private async verifyPerExecutionCallbackToken(
    token: string,
    callbacks: CallbackItemDto[],
  ): Promise<ExecutionCallbackTokenClaims> {
    const secrets = await this.resolveCallbackSecrets();
    let claims = verifyExecutionCallbackToken(token, secrets);
    if (!claims) {
      claims = await this.verifyAgainstPerExecutorSecrets(token, callbacks);
    }
    if (!claims) {
      // N32 分类取舍：token util 层是与 executor-node 签名端共享的纯函数
      // （算法由测试向量双向钉死），刻意不注入 Nest service；expired 与
      // bad-signature 的区分因此收回 controller，用结构重解析派生——
      // parseExecutionCallbackToken 无 HMAC 重算，成本可忽略。畸形 `v1.`
      // 串（解析失败）归入 v1_bad_signature。
      this.callbackMetrics.recordAuthResult(
        this.isV1TokenExpired(token) ? "v1_expired" : "v1_bad_signature",
      );
      throw new AppError("EXECUTION_CALLBACK_TOKEN_INVALID");
    }
    for (const item of callbacks) {
      if (item.executionId !== claims.executionId) {
        this.callbackMetrics.recordAuthResult("v1_binding_mismatch");
        throw new AppError("EXECUTION_CALLBACK_TOKEN_WRONG_EXECUTION");
      }
    }
    return claims;
  }

  /**
   * N32: structural expiry probe for the v1_expired vs v1_bad_signature
   * split. Mirrors verifyExecutionCallbackToken's fail-closed ordering
   * (expiry is checked before signatures, so an expired token classifies
   * as expired even if its signature would also have failed). A token that
   * cannot even be parsed is NOT expired — it is a bad signature.
   */
  private isV1TokenExpired(token: string): boolean {
    const parsed = parseExecutionCallbackToken(token);
    if (!parsed) return false;
    const nowSec = Math.floor(Date.now() / 1000);
    return (
      !Number.isFinite(parsed.expiresAtSec) || parsed.expiresAtSec <= nowSec
    );
  }

  /**
   * N26: per-executor HMAC fallback. A node installed with its own
   * `--secret` signs AUTOFLOW_CALLBACK_TOKEN with the credential it
   * received at register time (the stored tokenHash), which is not one of
   * the fleet-global candidates. Try each unique batch address' tokenHash
   * as the key; first structural match wins. Unknown addresses / missing
   * hashes are skipped (fail-closed overall).
   */
  private async verifyAgainstPerExecutorSecrets(
    token: string,
    callbacks: CallbackItemDto[],
  ): Promise<ExecutionCallbackTokenClaims | null> {
    const seen = new Set<string>();
    for (const item of callbacks) {
      const addr = item.executorAddress?.trim();
      if (!addr || seen.has(addr)) continue;
      seen.add(addr);
      // ADR-017 阶段 3：取该地址上**全部**行的 tokenHash 作候选——pull 模式
      // 允许同地址多行并存（ADR-017 §5），而执行行只记地址不记行身份。按地址
      // 取「第一行」会拿到别人的哈希 → 合法执行器验签失败 → 401 → 执行卡在
      // RUNNING 直到 stale sweep。逐个试不降低安全性（每个候选仍须通过完整
      // 签名校验），匹配即证明归属。
      const secrets =
        await this.executorService.getCallbackSecretCandidatesByAddress(addr);
      if (secrets.length === 0) continue;
      const claims = verifyExecutionCallbackToken(token, secrets);
      if (claims) return claims;
    }
    return null;
  }

  /**
   * RT-LOG: 实时日志流端点。
   *
   * 执行器在任务运行期间按增量分片上报日志行（fromLine + lines），落
   * ExecutionLogLine 后由既有的 SSE 通路（task.controller 的
   * `/tasks/:id/executions/:execId/logs/stream` → streamExecutionLogs 轮询）
   * 立即推给前端——即"执行中就能看到日志"，而不是等终态回调才一次性落库。
   *
   * 鉴权与 `POST /executions/callback` **同源**（同一套 per-execution HMAC
   * 令牌 / per-address / 共享令牌三层），因此这里只做「解析令牌 → 判定归属」
   * 两件事，判定逻辑复用既有私有方法，避免第二份实现漂移。
   */
  @WriteGuard("execution", {
    scope: "token",
    reason: "执行器持 per-execution HMAC 令牌流式上报运行中日志",
  })
  @Post(":id/logs")
  @Public()
  @Throttle(LOG_STREAM_THROTTLE)
  @ApiOperation({
    description:
      "任务仍在运行时由执行器调用，用于增量上报日志行。接受一段日志行及其从 0 开始的起始行号；重复上报同一区间是幂等的。鉴权：本次执行 `v1.` HMAC 令牌或按地址/per-executor 令牌（共享令牌不适用——它不绑定执行，见 SEC-R3-3）。",
    summary: "实时执行日志流式上报",
  })
  @ApiOkResponse({ type: LogChunkAckDto, description: "{count} 落账行数" })
  @ApiResponse({ status: 400, description: "请求体非法" })
  @ApiResponse({ status: 401, description: "执行器令牌无效" })
  @ApiResponse({ status: 404, description: "执行记录不存在" })
  @ApiBody({
    type: AppendLogChunkDto,
    description: "带 0 起始行偏移的日志块及其内容行",
  })
  async appendLogChunk(
    @Param("id") executionId: string,
    @Headers("authorization") auth: string | undefined,
    @Body() dto: AppendLogChunkDto,
  ): Promise<{ count: number }> {
    await this.authorizeExecutionWrite(executionId, auth);
    return this.taskService.appendLogChunk(
      executionId,
      dto.fromLine,
      dto.lines,
    );
  }

  /**
   * RT-LOG: 单执行维度的写授权——`POST /executions/:id/logs` 专用。
   *
   * 与 `callback` 的差别只在**粒度**：回调是批量端点，令牌要对批次里每个
   * executionId 都成立；这里是单执行端点，令牌只需绑定到路径上的那一个 id。
   * 因此逐层复用既有构件：
   *   - `v1.` 前缀 → resolveCallbackSecrets（fleet 全局候选）+ 该执行的
   *     executorAddress 的 tokenHash（N26 per-executor 兜底），最后校验
   *     `claims.executionId === executionId`（单执行绑定，比批量的逐项比对更严）；
   *   - 其它令牌 → per-address 校验；共享令牌兜底**一律拒绝**（SEC-R3-3：
   *     共享令牌不绑定行，无法证明调用者是这条 execution 的执行器——日志是
   *     写入型取证面，不能接受「任一台执行器都能写任意执行」。与 callback
   *     的共享兜底刻意不同：那边是旧版的**结果**上报主路径，拒绝会直接
   *     打断执行；本端点拒绝时日志退回终态回调，不丢结果）。
   *
   * 认证结果照常计入 callbackMetrics（N32 的分类观测面不因新增端点而缺口）。
   */
  private async authorizeExecutionWrite(
    executionId: string,
    auth: string | undefined,
  ): Promise<void> {
    const token = auth?.startsWith("Bearer ") ? auth.slice(7) : auth;
    if (!token) {
      // N32: 完全没带 token —— 与"带了但校验失败"区分开。
      this.callbackMetrics.recordAuthResult("missing_token");
      throw new AppError("EXECUTION_CALLBACK_TOKEN_MISSING");
    }

    if (token.startsWith(EXECUTION_CALLBACK_TOKEN_PREFIX)) {
      const secrets = await this.resolveCallbackSecrets();
      let claims = verifyExecutionCallbackToken(token, secrets);
      if (!claims) {
        // N26 per-executor 兜底：该执行的执行器用自己的 tokenHash 作 HMAC 源。
        const address =
          await this.taskService.findExecutionAddress(executionId);
        if (address) {
          // ADR-017 阶段 3：该地址上全部行的哈希都作候选（同址多行并存时按
          // 第一行取会验错密钥 → 合法日志流 401）。
          const secrets =
            await this.executorService.getCallbackSecretCandidatesByAddress(
              address,
            );
          if (secrets.length > 0) {
            claims = verifyExecutionCallbackToken(token, secrets);
          }
        }
      }
      if (!claims || claims.executionId !== executionId) {
        this.callbackMetrics.recordAuthResult(
          this.isV1TokenExpired(token) ? "v1_expired" : "v1_bad_signature",
        );
        throw new AppError("EXECUTION_CALLBACK_TOKEN_INVALID");
      }
      this.callbackMetrics.recordAuthResult("ok");
      return;
    }

    // 非 v1 令牌：per-address 校验（地址取自该执行行），失败退共享令牌。
    const address = await this.taskService.findExecutionAddress(executionId);
    if (!address) {
      this.callbackMetrics.recordAuthResult("bad_address");
      throw new AppError("EXECUTION_CALLBACK_ADDRESS_NOT_FOUND");
    }
    // ADR-017 阶段 3：同址任一行匹配即通过（理由见上文与 service 头注）。
    const isValid = await this.executorService.validateTokenByAddressAnyRow(
      address,
      token,
    );
    if (!isValid) {
      try {
        await verifyExecutorToken(
          auth,
          this.configService,
          this.systemConfigService,
        );
        // SEC-R3-3（第 3 轮并行审计 P2）：共享令牌只证明「某台合法执行器」，
        // 不证明「你就是这条 execution 的执行器」。日志是写入型取证面
        // （伪造排障/取证证据 + 行膨胀），不能像 v1/按地址令牌那样绑定到
        // 单条执行——共享令牌兜底一律拒绝。
        //
        // 为什么不能在这里做归属校验：共享令牌不携带行身份，路径上的
        // executionId 由调用方自报，没有可比对的第二个事实源。
        //
        // 兼容性：执行器侧的正常日志流走 `v1.` 单执行 HMAC 或 per-address
        // 令牌（N26/ADR-017）；共享令牌只是旧版的最后兜底，被拒时日志退回
        // 终态回调里的 logs 字段，不丢执行结果。
        this.logger.warn(
          `Execution log write rejected: shared executor token cannot bind to execution ${executionId} (SEC-R3-3)`,
        );
        this.callbackMetrics.recordAuthResult("legacy_shared_invalid");
      } catch (err) {
        this.callbackMetrics.recordAuthResult("legacy_shared_invalid");
        throw err;
      }
      throw new AppError("EXECUTION_CALLBACK_TOKEN_INVALID");
    }
    this.callbackMetrics.recordAuthResult("ok");
  }

  /** Candidate HMAC secrets, most-specific first; empty entries dropped. */
  private async resolveCallbackSecrets(): Promise<string[]> {
    const candidates: (string | undefined | null)[] = [
      this.configService.get<string>("executionCallback.secret"),
      this.configService.get<string>("executor.sharedToken"),
    ];
    try {
      const cfg = await this.systemConfigService.findOne(
        "executor.sharedToken",
      );
      // DB-rotated token slots in ahead of the env fallback.
      candidates.splice(1, 0, cfg?.value ?? null);
    } catch {
      // key not found in DB — env candidates remain
    }
    return candidates.filter((s): s is string => Boolean(s));
  }
}
