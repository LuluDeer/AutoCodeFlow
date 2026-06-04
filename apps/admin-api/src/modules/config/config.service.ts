import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SystemConfig } from './entities/system-config.entity';
import { UpsertConfigDto } from './dto/upsert-config.dto';

@Injectable()
export class SystemConfigService {
  constructor(
    @InjectRepository(SystemConfig)
    private readonly repo: Repository<SystemConfig>,
  ) {}

  findAll(): Promise<SystemConfig[]> {
    return this.repo.find({ order: { key: 'ASC' } });
  }

  async findOne(key: string): Promise<SystemConfig> {
    const config = await this.repo.findOneBy({ key });
    if (!config) throw new NotFoundException(`Config key "${key}" not found`);
    return config;
  }

  async upsert(dto: UpsertConfigDto): Promise<SystemConfig> {
    // 使用数据库原生 upsert，避免 TOCTOU 竞争条件
    await this.repo.upsert(
      { key: dto.key, value: dto.value, description: dto.description, valueType: dto.valueType ?? 'string', isSecret: dto.isSecret ?? false },
      { conflictPaths: ['key'], skipUpdateIfNoValuesChanged: true },
    );
    return this.repo.findOneBy({ key: dto.key });
  }

  async remove(key: string): Promise<{ deleted: boolean }> {
    const config = await this.repo.findOneBy({ key });
    if (!config) throw new NotFoundException(`Config key "${key}" not found`);
    await this.repo.remove(config);
    return { deleted: true };
  }
}
