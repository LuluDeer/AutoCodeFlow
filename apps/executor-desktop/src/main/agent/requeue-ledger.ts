/**
 * 待重发 id 的磁盘锚点（claim ledger）。
 *
 * ## 它解决什么
 * `agent-host` 的重发通道（`resendAssignments: string[]`）此前只活在内存里：
 * poll 一次可能下发 ≤3 张指派，本轮只跑第 1 张，其余进 `resendAssignmentIds`
 * 等下一轮定向重投。**待重发的 id 只在内存**——host 在「poll 拿到 items」到
 * 「下轮 poll」之间崩溃/退出，这些 id 就彻底丢了：中台侧它们已被标
 * in_progress 并写了 pulledAt，下一轮 requested 恒 false，只能空转到 10min
 * 被判 stalled。同理，`agent_disabled_during_poll` 的回报失败、瞬态续跑、
 * awaiting_reply 回排也都只有内存锚点。
 *
 * 本模块只做一件事：**把 id 落盘**（`<workDir>/agent-journal/requeue.json`），
 * 重启后把这些 id 重新并入内存队列，让下一轮 poll 按 id 定向重投。
 *
 * ## 纪律（三条红线）
 * 1. **只存 id**：没有 SOP 载荷、没有阶段、没有计数。账本不承担恢复点职责
 *    ——恢复点始终是 assignment-journal（每个单一个文件）。
 * 2. **绝不因账本重建/覆盖任何单的 journal**：这是上一轮修掉的失败形态
 *    （把 awaiting_reply 的单重建成 running 后重跑，人工答复只能被 ACK 丢弃）。
 * 3. **fail-open**：任何读写失败只 warn，绝不抛给轮询循环——账本是「锦上添花
 *    的锚点」，不是 tick 的前置条件；读不出来就当没有历史（中台超时治理兜底）。
 *
 * ## 读写形态
 * - 原子写：写 `.tmp` 再 rename，崩溃不会留下半截 JSON。
 * - 读侧结构校验：必须是对象、`ids` 必须是数组、元素必须是非空字符串、去重、
 *   条数 ≤ 200、`updatedAt` 必须是可解析时间且不超过 7 天；任一条不满足即
 *   整份判废（丢弃 + warn），绝不让畸形文件影响 tick。
 */

import * as fs from 'fs';
import * as path from 'path';

/** 账本文件名（与 assignment-journal 同目录，便于运维一起看）。 */
export const REQUEUE_LEDGER_FILENAME = 'requeue.json';

/** 条数上限：一轮最多 3 张，正常水位在个位数；200 已远超任何真实积压。 */
export const REQUEUE_LEDGER_MAX_IDS = 200;

/**
 * 陈旧阈值：与 assignment-journal 的 7 天一致——更早的锚点对应的工单多半
 * 已被中台超时治理收走，再重发只是噪音（且中台会按未知/已终态忽略）。
 */
export const REQUEUE_LEDGER_STALE_MS = 7 * 24 * 60 * 60 * 1000;

/** 落盘形态：只有 id 列表与写入时刻。 */
export interface RequeueLedgerSnapshot {
  ids: string[];
  updatedAt: string;
}

export interface RequeueLedgerOptions {
  /** 时钟注入（selftest 用它验证 7 天陈旧判定）；缺省 Date.now。 */
  now?: () => number;
  /** 诊断出口（缺省带统一前缀的 console.warn）。 */
  warn?: (message: string) => void;
}

/** `<workDir>/agent-journal/requeue.json`。 */
export function requeueLedgerPath(workDir: string): string {
  return path.join(workDir, 'agent-journal', REQUEUE_LEDGER_FILENAME);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 账本的内存镜像 + 落盘。
 *
 * 每个 host 实例持有一个；首次访问时读盘（一次），此后每次变更即时原子落盘。
 * 所有公开方法都不抛异常（fail-open）——出问题只会走 `warn`。
 */
export class RequeueLedger {
  private ids: string[] | null = null;
  private readonly now: () => number;
  private readonly warn: (message: string) => void;

  constructor(
    private readonly workDir: string,
    opts: RequeueLedgerOptions = {},
  ) {
    this.now = opts.now ?? (() => Date.now());
    this.warn = opts.warn ?? ((message) => console.warn(`[requeue-ledger] ${message}`));
  }

  /** 当前账本（拷贝）。首次调用会读盘并做结构校验。 */
  list(): string[] {
    return [...this.ensureLoaded()];
  }

  has(assignmentId: string): boolean {
    return this.ensureLoaded().includes(assignmentId);
  }

  /** 批量入账，返回**实际落盘**的 id（重复的、非法的、超上限被挤掉的不算）。 */
  add(assignmentIds: readonly string[]): string[] {
    const ids = this.ensureLoaded();
    const added: string[] = [];
    for (const raw of assignmentIds) {
      if (typeof raw !== 'string') continue;
      const id = raw.trim();
      // assignmentId 来自中台载荷（不可信输入）：空串/空白串不入账，也绝不
      // 让它参与任何路径拼接（账本只存字符串，不拼路径）。
      if (id === '' || ids.includes(id)) continue;
      ids.push(id);
      added.push(id);
    }
    if (added.length === 0) return added;
    if (ids.length > REQUEUE_LEDGER_MAX_IDS) {
      // 积压超上限：丢最旧的（新的更贴近当下的在途单）。
      const overflow = ids.length - REQUEUE_LEDGER_MAX_IDS;
      const dropped = ids.splice(0, overflow);
      this.warn(`账本超出 ${REQUEUE_LEDGER_MAX_IDS} 条上限，丢弃最旧的 ${overflow} 条: ${dropped.join(',')}`);
    }
    this.flush();
    const survivors = new Set(ids);
    return added.filter((id) => survivors.has(id));
  }

  /** 删除一条（单张终态回报成功时调用）。返回是否真的删除了。 */
  remove(assignmentId: string): boolean {
    const ids = this.ensureLoaded();
    const at = ids.indexOf(assignmentId);
    if (at < 0) return false;
    ids.splice(at, 1);
    this.flush();
    return true;
  }

  /**
   * 对账：只保留 `keep` 里出现的 id（= 本轮中台仍投递的）。
   * 没被返回的 id 说明中台不再投递它（已终态 / 被别的执行器领走 / 单子没了），
   * 继续留着只会让重启后的 poll 请求一批不存在的 id。
   * 返回被移除的 id。
   */
  retain(keep: readonly string[]): string[] {
    const ids = this.ensureLoaded();
    const keepSet = new Set(keep);
    const dropped = ids.filter((id) => !keepSet.has(id));
    if (dropped.length === 0) return [];
    this.ids = ids.filter((id) => keepSet.has(id));
    this.flush();
    return dropped;
  }

  private ensureLoaded(): string[] {
    if (this.ids === null) this.ids = this.read();
    return this.ids;
  }

  /** 读盘 + 结构校验。任何异常/畸形都收敛为空账本（丢弃 + warn）。 */
  private read(): string[] {
    const file = requeueLedgerPath(this.workDir);
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
      // 不存在是常态（首次运行/已清空），不算异常
      if ((err as NodeJS.ErrnoException | null)?.code !== 'ENOENT') {
        this.warn(`读取失败，按空账本继续（fail-open）: ${file} — ${errorMessage(err)}`);
      }
      return [];
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.warn(`账本不是合法 JSON，已忽略: ${file}`);
      return [];
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      this.warn(`账本顶层不是对象，已忽略: ${file}`);
      return [];
    }
    const record = parsed as Record<string, unknown>;
    if (!Array.isArray(record.ids)) {
      this.warn(`账本 ids 不是数组，已忽略: ${file}`);
      return [];
    }
    if (record.ids.length > REQUEUE_LEDGER_MAX_IDS) {
      this.warn(
        `账本条数 ${record.ids.length} 超过上限 ${REQUEUE_LEDGER_MAX_IDS}，整份忽略: ${file}`,
      );
      return [];
    }
    const updatedAt = typeof record.updatedAt === 'string' ? Date.parse(record.updatedAt) : NaN;
    if (!Number.isFinite(updatedAt)) {
      this.warn(`账本 updatedAt 缺失/非法，已忽略: ${file}`);
      return [];
    }
    if (this.now() - updatedAt >= REQUEUE_LEDGER_STALE_MS) {
      // 陈旧：对应工单多半已被中台超时治理收走。丢弃但**不删文件**——下一次
      // 入账会用新的 updatedAt 覆盖它（读侧保持无副作用）。
      this.warn(`账本已超 ${REQUEUE_LEDGER_STALE_MS} ms 未更新，按空账本继续: ${file}`);
      return [];
    }
    const ids: string[] = [];
    const seen = new Set<string>();
    let invalid = 0;
    for (const value of record.ids) {
      if (typeof value !== 'string' || value.trim() === '') {
        invalid += 1;
        continue;
      }
      const id = value.trim();
      if (seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
    if (invalid > 0) {
      this.warn(`账本丢弃 ${invalid} 条非法 id（非字符串/空串）: ${file}`);
    }
    return ids;
  }

  /** 原子落盘（tmp + rename）。失败只 warn——内存镜像仍生效，本轮 tick 不受影响。 */
  private flush(): void {
    const ids = this.ids ?? [];
    const file = requeueLedgerPath(this.workDir);
    const snapshot: RequeueLedgerSnapshot = {
      ids: [...ids],
      updatedAt: new Date(this.now()).toISOString(),
    };
    const tmp = `${file}.tmp`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(snapshot), 'utf8');
      fs.renameSync(tmp, file);
    } catch (err) {
      this.warn(`写账本失败，锚点仅存内存（fail-open）: ${file} — ${errorMessage(err)}`);
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* 清临时文件失败无害——不会命中 *.json 的恢复扫描 */
      }
    }
  }
}
