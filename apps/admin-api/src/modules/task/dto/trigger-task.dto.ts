import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsBoolean, IsInt, IsObject, IsOptional, Min } from "class-validator";
// B-9: 与 webhook 面同一 params 体积门（常量与判定同一出处）
import { TaskParamsMaxBytes } from "./params-size.constraint";
import { TaskParamsNoKeyCaseCollision } from "./param-key-collision.constraint";
export class TriggerTaskDto {
  @ApiPropertyOptional({
    description: `触发参数覆盖；序列化后体积不得超过 65536 字节（与 webhook 面同一上限）`,
  })
  @IsOptional()
  @IsObject()
  // B-9: 手动/API 触发 params 此前无体积上限（仅 webhook 面 64KB）——
  // 统一为同一常量，超限 400。
  @TaskParamsMaxBytes()
  @TaskParamsNoKeyCaseCollision()
  params?: Record<string, any>;

  /**
   * 技术债 A 组（2026-10-01）·按原版本重放：指定以任务版本历史的第 N 个
   * 快照（v<N>）派发本次执行——校验该版本存在且属于该任务（不存在 404）；
   * 派发载荷按该版本快照覆盖执行相关字段（codeSource/gitRepo/gitBranch/
   * gitCommit/entrypoint/runtimeVersion/requirements/glueSource/applicationId，
   * packageUrl 仍按快照 applicationId 在派发时解析）；执行记录 taskVersion
   * 记该钉定版本号。不落库、不建新版本、不影响任务当前配置；不传 version
   * 行为完全不变（沿用任务当前配置）。
   */
  @ApiPropertyOptional({ type: Number, example: 3, minimum: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  version?: number;

  /**
   * A6b：**提前触发并消耗下一个计划落点**（产品 2026-11-03 拍板）。
   *
   * 口径原文：「手动执行不算覆盖计划落点；**除非**给一个入口**提前触发**，
   * 去**消耗最近 1 次 cron**。」⇒ 手动触发默认按**严格 cron 语义**
   * （不覆盖任何计划落点，该补的还补）；本开关是**唯一**例外：
   *
   * - 勾选 ⇒ 把「**下一个** cron 落点」（从 now 起算）登记为已消耗；
   *   到该时刻调度器**跳过一次**并清除登记（一次性，**不是**永久 mute）；
   *   该跳过会留痕（warn 日志 + 审计 `task.fire_point_consumed`）。
   * - **缺省 false ⇒ 行为逐字节不变**（不进任何新分支、不查任何新列）。
   *
   * 约束：
   * - 仅 cron 任务可用（非 cron 无「计划落点」可消耗 ⇒ 400 明确报错）；
   * - 已有未消耗登记时再次请求 ⇒ **409**（不静默覆盖：覆盖会丢掉一次
   *   「已答应跳过」的承诺）；
   * - 编辑 cron 表达式/时区 ⇒ 旧登记失效并清除（否则会跳过一个「本来
   *   就不该跑」的点）。
   */
  @ApiPropertyOptional({
    type: Boolean,
    description:
      "提前触发并消耗下一个 cron 计划落点：登记后到该落点时刻调度器跳过一次" +
      "（一次性），并留痕。缺省 false ⇒ 行为不变（手动触发不覆盖计划落点）。" +
      "仅 cron 任务可用；已有未消耗登记时返回 409。",
  })
  @IsOptional()
  @IsBoolean()
  consumeNextFirePoint?: boolean;
}
