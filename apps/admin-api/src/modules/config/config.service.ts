import { Injectable, Logger, Optional } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { Cron } from "@nestjs/schedule";
import { ConfigService } from "@nestjs/config";
import { SystemConfig } from "./entities/system-config.entity";
import { ConfigHistory } from "./entities/config-history.entity";
import { UpsertConfigDto } from "./dto/upsert-config.dto";
// B-10: config_history 只增不删——retention 复用 outbox 每日 retention 的
// 公共设施（cappedBatchedDelete 分批 + LeaderGate 门禁，ARCH-31 §5 铁律）。
import { LeaderGateService } from "../../common/leader-gate/leader-gate.service";
import { cappedBatchedDelete } from "../../common/utils/capped-batched-delete.util";
// LANG-ERR-01（后端错误码化）：用户面抛出统一走 AppError（带稳定码，前端按
// 用户语言渲染）。AppError 按状态码挂到对应内置异常原型上，故既有按异常类
// 断言的 spec 不受影响。
import { AppError } from "../../common/errors/app-error";
import { ErrorCode } from "../../common/errors/error-codes";

interface HistoryOptions {
  // PK-21（DEEP_REVIEW 0ef3bbe）：userId 对齐全库 integer 形态
  userId?: number;
  username?: string;
  ipAddress?: string;
}

/**
 * B-10: 每键保留的最近历史条数。rollback 依赖历史行（oldValue/description/
 * valueType/isSecret 快照），保 50 条让回滚在长活跃键上也始终可用；超出部分
 * 每日清理（payload 为纯文本 old/new 值，长期堆积无审计收益——审计面在
 * audit_logs，不在本表）。
 */
export const CONFIG_HISTORY_RETENTION_PER_KEY = 50;
/** 每日 04:05 清理（6 段 cron；错开 03:30/03:35/03:40/03:45/03:55 的既有维护窗）。 */
export const CONFIG_HISTORY_RETENTION_CRON = "0 5 4 * * *";
/** retention 分批大小（对齐 OUTBOX_RETENTION_BATCH_SIZE / LOG_RETENTION_BATCH_SIZE）。 */
export const CONFIG_HISTORY_RETENTION_BATCH_SIZE = 5000;

/**
 * PERF-2: findOne 进程内短 TTL 缓存的**回退默认值**（毫秒）。
 *
 * 真正的生效值来自配置中心（`systemConfig.cacheTtlMs`，Joi 默认 1000），
 * 这里只是 ConfigService 缺席（单测手工 new / 装配不全）时的兜底——与
 * configuration.ts 的缺省逐字节一致，避免两条默认值漂移。
 */
export const SYSTEM_CONFIG_CACHE_TTL_DEFAULT_MS = 1000;

@Injectable()
export class SystemConfigService {
  private readonly logger = new Logger(SystemConfigService.name);

  /**
   * PERF-2: findOne 的进程内短 TTL 缓存（key → 缓存行）。
   *
   * 为什么值得缓：SystemConfig 是「低频人写、极高频机读」的表——每次执行器
   * 派发/回调、每次 verifyExecutorToken 都会 findOne("executor.sharedToken")，
   * 单个短连接池上的同一条 SELECT 被打成热路径。
   *
   * ## 正确性（本设计唯一不能出错的地方）
   *
   * 全部写面（upsert / batchUpsert / remove / rollback）都收敛在本服务内，
   * 故**每一处写完都调 invalidateCache()**，同进程内「写后读」立即可见——
   * 不依赖 TTL 到期。TTL 只约束下面「多实例限制」那一类情况。
   *
   * ## 多实例限制（本轮刻意不做，见任务边界）
   *
   * 缓存是**进程内**的。HA（`--scale admin-api=N`）下实例 A 改配置，实例 B
   * 的缓存要到自己的 TTL 窗口过期才收敛——窗口内 B 可能用旧值（例如旧
   * 的 executor.sharedToken）。跨实例失效需要 pub/sub（先例：
   * executor/token-cache-sync.service.ts），本轮**不做**：它引入 Redis 依赖
   * 与新的失败面，而 TTL 已把最坏滞后压到 1s。真要跨实例强一致，把
   * SYSTEM_CONFIG_CACHE_TTL_MS 设为 0（回到逐次读库）即可，无需改代码。
   *
   * 存的是**实体引用**（与 TypeORM 返回的是同一个对象）：调用方若原地改写
   * 返回值会污染缓存。本服务的读面只读不写，调用方（控制器/守卫）同样只读；
   * 写面一律走 repo.upsert，不经过这里。故刻意不做深拷贝（省掉每次热读的
   * 分配开销）。
   */
  private readonly cache = new Map<
    string,
    { config: SystemConfig; expiresAt: number }
  >();

  /** PERF-2: 生效的缓存窗口（毫秒；0 = 关闭）。构造期解析一次。 */
  private readonly cacheTtlMs: number;

  constructor(
    @InjectRepository(SystemConfig)
    private readonly repo: Repository<SystemConfig>,
    @InjectRepository(ConfigHistory)
    private readonly historyRepo: Repository<ConfigHistory>,
    // B-10: @Cron 维护任务的多实例门禁（@Optional——既有单测装配 gate 缺席
    // → null → 门禁不生效，先例同 outbox-dispatcher / log-retention-cleanup）。
    @Optional()
    private readonly leaderGate: LeaderGateService | null = null,
    // PERF-2: @Optional 仅为既有单测装配兼容（先例 leaderGate / executor 的
    // eventBus）——ConfigService 缺席时回落常量默认值，缓存照常工作。
    @Optional()
    private readonly configService: ConfigService | null = null,
  ) {
    const raw = this.configService?.get<number>("systemConfig.cacheTtlMs");
    const parsed = typeof raw === "string" ? parseInt(raw, 10) : raw;
    this.cacheTtlMs =
      typeof parsed === "number" && Number.isFinite(parsed) && parsed > 0
        ? parsed
        : parsed === 0
          ? 0
          : SYSTEM_CONFIG_CACHE_TTL_DEFAULT_MS;
  }

  // P3-1：SystemConfig 是极小配置表（个位数行），全表 find 无需分页——刻意保持现状。
  findAll(): Promise<SystemConfig[]> {
    return this.repo.find({ order: { key: "ASC" } });
  }

  /**
   * PERF-2: 清空整个读缓存。
   *
   * 刻意做成**全清**而不是按 key 精确删：配置表只有个位数行，全清的代价是
   * 几条 SELECT，而按 key 删在 batchUpsert / rollback（一次动多个 key、且
   * 失败回滚后 DB 与缓存可能不一致）下极易漏删——漏删就是静默的陈旧读，
   * 正是本缓存唯一不能犯的错。宁可多读几次，不可读到旧值。
   */
  private invalidateCache(): void {
    this.cache.clear();
  }

  async findOne(key: string): Promise<SystemConfig> {
    // PERF-2: 命中窗口内直接返回；cacheTtlMs=0 时整段短路（旧行为）。
    if (this.cacheTtlMs > 0) {
      const cached = this.cache.get(key);
      if (cached && Date.now() < cached.expiresAt) return cached.config;
    }

    const config = await this.repo.findOneBy({ key });
    if (!config) {
      // 不缓存「不存在」：负缓存会让「先读一次 404、随后创建」的路径在窗口内
      // 继续 404（配置项恰恰是按需创建的）。缺 key 本就是异常路径，不值得优化。
      throw new AppError(ErrorCode.CONFIG_ITEM_NOT_FOUND, { key });
    }

    if (this.cacheTtlMs > 0) {
      this.cache.set(key, {
        config,
        expiresAt: Date.now() + this.cacheTtlMs,
      });
    }
    return config;
  }

  async upsert(
    dto: UpsertConfigDto,
    options?: HistoryOptions,
  ): Promise<SystemConfig> {
    // 单条 upsert 保持原语义（走外部仓储，不强制事务）；batchUpsert 的事务
    // 路径复用同一实现但传入事务级仓储（WIKI-OPT-2）。
    try {
      return await this.upsertInStores(
        this.repo,
        this.historyRepo,
        dto,
        options,
      );
    } finally {
      // PERF-2: 失败也要失效——写事务/语句可能已部分生效（如历史行已落、
      // 配置行 upsert 失败），此时缓存里的旧值比「多读一次库」危险得多。
      this.invalidateCache();
    }
  }

  /**
   * WIKI-OPT-2: 单条 upsert 的实际实现，两个仓储由调用方注入——upsert()
   * 传外部（非事务）仓储，batchUpsert() 传事务级 manager.getRepository(...)。
   * 事务路径严禁混用外部 this.repo/this.historyRepo（外部连接不参与事务
   * 回滚，会留下部分写入）。
   */
  private async upsertInStores(
    repo: Repository<SystemConfig>,
    historyRepo: Repository<ConfigHistory>,
    dto: UpsertConfigDto,
    options?: HistoryOptions,
  ): Promise<SystemConfig> {
    const existing = await repo.findOneBy({ key: dto.key });
    const action = existing ? "update" : "create";

    // S3: the read surface masks secret values to '***' (ConfigController
    // findAll/findOne) and admin-web prefills that mask into the edit form.
    // Saving a form that round-trips the mask must not clobber the real
    // secret (e.g. executor.sharedToken drives cluster-wide executor auth).
    // Same sentinel semantics as the notification ChannelConfigStore write
    // path: a value of '***' on an isSecret item means "unchanged" — keep the
    // stored value instead of persisting the mask.
    const isSecret = dto.isSecret ?? false;
    let value = dto.value;
    if (isSecret && value === "***" && existing) {
      value = existing.value;
    }

    // Validate the effective value (a '***' sentinel is not valid JSON, but
    // the preserved real value may well be).
    await this.validateConfig({ ...dto, value });

    await repo.upsert(
      {
        key: dto.key,
        value,
        description: dto.description,
        valueType: dto.valueType ?? "string",
        isSecret,
      },
      { conflictPaths: ["key"], skipUpdateIfNoValuesChanged: true },
    );

    await this.recordHistory(historyRepo, {
      configKey: dto.key,
      oldValue: existing?.value,
      newValue: value,
      description: dto.description,
      // WIKI-OPT-2: 历史行持久化落库后的最终元数据（与上方 repo.upsert
      // 写入值一致），供回滚恢复与读面行级保密使用。
      valueType: dto.valueType ?? "string",
      isSecret,
      action,
      ...options,
    });

    return repo.findOneBy({ key: dto.key });
  }

  async remove(
    key: string,
    options?: HistoryOptions,
  ): Promise<{ deleted: boolean }> {
    // PERF-2: remove 有 404 早退分支，故用 try/finally 而不是在每个 return
    // 前手写失效——早退路径同样可能已被别的并发写改过，全清最安全。
    try {
      const config = await this.repo.findOneBy({ key });
      if (!config) throw new AppError(ErrorCode.CONFIG_ITEM_NOT_FOUND, { key });

      await this.recordHistory(this.historyRepo, {
        configKey: key,
        oldValue: config.value,
        newValue: null,
        description: config.description,
        // WIKI-OPT-2: 记被删配置行的原元数据（行删除后回滚可如实在原，
        // 读面行级保密也依赖它）。
        valueType: config.valueType,
        isSecret: config.isSecret,
        action: "delete",
        ...options,
      });

      await this.repo.remove(config);
      return { deleted: true };
    } finally {
      this.invalidateCache();
    }
  }

  /**
   * WIKI-OPT-2: 批量 upsert 事务化——整批（每条的配置写入 + 历史写入）
   * 包在单个数据库事务内，任一项失败整体回滚并向上抛错，不再留下部分写入
   * （wiki page-19 评审：此前 for 循环顺序调用 upsert 无原子性）。
   * 事务内一律走事务级 manager.getRepository(...)，不混用外部 this.repo。
   * 单条 upsert() 保持原语义（不强制也走事务）。
   */
  async batchUpsert(
    items: UpsertConfig[],
    options?: HistoryOptions,
  ): Promise<SystemConfig[]> {
    try {
      return await this.repo.manager.transaction(async (manager) => {
        const txConfigRepo = manager.getRepository(SystemConfig);
        const txHistoryRepo = manager.getRepository(ConfigHistory);
        const results: SystemConfig[] = [];
        for (const item of items) {
          const dto: UpsertConfigDto = {
            key: item.key,
            value: item.value,
            description: item.description,
            valueType: item.valueType,
            isSecret: item.isSecret,
          };
          results.push(
            await this.upsertInStores(
              txConfigRepo,
              txHistoryRepo,
              dto,
              options,
            ),
          );
        }
        return results;
      });
    } finally {
      // PERF-2: 事务提交/回滚后都全清——提交后要看到新值，回滚后要丢掉
      // 可能已被 upsertInStores 内 findOneBy 之外的路径污染的任何缓存行。
      this.invalidateCache();
    }
  }

  async getHistory(
    key?: string,
    page = 1,
    limit = 20,
  ): Promise<{ data: ConfigHistory[]; total: number }> {
    const query = this.historyRepo
      .createQueryBuilder("h")
      .orderBy("h.createdAt", "DESC");

    if (key) {
      query.where("h.configKey = :key", { key });
    }

    const [data, total] = await query
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    return { data, total };
  }

  /**
   * FEAT-08: roll a config key back to the state recorded in a history entry.
   *
   * 掩码哨兵语义（S3 延伸场景，已核实写历史代码）：
   * - upsert 在 recordHistory 之前已把 '***' 哨兵解析为库中现值（isSecret 且
   *   existing 存在时），因此 config_history 落库的 old/new 是真实值；'***'
   *   掩码只出现在控制器读取面（getHistory/findOne 等出参；历史读面自
   *   WIKI-OPT-2 起按历史行持久化的 isSecret 行级掩码，存量 NULL 行沿用
   *   「按当前配置行 isSecret」的键级推断）。
   * - 所以本方法从库里读到的 history.oldValue 就是历史真实值，可直接回写。
   * - 防御性守卫：若库里 oldValue 本身就是 '***'（只可能来自 S3 修复前的旧行、
   *   或"创建 secret 项时直接提交掩码"的边缘写入），且该键当前 isSecret
   *   （行已删除时取历史行持久化的 isSecret，WIKI-OPT-2），则拒绝回滚 ——
   *   把掩码当真实值写回配置正是 S3 数据破坏的回滚版镜像。
   *
   * 语义矩阵：
   * - 条目不存在 → 404；
   * - action=create（oldValue 恒为 null）→ 回滚 = 删除该配置项（回到创建前
   *   状态；键已不存在则幂等成功，不写重复历史）；
   * - action=update 且 oldValue 为空 → 400 无回滚值（不会误删仍存在的键）；
   * - action=delete（oldValue 为被删时的真实值，可能为 null）→ 按 oldValue
   *   重建该键；
   * - 其余（update 且 oldValue 非空）→ 把值写回 oldValue，仅回滚值本身：
   *   行仍在时保留其当前 description/valueType/isSecret（不覆盖现状）；
   *   行已删除时以历史行记录的 description 重建，valueType/isSecret 优先
   *   取历史行持久化的元数据（迁移 1790000000018 起 recordHistory 落值，
   *   WIKI-OPT-2），存量旧行（NULL=元数据不可知）才回退默认值
   *   "string"/false。
   *
   * 每次回滚本身写一条 action='rollback' 的历史（含操作者 userId/username/
   * ipAddress）。不走 this.upsert() 是因为它会再落一条 'update'/'create' 历史、
   * 把回滚伪装成普通修改，且其 description 入参会覆盖配置项描述。
   */
  async rollback(
    historyId: number,
    options?: HistoryOptions,
  ): Promise<SystemConfig | { deleted: true }> {
    // PERF-2: 与 upsert/remove 同一条纪律——所有写面出口都全清缓存。rollback
    // 有三个返回点（create 回滚删除 / 404 早退 / 正常回写），try/finally 一次
    // 覆盖，避免日后新增分支漏失效。
    try {
      const history = await this.historyRepo.findOneBy({ id: historyId });
      if (!history) {
        throw new AppError(ErrorCode.CONFIG_HISTORY_NOT_FOUND, { historyId });
      }

      if (history.action === "create") {
        const existing = await this.repo.findOneBy({ key: history.configKey });
        if (existing) {
          await this.recordHistory(this.historyRepo, {
            configKey: history.configKey,
            oldValue: existing.value,
            newValue: null,
            description: existing.description,
            // WIKI-OPT-2: 记被删（回滚到创建前）配置行的原元数据。
            valueType: existing.valueType,
            isSecret: existing.isSecret,
            action: "rollback",
            ...options,
          });
          await this.repo.remove(existing);
        }
        return { deleted: true };
      }

      if (history.action !== "delete" && history.oldValue == null) {
        throw new AppError(ErrorCode.CONFIG_HISTORY_NO_ROLLBACK_VALUE, {
          historyId,
        });
      }

      const current = await this.repo.findOneBy({ key: history.configKey });

      if (
        history.oldValue === "***" &&
        (current?.isSecret || history.isSecret === true)
      ) {
        throw new AppError(ErrorCode.CONFIG_HISTORY_SECRET_MASK_ROLLBACK, {
          historyId,
          configKey: history.configKey,
        });
      }

      const dto: UpsertConfigDto = {
        key: history.configKey,
        value: history.oldValue,
        description: current ? current.description : history.description,
        // WIKI-OPT-2: 行已删除时优先取历史行持久化的元数据（迁移
        // 1790000000018 起 recordHistory 落值）；存量旧行（NULL=元数据
        // 不可知）才回退默认值。行仍在时保持现行为（保留当前行元数据）。
        valueType: current
          ? current.valueType
          : (history.valueType ?? "string"),
        isSecret: current ? current.isSecret : (history.isSecret ?? false),
      };

      // 与 upsert 同一套校验与同一写入形态（conflictPaths +
      // skipUpdateIfNoValuesChanged）。
      await this.validateConfig(dto);

      await this.repo.upsert(
        {
          key: dto.key,
          value: dto.value,
          description: dto.description,
          valueType: dto.valueType ?? "string",
          isSecret: dto.isSecret ?? false,
        },
        { conflictPaths: ["key"], skipUpdateIfNoValuesChanged: true },
      );

      await this.recordHistory(this.historyRepo, {
        configKey: history.configKey,
        oldValue: current?.value ?? null,
        newValue: history.oldValue,
        description: dto.description,
        // WIKI-OPT-2: 记回滚后落库的最终元数据（与上方 upsert 写入值一致）。
        valueType: dto.valueType ?? "string",
        isSecret: dto.isSecret ?? false,
        action: "rollback",
        ...options,
      });

      return this.repo.findOneBy({ key: history.configKey });
    } finally {
      this.invalidateCache();
    }
  }

  async validateConfig(dto: UpsertConfigDto): Promise<void> {
    const allowedTypes = ["string", "number", "boolean", "json"];
    if (dto.valueType && !allowedTypes.includes(dto.valueType)) {
      throw new AppError(ErrorCode.CONFIG_VALUE_TYPE_INVALID, {
        valueType: dto.valueType,
        allowedTypes: allowedTypes.join(", "),
      });
    }

    if (dto.valueType === "json") {
      try {
        JSON.parse(dto.value ?? "null");
      } catch {
        throw new AppError(ErrorCode.CONFIG_JSON_VALUE_INVALID);
      }
    }

    if (
      dto.valueType === "boolean" &&
      !["true", "false"].includes(dto.value?.toLowerCase() ?? "")
    ) {
      throw new AppError(ErrorCode.CONFIG_BOOLEAN_VALUE_INVALID);
    }

    if (dto.valueType === "number" && isNaN(parseFloat(dto.value ?? ""))) {
      throw new AppError(ErrorCode.CONFIG_NUMBER_VALUE_INVALID);
    }
  }

  private async recordHistory(
    historyRepo: Repository<ConfigHistory>,
    data: {
      configKey: string;
      oldValue: string | null;
      newValue: string | null;
      description?: string;
      // WIKI-OPT-2: 历史行持久化的元数据快照——upsert 路径记落库后的最终
      // 值，remove 路径记被删配置行的原值，rollback 路径记回滚后的值；
      // 不传落 NULL（元数据不可知，存量旧行语义）。
      valueType?: string | null;
      isSecret?: boolean | null;
      action: "create" | "update" | "delete" | "rollback";
      // PK-21（DEEP_REVIEW 0ef3bbe）：userId integer 对齐
      userId?: number;
      username?: string;
      ipAddress?: string;
    },
  ): Promise<void> {
    const history = historyRepo.create({
      configKey: data.configKey,
      oldValue: data.oldValue,
      newValue: data.newValue,
      description: data.description,
      valueType: data.valueType ?? null,
      isSecret: data.isSecret ?? null,
      action: data.action,
      userId: data.userId,
      username: data.username,
      ipAddress: data.ipAddress,
    });
    await historyRepo.save(history);
  }

  async getByPrefix(prefix: string): Promise<SystemConfig[]> {
    return this.repo
      .createQueryBuilder("c")
      .where("c.key LIKE :prefix", { prefix: `${prefix}%` })
      .orderBy("c.key", "ASC")
      .getMany();
  }

  /** Returns the set of config keys that are marked isSecret=true. Used by the
   *  controller to mask old/new values in history responses.
   */
  async getSecretKeys(): Promise<Set<string>> {
    const secrets = await this.repo.find({
      select: { key: true },
      where: { isSecret: true },
    });
    return new Set(secrets.map((s) => s.key));
  }

  async getByTag(tag: string): Promise<SystemConfig[]> {
    const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return this.repo
      .createQueryBuilder("c")
      .where("c.description ~* :tagPattern", {
        tagPattern: `(^|\\s|,|;)${escapedTag}(\\s|,|;|$)`,
      })
      .orderBy("c.key", "ASC")
      .getMany();
  }

  // ─── B-10: config_history 每日 retention（@Cron Leader 门禁） ──────────────

  /**
   * 每日 04:05 清理；失败只记日志，等下一轮 cron 重试。upsert/rollback/remove
   * 每次落一行历史（config_history 只增不删），本任务把每键超出保留数的旧行
   * 分批清掉，rollback 依赖的最近 CONFIG_HISTORY_RETENTION_PER_KEY 条永不动。
   */
  @Cron(CONFIG_HISTORY_RETENTION_CRON)
  async handleDailyHistoryRetention(): Promise<void> {
    // ARCH-31 §5: 多实例下仅 cron Leader 执行
    if (this.leaderGate && !this.leaderGate.isLeader) return;
    try {
      const deleted = await this.cleanupHistoryOverflow();
      if (deleted > 0) {
        this.logger.log(
          `B-10: 清理 ${deleted} 行超出每键保留 ${CONFIG_HISTORY_RETENTION_PER_KEY} 条的 config_history 历史`,
        );
      }
    } catch (err) {
      this.logger.error(
        `B-10: config_history retention 清理失败: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * 清理每键超出「最近 N 条」的历史行，返回删除总行数。
   *
   * 窗口函数按 (configKey, createdAt DESC, id DESC) 编号——同刻并发写入由
   * id 决胜，编号 ≤ N 的（每键最近 N 条，rollback 可用面）绝不在删除集内。
   * 分批 DELETE + 轮数/墙钟双闸（LOG-RETENTION-01），单晚删不完的余量交下
   * 一个 cron 周期（幂等）。
   */
  async cleanupHistoryOverflow(): Promise<number> {
    return cappedBatchedDelete({
      batchSize: CONFIG_HISTORY_RETENTION_BATCH_SIZE,
      logLabel: "B-10 config-history",
      logger: this.logger,
      executeBatch: async () => {
        const result = await this.historyRepo
          .createQueryBuilder()
          .delete()
          .where(
            `"id" IN (
              SELECT "victim"."id" FROM (
                SELECT "h"."id", ROW_NUMBER() OVER (
                  PARTITION BY "h"."configKey"
                  ORDER BY "h"."createdAt" DESC, "h"."id" DESC
                ) AS "rn"
                FROM "config_history" "h"
              ) "victim"
              WHERE "victim"."rn" > :keep
              ORDER BY "victim"."id"
              LIMIT :batchSize
            )`,
            {
              keep: CONFIG_HISTORY_RETENTION_PER_KEY,
              batchSize: CONFIG_HISTORY_RETENTION_BATCH_SIZE,
            },
          )
          .execute();
        return result.affected ?? 0;
      },
    });
  }
}

export interface UpsertConfig {
  key: string;
  value?: string;
  description?: string;
  valueType?: string;
  isSecret?: boolean;
}
