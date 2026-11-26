/**
 * N18 rewind 代际围栏（纯判定层）。
 *
 * 会话/Part 带 generation；回退后旧代的异步写入与通知必须作废。
 * 本层只按入参算出放行/作废清单与审计计数，不落库、不发通知、不写审计。
 *
 * 代际语义只有一处：part-model.ts 的 isStaleGeneration（generation 严格 ===
 * 比较，缺失判旧，空串是合法 token）。本文件只负责把它套到每个待处理任务
 * 所关联的 Part 上，并对「当前代缺失/空」做 fail-closed 总闸。
 */
import {
  isStaleGeneration,
  type GenerationMarked,
  type GenerationToken,
} from "./part-model";

/** 围栏判定所需的最小 Part 面：id 用于关联待处理任务，generation 用于判代。 */
export interface FencedPart extends GenerationMarked {
  readonly id: string;
}

/** 待落盘/待通知的异步任务标记；partId 指向它归属的 Part。 */
export interface PendingAsyncWrite {
  readonly id: string;
  readonly partId: string;
}

/** 判定结果：放行清单、作废清单、作废计数（供上层审计「作废 N 任务」）。 */
export interface FenceResult<W> {
  allowed: W[];
  invalidated: W[];
  invalidatedCount: number;
}

/**
 * 按 Part 代际把待处理异步任务切成放行/作废两组。
 *
 * - 当前代缺失（null/undefined）或空串 ⇒ 全部作废（fail-closed）；
 * - 任务找不到归属 Part，或同 id 出现多个 Part（归属歧义）⇒ 作废；
 * - 其余一律复用 part-model 的 isStaleGeneration 判定，不在此重写比较逻辑。
 */
export function fenceAsyncWrites<W extends PendingAsyncWrite>(
  parts: readonly FencedPart[],
  currentGeneration: GenerationToken | null | undefined,
  pendingWrites: readonly W[],
): FenceResult<W> {
  const allowed: W[] = [];
  const invalidated: W[] = [];

  if (currentGeneration == null || currentGeneration === "") {
    return {
      allowed,
      invalidated: [...pendingWrites],
      invalidatedCount: pendingWrites.length,
    };
  }

  const byPartId = new Map<string, FencedPart | undefined>();
  for (const part of parts) {
    // 同 id 多份 ⇒ 代际归属不可判定；undefined 传给 isStaleGeneration 即判旧。
    byPartId.set(part.id, byPartId.has(part.id) ? undefined : part);
  }

  for (const write of pendingWrites) {
    const part = byPartId.get(write.partId);
    if (isStaleGeneration(part, currentGeneration)) {
      invalidated.push(write);
    } else {
      allowed.push(write);
    }
  }

  return {
    allowed,
    invalidated,
    invalidatedCount: invalidated.length,
  };
}
