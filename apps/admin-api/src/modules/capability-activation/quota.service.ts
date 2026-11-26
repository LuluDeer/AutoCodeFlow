import { Injectable, Logger } from "@nestjs/common";
import { AppError } from "../../common/errors/app-error";
import { ErrorCode } from "../../common/errors/error-codes";
import { SystemConfigService } from "../config/config.service";
import { ChannelConfigStore } from "../notification/channel-config.store";
import {
  AlertChannel,
  NotificationService,
} from "../notification/notification.service";
import { type NotificationPayload } from "../notification/channels/base.channel";
import { CapabilityActivationService } from "./capability-activation.service";
import {
  QUOTA_KEY_PREFIX,
  QUOTA_SCOPES,
  QUOTA_UNITS,
  type QuotaConfig,
  type QuotaScope,
  type QuotaStatusRow,
  type QuotaUnit,
  type SetQuotaDto,
} from "./dto/quota.dto";
import type { QuotaHardLimitGate } from "./quota-limit.gate";
import {
  classifyQuota,
  evaluateHardLimit,
  type HardLimitDecision,
  type HardLimitTarget,
} from "./quota-limit";

/** LANG-ERR-01：校验失败统一抛稳定码，detail 点名字段与原因。 */
const invalid: (detail: string) => never = (detail: string): never => {
  throw new AppError(ErrorCode.VALIDATION_FAILED, { detail });
};

/**
 * 金额闸只消费 stats 行上的投影字段；dual-meter 的顶层 report → stats 行投影
 * 由 service 装配层负责。这里不调用价目模块，也不把 null 折算成 0。
 */
type MeterAmountProjection = {
  currencyValue?: number | null;
  priceReason?: string;
};

/**
 * N20：按项目/能力的配额配置 + showback 状态 + 软阈值 webhook 告警。
 *
 * 计量口径复用 CapabilityActivationService.stats 的 byProject/byCapability
 * （**只有调用次数**，没有 token 样本，不做 token 计费）。
 *
 * 配置落 system_configs（key 前缀 acf.showback.quota.，valueType='json'），
 * 无新表、无迁移。写审计沿用 SystemConfigService.upsert 既有的 config.update
 * 留痕；本轮不新增审计 action、不改错误码目录。
 *
 * 硬阈值的实际拒绝经 `evaluateHardLimit`（本类实现的轻量 gate 面）接到
 * activation.record 主链：判定与三态边界共用 quota-limit.ts 的纯函数，
 * usage 仍只取自本文件既有的 status(windowDays) → activation.stats。
 */
@Injectable()
export class QuotaService implements QuotaHardLimitGate {
  private readonly logger = new Logger(QuotaService.name);

  /** 已告警集合：key = scope:target:window；status 回落到 ok 时清除，可再次告警。 */
  private readonly alerted = new Set<string>();

  constructor(
    private readonly activation: CapabilityActivationService,
    private readonly config: SystemConfigService,
    private readonly notify: NotificationService,
    private readonly channelStore: ChannelConfigStore,
  ) {}

  /** PUT：校验后以 JSON value upsert 一条配额配置。 */
  async upsert(dto: SetQuotaDto): Promise<QuotaConfig> {
    const cfg: QuotaConfig = {
      scope: dto.scope,
      target: dto.target,
      softLimit: dto.softLimit,
      hardLimit: dto.hardLimit,
      windowDays: dto.windowDays,
      ...(dto.webhookUrl ? { webhookUrl: dto.webhookUrl } : {}),
      ...(dto.unit ? { unit: dto.unit } : {}),
      ...(dto.amountHardLimit !== undefined
        ? { amountHardLimit: dto.amountHardLimit }
        : {}),
    };
    this.assertValid(cfg);
    await this.config.upsert({
      key: this.keyOf(cfg),
      value: JSON.stringify(cfg),
      description: `N20 showback quota: ${cfg.scope}/${cfg.target}`,
      valueType: "json",
    });
    return cfg;
  }

  /** GET /quota：读前缀下所有配置；坏行跳过（不让一条脏配置击穿整个读面）。 */
  async list(): Promise<QuotaConfig[]> {
    const rows = await this.config.getByPrefix(QUOTA_KEY_PREFIX);
    return rows
      .map((row) => this.parseConfig(row.value))
      .filter((cfg): cfg is QuotaConfig => cfg !== null);
  }

  /**
   * GET /quota-status：一次 stats({from,to}) 拿全量用量，再按配置算三态并告警。
   * 查询参数 windowDays 决定本次统计窗口，返回行的 windowDays 即该窗口；
   * 配置里的 windowDays 是登记口径（list 可见），默认同为 30。
   */
  async status(windowDays = 30): Promise<QuotaStatusRow[]> {
    const configs = await this.list();
    if (configs.length === 0) return [];

    const to = new Date();
    const from = new Date(to.getTime() - windowDays * 86_400_000);
    const stats = await this.activation.stats({
      from: from.toISOString(),
      to: to.toISOString(),
    });

    const rows: QuotaStatusRow[] = configs.map((cfg) => {
      const meterRow = (
        cfg.scope === "project"
          ? stats.byProject.find((p) => p.projectId === cfg.target)
          : stats.byCapability.find((c) => c.capabilityKey === cfg.target)
      ) as MeterAmountProjection | undefined;
      const usage =
        cfg.scope === "project"
          ? (stats.byProject.find((p) => p.projectId === cfg.target)?.count ??
            0)
          : (stats.byCapability.find((c) => c.capabilityKey === cfg.target)
              ?.count ?? 0);
      // 先判 hard 再判 soft：等值边界分别落 exceeded / warn（与 gate 共用判定）。
      const status = classifyQuota(cfg, usage);
      const row: QuotaStatusRow = {
        scope: cfg.scope,
        target: cfg.target,
        softLimit: cfg.softLimit,
        hardLimit: cfg.hardLimit,
        usage,
        status,
        windowDays,
      };
      if (cfg.unit === "amount") {
        row.unit = "amount";
        // 非有限/null 一律折叠为 null：金额不可得的状态只有 null，没有 0。
        row.amount =
          typeof meterRow?.currencyValue === "number" &&
          Number.isFinite(meterRow.currencyValue)
            ? meterRow.currencyValue
            : null;
        if (meterRow?.priceReason) row.priceReason = meterRow.priceReason;
        if (cfg.amountHardLimit !== undefined) {
          row.amountHardLimit = cfg.amountHardLimit;
        }
      }
      return row;
    });

    await Promise.all(rows.map((row) => this.maybeAlert(configs, row)));
    return rows;
  }

  /**
   * 硬阈闸（QuotaHardLimitGate 实现）：只挑与本次激活相关的配置，用**配置自己
   * 的 windowDays** 调既有 status 取 usage，再交纯函数判定；任一命中即拦截。
   * 同一窗口只查一次 stats（status 内已带软阈告警去重）。
   *
   * fail-open：配置读取、stats、判定任一异常只记 warn 并放行，绝不让配额系统
   * 故障挡住正常激活。
   */
  async evaluateHardLimit(dto: HardLimitTarget): Promise<HardLimitDecision> {
    try {
      const configs = await this.list();
      const relevant = configs.filter((cfg) =>
        cfg.scope === "project"
          ? dto.projectId != null && cfg.target === dto.projectId
          : cfg.target === dto.capabilityKey,
      );
      if (relevant.length === 0) return { blocked: false };

      const reasons: string[] = [];
      for (const windowDays of [
        ...new Set(relevant.map((c) => c.windowDays)),
      ]) {
        const rows = await this.status(windowDays);
        // status 一次给出所有配置的行；这里只保留本窗口自己的配置，避免把
        // 30 天用量套到 7 天配额上（各配置 windowDays 独立）。
        const scoped = rows.filter((row) =>
          relevant.some(
            (cfg) =>
              cfg.scope === row.scope &&
              cfg.target === row.target &&
              cfg.windowDays === windowDays,
          ),
        );
        const decision = evaluateHardLimit(scoped, dto);
        if (decision.blocked) return decision;
        if (decision.reasons) reasons.push(...decision.reasons);
      }
      return reasons.length === 0
        ? { blocked: false }
        : { blocked: false, reasons };
    } catch (err: unknown) {
      this.logger.warn(
        `[showback] hard-limit gate failed open for ${dto.capabilityKey}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return { blocked: false };
    }
  }

  /** 测试出口：清空去重状态（进程内状态跨用例会形成隐性顺序依赖）。 */
  resetAlerted(): void {
    this.alerted.clear();
  }

  private keyOf(cfg: QuotaConfig): string {
    return `${QUOTA_KEY_PREFIX}${cfg.scope}.${cfg.target}`;
  }

  private assertValid(cfg: QuotaConfig): void {
    if (!QUOTA_SCOPES.includes(cfg.scope)) {
      invalid("配额 scope 非法，仅支持 project 或 capability");
    }
    if (typeof cfg.target !== "string" || cfg.target.trim().length === 0) {
      invalid("配额 target 必须是非空字符串");
    }
    if (!Number.isSafeInteger(cfg.softLimit) || cfg.softLimit <= 0) {
      invalid("配额 softLimit 必须是正整数");
    }
    if (!Number.isSafeInteger(cfg.hardLimit) || cfg.hardLimit <= 0) {
      invalid("配额 hardLimit 必须是正整数");
    }
    if (cfg.softLimit > cfg.hardLimit) {
      invalid("配额 softLimit 必须为正数且不大于 hardLimit");
    }
    if (
      !Number.isSafeInteger(cfg.windowDays) ||
      cfg.windowDays < 1 ||
      cfg.windowDays > 90
    ) {
      invalid("配额 windowDays 必须在 1 到 90 之间");
    }
    if (
      cfg.unit !== undefined &&
      !QUOTA_UNITS.includes(cfg.unit as QuotaUnit)
    ) {
      invalid("配额 unit 非法，仅支持 invocations 或 amount");
    }
    if (
      cfg.unit === "amount" &&
      (typeof cfg.amountHardLimit !== "number" ||
        !Number.isFinite(cfg.amountHardLimit) ||
        cfg.amountHardLimit <= 0)
    ) {
      invalid("配额 amountHardLimit 必须是正数有限值（unit=amount 必填）");
    }
  }

  private parseConfig(value: string | null): QuotaConfig | null {
    try {
      const parsed: unknown = JSON.parse(value ?? "null");
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return null;
      }
      const cfg = parsed as Partial<QuotaConfig>;
      if (!QUOTA_SCOPES.includes(cfg.scope as QuotaScope) || !cfg.target) {
        return null;
      }
      if (
        cfg.unit !== undefined &&
        !QUOTA_UNITS.includes(cfg.unit as QuotaUnit)
      ) {
        this.logger.warn(
          `[showback] quota config line skipped: invalid unit ${JSON.stringify(cfg.unit)} for ${cfg.scope}/${cfg.target}`,
        );
        return null;
      }
      if (
        cfg.unit === "amount" &&
        (typeof cfg.amountHardLimit !== "number" ||
          !Number.isFinite(cfg.amountHardLimit) ||
          cfg.amountHardLimit <= 0)
      ) {
        this.logger.warn(
          `[showback] quota config line skipped: invalid amountHardLimit for ${cfg.scope}/${cfg.target}`,
        );
        return null;
      }
      return cfg as QuotaConfig;
    } catch {
      // 坏 JSON 只跳过本行，其余配额照常出状态（fail-open）。
      return null;
    }
  }

  private async maybeAlert(
    configs: QuotaConfig[],
    row: QuotaStatusRow,
  ): Promise<void> {
    const key = `${row.scope}:${row.target}:${row.windowDays}`;
    if (row.status === "ok") {
      this.alerted.delete(key);
      return;
    }
    if (this.alerted.has(key)) return;

    const cfg = configs.find(
      (c) => c.scope === row.scope && c.target === row.target,
    );
    const payload: NotificationPayload = {
      title: "能力用量告警",
      content: `能力用量告警：${row.target} 在 ${row.windowDays} 天内调用 ${row.usage} 次，已达软阈值 ${row.softLimit}`,
      level: row.status === "exceeded" ? "error" : "warning",
    };

    try {
      const url = cfg?.webhookUrl || this.globalWebhookUrl();
      if (url) {
        // NotificationService.sendWebhook 内部即 webhook.channel.send(payload, url)。
        const result = await this.notify.sendWebhook(payload, url);
        if (result !== "sent") {
          this.logger.warn(`[showback] webhook ${result} for ${key}`);
        }
      } else {
        // 没有配额级/全局 URL 时走渠道扇出，webhook.channel 自行返回 skipped。
        await this.notify.sendToChannels(payload, [AlertChannel.WEBHOOK]);
      }
    } catch (err: unknown) {
      // fail-open：发送失败只 warn，绝不阻断状态查询。
      this.logger.warn(
        `[showback] webhook failed for ${key}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    // 本窗口已尝试过告警即记入，避免每轮查询重复投递。
    this.alerted.add(key);
  }

  private globalWebhookUrl(): string | undefined {
    return this.channelStore.isEnabled("webhook")
      ? this.channelStore.get("webhook")?.url
      : undefined;
  }
}
