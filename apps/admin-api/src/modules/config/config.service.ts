import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { SystemConfig } from "./entities/system-config.entity";
import { ConfigHistory } from "./entities/config-history.entity";
import { UpsertConfigDto } from "./dto/upsert-config.dto";

interface HistoryOptions {
  userId?: string;
  username?: string;
  ipAddress?: string;
}

@Injectable()
export class SystemConfigService {
  constructor(
    @InjectRepository(SystemConfig)
    private readonly repo: Repository<SystemConfig>,
    @InjectRepository(ConfigHistory)
    private readonly historyRepo: Repository<ConfigHistory>,
  ) {}

  findAll(): Promise<SystemConfig[]> {
    return this.repo.find({ order: { key: "ASC" } });
  }

  async findOne(key: string): Promise<SystemConfig> {
    const config = await this.repo.findOneBy({ key });
    if (!config) throw new NotFoundException(`Config key "${key}" not found`);
    return config;
  }

  async upsert(
    dto: UpsertConfigDto,
    options?: HistoryOptions,
  ): Promise<SystemConfig> {
    const existing = await this.repo.findOneBy({ key: dto.key });
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

    await this.repo.upsert(
      {
        key: dto.key,
        value,
        description: dto.description,
        valueType: dto.valueType ?? "string",
        isSecret,
      },
      { conflictPaths: ["key"], skipUpdateIfNoValuesChanged: true },
    );

    await this.recordHistory({
      configKey: dto.key,
      oldValue: existing?.value,
      newValue: value,
      description: dto.description,
      action,
      ...options,
    });

    return this.repo.findOneBy({ key: dto.key });
  }

  async remove(
    key: string,
    options?: HistoryOptions,
  ): Promise<{ deleted: boolean }> {
    const config = await this.repo.findOneBy({ key });
    if (!config) throw new NotFoundException(`Config key "${key}" not found`);

    await this.recordHistory({
      configKey: key,
      oldValue: config.value,
      newValue: null,
      description: config.description,
      action: "delete",
      ...options,
    });

    await this.repo.remove(config);
    return { deleted: true };
  }

  async batchUpsert(
    items: UpsertConfig[],
    options?: HistoryOptions,
  ): Promise<SystemConfig[]> {
    const results: SystemConfig[] = [];
    for (const item of items) {
      const dto: UpsertConfigDto = {
        key: item.key,
        value: item.value,
        description: item.description,
        valueType: item.valueType,
        isSecret: item.isSecret,
      };
      const result = await this.upsert(dto, options);
      results.push(result);
    }
    return results;
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
   *   掩码只出现在控制器读取面（getHistory/findOne 等对 secret 键的出参）。
   * - 所以本方法从库里读到的 history.oldValue 就是历史真实值，可直接回写。
   * - 防御性守卫：若库里 oldValue 本身就是 '***'（只可能来自 S3 修复前的旧行、
   *   或"创建 secret 项时直接提交掩码"的边缘写入），且该键当前 isSecret，则
   *   拒绝回滚 —— 把掩码当真实值写回配置正是 S3 数据破坏的回滚版镜像。
   *
   * 语义矩阵：
   * - 条目不存在 → 404；
   * - action=create（oldValue 恒为 null）→ 回滚 = 删除该配置项（回到创建前
   *   状态；键已不存在则幂等成功，不写重复历史）；
   * - action=update 且 oldValue 为空 → 400 无回滚值（不会误删仍存在的键）；
   * - action=delete（oldValue 为被删时的真实值，可能为 null）→ 按 oldValue
   *   重建该键；
   * - 其余（update 且 oldValue 非空）→ 把值写回 oldValue，仅回滚值本身：
   *   行仍在时保留其当前 description/valueType/isSecret（历史行不记录这些
   *   元数据），行已删除时以历史行记录的 description 重建、valueType/isSecret
   *   不可知按默认值落库。
   *
   * 每次回滚本身写一条 action='rollback' 的历史（含操作者 userId/username/
   * ipAddress）。不走 this.upsert() 是因为它会再落一条 'update'/'create' 历史、
   * 把回滚伪装成普通修改，且其 description 入参会覆盖配置项描述。
   */
  async rollback(
    historyId: number,
    options?: HistoryOptions,
  ): Promise<SystemConfig | { deleted: true }> {
    const history = await this.historyRepo.findOneBy({ id: historyId });
    if (!history)
      throw new NotFoundException(`History record "${historyId}" not found`);

    if (history.action === "create") {
      const existing = await this.repo.findOneBy({ key: history.configKey });
      if (existing) {
        await this.recordHistory({
          configKey: history.configKey,
          oldValue: existing.value,
          newValue: null,
          description: existing.description,
          action: "rollback",
          ...options,
        });
        await this.repo.remove(existing);
      }
      return { deleted: true };
    }

    if (history.action !== "delete" && history.oldValue == null) {
      throw new BadRequestException(
        `History record "${historyId}" has no oldValue to roll back to`,
      );
    }

    const current = await this.repo.findOneBy({ key: history.configKey });

    if (history.oldValue === "***" && current?.isSecret) {
      throw new BadRequestException(
        `History record "${historyId}" only holds the '***' mask for secret key "${history.configKey}"; refusing to write the mask back as a real value`,
      );
    }

    const dto: UpsertConfigDto = {
      key: history.configKey,
      value: history.oldValue,
      description: current ? current.description : history.description,
      valueType: current ? current.valueType : "string",
      isSecret: current ? current.isSecret : false,
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

    await this.recordHistory({
      configKey: history.configKey,
      oldValue: current?.value ?? null,
      newValue: history.oldValue,
      description: dto.description,
      action: "rollback",
      ...options,
    });

    return this.repo.findOneBy({ key: history.configKey });
  }

  async validateConfig(dto: UpsertConfigDto): Promise<void> {
    const allowedTypes = ["string", "number", "boolean", "json"];
    if (dto.valueType && !allowedTypes.includes(dto.valueType)) {
      throw new BadRequestException(
        `Invalid valueType: ${dto.valueType}. Allowed types: ${allowedTypes.join(", ")}`,
      );
    }

    if (dto.valueType === "json") {
      try {
        JSON.parse(dto.value ?? "null");
      } catch {
        throw new BadRequestException("Invalid JSON value");
      }
    }

    if (
      dto.valueType === "boolean" &&
      !["true", "false"].includes(dto.value?.toLowerCase() ?? "")
    ) {
      throw new BadRequestException('Boolean value must be "true" or "false"');
    }

    if (dto.valueType === "number" && isNaN(parseFloat(dto.value ?? ""))) {
      throw new BadRequestException("Invalid number value");
    }
  }

  private async recordHistory(data: {
    configKey: string;
    oldValue: string | null;
    newValue: string | null;
    description?: string;
    action: "create" | "update" | "delete" | "rollback";
    userId?: string;
    username?: string;
    ipAddress?: string;
  }): Promise<void> {
    const history = this.historyRepo.create({
      configKey: data.configKey,
      oldValue: data.oldValue,
      newValue: data.newValue,
      description: data.description,
      action: data.action,
      userId: data.userId,
      username: data.username,
      ipAddress: data.ipAddress,
    });
    await this.historyRepo.save(history);
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
      select: ["key"],
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
}

export interface UpsertConfig {
  key: string;
  value?: string;
  description?: string;
  valueType?: string;
  isSecret?: boolean;
}
