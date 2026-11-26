/**
 * N18 rewind 代际围栏的服务端消费层（把 rewind-fence 纯判定接进生产链）。
 *
 * 分工：
 * - rewind-fence.ts 只做纯判定，本文件不重写代际比较；
 * - 代际只读服务端注入的 PolicyGenerationService（token 别名
 *   REWIND_GENERATION_SOURCE），客户端传来的任何代际锚点都不参与判定；
 * - 在途写入只从服务端注入的 RewindAsyncWriteSource 取，作废集合不进入 apply
 *   （落盘与通知扇出同源）——NotificationService 无撤回 API，作废即「不扇出」，
 *   本文件不新建任何通知接口；
 * - 每次执行都记一条字面量 action 的审计，detail.invalidatedCount 即作废数。
 *
 * 用字符串 token 注入而非值 import AuditService / PolicyGenerationService：
 * 内存替身单测（ts-jest/CJS）不必装载这两个服务的 ESM 依赖，controller 也因此
 * 可以安全地值 import 本文件而不牵连既有 preview/commit 单测。
 */
import {
  Inject as NestInject,
  Injectable,
  Logger,
  Optional,
} from "@nestjs/common";

import type { AuditLogPayload } from "../audit/audit.service";
import {
  fenceAsyncWrites,
  type FencedPart,
  type PendingAsyncWrite,
} from "./rewind-fence";

/** 极简框架替身可能没有 @Inject；缺席降级 no-op（同 workbench.controller.ts:71）。 */
const Inject: (...args: any[]) => any =
  typeof NestInject === "function" ? NestInject : () => () => undefined;

/** DI token：生产由 WorkbenchModule useExisting 别名到真实服务。 */
export const REWIND_GENERATION_SOURCE = "REWIND_GENERATION_SOURCE";
export const REWIND_AUDIT_SINK = "REWIND_AUDIT_SINK";
export const REWIND_ASYNC_WRITE_SOURCE = "REWIND_ASYNC_WRITE_SOURCE";

/** 运行时代际读取口（PolicyGenerationService.currentGeneration 的结构面）。 */
export interface RewindGenerationSource {
  currentGeneration(): Promise<string>;
}

/** 审计写入口（AuditService.log 的结构面）。 */
export interface RewindAuditSink {
  log(payload: AuditLogPayload): Promise<void>;
}

/**
 * 在途异步写入的服务端数据源 + 执行面。
 *
 * listParts / listPendingWrites 由服务端仓储或注册表提供（绝不接客户端清单）；
 * apply 同时完成落盘与通知扇出，只对围栏放行集合调用。
 */
export abstract class RewindAsyncWriteSource {
  abstract listParts(
    sessionId: string,
    partIds?: readonly string[],
  ): Promise<readonly FencedPart[]>;
  abstract listPendingWrites(
    sessionId: string,
    partIds?: readonly string[],
  ): Promise<readonly PendingAsyncWrite[]>;
  abstract apply(write: PendingAsyncWrite): Promise<void>;
}

/** 缺席回退：无在途写入、不执行任何副作用；审计仍落（invalidatedCount=0）。 */
export class EmptyRewindAsyncWriteSource extends RewindAsyncWriteSource {
  async listParts(): Promise<readonly FencedPart[]> {
    return [];
  }
  async listPendingWrites(): Promise<readonly PendingAsyncWrite[]> {
    return [];
  }
  async apply(): Promise<void> {
    return;
  }
}

export interface RewindExecutionInput {
  readonly sessionId: string;
  readonly partIds?: readonly string[];
  readonly username?: string;
}

export interface RewindExecutionResult {
  readonly resourceId: string;
  readonly allowedCount: number;
  readonly invalidatedCount: number;
  readonly executedWriteIds: string[];
  readonly generation: string | null;
}

@Injectable()
export class RewindRunner {
  private readonly logger = new Logger(RewindRunner.name);

  constructor(
    @Inject(REWIND_GENERATION_SOURCE)
    private readonly generation: RewindGenerationSource,
    @Inject(REWIND_AUDIT_SINK)
    private readonly audit: RewindAuditSink,
    @Optional()
    @Inject(REWIND_ASYNC_WRITE_SOURCE)
    private readonly source?: RewindAsyncWriteSource | null,
  ) {}

  /**
   * 执行一次 rewind：取数 → 读服务端代际 → 围栏判定 → 只执行放行组 → 留审计。
   * 代际读取失败按 fail-closed 处理（null ⇒ 全部作废），不放过任何在途写入。
   */
  async rewind(input: RewindExecutionInput): Promise<RewindExecutionResult> {
    const source = this.source ?? new EmptyRewindAsyncWriteSource();
    const [parts, pendingWrites] = await Promise.all([
      source.listParts(input.sessionId, input.partIds),
      source.listPendingWrites(input.sessionId, input.partIds),
    ]);

    let currentGeneration: string | null = null;
    try {
      currentGeneration = (await this.generation.currentGeneration()) ?? null;
    } catch (err: unknown) {
      currentGeneration = null;
      if (typeof this.logger?.warn === "function") {
        this.logger.warn(
          `N18 rewind：当前代际读取失败，全部作废（fail-closed）：` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const verdict = fenceAsyncWrites(parts, currentGeneration, pendingWrites);

    // 作废组不进 apply：既不落盘，也不扇出通知（无撤回 API，作废 = 不调用）。
    const executedWriteIds: string[] = [];
    for (const write of verdict.allowed) {
      await source.apply(write);
      executedWriteIds.push(write.id);
    }

    // audit guard 只认 action: "x.y" 字面量（常量引用会失明）——保持字面量直写。
    await this.audit.log({
      action: "workbench.rewind",
      resource: "workbench",
      resourceId: input.sessionId,
      username: input.username,
      detail: { invalidatedCount: verdict.invalidatedCount },
    });

    return {
      resourceId: input.sessionId,
      allowedCount: verdict.allowed.length,
      invalidatedCount: verdict.invalidatedCount,
      executedWriteIds,
      generation: currentGeneration,
    };
  }
}
