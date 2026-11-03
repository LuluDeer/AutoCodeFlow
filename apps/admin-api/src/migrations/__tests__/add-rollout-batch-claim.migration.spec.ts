import * as fs from "fs";
import * as path from "path";

import { AddRolloutBatchClaim1790000000095 } from "../1790000000095-AddRolloutBatchClaim";

/**
 * R1 阶段 1 · 1-B：灰度**批次占坑**的迁移结构钉死（迁移 1790000000095）。
 *
 * 无真机 PG 的单测约定（本仓先例 add-audit-logs-created-at-id-index /
 * add-deployment-rollout-columns.migration.spec）：SQL 文本逐段断言，不连库。
 * `migrations.spec.ts` 已覆盖「时间戳唯一 / 类名后缀与文件名一致 / 严格递增」
 * 等全目录约束，本文件只管本迁移的形状与**谓词**。
 *
 * ## 为什么这个 spec 是「有牙」的（每条都能单独转红）
 *
 *   · 谓词被改成 `rolloutState IN ('pending','probing')` → 谓词用例转红。
 *     ⚠️ 这是**已否决方案**的指纹：它与「一批多行同时 pending」结构性冲突
 *     （`canaryBatchSize(N,pct)=ceil(N×pct/100)`，N=10 时 5 行同时 pending），
 *     第 2 行必撞 23505 ⇒ 多机灰度全线失效。本 spec 把「不许退回去」钉住。
 *   · 唯一性被去掉（改成普通 INDEX）→ 「必须是 UNIQUE」用例转红。
 *   · 列名写错（`rolloutBatchClaim` / `rolloutClaimId`）→ 列名用例转红。
 *   · 索引名写错 → 索引名用例转红（**这是 service 侧 23505 归因的锚点**，
 *     改了名字 `isRolloutClaimUniqueViolation` 就再也认不出来）。
 *   · down 顺序反了（先 DROP COLUMN 再 DROP INDEX）→ 顺序用例转红
 *     （先删列会让索引被自动级联删掉，随后 DROP INDEX 变成静默 no-op，
 *     但 revert 语义已不可控）。
 *   · 加 DEFAULT / 回填 → 「metadata-only、零回填」用例转红。
 */
const FILE = path.join(
  __dirname,
  "..",
  "1790000000095-AddRolloutBatchClaim.ts",
);
const INDEX_NAME = "uq_app_deployments_rollout_claim";
const COLUMN = "rolloutBatchClaimId";

/** 剥掉块注释与行注释：头注里**刻意引用**了已否决方案的写法作「勿重犯」说明。 */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

describe("AddRolloutBatchClaim1790000000095（R1 1-B 批次占坑）", () => {
  let sql: string;
  let migration: AddRolloutBatchClaim1790000000095;

  beforeAll(() => {
    sql = fs.readFileSync(FILE, "utf8");
    migration = new AddRolloutBatchClaim1790000000095();
  });

  it("TypeORM 契约：name/up/down 与类名后缀一致", () => {
    expect(migration.name).toBe("AddRolloutBatchClaim1790000000095");
    expect(typeof migration.up).toBe("function");
    expect(typeof migration.down).toBe("function");
  });

  it("up：加可空列 rolloutBatchClaimId（VARCHAR NULL，无 DEFAULT）", () => {
    const up = sql.split("public async down")[0];
    expect(up).toContain('ALTER TABLE "app_deployments"');
    expect(up).toContain(`ADD COLUMN IF NOT EXISTS "${COLUMN}" VARCHAR NULL`);
    // 可空 + 无 DEFAULT ⇒ metadata-only、存量零回填
    expect(up).not.toMatch(new RegExp(`"${COLUMN}"\\s+VARCHAR\\s+NOT\\s+NULL`));
    expect(up).not.toMatch(new RegExp(`"${COLUMN}"[^;]{0,80}DEFAULT`));
  });

  it("up：唯一索引名与列（service 的 23505 归因锚点）", () => {
    const up = sql.split("public async down")[0];
    expect(up).toContain(`CREATE UNIQUE INDEX IF NOT EXISTS "${INDEX_NAME}"`);
    expect(up).toContain('ON "app_deployments" ("applicationId")');
    // 必须是 UNIQUE：普通索引不做冲突检查 ⇒ 两批次可同时存在
    expect(up).toMatch(
      new RegExp(`CREATE\\s+UNIQUE\\s+INDEX[^;]*"${INDEX_NAME}"`),
    );
  });

  it("⚠️ 谓词必须只覆盖「携带 claim 的行」，不得退回 rolloutState 在途态", () => {
    // ⚠️ 必须剥注释再判「反例」：本迁移的头注**刻意**引用了已否决方案的
    // 索引定义（`WHERE "rolloutState" IN ('pending','probing')`）作为「勿重犯」
    // 的说明。不剥注释就会把「解释缺陷的文字」当成缺陷本身，红得毫无线索
    // （`check-index-drift` 的头注里记着同一教训）。
    const upCode = stripComments(sql.split("public async down")[0]);
    // 正例：谓词与 claim 列同源
    expect(upCode).toMatch(new RegExp(`WHERE\\s+"${COLUMN}"\\s+IS NOT NULL`));
    // 反例（已否决方案）：谓词落在 rolloutState 上 ⇒ 一批多行必撞 23505
    expect(upCode).not.toMatch(/WHERE\s+"?rolloutState"?\s+IN/i);
    // 也否决 (applicationId, batchId) 组合键（同批多行共享 batchId，照样撞）
    expect(upCode).not.toMatch(/"applicationId"\s*,\s*"batchId"/);
  });

  it("幂等：ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS / DROP IF EXISTS", () => {
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "rolloutBatchClaimId"');
    expect(sql).toContain(`CREATE UNIQUE INDEX IF NOT EXISTS "${INDEX_NAME}"`);
    expect(sql).toContain(`DROP INDEX IF EXISTS "${INDEX_NAME}"`);
    expect(sql).toContain('DROP COLUMN IF EXISTS "rolloutBatchClaimId"');
  });

  it("不用 CONCURRENTLY（非百万级表 + 迁移事务内），并有先例说明", () => {
    // CONCURRENTLY 不能在迁移事务里跑，且 app_deployments 是每应用几十行；
    // 同表既有 uq_app_deployments_application_in_flight（1789000000000）即先例。
    // 断言的是**代码**里没有 CONCURRENTLY（头注里解释「为何不用」不算）。
    expect(stripComments(sql)).not.toContain("CONCURRENTLY");
    expect(sql).toContain("1789000000000");
  });

  it("down：先 DROP INDEX 再 DROP COLUMN（逆序回收）", () => {
    const down = sql.split("public async down")[1];
    expect(down).toBeDefined();
    expect(down.indexOf(`DROP INDEX IF EXISTS "${INDEX_NAME}"`)).toBeGreaterThan(
      -1,
    );
    expect(
      down.indexOf(`DROP INDEX IF EXISTS "${INDEX_NAME}"`),
    ).toBeLessThan(down.indexOf(`DROP COLUMN IF EXISTS "${COLUMN}"`));
  });
});
