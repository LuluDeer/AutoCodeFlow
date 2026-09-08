import { ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
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

/** POST /applications/:id/upgrade-all 请求体（全可选，兼容既有无 body 调用）。 */
export class UpgradeAllDto {
  @ApiPropertyOptional({ type: RolloutStrategyDto })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => RolloutStrategyDto)
  rollout?: RolloutStrategyDto;
}

/**
 * DEP-03: manifest.healthCheck 的宽松解析/校验（纯函数）。manifest 是
 * jsonb 自由结构（UpdateApplicationDto 仅 @IsObject），深 shape 在消费点
 * 把关：合法返回归一化对象，非法（path 缺失/非字符串等）返回 null——
 * 调用方按「无健康检查」处理并记录 warn，绝不 throw 中断升级链。
 */
export function parseManifestHealthCheck(
  manifest: unknown,
): Required<
  Pick<ManifestHealthCheckDto, "path" | "interval" | "failThreshold" | "timeoutMs">
> & { port: number | null } | null {
  if (!manifest || typeof manifest !== "object") return null;
  const hc = (manifest as Record<string, unknown>).healthCheck;
  if (!hc || typeof hc !== "object") return null;
  const raw = hc as Record<string, unknown>;
  if (typeof raw.path !== "string" || !raw.path.startsWith("/")) return null;
  const port =
    typeof raw.port === "number" && Number.isInteger(raw.port) &&
    raw.port >= 1 && raw.port <= 65535
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
