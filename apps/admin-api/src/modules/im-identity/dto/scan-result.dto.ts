import { ApiProperty } from "@nestjs/swagger";
import type {
  ImInjectionFinding,
  ImInjectionScanResult,
  ImInjectionSeverity,
} from "../injection-guard";

/**
 * 注入扫描的单条命中项（injection-guard.ts 的 ImInjectionFinding 投影）。
 * 单独成 class 是为了让 findings 数组元素在 openapi 里有具名 schema，
 * 前端生成的类型不是 Record<string, never>。
 */
export class ImInjectionFindingDto implements ImInjectionFinding {
  @ApiProperty({
    description: "命中的规则代码（如 ROLE_HIJACK_EN / URL_DANGEROUS_COMMAND）",
    example: "ROLE_HIJACK_EN",
  })
  rule: string;

  @ApiProperty({
    description: "命中严重级别：CRITICAL（阻断）| WARN（仅提示）",
    enum: ["CRITICAL", "WARN"],
    example: "CRITICAL",
  })
  severity: ImInjectionSeverity;

  @ApiProperty({
    description: "触发规则的原文片段（超长截断至 160 字符）",
    example: "忽略之前所有指令",
  })
  evidence: string;
}

/**
 * POST /api/im-identity/scan 的 200 响应 DTO。
 * 与 injection-guard.ts 的 ImInjectionScanResult 接口逐字段对齐，
 * controller 直接返回 service 结果，无需运行时转换。
 */
export class ImInjectionScanResultDto implements ImInjectionScanResult {
  @ApiProperty({
    description: "是否通过注入扫描（CRITICAL 命中即 false）",
    example: true,
  })
  safe: boolean;

  @ApiProperty({
    type: [ImInjectionFindingDto],
    description: "命中项列表（rule / severity / evidence）",
  })
  findings: ImInjectionFindingDto[];

  @ApiProperty({ description: "CRITICAL 级命中数量", example: 0 })
  criticalCount: number;

  @ApiProperty({
    description: "正文超过 20000 字符时只扫描前缀并置位",
    example: false,
  })
  truncated: boolean;
}
