import * as fs from "fs";
import * as path from "path";

/**
 * R72-A1（R70-A1 遗留①）：历史 SOP 审计行 `detail.sopId` 的**回填到底能不能做**。
 *
 * ## 结论（本文件把这个结论钉死，而不是钉死一条 SQL）
 *
 * 做不了。原计划是 data-only 迁移：
 *
 *   UPDATE "audit_logs" SET detail = detail || jsonb_build_object('sopId', a."sopId")
 *   FROM ... WHERE NOT (detail ? 'sopId') AND action IN (四类);
 *
 * 它在**部署时就会炸掉整条迁移链**：审计行被迁移 1790000000006 挂的行级
 * `trg_audit_logs_append_only` 守卫**无条件**拒绝（BEFORE UPDATE → RAISE
 * EXCEPTION P0001，'audit_logs is append-only: UPDATE denied'）。
 *
 * 关键细节（也是最容易看反的一处）：该守卫函数确实有一个 GUC 逃生门
 * `app.bypass_audit_guard = 'on'`，但它**只写在 `IF TG_OP = 'DELETE' THEN` 分支
 * 内部**——为保留期清理（AuditService.retentionDelete 的分批 DELETE）开的通道。
 * 一旦走出那个 `END IF;`，函数体对任何 UPDATE 都是裸的 RAISE，没有任何
 * `current_setting(...)` 放行判断。所以「迁移里先 SET LOCAL bypass 再 UPDATE」
 * 是**看着像有门、实际必然失败**的写法，而且即便它侥幸能跑，也等于把
 * append-only 从「不可改」降级为「不可改除非…」——这正是安全机制要防的事。
 *
 * 同理禁止的还有：`session_replication_role = replica`、`ALTER TABLE ... DISABLE
 * TRIGGER`、`DROP TRIGGER` 后重放、以及放宽守卫函数本身。这些都不是"实现
 * 回填"，而是拆掉审计防篡改。
 *
 * 因此本任务**不产出 1790000000059 的迁移文件**（编号已在 docs/PLAN-CLAIMS.md
 * 预留并记录阻塞结论）。历史行要可深链，只能改**读面**：审计列表渲染时按
 * `resource` + `resourceId` 反解 sopId（澄清行 → sop_clarifications.assignmentId
 * → sop_assignments.sopId；指派行 → sop_assignments.sopId），不动历史行。
 *
 * 本 spec 守住三件事，任何一件被"后来者顺手改回去"都会红：
 *  1. 守卫函数的 UPDATE 分支**没有**逃生门（GUC 只在 DELETE 分支内）；
 *  2. 全目录**没有任何迁移**对 audit_logs 发 UPDATE，也没有关触发器的旁路 DDL；
 *  3. 四类 action 的 resource/resourceId 语义与 join 边的列形态不变
 *     （读面解析方案的前提）。
 */

const MIGRATIONS_DIR = path.join(__dirname, "..");
const REPO_ROOT = path.join(MIGRATIONS_DIR, "..", "..", "..", "..");

const GUARD_MIGRATION = path.join(
  MIGRATIONS_DIR,
  "1790000000006-AuditLogsAppendOnlyGuard.ts",
);
const AUDIT_SERVICE = path.join(
  MIGRATIONS_DIR,
  "..",
  "modules",
  "audit",
  "audit.service.ts",
);
const AUDIT_ENTITY = path.join(
  MIGRATIONS_DIR,
  "..",
  "modules",
  "audit",
  "entities",
  "audit-log.entity.ts",
);
const SOP_SERVICE = path.join(
  MIGRATIONS_DIR,
  "..",
  "modules",
  "sop",
  "sop.service.ts",
);
const CLARIFICATION_ENTITY = path.join(
  MIGRATIONS_DIR,
  "..",
  "modules",
  "sop",
  "entities",
  "sop-clarification.entity.ts",
);
const PLAN_CLAIMS = path.join(REPO_ROOT, "docs", "PLAN-CLAIMS.md");

/**
 * 只提取**真正下发给 PG 的 SQL**（`queryRunner.query(...)` 的模板字面量），
 * 不扫注释——本仓迁移文件的类注释里大量出现 "UPDATE audit_logs" 这类**说明
 * 文字**（例如 1790000000057 的注释就在讲为什么不用 session_replication_role），
 * 全文正则会把注释当 SQL 断言，产生假失败。先例同
 * audit-logs-no-truncate-guard.migration.spec 的 sqlQueriesOf。
 */
const sqlQueriesOf = (source: string): string =>
  Array.from(source.matchAll(/queryRunner\.query\(\s*`([\s\S]*?)`\s*\)/g))
    .map((m) => m[1])
    .join("\n");

/** 只取 up() 段（down 里的合法回收语句不该被当成"新写入"）。 */
const upSqlOf = (file: string): string =>
  sqlQueriesOf(fs.readFileSync(file, "utf8").split("public async down")[0]);

const migrationFiles = (): string[] =>
  fs
    .readdirSync(MIGRATIONS_DIR)
    .filter(
      (f) =>
        f.endsWith(".ts") && !f.endsWith(".spec.ts") && !f.endsWith(".d.ts"),
    )
    .map((f) => path.join(MIGRATIONS_DIR, f));

/** 去掉注释行后的源码（只用于"应用层有没有 UPDATE 通道"这类代码级判定）。 */
const codeWithoutComments = (source: string): string =>
  source
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("/*");
    })
    .join("\n");

describe("R72-A1：audit_logs 的 detail 回填被 append-only 守卫阻塞（1790000000006 结论钉死）", () => {
  let guardSql: string;

  beforeAll(() => {
    guardSql = sqlQueriesOf(fs.readFileSync(GUARD_MIGRATION, "utf8"));
  });

  it("守卫函数：唯一逃生门是 app.bypass_audit_guard，且**落在 IF TG_OP = 'DELETE' 分支内**", () => {
    const gucIdx = guardSql.indexOf(
      "current_setting('app.bypass_audit_guard', true)",
    );
    const deleteBranchIdx = guardSql.indexOf("IF TG_OP = 'DELETE' THEN");
    const updateRaiseIdx = guardSql.indexOf(
      "'audit_logs is append-only: UPDATE denied'",
    );

    expect(deleteBranchIdx).toBeGreaterThan(-1);
    expect(gucIdx).toBeGreaterThan(deleteBranchIdx);
    expect(updateRaiseIdx).toBeGreaterThan(gucIdx);

    // DELETE 分支的收口（外层 END IF;——即 UPDATE 裸 RAISE 之前最后一个 END IF;）。
    // GUC 必须在它**之前**：这句断言就是"UPDATE 侧没有逃生门"的机器化表述，
    // 任何人把 current_setting 检查挪出 DELETE 分支、或给 UPDATE 加一个
    // bypass 判断，都会让 gucIdx 越过这条线而失败。
    const deleteBranchEnd = guardSql.lastIndexOf("END IF;", updateRaiseIdx);
    expect(deleteBranchEnd).toBeGreaterThan(gucIdx);
    expect(updateRaiseIdx).toBeGreaterThan(deleteBranchEnd);

    // 全函数只有这一处 GUC 读取：不允许"再补一个 UPDATE 的判断"
    expect(
      guardSql.match(/current_setting\('app\.bypass_audit_guard'/g),
    ).toHaveLength(1);
    // 也不允许出现 TG_OP = 'UPDATE' 的分支（那正是把门开给 UPDATE 的形态）
    expect(guardSql).not.toMatch(/TG_OP\s*=\s*'UPDATE'/);
  });

  it("守卫函数：UPDATE 分支无条件 RAISE，错误指纹固定（P0001 / 'UPDATE denied'）", () => {
    expect(guardSql).toMatch(
      /RAISE EXCEPTION 'audit_logs is append-only: UPDATE denied'\s+USING ERRCODE = 'P0001';/,
    );
    // 迁移里严禁出现"先绕过再改"的写法：GUC 名称只出现在守卫函数里，
    // 且设置值必须是 'on'（与 retentionDelete 的 SET LOCAL 对齐）。
    expect(guardSql).toContain(
      "current_setting('app.bypass_audit_guard', true) = 'on'",
    );
  });

  it("触发器形态：BEFORE UPDATE OR DELETE + FOR EACH ROW，且没有 WHEN 限缩某些 UPDATE", () => {
    const trgIdx = guardSql.indexOf(
      "CREATE TRIGGER trg_audit_logs_append_only",
    );
    expect(trgIdx).toBeGreaterThan(-1);
    const triggerSql = guardSql.slice(trgIdx);
    expect(triggerSql).toContain('BEFORE UPDATE OR DELETE ON "audit_logs"');
    expect(triggerSql).toContain("FOR EACH ROW");
    // 有 WHEN 子句就可能被写成"只拦部分 UPDATE"，那时本任务的回填会变成
    // "能跑但只回填一半"，比彻底失败更难发现。
    expect(triggerSql).not.toMatch(/WHEN\s*\(/);
  });

  it("应用层同样没有 UPDATE 通道（守卫之外的第二道确认：audit.service 不写 UPDATE）", () => {
    const src = codeWithoutComments(fs.readFileSync(AUDIT_SERVICE, "utf8"));
    expect(src).not.toMatch(/UPDATE\s+"?audit_logs"?/i);
    expect(src).not.toMatch(/repo\.update\(/);
  });

  it("全目录回归：没有任何迁移对 audit_logs 发 UPDATE（本任务结论的机器守卫）", () => {
    const files = migrationFiles();
    // 防止"扫描没跑起来"这种假绿
    expect(files.length).toBeGreaterThan(50);

    const offenders = files.filter((file) =>
      /UPDATE\s+(?:ONLY\s+)?"?audit_logs"?/i.test(
        sqlQueriesOf(fs.readFileSync(file, "utf8")),
      ),
    );
    expect(offenders.map((f) => path.basename(f))).toEqual([]);
  });

  it("全目录回归：不存在关触发器的旁路 DDL（DISABLE TRIGGER / session_replication_role）", () => {
    const offenders = migrationFiles().filter((file) => {
      const upSql = upSqlOf(file);
      return (
        /DISABLE\s+TRIGGER/i.test(upSql) ||
        /session_replication_role/i.test(upSql)
      );
    });
    expect(offenders.map((f) => path.basename(f))).toEqual([]);
  });

  it("全目录回归：守卫函数的定义/替换**只有** 1790000000006 一处（不许「放宽」它）", () => {
    const owners = migrationFiles().filter((file) =>
      /(?:CREATE\s+OR\s+REPLACE|DROP)\s+FUNCTION\s+(?:IF\s+EXISTS\s+)?audit_logs_append_only_guard/i.test(
        upSqlOf(file),
      ),
    );
    // 唯一合法所有者是建它的那条迁移。出现第二条 ⇒ 有人在动守卫策略（例如给
    // UPDATE 加 bypass 判断），那是安全评审事项，不能当作业务 PR 的顺手改动。
    expect(owners.map((f) => path.basename(f))).toEqual([
      "1790000000006-AuditLogsAppendOnlyGuard.ts",
    ]);
  });

  it("编号已登记：docs/PLAN-CLAIMS.md 迁移分配表预留 1790000000059 并写明阻塞结论", () => {
    const plan = fs.readFileSync(PLAN_CLAIMS, "utf8");
    const registryIdx = plan.indexOf("## 迁移时间戳分配表");
    expect(registryIdx).toBeGreaterThan(-1);
    const registry = plan.slice(registryIdx);
    const row = registry
      .split("\n")
      .find((l) => /^\s*\|\s*1790000000059\s*\|/.test(l));
    expect(row).toBeDefined();
    // 行内必须写明"未落盘 / 阻塞"，否则下一位读者会以为这条迁移已经跑过
    expect(row).toContain("未落盘");
    expect(row).toContain("阻塞");
  });

  it("读面解析方案的前提 ①：四类 action 的 resource 归属（澄清三类 vs 指派一类）", () => {
    const sopSrc = fs.readFileSync(SOP_SERVICE, "utf8");
    const windowAfter = (marker: string): string => {
      const idx = sopSrc.indexOf(marker);
      expect(idx).toBeGreaterThan(-1);
      return sopSrc.slice(idx, idx + 500);
    };

    // resourceId = **澄清行** id → join 走 sop_clarifications
    for (const action of [
      "sop.clarify",
      "sop.reply",
      "sop.clarification.escalated",
    ]) {
      expect(windowAfter(`action: "${action}"`)).toContain(
        'resource: "sop_clarification"',
      );
    }
    // resourceId = **指派行** id → join 走 sop_assignments（与上面三条路径不同）
    expect(windowAfter('action: "sop.complete"')).toContain(
      'resource: "sop_assignment"',
    );
  });

  it("读面解析方案的前提 ②：join 边的列形态（澄清行 assignmentId 非空 uuid；audit 侧是字符串）", () => {
    const clar = fs.readFileSync(CLARIFICATION_ENTITY, "utf8");
    // sop_clarifications.assignmentId：NOT NULL uuid —— 澄清行 → 指派行这条边恒存在
    expect(clar).toMatch(
      /@Column\(\{\s*type:\s*"uuid"\s*\}\)\s*\n\s*assignmentId:\s*string;/,
    );

    const audit = fs.readFileSync(AUDIT_ENTITY, "utf8");
    // audit_logs.resourceId 是 varchar（不是 uuid）→ 反解时按文本比较，
    // 不能直接 resourceId::uuid（历史行里可能有非 uuid 的 resourceId，会抛 22P02）
    expect(audit).toMatch(
      /@Column\(\{\s*nullable:\s*true\s*\}\)\s*\n\s*resourceId:\s*string;/,
    );
    // detail 是 jsonb（回填方案若被重新讨论，载体仍在这里）
    expect(audit).toMatch(
      /@Column\(\{\s*type:\s*"jsonb",\s*nullable:\s*true\s*\}\)\s*\n\s*detail:/,
    );
  });
});
