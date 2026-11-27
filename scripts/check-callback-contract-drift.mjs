#!/usr/bin/env node
/**
 * 回调契约漂移守卫：protocol.CallbackPayload 字段 ⊆ admin CallbackItemDto 字段。
 *
 * 为什么需要静态守卫（与 controller 的 forbidNonWhitelisted 互补）：
 *   - 运行期 forbidNonWhitelisted 保证「DTO 没声明的字段整批 400」——它是拒未知，
 *     但不能阻止协议新增字段后 DTO 忘了跟：执行器升级后每次回调都 400，终态
 *     全部丢失（槽位泄漏），而错误只在生产流量里出现。
 *   - 本脚本在代码层对账：协议登记的每个字段必须在 admin DTO 上有声明，
 *     且 attemptSeq 必须在派发/回调两侧闭合。新增协议字段必须先补 DTO 再发版。
 *
 * 自检纪律：抽取器一旦与源码风格脱节，会退化成「空集 ⊆ 任何集合」的永真断言。
 * 因此同时检查抽取到的字段数下界，并把下界失配单独报为 structure 错误。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROTOCOL_RELATIVE = join(
  "packages",
  "executor-protocol",
  "protocol.json",
);
const DTO_RELATIVE = join(
  "apps",
  "admin-api",
  "src",
  "modules",
  "task",
  "dto",
  "execution-callback.dto.ts",
);
const CONTROLLER_RELATIVE = join(
  "apps",
  "admin-api",
  "src",
  "modules",
  "task",
  "execution-callback.controller.ts",
);
const DISPATCH_RELATIVE = join(
  "apps",
  "admin-api",
  "src",
  "modules",
  "executor",
  "executor.service.ts",
);

/** 向上找仓库根——硬编码 ../ ×N 会随脚本移动而静默失效。 */
export function findRepoRoot(from) {
  let dir = from;
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, PROTOCOL_RELATIVE))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`executor-protocol/protocol.json not found above ${from}`);
}

/**
 * 从 DTO 源码抽取 CallbackItemDto 上经 @ApiProperty/@ApiPropertyOptional
 * 声明的字段名。返回 null = 锚点缺失（调用方按「守卫失效」报错，绝不返回空数组
 * 冒充「全部覆盖」）。
 */
export function extractDtoFields(source) {
  const anchor = "export class CallbackItemDto";
  const start = source.indexOf(anchor);
  if (start === -1) return null;
  const open = source.indexOf("{", start);
  const end = source.indexOf("\n}", open);
  if (open === -1 || end === -1) return null;
  const body = source.slice(open, end);
  const fields = new Set();
  let expectingField = false;
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("@ApiProperty")) {
      expectingField = true;
      continue;
    }
    if (!expectingField) continue;
    // 字段声明恰好以两空格缩进开头（装饰器对象内的键是四空格，不会误命中）。
    const match = /^  ([A-Za-z_][A-Za-z0-9_]*)(\?)?\s*:\s*/.exec(line);
    if (match) {
      fields.add(match[1]);
      expectingField = false;
    }
  }
  return [...fields];
}

/** 抽取下限：低于此值说明抽取器与源码脱节，而不是协议真的只有几个字段。 */
export const MIN_DTO_FIELDS = 10;
export const MIN_PROTOCOL_FIELDS = 10;
/** push / pull / 广播 push / 广播 pull 四个派发点都要带顶层键。 */
export const MIN_DISPATCH_SITES = 3;

export function check({ protocol, dtoSource, controllerSource, dispatchSource }) {
  const errors = [];
  const structure = [];
  const props = protocol?.schemas?.CallbackPayload?.properties;
  if (!props || typeof props !== "object") {
    errors.push(
      "protocol.json 缺少 schemas.CallbackPayload.properties（锚点缺失，守卫不成立）",
    );
    return { errors, structure, stats: { protocol: 0, dto: 0 } };
  }
  const protocolFields = Object.keys(props);
  const dtoFields = extractDtoFields(dtoSource);
  if (dtoFields === null) {
    errors.push(
      "CallbackItemDto 类锚点未找到（抽取器与源码脱节，守卫会退化成永真）",
    );
    return { errors, structure, stats: { protocol: protocolFields.length, dto: 0 } };
  }
  const dtoSet = new Set(dtoFields);
  if (protocolFields.length < MIN_PROTOCOL_FIELDS) {
    structure.push(
      `协议只抽出 ${protocolFields.length} 个回调字段（下界 ${MIN_PROTOCOL_FIELDS}）——抽取口径失配`,
    );
  }
  if (dtoFields.length < MIN_DTO_FIELDS) {
    structure.push(
      `DTO 只抽出 ${dtoFields.length} 个字段（下界 ${MIN_DTO_FIELDS}）——抽取器与 @ApiProperty 写法脱节`,
    );
  }
  const missing = protocolFields.filter((field) => !dtoSet.has(field));
  if (missing.length > 0) {
    errors.push(
      `CallbackPayload 字段未在 CallbackItemDto 声明（新增协议字段会整批 400）：${missing.join(", ")}`,
    );
  }
  if (!protocolFields.includes("attemptSeq") || !dtoSet.has("attemptSeq")) {
    errors.push(
      "attemptSeq 未在派发/回调两侧闭合：protocol.CallbackPayload 与 CallbackItemDto 都必须声明 `attemptSeq?: number`",
    );
  }
  if (
    !controllerSource.includes("forbidNonWhitelisted: true") ||
    !controllerSource.includes("whitelist: true")
  ) {
    errors.push(
      "execution-callback.controller.ts 的 ParseArrayPipe 必须同时带 whitelist + forbidNonWhitelisted（未知字段 fail-fast）",
    );
  }
  // 派发侧闭合：attemptSeq 必须以顶层可选键写入每条派发路径，
  // 漏一条就会出现「某类执行器回传不出世代」的静默退化。
  const dispatchSites = (
    dispatchSource.match(/\.\.\.\(attemptSeq !== undefined \? \{ attemptSeq \} : \{\}\)/g) ?? []
  ).length;
  if (
    dispatchSites < MIN_DISPATCH_SITES ||
    !dispatchSource.includes("private dispatchAttemptSeq(")
  ) {
    errors.push(
      `executor.service.ts 派发载荷的顶层 attemptSeq 写入点只有 ${dispatchSites} 处（下界 ${MIN_DISPATCH_SITES}），或归一化方法缺失`,
    );
  }
  return {
    errors,
    structure,
    stats: { protocol: protocolFields.length, dto: dtoFields.length, dispatchSites },
  };
}

export function checkFiles(
  root = findRepoRoot(HERE),
) {
  const protocol = JSON.parse(
    readFileSync(join(root, PROTOCOL_RELATIVE), "utf8"),
  );
  const dtoSource = readFileSync(join(root, DTO_RELATIVE), "utf8");
  const controllerSource = readFileSync(
    join(root, CONTROLLER_RELATIVE),
    "utf8",
  );
  const dispatchSource = readFileSync(join(root, DISPATCH_RELATIVE), "utf8");
  return check({ protocol, dtoSource, controllerSource, dispatchSource });
}

function main() {
  try {
    const result = checkFiles();
    for (const line of result.structure) console.error(`[structure] ${line}`);
    for (const line of result.errors) console.error(`[drift] ${line}`);
    if (result.errors.length > 0 || result.structure.length > 0) {
      console.error(
        `callback contract drift: protocol=${result.stats.protocol} dto=${result.stats.dto}`,
      );
      process.exit(1);
    }
    console.log(
      `callback contract ok: protocol=${result.stats.protocol} fields ⊆ dto=${result.stats.dto} fields; forbidNonWhitelisted on; dispatchSites=${result.stats.dispatchSites}`,
    );
  } catch (err) {
    console.error(
      `callback contract guard failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }
}

// 直接执行时才跑 main；被 spec import 做纯函数对账时不产生副作用。
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
