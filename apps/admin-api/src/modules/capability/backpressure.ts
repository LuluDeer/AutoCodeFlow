/**
 * N24 中间形态 —— slots / streams 双限流（纯状态机，零异步 / 零 IO）。
 *
 * slots 是有身份的有限槽位：acquire 返回 token，release 凭 token 归还；
 * streams 是无身份的并发计数：enterStream 放行 / leaveStream 归还。
 * 两者都在上限内放行、超限拒绝且**不改动状态**（fail-closed）。
 *
 * 上限非法（负数 / 非整数 / 非有限数）、token 为空、初始状态畸形一律按
 * fail-closed 收敛：不抛异常，所有 acquire / enter 返回 null / false。
 * 本文件不依赖 Nest、DB、时间或随机数；可独立单测。
 */

export interface BackpressureLimits {
  readonly maxSlots: number;
  readonly maxStreams: number;
}

/** 只读快照；调用方拿到的数组是副本，改它不影响状态机。 */
export interface BackpressureState {
  readonly slots: readonly string[];
  readonly streams: number;
}

export interface BackpressureController {
  readonly state: BackpressureState;
  /** 占用一个槽位；token 省略时生成确定性 token；超限或非法 token ⇒ null。 */
  acquireSlot(token?: string): string | null;
  /** 归还 token；空 token / 未占用 token ⇒ false 且状态不变。 */
  releaseSlot(token: string): boolean;
  /** 并发流进入；达上限 ⇒ false 且状态不变。 */
  enterStream(): boolean;
  /** 并发流离开；零计数 ⇒ false 且状态不变。 */
  leaveStream(): boolean;
}

function validLimit(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 0
  );
}

function validToken(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * 构造一张有界状态机。非法 limits 收敛成「永久拒绝」状态机，不抛错。
 * initial 只在完整合法时采纳（槽位数不超上限、token 非空且唯一、流计数在界内），
 * 否则从空态起且保持 fail-closed。
 */
export function createBackpressure(
  limits: BackpressureLimits | null | undefined,
  initial?: BackpressureState | null,
): BackpressureController {
  const maxSlots = validLimit(limits?.maxSlots) ? limits.maxSlots : -1;
  const maxStreams = validLimit(limits?.maxStreams) ? limits.maxStreams : -1;
  const invalid = maxSlots < 0 || maxStreams < 0;
  const slots: string[] = [];
  let streams = 0;
  let sequence = 0;

  const initialSlots: readonly unknown[] = Array.isArray(initial?.slots)
    ? initial.slots
    : [];
  if (
    !invalid &&
    initialSlots.length <= maxSlots &&
    initialSlots.every(validToken) &&
    new Set(initialSlots.map((token) => (token as string).trim())).size ===
      initialSlots.length &&
    validLimit(initial?.streams) &&
    (initial?.streams as number) <= maxStreams
  ) {
    slots.push(...initialSlots.map((token) => (token as string).trim()));
    streams = initial.streams as number;
  }

  return {
    get state(): BackpressureState {
      return { slots: Object.freeze(slots.slice()), streams };
    },
    acquireSlot(token?: string): string | null {
      if (invalid || slots.length >= maxSlots) return null;
      let resolved: string;
      if (token === undefined) {
        do {
          sequence += 1;
          resolved = `slot:${sequence}`;
        } while (slots.includes(resolved));
      } else if (validToken(token)) {
        resolved = token.trim();
        if (slots.includes(resolved)) return null;
      } else {
        return null;
      }
      slots.push(resolved);
      return resolved;
    },
    releaseSlot(token: string): boolean {
      if (!validToken(token)) return false;
      const trimmed = token.trim();
      const index = slots.indexOf(trimmed);
      if (index < 0) return false;
      slots.splice(index, 1);
      return true;
    },
    enterStream(): boolean {
      if (invalid || streams >= maxStreams) return false;
      streams += 1;
      return true;
    },
    leaveStream(): boolean {
      if (invalid || streams <= 0) return false;
      streams -= 1;
      return true;
    },
  };
}
