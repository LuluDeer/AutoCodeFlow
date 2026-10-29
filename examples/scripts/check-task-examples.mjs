#!/usr/bin/env node
/**
 * 示例任务配置 ↔ 后端 `CreateTaskDto` 对账守卫（SDK-DX-06，2026-10-29）。
 *
 * 由来（缺陷现场）：`examples/private-registry-deps-node/task.example.json`
 * 里带着 `"id": "private-registry-deps-node-demo"` 且**没有必填的
 * `triggerType`**——而文档（`docs/sdk-guide.md`「官方示例」、两处 README）
 * 都把这份文件宣传成「最小任务配置」，用户照着 `POST /api/tasks` 会连撞两次
 * 400：一次是 `id` 不是 UUID v4（`@IsUUID("4")`），一次是缺 `triggerType`。
 * 这类偏差此前**没有任何守卫**（CLI 审计的 `P2-3` 登记的正是这个缺口）。
 *
 * 判据（只判确定能判的，不做语义理解）：
 *   A. 键集 ⊆ `CreateTaskDto` 的顶层属性名——多出来的键会被全局
 *      `ValidationPipe{forbidNonWhitelisted:true}` 打成 400；
 *   B. 必填项（DTO 里**没有** `@IsOptional()` 的顶层属性）必须出现；
 *   C. 少量高价值取值：`id` 必须是 UUID v4（DTO 的 `@IsUUID("4")`）、
 *      `triggerType` ∈ `TaskTriggerType`、`runtime` ∈ `TaskRuntime`；
 *   D. `name` 非空、首尾无空白、≤255（`IsTaskName` 约束的可机检部分）。
 *
 * 事实源是 DTO 源码本身（不是手抄的字段表）：DTO 加字段、改必填，这里自动跟上。
 *
 * 用法：
 *   node examples/scripts/check-task-examples.mjs            # 校验 examples/*​/task.example.json
 *   node examples/scripts/check-task-examples.mjs --selftest # 反例自检（修好的那份必须绿、
 *                                                            # 修复前的形态必须红）
 * 退出码：0 = 全绿；1 = 有偏差（逐条打印文件与原因）。
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// examples/scripts/ → 仓库根是两级向上
const REPO_ROOT = resolve(HERE, "..", "..");

const DTO_PATH = "apps/admin-api/src/modules/task/dto/create-task.dto.ts";
const ENTITY_PATH = "apps/admin-api/src/modules/task/entities/task.entity.ts";

/** 读仓库相对路径的文本；缺失时抛带路径的错误（守卫不该静默跳过事实源）。 */
function readRepo(rel, root = REPO_ROOT) {
  const abs = join(root, rel);
  if (!existsSync(abs)) throw new Error(`事实源不存在：${rel}（仓库根 ${root}）`);
  return readFileSync(abs, "utf8");
}

/** 从 TS 里取某个 enum 的字符串成员（`ENUM = "value"` 形态）。 */
export function parseEnumValues(source, enumName) {
  const m = new RegExp(`export enum ${enumName}\\s*\\{([\\s\\S]*?)\\n\\}`).exec(source);
  if (!m) return [];
  return [...m[1].matchAll(/=\s*"([^"]+)"/g)].map((x) => x[1]);
}

/**
 * 解析 `CreateTaskDto` 的顶层属性：{ name, optional }[]。
 *
 * 不引 TypeScript 编译器（守卫必须零依赖、秒级可跑）：对 class 体做一个**括号
 * 深度扫描**——
 * - 深度 0 的 `@Decorator` → 记进当前属性的装饰器列表（`(` 会抬深度，所以
 *   `@ApiProperty({ description: "a: b" })` 里的键值对不会被误认成属性）；
 * - 深度 0 的 `name?` / `name:` → 一个属性声明，`optional` =
 *   `@IsOptional()` 或声明自带 `?`；
 * - 块注释/行注释先剥掉（DTO 里大段 `/** … *\/` 注释含 `@IsOptional()` 字样，
 *   不剥会把「注释提到的可选项」当成真可选项——那正是想要的判据不能来源）。
 *
 * 只判顶层（嵌套 DTO 的字段由各自的 DTO 负责），与 `forbidNonWhitelisted`
 * 的判据面一致：它只看**顶层**多余键。
 */
export function parseDtoFields(source, className = "CreateTaskDto") {
  const classStart = source.search(new RegExp(`^export class ${className}\\b`, "m"));
  if (classStart < 0) return [];
  const openBrace = source.indexOf("{", classStart);
  if (openBrace < 0) return [];
  // class 体：从第一个 `{` 到顶格 `}`（DTO 里没有顶格的 `}`）
  const rest = source.slice(openBrace + 1);
  const close = rest.search(/^\}/m);
  let body = close >= 0 ? rest.slice(0, close) : rest;
  // 剥注释（含跨行块注释）；字符串里的 `//` 只会截断装饰器描述，不影响判据
  body = body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

  const fields = [];
  let decorators = [];
  let depth = 0;
  let i = 0;
  while (i < body.length) {
    const ch = body[i];
    if (ch === "(" || ch === "{" || ch === "[") {
      depth++;
      i++;
      continue;
    }
    if (ch === ")" || ch === "}" || ch === "]") {
      depth--;
      i++;
      continue;
    }
    if (depth === 0 && ch === "@") {
      const m = /^@([A-Za-z_$][\w$.]*)/.exec(body.slice(i));
      if (m) {
        decorators.push(m[1]);
        i += m[0].length;
        continue;
      }
    }
    if (depth === 0) {
      const m = /^([A-Za-z_$][\w$]*)(\??):/.exec(body.slice(i));
      if (m) {
        fields.push({
          name: m[1],
          optional: m[2] === "?" || decorators.includes("IsOptional"),
        });
        decorators = [];
        i += m[0].length;
        continue;
      }
    }
    i++;
  }
  return fields;
}

/** UUID v4（DTO 用 `@IsUUID("4")`——版本位必须是 4）。 */
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * 5 字段 cron 的**纯数字**语法校验（零依赖，镜像后端 `@IsCron5Field` 的收紧面）。
 *
 * 为什么必须校验：`@IsCron5Field` 刻意把 node-cron 的宽松面**收紧到纯数字 5 段**
 * （`cron-expression.constraint.ts` 的注释写明了原因：6 段会让前端预览器
 * `parseCronExpression` 解析失败、字母星期/月份会让预览与维护窗口对同一表达式
 * 各说各话）。而四份示例此前全写 Quartz 风格的 **6 段**
 * （`"0 0 3 * * *"`），实测被 DTO 判 `cronExpression must be a valid cron
 * expression (5 fields: …)` —— 也就是说「删掉 id、补上 triggerType」之后
 * 这份示例**仍然**提交不了（DX-06 的真实范围比审计报告写的大一圈）。
 *
 * 判据：恰好 5 段；每段是 `*` 或逗号列表，列表中每项为
 * `n` / `n-m` / `n/s` / `n-m/s` / `*​/s`，全部**纯数字**且在字段取值域内。
 * @returns {string[]} 问题清单
 */
export function checkCron5Field(expr) {
  if (typeof expr !== "string") return [`cronExpression 必须是字符串，收到 ${JSON.stringify(expr)}`];
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    return [
      `cronExpression = ${JSON.stringify(expr)} 是 ${fields.length} 段，` +
        `后端契约是 **5 段**（min hour day month weekday）；` +
        `Quartz 风格 6 段（带秒，如 "0 0 3 * * *"）会 400。5 段写法： "0 3 * * *"`,
    ];
  }
  const bounds = [
    [0, 59, "minute"],
    [0, 23, "hour"],
    [1, 31, "day-of-month"],
    [1, 12, "month"],
    [0, 7, "day-of-week"],
  ];
  const problems = [];
  fields.forEach((field, idx) => {
    const [min, max, label] = bounds[idx];
    for (const item of field.split(",")) {
      const m = /^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/.exec(item);
      if (!m) {
        problems.push(
          `cronExpression 第 ${idx + 1} 段（${label}）的 "${item}" 非法：` +
            `只接受纯数字（不收 sun/jan 这类字母，后端同样拒绝）`,
        );
        continue;
      }
      const lo = m[1] === "*" ? min : Number(m[1]);
      const hi = m[2] === undefined ? lo : Number(m[2]);
      if (lo < min || lo > max || hi < min || hi > max || lo > hi) {
        problems.push(
          `cronExpression 第 ${idx + 1} 段（${label}）的 "${item}" 越界：合法范围 ${min}-${max}`,
        );
      }
      if (m[3] !== undefined && Number(m[3]) === 0) {
        problems.push(`cronExpression 第 ${idx + 1} 段（${label}）的步进不能是 0`);
      }
    }
  });
  return problems;
}

/**
 * 校验一份任务配置对象（纯函数，便于 selftest 直接喂夹具）。
 * @returns {string[]} 问题清单（空数组 = 通过）
 */
export function checkTaskConfig(config, dtoFields, enums) {
  const problems = [];
  const allowed = new Set(dtoFields.map((f) => f.name));
  const required = dtoFields.filter((f) => !f.optional).map((f) => f.name);

  for (const key of Object.keys(config)) {
    if (!allowed.has(key)) {
      problems.push(
        `多余键 "${key}"：不在 CreateTaskDto 白名单内，` +
          `全局 ValidationPipe{forbidNonWhitelisted:true} 会直接 400（property ${key} should not exist）`,
      );
    }
  }
  for (const key of required) {
    if (!(key in config)) {
      problems.push(
        `缺必填键 "${key}"：DTO 里没有 @IsOptional()，后端会 400（${key} must be one of …）`,
      );
    }
  }
  if ("id" in config && !UUID_V4.test(String(config.id))) {
    problems.push(
      `id = ${JSON.stringify(config.id)} 不是 UUID v4：DTO 是 @IsUUID("4") 的可选主键，` +
        `想让后端生成就别带这个字段（示例应删掉它，而不是塞一个可读名字）`,
    );
  }
  if ("triggerType" in config && enums.triggerType.length > 0) {
    if (!enums.triggerType.includes(config.triggerType)) {
      problems.push(
        `triggerType = ${JSON.stringify(config.triggerType)} 非法，可选：${enums.triggerType.join(" / ")}`,
      );
    }
  }
  if ("runtime" in config && enums.runtime.length > 0) {
    if (!enums.runtime.includes(config.runtime)) {
      problems.push(
        `runtime = ${JSON.stringify(config.runtime)} 非法，可选：${enums.runtime.join(" / ")}`,
      );
    }
  }
  if ("cronExpression" in config) {
    problems.push(...checkCron5Field(config.cronExpression));
  }
  if ("name" in config) {
    const name = config.name;
    if (typeof name !== "string" || name.trim() === "") {
      problems.push("name 必须是非空字符串");
    } else if (name !== name.trim()) {
      problems.push("name 首尾不得有空白（IsTaskName 约束）");
    } else if (name.length > 255) {
      problems.push(`name 长度 ${name.length} > 255（与 DB 列宽 / IsTaskName 对齐）`);
    }
  }
  return problems;
}

/** 跑仓库里所有示例配置。 */
export function checkRepo(root = REPO_ROOT) {
  const dtoFields = parseDtoFields(readRepo(DTO_PATH, root));
  const entity = readRepo(ENTITY_PATH, root);
  const enums = {
    triggerType: parseEnumValues(entity, "TaskTriggerType"),
    runtime: parseEnumValues(entity, "TaskRuntime"),
  };
  if (dtoFields.length === 0) throw new Error(`未能从 ${DTO_PATH} 解析出任何字段（格式变了？）`);
  if (enums.triggerType.length === 0) throw new Error(`未能从 ${ENTITY_PATH} 解析出 TaskTriggerType`);

  const examplesDir = join(root, "examples");
  const results = [];
  for (const entry of readdirSync(examplesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const rel = `examples/${entry.name}/task.example.json`;
    if (!existsSync(join(root, rel))) continue;
    let config;
    try {
      config = JSON.parse(readRepo(rel, root));
    } catch (e) {
      results.push({ file: rel, problems: [`JSON 解析失败：${e.message}`] });
      continue;
    }
    results.push({ file: rel, problems: checkTaskConfig(config, dtoFields, enums) });
  }
  return { results, dtoFields, enums };
}

// ── 反例自检：判定必须有齿 ────────────────────────────────────────────────
const FIXTURES = {
  /** 合法：修复后的形态（无 id、有 triggerType）。 */
  good: {
    name: "私服依赖示例（Node）",
    triggerType: "cron",
    runtime: "node",
    entrypoint: "examples/private-registry-deps-node/private_dep_task.js",
    cronExpression: "0 3 * * *",
    timeoutSeconds: 600,
    maxRetry: 1,
    retryDelay: 30,
    params: { pkg_name: "@autocodeflow/sdk" },
    requirements: ["@autocodeflow/sdk"],
  },
  /** 非法：修复前的真实形态（id 是自造字符串 + 缺 triggerType + 6 段 cron）。 */
  brokenBeforeFix: {
    id: "private-registry-deps-node-demo",
    name: "私服依赖示例（Node）",
    runtime: "node",
    entrypoint: "examples/private-registry-deps-node/private_dep_task.js",
    cronExpression: "0 0 3 * * *",
    timeoutSeconds: 600,
    maxRetry: 1,
    retryDelay: 30,
    params: { pkg_name: "@autocodeflow/sdk" },
    requirements: ["@autocodeflow/sdk"],
  },
  /** 非法：多余键（非 id）+ 非法枚举值。 */
  extraKeyAndBadEnum: {
    name: "x",
    triggerType: "every-minute",
    runtime: "deno",
    unknownField: 1,
  },
};

function runSelftest() {
  const dtoFields = parseDtoFields(readRepo(DTO_PATH));
  const entity = readRepo(ENTITY_PATH);
  const enums = {
    triggerType: parseEnumValues(entity, "TaskTriggerType"),
    runtime: parseEnumValues(entity, "TaskRuntime"),
  };
  const cases = [
    ["good", 0],
    ["brokenBeforeFix", 2], // ① id 非 UUID v4 ② 缺 triggerType
    ["extraKeyAndBadEnum", 3], // ① 多余键 ② triggerType 非法 ③ runtime 非法
  ];
  let failures = 0;
  for (const [name, expected] of cases) {
    const problems = checkTaskConfig(FIXTURES[name], dtoFields, enums);
    const ok = expected === 0 ? problems.length === 0 : problems.length >= expected;
    if (ok) {
      console.log(
        `✅ 有齿：${name} → ${problems.length} 个问题（期望 ${expected === 0 ? "0" : `≥${expected}`}）`,
      );
    } else {
      failures++;
      console.error(
        `✗ 失齿：${name} → ${problems.length} 个问题（期望 ${expected === 0 ? "0" : `≥${expected}`}）`,
      );
      for (const p of problems) console.error("    " + p);
    }
    if (process.env.SHOW_FIXTURE_PROBLEMS === "1" || expected > 0) {
      for (const p of problems) console.log(`    · ${p}`);
    }
  }
  if (failures > 0) {
    console.error(`\n${failures} 项反例测试失败\n`);
    process.exit(1);
  }
  console.log(`\n反例测试全部通过（DTO 必填项：${dtoFields.filter((f) => !f.optional).map((f) => f.name).join(", ")}）\n`);
}

function main() {
  const { results, dtoFields } = checkRepo();
  const errors = results.flatMap((r) => r.problems.map((p) => `${r.file}: ${p}`));
  if (errors.length > 0) {
    console.error(`\n✖ 示例任务配置守卫发现 ${errors.length} 个问题：`);
    for (const e of errors) console.error("  · " + e);
    console.error(
      "\n  修法：示例 JSON 必须能被原样 POST /api/tasks（键集 ⊆ CreateTaskDto 白名单、必填项齐全、" +
        "id 是 UUID v4 就别自带）。事实源见 apps/admin-api/src/modules/task/dto/create-task.dto.ts。\n",
    );
    process.exit(1);
  }
  console.log(
    `✔ 示例任务配置守卫通过（${results.length} 份示例 ↔ CreateTaskDto ${dtoFields.length} 个属性，` +
      `必填：${dtoFields.filter((f) => !f.optional).map((f) => f.name).join(", ")}）`,
  );
}

const invokedDirectly =
  Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  if (process.argv.includes("--selftest")) runSelftest();
  else main();
}
