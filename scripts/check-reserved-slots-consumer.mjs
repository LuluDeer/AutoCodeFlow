#!/usr/bin/env node
/**
 * R17（2026-11-05）：`executors.reservedSlots` 的**消费点守卫**（立项「路 B」）。
 *
 * ## 为什么是守卫而不是加防护
 *
 * R16 修掉了心跳把 `runningTaskCount` 改小导致的超卖。它的同族列 `reservedSlots`
 * （客户端自述「pull 长轮询已预留但未领取」的槽位）在 R16 台账里被标为 P2 风险：
 * **一旦有人拿它做容量判断，就要求「不低服务端在途」的下限，否则超卖 2.0。**
 *
 * 但 R17 事实核查（`artifacts/autonomy/R17/reserved-slots-facts.md`）证明**当前没有任何消费点**：
 * 派发/容量判定面（`executor-dispatch-*` / `block-strategy-gate` / `scheduler` / `task/`）
 * **零命中**，其余 5 处全是展示、DTO 透传、控制器转发与执行器上报侧。实体注释与迁移头注也
 * 写死了同一条约束：「**派发闸门绝不读本列**——否则会重开 E-01 要关闭的超卖竞态」。
 *
 * ⇒ 现在给它加「在途下限」是**死代码**（没有读者，没有任何一行会在意那个下限）。
 * 正确的做法是把**事实本身**变成判据：
 *   ① **容量面零容忍**：`CAPACITY_SURFACES` 里的文件一旦出现 `reservedSlots` ⇒ 红，
 *      提示作者「要么改读 runningTaskCount，要么在同一处补上 R16 的在途下限（并登记到 KNOWN_READERS）」；
 *   ② **其它面必须登记**：出现 `reservedSlots` 但不属于容量面的文件，必须在 `KNOWN_READERS`
 *      里带理由登记（新增读者会被迫被复核，而不是悄悄扩散）；
 *   ③ **写入侧自洽约束不许消失**：心跳采纳处的 `reservedSlots > runningTaskCount` 拒绝分支
 *      必须还在（那是唯一一条现存的硬约束）；
 *   ④ **设计约束的注释不许被删**：实体列定义上那句「派发闸门绝不读本列」必须在。
 *
 * ## 反向验证（判据的牙齿）
 *
 * `--selftest` 在 fixture 树上逐条反证：容量面出现读者 / 未登记的新读者 / 写入自洽约束被删 /
 * 设计约束注释被删 —— 四种都必须 exit 1 并点名。
 *
 * 用法：`node scripts/check-reserved-slots-consumer.mjs [--selftest] [--root=<dir>]`
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expectExit, makeFixtureRepo, reportCases, runGuard } from "./lib/guard-selftest.mjs";
import { printCoverageBanner } from "./lib/agent-coverage.mjs";

printCoverageBanner(import.meta.url, "push");

const HERE = fileURLToPath(import.meta.url);
export const REPO_ROOT = resolve(HERE, "..", "..");
export const SCAN_ROOT = "apps/admin-api/src";

/** 容量判定面：这些文件里出现 `reservedSlots` 等价于「拿它做放行判断」 ⇒ 零容忍。 */
export const CAPACITY_SURFACES = [
  /modules\/executor\/executor-dispatch[^/]*\.ts$/,
  /modules\/task\/block-strategy-gate\.ts$/,
  /modules\/scheduler\/[^/]*\.ts$/,
  /modules\/task\/task\.service\.ts$/,
];

/**
 * 已复核的**非容量**读者（展示 / 透传 / 产生侧）。新增读者必须在这里带理由登记。
 * key = 仓库相对路径。
 */
export const KNOWN_READERS = {
  "apps/admin-api/src/modules/executor/executor.service.ts":
    "展示换算（实际运行 = runningTaskCount − reservedSlots）+ 心跳采纳管线；不参与任何放行判定",
  "apps/admin-api/src/modules/executor/executor-heartbeat-report.collaborator.ts":
    "心跳采纳与自洽校验（reservedSlots <= runningTaskCount）；不参与放行判定",
  "apps/admin-api/src/modules/executor/executor-response.dto.ts": "响应出参透出",
  "apps/admin-api/src/modules/executor/dto/executor-response.dto.ts": "响应出参透出",
  "apps/admin-api/src/modules/executor/dto/executor-heartbeat.dto.ts": "入参 DTO 文档与声明",
  "apps/admin-api/src/modules/executor/executor.controller.ts": "控制器白名单转发（F-7）",
  "apps/admin-api/src/modules/executor/entities/executor.entity.ts": "列定义 + 设计约束注释",
  "apps/admin-api/src/common/dto/misc-2xx-response.dto.ts":
    "OpenAPI 响应 schema 的属性声明（纯类型面，运行时不读取该值）",
};

/** 写入侧自洽约束的锚点（必须存在）。 */
export const WRITE_SELF_CONSISTENCY = {
  file: "apps/admin-api/src/modules/executor/executor-heartbeat-report.collaborator.ts",
  needle: "reservedSlots > e.runningTaskCount",
  why: "心跳采纳处「预留不得超过已占槽位」的自洽拒绝必须还在（现存唯一硬约束）",
};

/** 设计约束注释锚点（必须存在，防止有人顺手删掉那条警告）。 */
export const DESIGN_CONSTRAINT = {
  file: "apps/admin-api/src/modules/executor/entities/executor.entity.ts",
  needle: "派发闸门绝不读本列",
  why: "实体注释里「派发闸门绝不读本列」是这条设计的唯一书面约束，删了就等于放开",
};

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const st = statSync(abs);
    if (st.isDirectory()) {
      if (name === "__tests__" || name === "node_modules") continue;
      walk(abs, out);
    } else if (name.endsWith(".ts") && !name.endsWith(".spec.ts") && !name.endsWith(".d.ts")) {
      out.push(abs);
    }
  }
  return out;
}

export function check(root = REPO_ROOT) {
  const errors = [];
  const scanAbs = join(root, SCAN_ROOT);
  if (!existsSync(scanAbs)) return [`读不到 ${SCAN_ROOT} —— 扫描面缺失（守卫瞎了）`];

  const files = walk(scanAbs).filter((abs) => !abs.includes(`${join("src", "migrations")}`));
  let hits = 0;
  for (const abs of files) {
    const rel = relative(root, abs).split("\\").join("/");
    const text = readFileSync(abs, "utf8");
    if (!text.includes("reservedSlots")) continue;
    hits += 1;
    const inCapacitySurface = CAPACITY_SURFACES.some((re) => re.test(rel));
    if (inCapacitySurface) {
      errors.push(
        `${rel} 是**容量判定面**却读了 reservedSlots —— 这等价于拿它做放行判断。` +
          `要么改读 runningTaskCount（推荐），要么在此处补「不低服务端在途占坑」的下限` +
          `（R16 的 heartbeat-count.util.ts 同一条思路），并把本文件登记进 KNOWN_READERS 说明理由。`,
      );
      continue;
    }
    if (!(rel in KNOWN_READERS)) {
      errors.push(
        `${rel} 读了 reservedSlots 但未在 KNOWN_READERS 登记 —— ` +
          `新增读者必须被复核：确认它不参与容量判断（只是展示/透传/产生侧），然后带理由登记。`,
      );
    }
  }
  if (hits === 0) {
    errors.push("全仓零命中 reservedSlots —— 扫描器失效或该列被删（守卫瞎了，不是「无消费者」）");
  }

  const w = WRITE_SELF_CONSISTENCY;
  const wAbs = join(root, w.file);
  if (!existsSync(wAbs)) errors.push(`读不到 ${w.file}`);
  else if (!readFileSync(wAbs, "utf8").includes(w.needle)) {
    errors.push(`${w.file} 里找不到 \`${w.needle}\` —— ${w.why}`);
  }

  const d = DESIGN_CONSTRAINT;
  const dAbs = join(root, d.file);
  if (!existsSync(dAbs)) errors.push(`读不到 ${d.file}`);
  else if (!readFileSync(dAbs, "utf8").includes(d.needle)) {
    errors.push(`${d.file} 里找不到「${d.needle}」—— ${d.why}`);
  }

  return errors;
}

// ── 自检：四种反例都必须红 ───────────────────────────────────────────────
const SELF = fileURLToPath(import.meta.url);

const ENTRY = `apps/admin-api/src/modules/executor/executor-dispatch-slot.collaborator.ts`;
const SERVICE = `apps/admin-api/src/modules/executor/executor.service.ts`;
const REPORT = `apps/admin-api/src/modules/executor/executor-heartbeat-report.collaborator.ts`;
const ENTITY = `apps/admin-api/src/modules/executor/entities/executor.entity.ts`;

function fixtureTree(over = {}) {
  return {
    [SERVICE]:
      over.service ??
      "export const f = (e) => e.runningTaskCount - e.reservedSlots; // 展示换算\n",
    [REPORT]:
      over.report ??
      "if (reservedSlots > e.runningTaskCount) { throw new Error('x'); }\n",
    [ENTITY]: over.entity ?? "// 派发闸门绝不读本列（selectLeastLoaded / 容量守卫仍读 runningTaskCount）\nexport class E { reservedSlots: number | null }\n",
    [ENTRY]: over.entry ?? "export const s = 1;\n",
  };
}

function runSelftest() {
  const cases = [];
  const push = (name, fn) => cases.push({ name, fn });

  push("正例控制组：无容量面读者 + 登记齐 + 两处锚点在 ⇒ exit 0", () => {
    const repo = makeFixtureRepo(fixtureTree());
    try {
      expectExit(runGuard(SELF, { args: ["--root", repo.dir] }), { code: 0, withinMs: 20000, label: "正例" });
    } finally {
      repo.cleanup();
    }
  });

  push("反例①：容量面新增读者 ⇒ exit 1 且点名该文件", () => {
    const repo = makeFixtureRepo(
      fixtureTree({ entry: "const avail = e.maxConcurrentTasks - e.reservedSlots;\n" }),
    );
    try {
      expectExit(runGuard(SELF, { args: ["--root", repo.dir] }), {
        code: 1, contains: ["容量判定面", "reservedSlots"], withinMs: 20000, label: "容量面读者",
      });
    } finally {
      repo.cleanup();
    }
  });

  push("反例②：非容量面新增未登记读者 ⇒ exit 1 且点名「未在 KNOWN_READERS 登记」", () => {
    const repo = makeFixtureRepo({
      ...fixtureTree(),
      "apps/admin-api/src/modules/executor/executor-something-new.ts": "export const x = e.reservedSlots;\n",
    });
    try {
      expectExit(runGuard(SELF, { args: ["--root", repo.dir] }), {
        code: 1, contains: ["未在 KNOWN_READERS 登记"], withinMs: 20000, label: "未登记读者",
      });
    } finally {
      repo.cleanup();
    }
  });

  push("反例③：写入侧自洽约束被删 ⇒ exit 1", () => {
    const repo = makeFixtureRepo(fixtureTree({ report: "// 校验被删\n" }));
    try {
      expectExit(runGuard(SELF, { args: ["--root", repo.dir] }), {
        code: 1, contains: ["reservedSlots > e.runningTaskCount"], withinMs: 20000, label: "自洽约束",
      });
    } finally {
      repo.cleanup();
    }
  });

  push("反例④：设计约束注释被删 ⇒ exit 1", () => {
    const repo = makeFixtureRepo(fixtureTree({ entity: "export class E { reservedSlots: number | null }\n" }));
    try {
      expectExit(runGuard(SELF, { args: ["--root", repo.dir] }), {
        code: 1, contains: ["派发闸门绝不读本列"], withinMs: 20000, label: "设计约束",
      });
    } finally {
      repo.cleanup();
    }
  });

  push("反例⑤：全仓零命中（扫描器失效）⇒ exit 1，不冒充「无消费者」", () => {
    const repo = makeFixtureRepo({
      [ENTITY]: "export class E {}\n",
      [REPORT]: "export const s = 1;\n",
      [SERVICE]: "export const s = 1;\n",
      [ENTRY]: "export const s = 1;\n",
    });
    try {
      expectExit(runGuard(SELF, { args: ["--root", repo.dir] }), {
        code: 1, contains: ["零命中"], withinMs: 20000, label: "扫描器失效",
      });
    } finally {
      repo.cleanup();
    }
  });

  const failed = reportCases(cases, { title: "check-reserved-slots-consumer selftest" });
  process.exit(failed === 0 ? 0 : 1);
}

function main(argv) {
  const eq = argv.find((a) => a.startsWith("--root="));
  const at = argv.indexOf("--root");
  const rootArg = eq ? eq.slice("--root=".length) : at >= 0 && at + 1 < argv.length ? argv[at + 1] : null;
  const errors = check(resolve(rootArg ?? REPO_ROOT));
  if (errors.length === 0) {
    console.log(
      `✔ reservedSlots 消费点守卫通过：容量判定面（dispatch / block-strategy-gate / scheduler / task.service）零读者，` +
        `${Object.keys(KNOWN_READERS).length} 个展示/透传/产生侧读者全部已登记；写入侧自洽约束与设计约束注释都在。`,
    );
    return 0;
  }
  console.error(`✘ reservedSlots 消费点守卫：${errors.length} 项`);
  for (const e of errors) console.error(`   · ${e}`);
  return 1;
}

if (process.argv[1] && resolve(process.argv[1]) === HERE) {
  process.exit(process.argv.includes("--selftest") ? runSelftest() : main(process.argv.slice(2)));
}
