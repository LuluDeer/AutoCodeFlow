/**
 * N14+（在途策略即时失效 + 持久化代际）：方案卡策略代际的**运行时注册表**。
 *
 * 以前 generation 由 preview-validator.ts 的编译期常量算出——中台改了能力后
 * 必须重新部署才能换代际，在途旧卡仍可 commit。这里把「策略版本」一维升级为
 * 进程内 counter：capability 写操作落库后 emit capability.changed，本服务在
 * 构造器里订阅该事件并 bump counter ⇒ 下一次 preview 得到新 generation，
 * 拿着旧 generation 的在途卡在 commit 闸口被拒。
 *
 * 输出口径**不变**：仍然走 computePolicyGeneration()，仍是 16 位 hex
 * （与 cardHash 同格式），前端与 DTO 零改动。
 *
 * ── 持久化 + 跨实例一致性（本轮升级）────────────────────────────────────
 * version 存 system_configs，key = "workbench.policy_generation_version"、
 * valueType="number"（SystemConfig.value 是 text 列，存十进制串）。
 * 进程内只留一份缓存（cachedVersion + loaded + loadedAt）；首次读取从
 * ConfigStore.findOne 回源一次，之后走缓存，避免每请求 SELECT（SystemConfig
 * 是"人低频写、机高频读"表）。
 *
 * bump() 走「读-改-写 + 短重试」：ConfigService 没有原子 increment（upsert
 * 内部是 findOneBy → repo.upsert，无行锁），故并发窗口真实存在——两个实例
 * 同时读到 N 都写 N+1，最终仍单调（不会回退），但" bump 次数 = 版本增量"在
 * 该窗口内不成立。重试 + 写后回读把窗口压到一次事务内；注释见 writeIncremented。
 * 写成功后 publishInvalidate(key)，经 ConfigCacheSync 的 Redis 广播让其它实例
 * 的配置缓存逐出（SystemConfigService.upsert 内部也会广播，幂等重复无害）。
 *
 * ── 一致性边界（诚实声明）────────────────────────────────────────────────
 * 优先接广播，但 ConfigCacheSyncService.bindHandlers 是**单消费者槽位**，已由
 * SystemConfigService.onModuleInit 占用，且该服务未从 SystemConfigModule 导出；
 * 在不碰 config 模块源码的写域约束下无法安全挂载第二 listener。故退化为
 * TTL=5s：loadedAt 之后的读取会回源 DB，跨实例失效窗口 <= 5s（消息送达时
 * ConfigService 自身 1s 缓存被逐出，实际通常更短）。invalidate() 是预留缝：
 * 未来可在 config 模块暴露多 listener 后由广播直接调用，立即置 loaded=false。
 *
 * fail-open：emit 异常、监听器异常、DB 读/写失败都不冒泡到 capability 主链；
 * ConfigStore / invalidator 缺席（内存替身单测）→ 退回原进程内 counter 语义。
 */
import {
  Injectable as NestInjectable,
  Logger as NestLogger,
  Optional as NestOptional,
} from "@nestjs/common";

import {
  DOMAIN_EVENTS,
  type CapabilityChangedEventPayload,
} from "../../common/events/domain-events";
import { DomainEventBus } from "../../common/services/domain-event-bus.service";
import {
  computePolicyGeneration,
  policySnapshotForVersion,
} from "./preview-validator";

/** 极简框架替身可能不提供这些装饰器/Logger；缺席时降级 no-op（同 workbench.controller.ts）。 */
const Injectable: (...args: any[]) => any =
  typeof NestInjectable === "function" ? NestInjectable : () => () => undefined;
const Optional: (...args: any[]) => any =
  typeof NestOptional === "function" ? NestOptional : () => () => undefined;
const Logger: new (...args: any[]) => { warn?: (message: string) => void } =
  typeof NestLogger === "function"
    ? NestLogger
    : class {
        warn(): void {}
      };

/** 持久化 key / valueType（固定，勿改；system_configs 已存在，无新表无迁移）。 */
export const POLICY_GENERATION_CONFIG_KEY =
  "workbench.policy_generation_version";
export const POLICY_GENERATION_VALUE_TYPE = "number";

/** 跨实例一致性窗口：缓存超过该时长即回源 DB（见文件头一致性边界）。 */
export const POLICY_GENERATION_CACHE_TTL_MS = 5_000;

/**
 * 配置存储的最小结构面（抽象类即 DI token）。生产由 SystemConfigService 承担
 * （findOne/upsert 签名兼容）；刻意不值 import config.service.ts，避免把 typeorm
 * 依赖拖进内存替身单测，同 workbench.controller.ts 的 CapabilityActivationRecorder。
 */
export abstract class PolicyConfigStore {
  abstract findOne(key: string): Promise<{ value: string | null }>;
  abstract upsert(dto: {
    key: string;
    value: string;
    valueType?: string;
    description?: string;
  }): Promise<unknown>;
}

/** 失效广播的最小结构面（DI token，生产由 workbench.module.ts 用 ModuleRef 桥接）。 */
export abstract class PolicyGenerationInvalidator {
  abstract publishInvalidate(key?: string): Promise<void> | void;
}

@Injectable()
export class PolicyGenerationService {
  private readonly logger = new Logger(PolicyGenerationService.name);

  /** 单调版本：有 ConfigStore 时是 DB 值的进程内缓存；缺席时即原进程内 counter。 */
  private cachedVersion = 0;
  /** 是否已从 DB 回源过（缓存是否有效）。 */
  private loaded = false;
  /** 上次回源时刻（TTL 起点）。 */
  private loadedAt = 0;
  /** 并发首次读取合流，避免同一 tick 多次 findOne。 */
  private inflight: Promise<void> | null = null;

  constructor(
    @Optional() private readonly bus: DomainEventBus | null = null,
    @Optional() private readonly config?: PolicyConfigStore | null,
    @Optional()
    private readonly invalidator?: PolicyGenerationInvalidator | null,
  ) {
    if (!this.bus) return;
    // capability 写操作 → bus.emit → 这里 bump。DomainEventBus.on 已吞同步/异步
    // 异常，回调内再兜一层：任何异常都不改变 counter 的单调性约定、不外抛。
    this.bus.on<CapabilityChangedEventPayload>(
      DOMAIN_EVENTS.CAPABILITY_CHANGED,
      (payload) => {
        try {
          // bump 是 async：同步抛错由此 catch，异步 reject 由 DomainEventBus 包装器吞。
          void this.bump(payload?.operation ?? "capability.changed");
        } catch (err: unknown) {
          this.safeWarn(
            `policy generation bump failed (fail-open): ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      },
    );
  }

  /**
   * 当前代际：16 hex，格式与旧 computePolicyGeneration() 完全一致。
   * preview / commit 各 await 一次；两次之间若发生 bump 即得到不同字符串，
   * 旧卡被闸口拒绝。
   */
  async currentGeneration(): Promise<string> {
    await this.ensureLoaded();
    return computePolicyGeneration(
      policySnapshotForVersion(this.cachedVersion),
    );
  }

  /** 当前版本号（诊断/单测用，不是对外 generation 字符串）。 */
  async currentVersion(): Promise<number> {
    await this.ensureLoaded();
    return this.cachedVersion;
  }

  /**
   * 失效缝：丢弃本地缓存，下次 currentGeneration()/currentVersion() 回源 DB。
   * 未来 config 模块暴露多 listener 后可由广播直接调用；当前由 TTL 兜底。
   */
  invalidate(): void {
    this.loaded = false;
    this.loadedAt = 0;
  }

  /** 显式 bump（供事件监听与单测使用）；返回推进后的版本号。 */
  async bump(reason?: string): Promise<number> {
    // fail-open：无 ConfigStore → 原进程内 counter 语义，不崩。
    if (!this.config) {
      this.cachedVersion += 1;
      return this.cachedVersion;
    }
    try {
      const next = await this.writeIncremented();
      this.cachedVersion = next;
      this.loaded = true;
      this.loadedAt = Date.now();
      await this.broadcastInvalidation();
      return next;
    } catch (err: unknown) {
      this.safeWarn(
        `policy generation bump(${reason ?? "unknown"}) failed (fail-open): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      // 写失败也推进本地计数：至少本实例在途卡立即失效，不阻断 capability 主链。
      this.cachedVersion += 1;
      this.loaded = true;
      this.loadedAt = Date.now();
      return this.cachedVersion;
    }
  }

  /** 首次/TTL 过期时从 DB 回源一次；并发调用合流到同一 load。 */
  private async ensureLoaded(): Promise<void> {
    if (!this.config) return;
    if (
      this.loaded &&
      Date.now() - this.loadedAt < POLICY_GENERATION_CACHE_TTL_MS
    ) {
      return;
    }
    if (this.inflight) {
      await this.inflight;
      return;
    }
    const task = this.loadFromStore().finally(() => {
      if (this.inflight === task) this.inflight = null;
    });
    this.inflight = task;
    await task;
  }

  private async loadFromStore(): Promise<void> {
    try {
      this.cachedVersion = await this.readServerVersion();
    } catch (err: unknown) {
      // readServerVersion 内部已 fail-open；这里保底，绝不冒泡。
      this.safeWarn(
        `policy generation version load failed (fail-open): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    this.loaded = true;
    this.loadedAt = Date.now();
  }

  /** 从存储读版本；key 不存在或读失败 → 0 + warn（fail-open）。 */
  private async readServerVersion(): Promise<number> {
    try {
      const row = await this.config!.findOne(POLICY_GENERATION_CONFIG_KEY);
      const n = Number(row?.value);
      return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 0;
    } catch (err: unknown) {
      this.safeWarn(
        `policy generation version read failed (fail-open): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return 0;
    }
  }

  /**
   * 读-改-写 + 短重试（无原子 increment，见文件头并发窗口）。
   * 写后回读确认：确认值 >= 写入值即采纳（并发写入者只会让值更大，单调不回退）。
   */
  private async writeIncremented(): Promise<number> {
    const MAX_ATTEMPTS = 3;
    let observed = 0;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const before = await this.readServerVersion();
      const next = Math.max(before, this.cachedVersion) + 1;
      await this.config!.upsert({
        key: POLICY_GENERATION_CONFIG_KEY,
        value: String(next),
        valueType: POLICY_GENERATION_VALUE_TYPE,
        description: "workbench 方案卡策略代际版本（N14 持久化）",
      });
      const confirmed = await this.readServerVersion();
      if (confirmed >= next) return confirmed;
      // 并发写入者把值改小（异常路径）才重试；正常只会更大，上面已返回。
      observed = confirmed;
    }
    return observed + 1;
  }

  /** 广播失效：缺席即 no-op；publishInvalidate 本身 fire-and-forget 吞失败。 */
  private async broadcastInvalidation(): Promise<void> {
    if (!this.invalidator) return;
    try {
      await this.invalidator.publishInvalidate(POLICY_GENERATION_CONFIG_KEY);
    } catch (err: unknown) {
      this.safeWarn(
        `policy generation invalidation broadcast failed (fail-open): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private safeWarn(message: string): void {
    if (typeof this.logger?.warn === "function") this.logger.warn(message);
  }
}
