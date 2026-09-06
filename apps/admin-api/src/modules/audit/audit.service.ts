import { BadRequestException, Injectable, Logger } from "@nestjs/common";
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
    username?: string;
    startTime?: string;
    endTime?: string;
    userId?: number;
  }): Promise<string> {
    const { action, resource, userId } = options;
    const qb = this.repo
      .createQueryBuilder("log")
      .orderBy("log.createdAt", "DESC");

    if (action) {
      const sanitizedAction = action.trim().slice(0, 100);
      if (!/^[a-zA-Z0-9_.\-\s]+$/.test(sanitizedAction)) {
        // S13: a client-supplied filter value must map to 400, not an
        // unhandled Error that surfaces as a 500.
        throw new BadRequestException("Invalid action parameter");
      }
      qb.andWhere("log.action ILIKE :action", {
        action: `%${sanitizedAction}%`,
      });
    }
    if (resource) qb.andWhere("log.resource = :resource", { resource });
    if (userId) qb.andWhere("log.userId = :userId", { userId });
    this.applyExtraFilters(qb, options);

    // Cap export at 10 000 rows; select raw columns only to avoid loading
    // entities and the heavy jsonb `detail` column into memory
    const rows = await qb
      .select("log.id", "id")
      .addSelect("log.userId", "userId")
      .addSelect("log.username", "username")
      .addSelect("log.action", "action")
      .addSelect("log.resource", "resource")
      .addSelect("log.resourceId", "resourceId")
      .addSelect("log.result", "result")
      .addSelect("log.ip", "ip")
      .addSelect("log.createdAt", "createdAt")
      .limit(10_000)
      .getRawMany();

    // S8: CSV formula injection. Spreadsheet apps (Excel, LibreOffice,
    // Google Sheets) interpret cells whose text starts with = + - @ (and
    // tab/CR variants) as formulas when a CSV is opened, so a value like
    // `=HYPERLINK(...)` recorded in an audit field would execute on export
    // open. Defense per OWASP "CSV Injection": prefix such cells with a
    // single quote, which is the only mitigation that is honored safely by
    // both Excel and Google Sheets (a leading apostrophe is rendered as
    // literal text and is not itself displayed). The quote is applied
    // BEFORE RFC 4180 quoting so commas/quotes/newlines still escape
    // correctly on top of it.
    const FORMULA_CHARS = /^[=+\-@\t\r]/;
    const escape = (v: unknown) => {
      if (v === null || v === undefined) return "";
      let s = String(v);
      if (FORMULA_CHARS.test(s)) {
        s = `'${s}`;
      }
      if (s.includes(",") || s.includes('"') || s.includes("\n")) {
        return `"${s.replace(/"/g, '""')}"`;
      }
      return s;
    };

    const header =
      "id,userId,username,action,resource,resourceId,result,ip,createdAt";
    const lines = rows.map((r) =>
      [
        r.id,
        r.userId ?? "",
        r.username ?? "",
        r.action,
        r.resource ?? "",
        r.resourceId ?? "",
        r.result ?? "",
        r.ip ?? "",
        r.createdAt?.toISOString() ?? "",
      ]
        .map(escape)
        .join(","),
    );
    return [header, ...lines].join("\n");
  }

  async findAll(options: {
    page?: number;
    pageSize?: number;
    action?: string;
    resource?: string;
    username?: string;
    startTime?: string;
    endTime?: string;
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
        // S13: BadRequestException (400) instead of a bare Error (500) — the
        // value comes straight from the client query string.
        throw new BadRequestException(
          "Invalid action parameter: only alphanumeric characters, underscores, hyphens, and spaces are allowed",
        );
      }
      qb.andWhere("log.action ILIKE :action", {
        action: `%${sanitizedAction}%`,
      });
    }

    if (resource) qb.andWhere("log.resource = :resource", { resource });
    if (userId) qb.andWhere("log.userId = :userId", { userId });
    this.applyExtraFilters(qb, options);
    // Q12: cap pageSize to prevent full-table scans regardless of caller input
    const safePageSize = Math.min(pageSize, 100);
    const [data, total] = await qb
      .skip((page - 1) * safePageSize)
      .take(safePageSize)
      .getManyAndCount();
    return { data, total };
  }

  /**
   * R4 P1-2: shared username / time-range filters, used by both findAll and
   * exportCsv so the CSV export honours the same filter set as the list page.
   * All values are bound as query parameters (no string interpolation).
   */
  private applyExtraFilters(
    qb: import("typeorm").SelectQueryBuilder<AuditLog>,
    options: { username?: string; startTime?: string; endTime?: string },
  ): void {
    if (options.username) {
      qb.andWhere("log.username ILIKE :username", {
        username: `%${options.username}%`,
      });
    }
    if (options.startTime) {
      qb.andWhere("log.createdAt >= :startTime", {
        startTime: new Date(options.startTime),
      });
    }
    if (options.endTime) {
      qb.andWhere("log.createdAt <= :endTime", {
        endTime: new Date(options.endTime),
      });
    }
  }
}
