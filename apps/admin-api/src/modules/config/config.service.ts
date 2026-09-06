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

  async rollback(
    historyId: number,
    options?: HistoryOptions,
  ): Promise<SystemConfig> {
    const history = await this.historyRepo.findOneBy({ id: historyId });
    if (!history)
      throw new NotFoundException(`History record "${historyId}" not found`);

    if (history.action === "delete") {
      const dto: UpsertConfigDto = {
        key: history.configKey,
        value: history.oldValue,
        description: history.description,
      };
      return this.upsert(dto, options);
    }

    const dto: UpsertConfigDto = {
      key: history.configKey,
      value: history.oldValue,
    };
    return this.upsert(dto, options);
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
    action: "create" | "update" | "delete";
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
