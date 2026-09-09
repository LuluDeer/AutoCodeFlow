#!/usr/bin/env node
// scripts/audit-verify.mjs 自检：临时矩阵覆盖全部纯函数判据（零 DB 依赖），
// 参照 check-migrations.selftest.mjs 的形态。
import { auditVerifySelftest } from "./audit-verify.lib.mjs";

const failures = auditVerifySelftest();
process.exit(failures > 0 ? 1 : 0);
