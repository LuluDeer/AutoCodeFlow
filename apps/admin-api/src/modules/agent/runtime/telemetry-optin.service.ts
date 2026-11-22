import { Injectable, Optional } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";

import { SystemConfigService } from "../../config/config.service";
import { TelemetryOptin } from "../entities/telemetry-optin.entity";

/**
 * 系统总闸键（方案 §3）：缺失 / 非法 / 读失败一律按 false 处理。
 * 这里刻意不在 configuration.ts 放默认值——「默认不采集」的语义是**缺键即关**，
 * 多一个默认值就多一处可以把它翻开的沉默路径。
 */
export const TTFV_SYSTEM_GATE_KEY = "telemetry.ttfv.enabled";

/** 撤销也是一次有来源的状态变更；没有调用方传入 source，用固定标记留痕。 */
export const REVOKE_SOURCE = "revoke";

/** 与 agent-boundary/agent-budget 的布尔配置解析同口径；非法值一律 false。 */
function parseGateValue(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "true" || normalized === "1";
}

/**
 * TTFV 的 opt-in 授权闸门（默认不采集）。
 *
 * 双闸缺一不可：① 系统总闸 `telemetry.ttfv.enabled`；② 实例级
 * `telemetry_optin.opt_in`。任何异常都 fail-closed 返回 false——埋点服务
 * 绝不能因为配置库抖动而「顺手」把一个未授权 install 的漏斗事件放出去。
 */
@Injectable()
export class TelemetryOptinService {
  constructor(
    @InjectRepository(TelemetryOptin)
    private readonly repo: Repository<TelemetryOptin>,
    // @Optional + 置尾：缺 SystemConfigModule 接线/单测零装配时降级为 null，
    // 于是总闸读不到 ⇒ 直接 false。这正是「默认不采集」要求的失败方向。
    @Optional()
    private readonly systemConfig?: SystemConfigService | null,
  ) {}

  async isOptedIn(installId: string): Promise<boolean> {
    // 闸一：系统总闸。缺 key 时 findOne 抛 CONFIG_ITEM_NOT_FOUND，
    // 与「读失败」「非法值」一起收敛成 false，且**不查授权表**。
    let systemEnabled = false;
    try {
      const row = await this.systemConfig?.findOne(TTFV_SYSTEM_GATE_KEY);
      systemEnabled = parseGateValue(row?.value);
    } catch {
      return false;
    }
    if (!systemEnabled) return false;

    // 闸二：实例级授权状态。查表本身也 fail-closed。
    try {
      const row = await this.repo.findOneBy({ installId });
      return row?.optIn === true;
    } catch {
      return false;
    }
  }

  /** 授权：upsert 当前状态；userIdHash/source 随本次动作写入。 */
  async grant(
    installId: string,
    userIdHash: string | null,
    source: string,
  ): Promise<void> {
    await this.repo.upsert(
      {
        installId,
        userIdHash: userIdHash ?? null,
        optIn: true,
        optedAt: new Date(),
        source,
      },
      { conflictPaths: ["installId"] },
    );
  }

  /**
   * 撤销：同样 upsert（而不是 DELETE）——留一行 opt_in=false 的事实，
   * 避免「没登记」与「已撤销」在表上塌成同一形态。
   */
  async revoke(installId: string): Promise<void> {
    await this.repo.upsert(
      {
        installId,
        optIn: false,
        optedAt: new Date(),
        source: REVOKE_SOURCE,
      },
      { conflictPaths: ["installId"] },
    );
  }
}
