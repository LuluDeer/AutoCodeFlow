#!/usr/bin/env node
// scripts/audit-verify.mjs 自检：临时矩阵覆盖全部纯函数判据（零 DB 依赖），
// 参照 check-migrations.mjs --selftest 的形态（T4：伴生 selftest 文件已并入 --selftest）。
import { auditVerifySelftest } from "./audit-verify.lib.mjs";

const failures = auditVerifySelftest();
process.exit(failures > 0 ? 1 : 0);
