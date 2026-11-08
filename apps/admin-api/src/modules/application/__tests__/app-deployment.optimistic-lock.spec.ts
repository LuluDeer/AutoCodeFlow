import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * D-18：**全仓乐观锁假设为假** —— 假安全感的反向实证。
 *
 * ## 本案是什么
 *
 * `app-deployment.service.ts::saveWithOptimisticLock()` 的 doc 注释（以及
 * `pushDeployToExecutor` 处的注释）宣称：
 *   - 「`@VersionColumn` 让 `save` 自动追加 `AND version = :expected`」；
 *   - 「并发后写撞版本时 TypeORM 抛 `OptimisticLockVersionMismatchError`」；
 *   - 「这里转 409 让客户端重载重试」。
 *
 * **三条全为假。** 后果不是「500 报错」，而是**静默**：并发 `stop` / `upgrade` /
 * `redeploy` 之间是**最后写入者胜出**，竞态既没被拦截、也没被察觉；
 * `APP_DEPLOYMENT_CONCURRENT_MODIFICATION`（409）**生产永不触发**。
 *
 * ## 为什么既有测试抓不到（本仓第四次「假绿」）
 *
 * 本文件之前的所有 `app-deployment.*.spec.ts` 都把 `repo.save` 换成 `jest.fn()`。
 * 而真相藏在 **TypeORM 内部**：`save()` 走 `SubjectExecutor`，它**根本不读 version 列做
 * WHERE**。把 `save` mock 掉，等于把「被证伪的那一层」整个替换成替身 ⇒ 断言永远通过。
 *
 * ## 本文件的两层证据（**刻意分层，且如实标注强度**）
 *
 * ① **结构证据（structural）**：直接读 `node_modules/typeorm` 与仓内源码，断言
 *    「该异常**结构上不可能**由 `repo.save()` 抛出」。
 *    ⇒ 这是**必然性**证据：不依赖任何运行环境，任何时间任何机器结论相同。
 *    ⚠️ 但它不是**行为**证据：它证明的是「这条路不可能抛」，不是「跑起来确实没抛」。
 *
 * ② **语义复刻证据（semantics）**：按 TypeORM `SubjectExecutor` 的真实语义
 *    （覆盖写 + 版本列自增、**无** version 谓词）实现一个最小 fake repo，
 *    断言「过期快照写入时：不抛异常 ∧ 列被静默覆盖 ∧ 版本号仍递增」。
 *    ⇒ 它证明「一旦真跑起来，失败是静默的」。
 *    ⚠️ 这是**复刻**语义，不是连真库跑——真库在本机不可用（见下）。
 *
 * ### 真 DB 可用性（如实说明）
 *
 * 未连真 Postgres：本机 `DB_HOST=postgres` 不可解析、本地 PG 无 `autoflow` 角色。
 * 因此**没有**「真库上跑一次并发写」的行为证据。若要补，判据是：
 * 起一个 PG，开两个连接加载同一行，各自 `repo.save()` 一个**含不同 version 的实体**，
 * 断言**两边都成功**且 `version` 只 +1（而非 +2、也不抛错）。
 *
 * ## 转正判据（本文件从「记录缺陷」变为「守护修复」的那一刻）
 *
 * `it("stop() 必须走条件 UPDATE")` 与 `it("注释不得再宣称 save 带版本谓词")` 这两条
 * **当前是红的**；它们转绿 ⇔ 修复落地。在此之前，红是**正确状态**，不是噪声。
 */

const ADMIN_API = join(__dirname, "..", "..", "..", "..");
const TYPEORM = join(ADMIN_API, "node_modules", "typeorm");
const SERVICE = join(__dirname, "..", "app-deployment.service.ts");

const read = (p: string): string => readFileSync(p, "utf8");
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

// ---------------------------------------------------------------------------
// ① 结构证据：该异常「结构上不可能」由 repo.save() 抛出
// ---------------------------------------------------------------------------

describe("D-18 结构证据：repo.save() 结构上不可能抛 OptimisticLockVersionMismatchError", () => {
  it("TypeORM 的 SubjectExecutor（save 的执行体）零处把 versionColumn 用作 WHERE", () => {
    const src = read(join(TYPEORM, "persistence", "SubjectExecutor.js"));
    // 实证：整文件 0 次出现 versionColumn。若未来 TypeORM 改了这一点，
    // 本断言会红 —— 那正是我们**希望**被通知的时刻（该假设可能重新成立）。
    expect(src).not.toContain("versionColumn");
  });

  it("UpdateQueryBuilder 对版本列**只自增**，不拼接任何 WHERE version 谓词", () => {
    const src = read(join(TYPEORM, "query-builder", "UpdateQueryBuilder.js"));
    // 存在「自增」形态
    expect(src).toMatch(/" \+ 1"/);
    // 不存在「版本列做比较」的形态（乐观锁 WHERE 的唯一可行写法）
    // 否证形态收窄为「where/andWhere 子句里引用 versionColumn」——这才是乐观锁谓词
    // 的必由之路。刻意不用宽泛的「versionColumn 后跟 =」，那会误命中
    // `metadata.versionColumn && ...` 这类正常自增前置判断。
    expect(src).not.toMatch(/(?:andWhere|where)\([^)]{0,200}versionColumn/);
  });

  it("异常唯一抛出点在 SelectQueryBuilder，且被 lockMode==='optimistic' 守护", () => {
    const sel = read(join(TYPEORM, "query-builder", "SelectQueryBuilder.js"));
    const throws =
      sel.match(/new OptimisticLockVersionMismatchError_1\./g) ?? [];
    expect(throws.length).toBeGreaterThan(0);
    // 抛出点前 40 行内必须有 lockMode 守护
    const idx = sel.indexOf("new OptimisticLockVersionMismatchError_1.");
    const before = sel.slice(Math.max(0, idx - 2000), idx);
    expect(before).toContain('lockMode === "optimistic"');
  });

  it("仓内没有任何 setLock('optimistic') ⇒ 上述 throw 分支在业务代码里永不可达", () => {
    // 若有人写了 setLock("optimistic")，本断言会红 —— 届时 409 可能真的会触发，
    // 必须重新评估（这正是本条要挡的「悄悄改变可达性」）。
    const src = walk(join(ADMIN_API, "src"));
    expect(src.join("\n")).not.toMatch(/setLock\(\s*["']optimistic["']/);
  });
});

function walk(dir: string): string[] {
  // 极简遍历（只取 .ts，跳过 node_modules/dist）
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    // 跳过 __tests__：本文件的断言文本里就含 `setLock("optimistic")`，
    // 不跳过会自匹配（第一次跑就栽在这上面）。
    if (e === "node_modules" || e === "dist" || e === "__tests__") continue;
    const full = join(dir, e);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full));
    else if (e.endsWith(".ts") && !e.endsWith(".d.ts"))
      out.push(stripComments(read(full)));
  }
  return out;
}

// ---------------------------------------------------------------------------
// ② 语义复刻证据：真跑起来，失败是**静默**的
// ---------------------------------------------------------------------------

/**
 * 最小 fake repo，**按 TypeORM SubjectExecutor 的真实语义**实现 `save`：
 *   · 不做任何版本比较（结构证据已证）；
 *   · 版本列由 UpdateQueryBuilder 自增（`version = version + 1`）；
 *   · 其余列**整行覆盖**（最后写入者胜出）。
 *
 * ⚠️ 这与既有 spec 的 `jest.fn()` 有本质区别：`jest.fn()` 让 `save` **什么都不做**，
 * 于是「覆盖」和「不覆盖」都无从观察；这里**复刻了覆盖语义**，才能观察到静默丢失。
 */
const makeTruthfulRepo = (initial: Record<string, any>) => {
  const table = { ...initial };
  return {
    table,
    async save(entity: Record<string, any>) {
      // TypeORM save 的真实语义：无 version 谓词；版本列自增；其余列覆盖
      const nextVersion = (table.version ?? 0) + 1;
      for (const k of Object.keys(entity)) {
        if (k === "version") continue;
        if (entity[k] !== undefined) table[k] = entity[k];
      }
      table.version = nextVersion;
      return { ...table };
    },
  };
};

describe("D-18 语义复刻：并发后写**静默胜出**（不抛 409、不报错）", () => {
  it("过期快照写入：不抛异常 ∧ 列被覆盖 ∧ 版本号仍只 +1", async () => {
    const repo = makeTruthfulRepo({
      id: "d1",
      status: "running",
      statusMessage: "initial",
      version: 7,
    });

    // 实例 A 读到快照（version=7）
    const snapshotA = { ...repo.table };

    // 期间实例 B 完成一次合法写入（version 7 → 8）
    await repo.save({ id: "d1", status: "stopped", statusMessage: "by-B" });
    expect(repo.table.version).toBe(8);

    // 实例 A 用**过期快照**（version 仍是 7）后写 —— 期望 409，实际：静默成功
    let threw: unknown = null;
    try {
      await repo.save({ ...snapshotA, status: "upgrading" });
    } catch (e) {
      threw = e;
    }

    expect(threw).toBeNull(); // 不抛：409 分支不可达
    expect(repo.table.status).toBe("upgrading"); // A 静默覆盖了 B
    expect(repo.table.statusMessage).toBe("initial"); // 连 B 写的 message 一起被冲掉
    expect(repo.table.version).toBe(9); // 只 +1，没有「撞版本」
  });

  it("『乐观锁会抛 409』这一期望在当前实现下必然落空（反向钉住）", async () => {
    // 直接断言：按真实语义实现时，无论快照多旧都不会产生版本冲突异常。
    const repo = makeTruthfulRepo({ id: "d1", status: "running", version: 1 });
    const stale = { ...repo.table }; // version=1
    for (let i = 0; i < 5; i++) {
      await repo.save({ id: "d1", status: `s${i}` });
    }
    // 底层已到 version=6，stale 仍是 1
    expect(repo.table.version).toBe(6);
    await expect(
      repo.save({ ...stale, status: "final" }),
    ).resolves.toBeTruthy(); // 不 reject
    expect(repo.table.version).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// ③ 转正判据：这两条现在是红的，修完才绿
// ---------------------------------------------------------------------------

describe("D-18 转正判据（红 = 修复未落地，绿 = 已落地）", () => {
  it("stop() 必须走条件 UPDATE（不再是 read-modify-write + save）", () => {
    const src = read(SERVICE);
    // 定位 stop() 方法体（到下一个 async 方法声明为止）
    const m =
      /async stop\s*\(([\s\S]*?)\n\s{2}(?:async|private|public|protected)\s/.exec(
        src,
      );
    expect(m).not.toBeNull();
    const body = stripComments(m![1]);
    // 现状：body 内有 saveWithOptimisticLock ⇒ 红
    expect(body).not.toContain("saveWithOptimisticLock");
    // 修复后应出现版本谓词
    expect(body).toMatch(/"version"\s*=\s*:expected/);
  });

  it("注释不得再宣称 save 会自动追加 version 谓词（运维唯一会读的地方）", () => {
    const src = read(SERVICE);
    // 该句为假，必须删除/改写成事实
    expect(src).not.toMatch(
      /让\s*save\s*自动追加\s*AND\s*version\s*=\s*:expected/,
    );
    // 且应当明说 409 当前不可达（事实披露）
    expect(src).toContain("APP_DEPLOYMENT_CONCURRENT_MODIFICATION");
  });
});
