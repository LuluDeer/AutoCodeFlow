#!/usr/bin/env node
// SEC-10 selftest 共享实现：audit-verify.mjs 的纯函数判据矩阵。
// （lib 与 CLI 分离，纯函数 import 零 DB 依赖。）
import {
  checkGuardPresent,
  checkMutationDenied,
  checkSequenceIntegrity,
  buildWindowReport,
} from "./audit-verify.mjs";

export function auditVerifySelftest() {
  let failures = 0;
  const assert = (name, cond) => {
    if (cond) console.log(`  ✔ ${name}`);
    else {
      failures++;
      console.error(`  ✘ ${name}`);
    }
  };

  // ── checkGuardPresent ────────────────────────────────────────────────
  const gp1 = checkGuardPresent([
    { tgname: "other", tgenabled: "O" },
    { tgname: "trg_audit_logs_append_only", tgenabled: "O" },
  ]);
  assert("guard-present：触发器存在且启用 → ok", gp1.ok === true);

  const gp2 = checkGuardPresent([{ tgname: "other", tgenabled: "O" }]);
  assert("guard-present：触发器缺失 → 拦截", gp2.ok === false);

  const gp3 = checkGuardPresent([
    { tgname: "trg_audit_logs_append_only", tgenabled: "D" },
  ]);
  assert("guard-present：触发器被禁用（tgenabled=D）→ 拦截", gp3.ok === false);

  // ── checkMutationDenied ──────────────────────────────────────────────
  const md1 = checkMutationDenied({
    attempted: true,
    rejected: true,
    error: 'audit_logs is append-only: UPDATE denied',
  });
  assert("mutation-denied：UPDATE 被触发器拒绝（指纹匹配）→ ok", md1.ok === true);

  const md2 = checkMutationDenied({
    attempted: true,
    rejected: true,
    error: 'audit_logs is append-only: DELETE denied (use retention cleanup job)',
  });
  assert("mutation-denied：DELETE 被拒绝同样通过", md2.ok === true);

  const md3 = checkMutationDenied({ attempted: true, rejected: false, error: null });
  assert("mutation-denied：写试未被拒绝（纵深失效）→ 拦截", md3.ok === false);

  const md4 = checkMutationDenied({ attempted: false, rejected: false, error: null });
  assert("mutation-denied：未执行写试 → 拦截（结果不可信）", md4.ok === false);

  const md5 = checkMutationDenied({
    attempted: true,
    rejected: true,
    error: "some other constraint violation",
  });
  assert("mutation-denied：拒绝但错误指纹不符 → 拦截", md5.ok === false);

  // ── checkSequenceIntegrity ───────────────────────────────────────────
  const si1 = checkSequenceIntegrity([
    { id: 1, createdAt: "2026-09-01T00:00:00Z" },
    { id: 2, createdAt: "2026-09-02T00:00:00Z" },
    { id: 5, createdAt: "2026-09-03T00:00:00Z" }, // id 空洞合法
  ]);
  assert("sequence：id 单调 + createdAt 单调（含 id 空洞）→ ok", si1.ok && si1.checked === 3);

  const si2 = checkSequenceIntegrity([
    { id: 1, createdAt: "2026-09-03T00:00:00Z" },
    { id: 2, createdAt: "2026-09-02T00:00:00Z" }, // 时间倒挂 = 篡改嫌疑
  ]);
  assert("sequence：createdAt 相对 id 序倒挂 → 拦截（violations=1）", !si2.ok && si2.violations === 1);

  const si3 = checkSequenceIntegrity([
    { id: 1, createdAt: 1000 },
    { id: 2, createdAt: 1000 }, // 同毫秒批量写入合法
  ]);
  assert("sequence：同毫秒相等不算违例", si3.ok);

  // ── buildWindowReport ────────────────────────────────────────────────
  const DAY = 86_400_000;
  const rows = [
    { createdAt: new Date(Date.now() - 1 * DAY).toISOString() },
    { createdAt: new Date(Date.now() - 3 * DAY).toISOString() },
    { createdAt: new Date(Date.now() - 30 * DAY).toISOString() },
  ];
  const wr = buildWindowReport(rows, 7 * DAY);
  assert("window：7 天窗内 2 行、总 3 行", wr.rowsInWindow === 2 && wr.totalRows === 3);
  assert("window：密度估算为整数（行/天）", Number.isInteger(wr.densityPerDay));

  return failures;
}
