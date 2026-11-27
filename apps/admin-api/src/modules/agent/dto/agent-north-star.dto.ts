import { ApiProperty } from "@nestjs/swagger";

/**
 * R327 · 管理端北极星双口径看板的数据源契约。
 *
 * 字段与侧车脚本 `scripts/north-star-weekly.mjs` 的 `buildPayload()` 输出
 * **逐字对齐**（含 `active_install_weeks` 这个"周和"命名、两条 warnings 的
 * 顺序）。任何字段名变更都会破坏脚本对账与看板消费方，禁止改名。
 *
 * 两条口径分字段、分查询、绝不混算（R324 §8「不混用」裁决）：
 *   · `business_confirmed` —— 严格值，`business_confirmed` 漏斗事件周聚合；
 *   · `business_results_proxy` —— 过渡期代理值，SUCCESS + 有产物执行数。
 */

/** 严格值：单周聚合行。 */
export class AgentNorthStarConfirmedWeekDto {
  @ApiProperty({ description: "UTC 周一 00:00:00.000Z" })
  week_start: string;

  @ApiProperty({ description: "该周去重活跃实例数" })
  active_installs: number;

  @ApiProperty({ description: "该周去重确认事件数（每次执行最多一次）" })
  confirmed_events: number;
}

/** 严格值：跨周合计（active_install_weeks 是各周 active_installs 之和，非去重实例总数）。 */
export class AgentNorthStarConfirmedTotalsDto {
  @ApiProperty({
    description: "各周 active_installs 之和（周-实例对，非全局去重实例数）",
  })
  active_install_weeks: number;

  @ApiProperty({ description: "各周 confirmed_events 之和" })
  confirmed_events: number;
}

export class AgentNorthStarConfirmedDto {
  @ApiProperty({ type: [AgentNorthStarConfirmedWeekDto] })
  weeks: AgentNorthStarConfirmedWeekDto[];

  @ApiProperty({ type: AgentNorthStarConfirmedTotalsDto })
  totals: AgentNorthStarConfirmedTotalsDto;
}

/** 代理值：单周聚合行。 */
export class AgentNorthStarProxyWeekDto {
  @ApiProperty({ description: "UTC 周一 00:00:00.000Z" })
  week_start: string;

  @ApiProperty({
    description: "该周 SUCCESS 且 artifacts 非空、非 synthetic 的执行数",
  })
  executions: number;
}

export class AgentNorthStarProxyTotalsDto {
  @ApiProperty({ description: "各周 executions 之和" })
  executions: number;
}

export class AgentNorthStarProxyDto {
  @ApiProperty({ type: [AgentNorthStarProxyWeekDto] })
  weeks: AgentNorthStarProxyWeekDto[];

  @ApiProperty({ type: AgentNorthStarProxyTotalsDto })
  totals: AgentNorthStarProxyTotalsDto;
}

/** R448 升主数值阈值（与脚本 PROMOTION_THRESHOLDS 逐字一致）。 */
export class AgentNorthStarPromotionThresholdsDto {
  @ApiProperty({ description: "最小样本期周数" })
  minWeeks: number;

  @ApiProperty({ description: "活跃 install 周合计下限" })
  minActiveInstallWeeks: number;
}

/**
 * R448 升主判据单条原因：稳定类别码 + 人话文本并存。
 * 前端着色 / 本地化按 `code` 判定；`text` 是后端原文，作为未知码的回落展示。
 */
export class AgentNorthStarPromotionReasonDto {
  @ApiProperty({
    description: "稳定的升主原因类别码；前端着色与本地化按此码判定，不解析文本",
  })
  code: string;

  @ApiProperty({ description: "后端原文人话原因；前端遇未知码时回落展示" })
  text: string;
}

/** R448 升主判据（可计算，与脚本 computePromotionEligibility 同口径）。 */
export class AgentNorthStarPromotionDto {
  @ApiProperty({
    description: "两数值阈值是否均满足（不含运营前置 coverage=full）",
  })
  eligible: boolean;

  @ApiProperty({
    type: [String],
    description: "未达标逐条说明 + 运营前置提示（脚本不验证 coverage）",
  })
  reasons: string[];

  @ApiProperty({
    type: [AgentNorthStarPromotionReasonDto],
    description:
      "结构化原因：稳定类别码 + 原文文本，与既有 reasons 数组一一对应",
  })
  reasonDetails: AgentNorthStarPromotionReasonDto[];

  @ApiProperty({ description: "严格值周数" })
  weeks: number;

  @ApiProperty({ description: "活跃 install 周合计" })
  activeInstallWeeks: number;

  @ApiProperty({ type: AgentNorthStarPromotionThresholdsDto })
  thresholds: AgentNorthStarPromotionThresholdsDto;
}

/**
 * TTFV「真实口径」指标（R313 核心北极星指标上屏）。
 *
 * 三态必须结构化返回，前端按 `dataStatus` 区分「未启用 / 无数据 / 真零」：
 * gate_off=总闸未开或 telemetry_optin 无 opt_in=true 行；
 * no_data=双闸已开但无符合口径样本；ok=有样本。
 * gate_off/no_data 时 medianMinutes / activation24h 为 null（绝不是 0）。
 */
export class AgentNorthStarTtfvDto {
  @ApiProperty({
    description:
      "数据状态：gate_off=未启用（总闸关/无授权行/缺表）；no_data=有授权但无符合口径样本；ok=有样本",
    enum: ["gate_off", "no_data", "ok"],
  })
  dataStatus: "gate_off" | "no_data" | "ok";

  @ApiProperty({
    description: "安装到首次成功的连续中位数（分钟）；gate_off/no_data 为 null",
    type: Number,
    nullable: true,
  })
  medianMinutes: number | null;

  @ApiProperty({
    description:
      "满 24h 样本的首次触发执行激活率，比率 0~1（前端渲染 ×100 显示百分比）；无满 24h 样本为 null",
    type: Number,
    nullable: true,
  })
  activation24h: number | null;

  @ApiProperty({
    description: "样本量（converted_installs + 满 24h eligible）",
  })
  sampleSize: number;

  @ApiProperty({ description: "观测截止时间（ISO-8601），与顶层 as_of 同值" })
  asOf: string;

  @ApiProperty({
    description:
      "中文口径说明：仅 opt-in install、授权前不追溯、小样本警告；未启用/无数据时给出原因",
  })
  note: string;
}

/** GET /agent/north-star/metrics —— 双口径周报完整载荷。 */
export class AgentNorthStarResponseDto {
  @ApiProperty({
    description: "观测截止时间（ISO-8601），与脚本 buildPayload 同口径",
  })
  as_of: string;

  @ApiProperty({ type: AgentNorthStarConfirmedDto })
  business_confirmed: AgentNorthStarConfirmedDto;

  @ApiProperty({ type: AgentNorthStarProxyDto })
  business_results_proxy: AgentNorthStarProxyDto;

  @ApiProperty({
    type: AgentNorthStarPromotionDto,
    description:
      "R448 升主判据（eligible 仅判数值阈值，运营前置 coverage=full 见 reasons）",
  })
  promotionEligibility: AgentNorthStarPromotionDto;

  @ApiProperty({
    type: [String],
    description:
      "强制口径护栏（不可省略）：严格口径说明 + 「有产物/有证据 ≠ 被业务确认，代理值勿当严格值」强警告",
  })
  warnings: string[];

  @ApiProperty({
    type: AgentNorthStarTtfvDto,
    description:
      "TTFV 真实口径（安装→首成中位数 / 24h 激活率 / 样本量），三态以 dataStatus 判定",
  })
  ttfv: AgentNorthStarTtfvDto;
}
