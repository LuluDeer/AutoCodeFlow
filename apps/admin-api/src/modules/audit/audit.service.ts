import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository, LessThan } from "typeorm";
import { Cron } from "@nestjs/schedule";
import { AuditLog } from "./entities/audit-log.entity";

export interface AuditLogPayload {
  userId?: number;
  username?: string;
  action: string;
  resource?: string;
  resourceId?: string;
  detail?: Record<string, any>;
  ip?: string;
  result?: "success" | "failure";
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(
    @InjectRepository(AuditLog)
    private readonly repo: Repository<AuditLog>,
  ) {}

  async log(payload: AuditLogPayload): Promise<void> {
    const entry = this.repo.create({
      ...payload,
      result: payload.result ?? "success",
    });
    await this.repo.save(entry);
  }

  /** Q7: Daily at 2:05am, clean up audit logs older than 180 days */
  @Cron("0 5 2 * * *")
  async cleanupOldAuditLogs(): Promise<void> {
    const oneEightyDaysAgo = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000);
    const result = await this.repo.delete({
      createdAt: LessThan(oneEightyDaysAgo),
    });
    if (result.affected && result.affected > 0) {
      // Log the cleanup itself — but don't create an audit log entry to avoid recursion
      this.logger.log(
        `Q7 Cleanup: removed ${result.affected} audit logs older than 180 days`,
      );
    }
  }

  /**
   * Export audit logs as CSV.
   * Applies the same filters as findAll but streams all matching rows (no pagination cap).
   * Returns a CSV string with headers.
   */
  async exportCsv(options: {
    action?: string;
    resource?: string;
    userId?: number;
  }): Promise<string> {
    const { action, resource, userId } = options;
    const qb = this.repo
      .createQueryBuilder('log')
      .orderBy('log.createdAt', 'DESC');

    if (action) {
      const sanitizedAction = action.trim().slice(0, 100);
      if (!/^[a-zA-Z0-9_.\-\s]+$/.test(sanitizedAction)) {
        throw new Error('Invalid action parameter');
      }
      qb.andWhere('log.action ILIKE :action', { action: `%${sanitizedAction}%` });
    }
    if (resource) qb.andWhere('log.resource = :resource', { resource });
    if (userId) qb.andWhere('log.userId = :userId', { userId });

    // Cap export at 10 000 rows to avoid memory exhaustion
    const rows = await qb.take(10_000).getMany();

    const escape = (v: unknown) => {
      if (v === null || v === undefined) return '';
      const s = String(v);
      if (s.includes(',') || s.includes('"') || s.includes('\n')) {
        return `"${s.replace(/"/g, '""')}"`;
      }
      return s;
    };

    const header = 'id,userId,username,action,resource,resourceId,result,ip,createdAt';
    const lines = rows.map((r) =>
      [
        r.id,
        r.userId ?? '',
        r.username ?? '',
        r.action,
        r.resource ?? '',
        r.resourceId ?? '',
        r.result ?? '',
        r.ip ?? '',
        r.createdAt?.toISOString() ?? '',
      ]
        .map(escape)
        .join(','),
    );
    return [header, ...lines].join('\n');
  }

  async findAll(options: {
    page?: number;
    pageSize?: number;
    action?: string;
    resource?: string;
    userId?: number;
  }): Promise<{ data: AuditLog[]; total: number }> {
    const { page = 1, pageSize = 20, action, resource, userId } = options;
    const qb = this.repo
      .createQueryBuilder("log")
      .orderBy("log.createdAt", "DESC");

    // SEC-03: Validate and sanitize action parameter to prevent SQL injection and performance issues
    if (action) {
      // Limit action length to prevent DoS
      const sanitizedAction = action.trim().slice(0, 100);
      // Only allow alphanumeric, underscore, hyphen, and space characters
      if (!/^[a-zA-Z0-9_.\-\s]+$/.test(sanitizedAction)) {
        throw new Error(
          "Invalid action parameter: only alphanumeric characters, underscores, hyphens, and spaces are allowed",
        );
      }
      qb.andWhere("log.action ILIKE :action", {
        action: `%${sanitizedAction}%`,
      });
    }

    if (resource) qb.andWhere("log.resource = :resource", { resource });
    if (userId) qb.andWhere("log.userId = :userId", { userId });
    // Q12: cap pageSize to prevent full-table scans regardless of caller input
    const safePageSize = Math.min(pageSize, 100);
    const [data, total] = await qb
      .skip((page - 1) * safePageSize)
      .take(safePageSize)
      .getManyAndCount();
    return { data, total };
  }
}
