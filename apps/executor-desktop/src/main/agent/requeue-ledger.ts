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
 * 1. **只存 id 与其「未返回」计数**：没有 SOP 载荷、没有阶段。账本不承担
 *    恢复点职责——恢复点始终是 assignment-journal（每个单一个文件）。
 *    唯一的附加字段是 `misses`/`lastSeenAt`（第 6 轮审计 P2）：它们不是业务
 *    状态，只是「凭什么判断这条 id 该不该留」的证据（见下）。
 * 2. **绝不因账本重建/覆盖任何单的 journal**：这是上一轮修掉的失败形态
 *    （把 awaiting_reply 的单重建成 running 后重跑，人工答复只能被 ACK 丢弃）。
 * 3. **fail-open**：任何读写失败只 warn，绝不抛给轮询循环——账本是「锦上添花
 *    的锚点」，不是 tick 的前置条件；读不出来就当没有历史（中台超时治理兜底）。
 *
 * ## 第 6 轮审计 P2：缺席 ≠ 终态
 * 旧实现的对账把「本轮 poll 没返回」一律当终态删条目。但中台 poll 不返回
 * 终态条目——它只返回**可投递**的指派，而「被 resend 的 id 没进返回」还有
 * 另外两种成因：中台一轮只投 3 张（被上限挡下）、载荷构造失败（缺版本/
 * 能力不匹配）。于是最忙的一轮会用自己的判断删掉真实在途的锚点。
 *
 * 现在：**只有中台明确终结**（本机终态回报成功 → `remove`，见 agent-host 的
 * `settleAssignment`）才删条目；「本轮未返回」只累加证据：
 *   - `misses`：**明确请求了重发、中台却没投回**的连续轮数（投回即清零）；
 *   - `lastSeenAt`：最后一次被中台投回的时刻。
 * 到 `REQUEUE_MISS_DROP_THRESHOLD` 轮才判定「不再可投递」并由调用方删除
 * （带日志）。为什么必须有这个上界：账本的 `updatedAt` 每次写都会刷新，
 * 7 天陈旧闸在持续活跃的进程里永远不会触发——没有上界就是每条被中台取消
 * 的单都会被**永久**每 30s 请求一次（永动机）。
 *
 * ## 读写形态
 * - 原子写：写 `.tmp` 再 rename，崩溃不会留下半截 JSON。
 * - 读侧结构校验：必须是对象、`ids` 必须是数组、元素必须是非空字符串、去重、
 *   条数 ≤ 200、`updatedAt` 必须是可解析时间且不超过 7 天；任一条不满足即
 *   整份判废（丢弃 + warn），绝不让畸形文件影响 tick。
 * - `evidence` 段可选（旧文件没有）：逐条校验 `misses`/`lastSeenAt`，畸形条目
 *   只丢该条证据（按「从未缺席」处理），不整份判废——证据缺失是保守方向
 *   （多留一轮），不该被当成账本损坏。
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

/**
 * 连续「明确请求重发、中台仍未投回」多少轮后判定该 id 不再可投递（清理）。
 *
 * 取值理由（不拍脑袋）：
 * - 一轮 tick 的间隔是 30s，5 轮 ≈ 2.5 分钟——足够跨过中台侧的瞬时抖动
 *   （poll 并发、能力上报竞态）与单轮限流；
 * - 「被一轮 3 张上限挡下」这种最常见成因**不计入证据**（host 那侧遇到截断
 *   轮会直接跳过累加），所以这里的计数只覆盖「我们点名要了、中台没给」；
 * - 再大只会让一条已被中台取消的单多空转几轮（每轮多一个 id 的请求体），
 *   再小则可能在真实在途时过早放弃——2.5 分钟是这个权衡下的下界。
 */
export const REQUEUE_MISS_DROP_THRESHOLD = 5;

/**
 * 一条 id 的「未返回」证据（不是业务状态，只是判断去留的依据）。
 * 旧账本文件没有这一段，读侧按 `{ misses: 0, lastSeenAt: null }` 处理。
 */
export interface RequeueLedgerEvidence {
  /** 连续「明确请求了重发、中台却没投回」的轮数；被投回即清零。 */
  misses: number;
  /** 最后一次被中台投回的时刻（ISO）；从未见过为 null。 */
  lastSeenAt: string | null;
}

/** 落盘形态：id 列表、写入时刻、以及每条 id 的未返回证据。 */
export interface RequeueLedgerSnapshot {
  ids: string[];
  updatedAt: string;
  evidence?: Record<string, RequeueLedgerEvidence>;
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
  /** 内存镜像：id 顺序（= 入账顺序）+ 每条 id 的证据。null = 尚未读盘。 */
  private state: { ids: string[]; evidence: Map<string, RequeueLedgerEvidence> } | null = null;
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
    return [...this.load().ids];
  }

  has(assignmentId: string): boolean {
    return this.load().ids.includes(assignmentId);
  }

  /** 某条 id 的未返回证据（诊断/selftest 用）；不在账本里返回 null。 */
  evidenceOf(assignmentId: string): RequeueLedgerEvidence | null {
    const state = this.load();
    if (!state.ids.includes(assignmentId)) return null;
    const evidence = state.evidence.get(assignmentId);
    return evidence ? { ...evidence } : { misses: 0, lastSeenAt: null };
  }

  /** 批量入账，返回**实际落盘**的 id（重复的、非法的、超上限被挤掉的不算）。 */
  add(assignmentIds: readonly string[]): string[] {
    const state = this.load();
    const added: string[] = [];
    for (const raw of assignmentIds) {
      if (typeof raw !== 'string') continue;
      const id = raw.trim();
      // assignmentId 来自中台载荷（不可信输入）：空串/空白串不入账，也绝不
      // 让它参与任何路径拼接（账本只存字符串，不拼路径）。
      if (id === '' || state.ids.includes(id)) continue;
      state.ids.push(id);
      added.push(id);
    }
    if (added.length === 0) return added;
    if (state.ids.length > REQUEUE_LEDGER_MAX_IDS) {
      // 积压超上限：丢最旧的（新的更贴近当下的在途单）——证据一并清掉。
      const overflow = state.ids.length - REQUEUE_LEDGER_MAX_IDS;
      const dropped = state.ids.splice(0, overflow);
      for (const id of dropped) state.evidence.delete(id);
      this.warn(`账本超出 ${REQUEUE_LEDGER_MAX_IDS} 条上限，丢弃最旧的 ${overflow} 条: ${dropped.join(',')}`);
    }
    this.flush();
    const survivors = new Set(state.ids);
    return added.filter((id) => survivors.has(id));
  }

  /** 删除一条（单张终态回报成功 / 证据到期时调用）。返回是否真的删除了。 */
  remove(assignmentId: string): boolean {
    const state = this.load();
    const at = state.ids.indexOf(assignmentId);
    if (at < 0) return false;
    state.ids.splice(at, 1);
    state.evidence.delete(assignmentId);
    this.flush();
    return true;
  }

  /**
   * 中台**确实投回了**这些 id（指派载荷 / 澄清回复都算）：清零未返回计数，
   * 记下最后见到时刻。不在账本里的 id 忽略（账本不因一次投递就扩表）。
   */
  markSeen(assignmentIds: readonly string[]): void {
    const state = this.load();
    const nowIso = new Date(this.now()).toISOString();
    let changed = false;
    for (const raw of assignmentIds) {
      if (typeof raw !== 'string') continue;
      const id = raw.trim();
      if (id === '' || !state.ids.includes(id)) continue;
      const prev = state.evidence.get(id);
      if (prev && prev.misses === 0 && prev.lastSeenAt !== null) {
        // 已经「零缺席」：只刷新时刻，不必每轮都写盘（证据已在最保守的值上）。
        if (this.now() - Date.parse(prev.lastSeenAt) < 60_000) continue;
      }
      state.evidence.set(id, { misses: 0, lastSeenAt: nowIso });
      changed = true;
    }
    if (changed) this.flush();
  }

  /**
   * 记录「本轮**明确请求了**重发、中台却没投回」：累加连续未返回轮数。
   * 返回达到 `REQUEUE_MISS_DROP_THRESHOLD` 的 id——调用方据此删除条目并记日志
   * （本方法**不删**：删除语义只有调用方知道原因，日志要在那里写）。
   */
  markMissing(assignmentIds: readonly string[]): string[] {
    const state = this.load();
    const expired: string[] = [];
    let changed = false;
    for (const raw of assignmentIds) {
      if (typeof raw !== 'string') continue;
      const id = raw.trim();
      if (id === '' || !state.ids.includes(id)) continue;
      const prev = state.evidence.get(id) ?? { misses: 0, lastSeenAt: null };
      const next: RequeueLedgerEvidence = { misses: prev.misses + 1, lastSeenAt: prev.lastSeenAt };
      state.evidence.set(id, next);
      changed = true;
      if (next.misses >= REQUEUE_MISS_DROP_THRESHOLD) expired.push(id);
    }
    if (changed) this.flush();
    return expired;
  }

  private load(): { ids: string[]; evidence: Map<string, RequeueLedgerEvidence> } {
    if (this.state === null) this.state = this.read();
    return this.state;
  }

  /** 读盘 + 结构校验。任何异常/畸形都收敛为空账本（丢弃 + warn）。 */
  private read(): { ids: string[]; evidence: Map<string, RequeueLedgerEvidence> } {
    const empty = { ids: [] as string[], evidence: new Map<string, RequeueLedgerEvidence>() };
    const file = requeueLedgerPath(this.workDir);
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
      // 不存在是常态（首次运行/已清空），不算异常
      if ((err as NodeJS.ErrnoException | null)?.code !== 'ENOENT') {
        this.warn(`读取失败，按空账本继续（fail-open）: ${file} — ${errorMessage(err)}`);
      }
      return empty;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.warn(`账本不是合法 JSON，已忽略: ${file}`);
      return empty;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      this.warn(`账本顶层不是对象，已忽略: ${file}`);
      return empty;
    }
    const record = parsed as Record<string, unknown>;
    if (!Array.isArray(record.ids)) {
      this.warn(`账本 ids 不是数组，已忽略: ${file}`);
      return empty;
    }
    if (record.ids.length > REQUEUE_LEDGER_MAX_IDS) {
      this.warn(
        `账本条数 ${record.ids.length} 超过上限 ${REQUEUE_LEDGER_MAX_IDS}，整份忽略: ${file}`,
      );
      return empty;
    }
    const updatedAt = typeof record.updatedAt === 'string' ? Date.parse(record.updatedAt) : NaN;
    if (!Number.isFinite(updatedAt)) {
      this.warn(`账本 updatedAt 缺失/非法，已忽略: ${file}`);
      return empty;
    }
    if (this.now() - updatedAt >= REQUEUE_LEDGER_STALE_MS) {
      // 陈旧：对应工单多半已被中台超时治理收走。丢弃但**不删文件**——下一次
      // 入账会用新的 updatedAt 覆盖它（读侧保持无副作用）。
      this.warn(`账本已超 ${REQUEUE_LEDGER_STALE_MS} ms 未更新，按空账本继续: ${file}`);
      return empty;
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
    // evidence 段（第 6 轮审计新增，旧文件没有）：逐条校验，畸形条目只丢该条
    // 证据（按「从未缺席」= 多留一轮处理），绝不因证据段畸形整份判废。
    const evidence = new Map<string, RequeueLedgerEvidence>();
    const rawEvidence = record.evidence;
    if (rawEvidence !== undefined && rawEvidence !== null) {
      if (typeof rawEvidence !== 'object' || Array.isArray(rawEvidence)) {
        this.warn(`账本 evidence 不是对象，按「无证据」继续（锚点全部保留）: ${file}`);
      } else {
        let badEvidence = 0;
        for (const [key, value] of Object.entries(rawEvidence as Record<string, unknown>)) {
          const id = key.trim();
          // 只为账本里真实存在的 id 存证据（防伪造键把账本撑大）
          if (!seen.has(id)) continue;
          const rec = value as { misses?: unknown; lastSeenAt?: unknown } | null;
          const misses = rec && typeof rec === 'object' ? rec.misses : undefined;
          if (typeof misses !== 'number' || !Number.isInteger(misses) || misses < 0) {
            badEvidence += 1;
            continue;
          }
          const rawSeen = rec && typeof rec === 'object' ? rec.lastSeenAt : undefined;
          const seenMs = typeof rawSeen === 'string' ? Date.parse(rawSeen) : NaN;
          evidence.set(id, {
            // 上限收敛：手改过的畸形大计数不产生「一读就过期」的惊喜
            misses: Math.min(misses, REQUEUE_MISS_DROP_THRESHOLD * 2),
            lastSeenAt: Number.isFinite(seenMs) ? new Date(seenMs).toISOString() : null,
          });
        }
        if (badEvidence > 0) {
          this.warn(`账本丢弃 ${badEvidence} 条畸形证据（按「从未缺席」处理，锚点保留）: ${file}`);
        }
      }
    }
    return { ids, evidence };
  }

  /** 原子落盘（tmp + rename）。失败只 warn——内存镜像仍生效，本轮 tick 不受影响。 */
  private flush(): void {
    const state = this.state ?? { ids: [], evidence: new Map<string, RequeueLedgerEvidence>() };
    const file = requeueLedgerPath(this.workDir);
    const evidence: Record<string, RequeueLedgerEvidence> = {};
    for (const id of state.ids) {
      const entry = state.evidence.get(id);
      if (entry) evidence[id] = entry;
    }
    const snapshot: RequeueLedgerSnapshot = {
      ids: [...state.ids],
      updatedAt: new Date(this.now()).toISOString(),
      ...(Object.keys(evidence).length > 0 ? { evidence } : {}),
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
