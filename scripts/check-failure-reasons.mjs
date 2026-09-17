/**
 * 一致性闸：四方失败原因枚举必须互相对齐。
 *
 * 为什么需要：`failureReason` 在**四个**地方各有一份清单，任何一处漏改都会
 * 造成静默故障——最严重的是 admin 回调 DTO 的 `@IsIn`：执行器上报了一个
 * 未登记的值会让**整批**回调 400 被拒（不是单条失败），任务永远停在运行中。
 *
 *   ① packages/executor-protocol/protocol.json  （唯一事实源）
 *   ② apps/admin-api .../task-execution.entity.ts （TS 枚举）
 *   ③ packages/autoflow-sdk/.../callback.py       （Python SDK 校验集）
 *   ④ apps/executor-node/src/callback.ts          （客户端执行器可上报集）
 *
 * 纯静态读取，不需要 npm ci / PG / Redis。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const proto = JSON.parse(
  fs.readFileSync(path.join(root, 'packages/executor-protocol/protocol.json'), 'utf8'),
);
const all = proto.failureReason.all;
const reportable = proto.failureReason.executorReportable;
const internal = proto.failureReason.adminInternalOnly ?? [];

const uniqSorted = (list) => [...new Set(list)].sort();

const results = [];
function check(name, actual, expected) {
  const a = uniqSorted(actual);
  const e = uniqSorted(expected);
  results.push({ name, ok: JSON.stringify(a) === JSON.stringify(e), actual: a, expected: e });
}

// ① 自洽性：reportable 必须是 all 去掉 admin 内部专用后的集合。
check(
  'protocol: all minus adminInternalOnly === executorReportable',
  all.filter((r) => !internal.includes(r)),
  reportable,
);

// ② admin TS 枚举
const entitySrc = fs.readFileSync(
  path.join(root, 'apps/admin-api/src/modules/task/entities/task-execution.entity.ts'),
  'utf8',
);
const enumBlock = entitySrc.match(/enum\s+ExecutionFailureReason\s*\{([\s\S]*?)\n\}/);
if (!enumBlock) throw new Error('cannot locate ExecutionFailureReason enum');
check(
  'admin ExecutionFailureReason === protocol.all',
  [...enumBlock[1].matchAll(/=\s*"([a-z_]+)"/g)].map((m) => m[1]),
  all,
);

// ③ Python SDK 校验集（只认执行器可上报子集）
const sdkSrc = fs.readFileSync(
  path.join(root, 'packages/autoflow-sdk/autoflow_sdk/callback.py'),
  'utf8',
);
const sdkBlock = sdkSrc.match(/VALID_FAILURE_REASONS[\s\S]{0,900}?\{([\s\S]*?)\}/);
if (!sdkBlock) throw new Error('cannot locate VALID_FAILURE_REASONS');
check(
  'autoflow-sdk VALID_FAILURE_REASONS === protocol.executorReportable',
  [...sdkBlock[1].matchAll(/'([a-z_]+)'|"([a-z_]+)"/g)].map((m) => m[1] ?? m[2]),
  reportable,
);

// ④ 客户端执行器可上报集
const cbSrc = fs.readFileSync(path.join(root, 'apps/executor-node/src/callback.ts'), 'utf8');
const cbBlock = cbSrc.match(/CALLBACK_FAILURE_REASONS[\s\S]{0,900}?\[([\s\S]*?)\]/);
if (!cbBlock) throw new Error('cannot locate CALLBACK_FAILURE_REASONS');
check(
  'executor-node CALLBACK_FAILURE_REASONS === protocol.executorReportable',
  [...cbBlock[1].matchAll(/'([a-z_]+)'|"([a-z_]+)"/g)].map((m) => m[1] ?? m[2]),
  reportable,
);

let failed = 0;
for (const r of results) {
  if (r.ok) {
    console.log(`OK   ${r.name}  (${r.actual.length})`);
  } else {
    failed += 1;
    console.log(`FAIL ${r.name}`);
    console.log(`     actual  : ${r.actual.join(', ')}`);
    console.log(`     expected: ${r.expected.join(', ')}`);
  }
}
if (failed) {
  console.error(`\n${failed} failure-reason enum drift(s) detected`);
  process.exit(1);
}
console.log(`\nfailure-reason alignment OK: all=${all.length}, reportable=${reportable.length}`);
