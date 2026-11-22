import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";

import { FunnelEvent } from "../entities/funnel-event.entity";
import { TelemetryOptinService } from "./telemetry-optin.service";

/**
 * TTFV 阶段2 的写入输入：只收事件名、哈希与时间。
 * 没有正文、凭据或原始 id 字段，避免把敏感数据带进长期事实表（方案 §6）。
 */
export interface RecordFunnelEventInput {
  installId: string;
  eventName: string;
  taskIdHash?: string | null;
  executionIdHash?: string | null;
  ts?: Date;
  dedupeKey: string;
}

export interface RecordFunnelEventResult {
  /** true = 本次真的新增一行；false = 未授权或 dedupeKey 已存在，本次无副作用。 */
  recorded: boolean;
  reason?: "duplicate" | "not_opted_in";
}

/**
 * `funnel_events` 的 append-only 写入口。
 *
 * R306（方案 §3.1）：本入口是 opt-in 判定的**单一闸门点**——安装完成、首次成功、
 * 预算耗尽等任何触发点都必须经此写入，未授权 install 在到达 SQL builder 之前
 * 就被拦下，任何触发点都绕不过未授权判定。
 *
 * 幂等走条件写 `INSERT ... ON CONFLICT DO NOTHING`：唯一索引 `uq_funnel_events_dedupe_key`
 * 是并发下的硬闸，失败语义收敛成 `{ recorded: false, reason: "duplicate" }`，
 * 调用方据此判断是否需要补记指标，无需捕获 23505。
 */
@Injectable()
export class FunnelEventsService {
  constructor(
    @InjectRepository(FunnelEvent)
    private readonly repo: Repository<FunnelEvent>,
    private readonly optin: TelemetryOptinService,
  ) {}

  async record(
    input: RecordFunnelEventInput,
  ): Promise<RecordFunnelEventResult> {
    // R306（方案 §3.1）：单一不可绕过闸门——先查授权再碰 SQL builder。
    // 只兜 isOptedIn 自身的异常（不含下面的 INSERT 链，真实写入故障照常抛出）：
    // 闸门异常一律按未授权处理，不产生任何漏斗事件。
    let optedIn = false;
    try {
      optedIn = await this.optin.isOptedIn(input.installId);
    } catch {
      optedIn = false;
    }
    if (!optedIn) {
      return { recorded: false, reason: "not_opted_in" };
    }

    const result = await this.repo
      .createQueryBuilder()
      .insert()
      .into(FunnelEvent)
      .values({
        installId: input.installId,
        eventName: input.eventName,
        taskIdHash: input.taskIdHash ?? null,
        executionIdHash: input.executionIdHash ?? null,
        ts: input.ts ?? new Date(),
        dedupeKey: input.dedupeKey,
      })
      // RETURNING 让 raw 在「真插入」时有一行、ON CONFLICT DO NOTHING 时为空；
      // 否则 PG 的 raw=[] 会把成功插入误判成重复。
      .returning(["dedupeKey"])
      .orIgnore()
      .execute();

    const inserted = Array.isArray(result.raw) ? result.raw.length : 0;
    return inserted > 0
      ? { recorded: true }
      : { recorded: false, reason: "duplicate" };
  }
}
