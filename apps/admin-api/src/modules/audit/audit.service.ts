import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuditLog } from './entities/audit-log.entity';

export interface AuditLogPayload {
  userId?: number;
  username?: string;
  action: string;
  resource?: string;
  resourceId?: string;
  detail?: Record<string, any>;
  ip?: string;
  result?: 'success' | 'failure';
}

@Injectable()
export class AuditService {
  constructor(
    @InjectRepository(AuditLog)
    private readonly repo: Repository<AuditLog>,
  ) {}

  async log(payload: AuditLogPayload): Promise<void> {
    const entry = this.repo.create({ ...payload, result: payload.result ?? 'success' });
    await this.repo.save(entry);
  }

  async findAll(options: {
    page?: number;
    pageSize?: number;
    action?: string;
    resource?: string;
    userId?: number;
  }): Promise<{ data: AuditLog[]; total: number }> {
    const { page = 1, pageSize = 20, action, resource, userId } = options;
    const qb = this.repo.createQueryBuilder('log').orderBy('log.createdAt', 'DESC');
    if (action) qb.andWhere('log.action ILIKE :action', { action: `%${action}%` });
    if (resource) qb.andWhere('log.resource = :resource', { resource });
    if (userId) qb.andWhere('log.userId = :userId', { userId });
    const [data, total] = await qb
      .skip((page - 1) * pageSize)
      .take(pageSize)
      .getManyAndCount();
    return { data, total };
  }
}
