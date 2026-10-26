import { ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";

/**
 * DEP-03: 应用 manifest 的 healthCheck 声明（DEP-02 灰度批次的探活依据）。
 *
 * 声明位置：application.manifest.healthCheck（jsonb，落库无需新列）。
 * 缺省（无 healthCheck 键）= 无健康检查，灰度批次跳过探测直接提升，
 * 行为与特性引入前一致（零破坏）。
 *
 * 端口约定（侦察结论：平台对部署应用无标准探活端点，path/port 由应用
 * 用户提供）：探测目标 = `http://<executorAddress-host>:<port><path>`。
 * port 缺省回退执行器地址自身的端口（执行器与其托管应用同端口的可能性
 * 低，但作为最小缺省可预期）；path 必填。
 */
export class ManifestHealthCheckDto {
  /** 探活路径，如 "/health"。必填。 */
  @IsString()
  path: string;

  /** 应用监听端口。缺省=复用执行器地址端口。 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65535)
  port?: number;

  /** 探测间隔（毫秒），缺省 5000。 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(250)
  @Max(120000)
  interval?: number;

  /** 连续失败多少次判定不健康，缺省 3。 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(60)
  failThreshold?: number;

  /** 单次探测超时（毫秒），缺省 3000。 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(100)
  @Max(30000)
  timeoutMs?: number;
}

/**
 * DEP-02: upgrade-all 请求体的灰度策略。缺省（不传 rollout）= 'all'，
 * 既有全量升级行为逐字节保持（零破坏）。
 */
export class RolloutStrategyDto {
  /** canary=先升 percentage 比例（至少 1 台）→ 健康探测 → 提升其余；all=全量。 */
  @IsOptional()
  @IsIn(["canary", "all"])
  strategy?: "canary" | "all";

  /** canary 首批百分比（1-100），缺省 50。 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  percentage?: number;
}

/** POST /applications/:id/upgrade-all 请求体（全可选，兼容既有不传 body 调用）。 */
export class UpgradeAllDto {
  @ApiPropertyOptional({ type: RolloutStrategyDto })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => RolloutStrategyDto)
  rollout?: RolloutStrategyDto;

  /**
   * 版本定向灰度（2026-10-07 拍板立项）：把灰度目标从「当前 latest」换成指定
   * 的**历史 released 版本**（version 号字符串，非 uuid）。主要场景是**渐进
   * 回滚**——N 实例应用发现新版本有问题，先灰度回滚 1 台观察，而
   * rollbackApplication 是全量动作。实现语义：先按该版本快照恢复应用字段
   * （与 rollbackApplication 同一映射），再走既有 rollout 全套（DEP-02
   * 心跳确认/健康探测/失败自动回滚照常生效）；version 与应用当前 version
   * 相同时跳过恢复（「缺省=latest 逐字节不变」的同版本显式请求也保持纯升级）。
   */
  @ApiPropertyOptional({
    maxLength: 64,
    description:
      "本次灰度定向到某个历史 released 版本（version **字符串**，非 uuid）——用于渐进式回滚。缺省：应用当前版本。注意：该参数等价于 set-current-version + deploy-version 的组合（先按快照恢复应用当前字段，再下发），且会改写中台当前版本——R1（§4.2）拆分出的这两个端点是更明确的表达，建议改用新端点",
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  version?: string;

  /**
   * R2（部署模型评审 §4.4 / §9.4，2026-10-24）：覆盖面显式化的显式 opt-in。
   * stopped 行可能是人为停用，缺省不纳入；true 时 all 策略把 stopped 行一并
   * 下发升级（canary 策略忽略该参数——健康探测需要活进程，覆盖面维持既有
   * 全部 RUNNING 口径）。缺省覆盖面 = 全部 RUNNING 行（含 scheduled 实证口径：
   * scheduled 部署完成即上报 running，行稳态就是 RUNNING，详见 service 注释）。
   */
  @ApiPropertyOptional({
    description:
      "all 策略下把 stopped 部署行一并纳入升级（缺省 false——stopped 可能是人为停用）。pending/deploying/upgrading 在途行恒跳过并进响应 skipped 明细；failed 行恒排除（应走显式重新部署）。canary 策略忽略本参数",
  })
  @IsOptional()
  @IsBoolean()
  includeStopped?: boolean;
}

/**
 * DEP-03: manifest.healthCheck 的宽松解析/校验（纯函数）。manifest 是
 * jsonb 自由结构（UpdateApplicationDto 仅 @IsObject），深 shape 在消费点
 * 把关：合法返回归一化对象，非法（path 缺失/非字符串等）返回 null——
 * 调用方按「无健康检查」处理并记录 warn，绝不 throw 中断升级链。
 */
export function parseManifestHealthCheck(
  manifest: unknown,
):
  | (Required<
      Pick<
        ManifestHealthCheckDto,
        "path" | "interval" | "failThreshold" | "timeoutMs"
      >
    > & { port: number | null })
  | null {
  if (!manifest || typeof manifest !== "object") return null;
  const hc = (manifest as Record<string, unknown>).healthCheck;
  if (!hc || typeof hc !== "object") return null;
  const raw = hc as Record<string, unknown>;
  if (typeof raw.path !== "string" || !raw.path.startsWith("/")) return null;
  const port =
    typeof raw.port === "number" &&
    Number.isInteger(raw.port) &&
    raw.port >= 1 &&
    raw.port <= 65535
      ? raw.port
      : null;
  const intOr = (v: unknown, d: number, lo: number, hi: number) =>
    typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi ? v : d;
  return {
    path: raw.path,
    port,
    interval: intOr(raw.interval, 5000, 250, 120000),
    failThreshold: intOr(raw.failThreshold, 3, 1, 60),
    timeoutMs: intOr(raw.timeoutMs, 3000, 100, 30000),
  };
}

/** DEP-02: canary 首批台数 = ceil(N × percentage%)，钳 [1, N]。纯函数。 */
export function canaryBatchSize(total: number, percentage: number): number {
  if (total <= 0) return 0;
  const pct =
    typeof percentage === "number" && Number.isFinite(percentage)
      ? Math.min(Math.max(Math.trunc(percentage), 1), 100)
      : 50;
  return Math.min(Math.max(Math.ceil((total * pct) / 100), 1), total);
}
