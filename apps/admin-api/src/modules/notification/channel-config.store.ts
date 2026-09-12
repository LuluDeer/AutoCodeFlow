import { Injectable, Logger, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { NotificationChannelConfig } from "./entities/notification-channel-config.entity";

/**
 * V1 (round-7): single source of truth for channel configs saved through
 * `PATCH /notification/channels/:key`. Before this existed the admin config
 * surface was write-only — channels resolved their outbound URL/credentials
 * exclusively from `ConfigService` (env), so a saved webhookUrl/SMTP config
 * never affected `send()`/`sendTest()`.
 *
 * Resolution order for every channel is now: **saved config first, env as
 * fallback default** (see the individual `*.channel.ts` implementations).
 * When nothing was ever saved (or the saved value is empty) the previous env
 * behavior is preserved unchanged.
 *
 * Values here are RAW (unmasked). The N11 masking (`password` → `'***'`)
 * applies only to the GET/PATCH response surface in NotificationConfigService,
 * and the `'***'` sentinel is filtered out on write — so the send path always
 * sees the real secret, never the masked echo.
 *
 * N37 (round-10): the store also carries the channel's `enabled` flag
 * (parallel map, kept OUT of the config record so `get()` stays the pure raw
 * config the other channels read). The webhook channel only lets a SAVED url
 * take effect while the channel is enabled — a disabled channel's config must
 * not silently reroute traffic. Entries published without an explicit flag
 * (e.g. test fixtures seeding config directly) default to enabled.
 *
 * ARCH-31 (本轮): 保存动作现在**写穿到 DB**（`notification_channel_configs`，
 * 迁移 1790000000014），并按 `CHANNEL_CONFIG_REFRESH_MS`（默认 15s）从 DB
 * 读穿刷新内存。此前「保存只落在接收请求的那一个进程」——多实例下其余实例
 * 永远回退到 env，保存过的 webhook/SMTP 静默失效。写穿 + 读穿后跨实例在
 * 一个刷新周期内收敛（🟡：TTL 内偏差，无写冲突——渠道配置只有管理员写，
 * DB 行是唯一真相，刷新是覆盖式而非合并式）。
 *
 * DB 不可用时（@Optional 仓储缺失 / 查询异常）逐字节降级回 V1 纯内存语义，
 * 与 FEAT-01 静默写穿的既有姿态一致。
 */
@Injectable()
export class ChannelConfigStore {
  private readonly logger = new Logger(ChannelConfigStore.name);
  private readonly configs = new Map<string, Record<string, string>>();
  private readonly enabledFlags = new Map<string, boolean>();
  private refreshTimer?: NodeJS.Timeout;

  static readonly DEFAULT_REFRESH_MS = 15_000;
  /** 刷新周期下限（防误配成 0/负数把 DB 打成热点）。 */
  static readonly MIN_REFRESH_MS = 1_000;

  constructor(
    // ARCH-31: 共享持久化层。@Optional —— 存量测试模块与 DB 不可用场景
    // 一律降级回纯内存语义（先例：NotificationService.silenceStore）。
    @Optional()
    @InjectRepository(NotificationChannelConfig)
    private readonly repo?: Repository<NotificationChannelConfig>,
    // ARCH-27: env 一律经 ConfigService（Joi + configuration.ts 注册），
    // 不在服务内直读 process.env。@Optional 同 repo——测试裸构造时回落默认。
    @Optional()
    private readonly configService?: ConfigService,
  ) {}

  /** 原始（未脱敏）配置，若该渠道保存过。 */
  get(key: string): Record<string, string> | undefined {
    return this.configs.get(key);
  }

  /** N37：该渠道保存配置是否可在发送路径生效（未发布过则默认启用）。 */
  isEnabled(key: string): boolean {
    return this.enabledFlags.get(key) ?? true;
  }

  /** 保存快照（浅拷贝，原始值）。enabled 省略时保留此前发布的开关态。 */
  set(key: string, config: Record<string, string>, enabled?: boolean): void {
    this.configs.set(key, { ...config });
    if (enabled !== undefined) this.enabledFlags.set(key, enabled);
  }

  /**
   * R8 (N29)：丢弃快照（testChannel 临时 override 后的还原）。
   * ARCH-31：同步删 DB 行（fire-and-forget，失败仅告警——内存语义不受影响）。
   */
  delete(key: string): void {
    this.configs.delete(key);
    this.enabledFlags.delete(key);
    if (!this.repo) return;
    void this.repo.delete(key).catch((e: unknown) => {
      this.logger.warn(
        `[channel-config] DB delete failed for ${key}: ${e instanceof Error ? e.message : String(e)}`,
      );
    });
  }

  // -----------------------------------------------------------------------
  // ARCH-31: 跨实例共享（DB 写穿 + 读穿刷新）
  // -----------------------------------------------------------------------

  /** 是否真的接了持久化层（无则整体旁路，行为与 V1 完全一致）。 */
  isPersistent(): boolean {
    return !!this.repo;
  }

  /**
   * 周期刷新的挂载点。**唯一刷新驱动方是 NotificationConfigService**（它同时
   * 持有读面 `channelConfigs` 与本 store，两边必须一起刷新才不会出现
   * 「GET 看到旧值、发送用新值」的错位）；本方法只负责登记定时器，避免在
   * 一次刷新周期里打两遍 DB。
   */
  registerRefreshTask(run: () => Promise<unknown>): void {
    if (!this.repo) return;
    const intervalMs = this.resolveRefreshMs();
    this.refreshTimer = setInterval(() => {
      void run().catch((e: unknown) => {
        this.logger.warn(
          `[channel-config] refresh task failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      });
    }, intervalMs);
    this.refreshTimer.unref();
  }

  onModuleDestroy(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }
  }

  /**
   * 刷新周期（ms）：`notification.channelConfigRefreshMs`（env
   * `CHANNEL_CONFIG_REFRESH_MS`），缺省/非法值回落 15s。
   */
  resolveRefreshMs(): number {
    const configured = this.configService?.get<number>(
      "notification.channelConfigRefreshMs",
    );
    if (
      typeof configured !== "number" ||
      !Number.isFinite(configured) ||
      configured < ChannelConfigStore.MIN_REFRESH_MS
    ) {
      return ChannelConfigStore.DEFAULT_REFRESH_MS;
    }
    return configured;
  }

  /**
   * 从 DB 读穿刷新内存。返回被刷新的渠道键数；DB 缺席/异常返回 0（降级）。
   * 覆盖式而非合并式：管理员的「保存」是整体替换语义，本地 env 种子值在
   * 有 DB 行时让位（与渠道解析顺序 saved → env 一致）。
   */
  async refreshFromStore(): Promise<number> {
    if (!this.repo) return 0;
    try {
      const rows = await this.repo.find();
      for (const row of rows) {
        this.configs.set(row.key, { ...(row.config ?? {}) });
        this.enabledFlags.set(row.key, row.enabled);
      }
      return rows.length;
    } catch (e: unknown) {
      this.logger.warn(
        `[channel-config] DB refresh failed (memory-only): ${e instanceof Error ? e.message : String(e)}`,
      );
      return 0;
    }
  }

  /** 已持久化的渠道键（供 NotificationConfigService 同步两个内存面）。 */
  async listPersisted(): Promise<
    Array<{ key: string; config: Record<string, string>; enabled: boolean }>
  > {
    if (!this.repo) return [];
    try {
      const rows = await this.repo.find();
      return rows.map((r) => ({
        key: r.key,
        config: { ...(r.config ?? {}) },
        enabled: r.enabled,
      }));
    } catch (e: unknown) {
      this.logger.warn(
        `[channel-config] listPersisted failed: ${e instanceof Error ? e.message : String(e)}`,
      );
      return [];
    }
  }

  /**
   * 写穿持久化（upsert）。调用方（NotificationConfigService.updateChannel）
   * 保持同步返回，故为 fire-and-forget——失败仅告警，内存态已生效。
   */
  persist(
    key: string,
    config: Record<string, string>,
    enabled: boolean,
  ): Promise<boolean> {
    if (!this.repo) return Promise.resolve(false);
    return this.repo
      .upsert([{ key, config, enabled }], { conflictPaths: ["key"] })
      .then(() => true)
      .catch((e: unknown) => {
        this.logger.warn(
          `[channel-config] DB persist failed for ${key} (memory-only): ${e instanceof Error ? e.message : String(e)}`,
        );
        return false;
      });
  }
}
