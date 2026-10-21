#!/usr/bin/env node
/**
 * 「admin-api 全路由鉴权矩阵」守卫的 CLI 外壳（R203-A1）。
 *
 * ## 为什么是外壳而不是又一个正则扫描器
 *
 * 这个判据的输入是 **Nest 的真实装饰器元数据**（PATH_METADATA / METHOD_METADATA /
 * ROLES_KEY / IS_PUBLIC_KEY / WRITE_GUARD_KEY / GUARDS_METADATA）——类级与 handler
 * 级的覆盖顺序（getAllAndOverride）、@Public() 对全局守卫的短路、@UseGuards 的
 * 补偿守卫、空 @Roles() 对类级 ADMIN 的覆写，这些都只有 reflect 元数据说得清。
 * 用正则再实现一遍会得到**第二套语义**，两套语义一漂移就是「脚本绿、CI 红」或者
 * 更糟的「两边都绿、线上公开」。
 *
 * 所以判据只有一份实现：src/common/guards/__tests__/route-authz-matrix.spec.ts。
 * 本脚本负责「让它在任意入口（本地 / CI / pre-push）都能一把跑完并给出可读结论」。
 *
 * ## 判据摘要
 *
 *   每条路由必须落进一个具名鉴权形态：
 *     role-gated      @Roles 非空
 *     declared-*      @WriteGuard 显式声明
 *     delegated       @Public + 已登记白名单里的补偿守卫
 *     open-registered @Public 且既无声明也无补偿守卫 -> 必须在 OPEN_ROUTE_REGISTRY 逐条写明理由
 *     jwt             仅全局 JwtAuthGuard
 *   @Public 且未登记 / @Public 与 @Roles 并存 / 空 @Roles() 覆写类级 ADMIN /
 *   scope 与 @Public 不自洽 / 登记表过期 —— 一律红灯。
 *
 *   规模下界（脚本坏了不能永远绿）：30 个控制器、>=220 条路由；控制器数必须等于
 *   磁盘上的 *.controller.ts 文件数。
 *
 * ## 用法
 *
 *   node scripts/check-route-authz-matrix.mjs              # 判定，绿退出 0 / 红退出 1
 *   node scripts/check-route-authz-matrix.mjs --selftest   # 额外确认「能红」的链路是通的
 *
 * --selftest 不只看退出码：它还要求输出里出现 spec 自检用例打印的
 * ROUTE_AUTHZ_SELFTEST_OK 标记（证明 jest -> spec -> 检测器这条链真的跑到过，
 * 而不是被 --passWithNoTests 一类的配置短路成空跑）。
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(HERE, "..");
const SPEC_REL = "src/common/guards/__tests__/route-authz-matrix.spec.ts";
const SPEC_ABS = join(APP_ROOT, SPEC_REL);

const selftest = process.argv.includes("--selftest");

if (!existsSync(SPEC_ABS)) {
  console.error("✖ 找不到判据 spec：" + SPEC_REL);
  console.error("  本脚本只是外壳，判据本身在该 spec 里；它被改名/移动时这里必须同步。");
  process.exit(1);
}

// 不经过 npx/shell：直接以 --experimental-vm-modules 跑本地 jest 入口。
// 等价于 package.json 的 `npx --node-options=--experimental-vm-modules jest`，
// 但避开 Windows 上 .cmd + shell 的引号/DEP0190 麻烦。
const JEST_BIN = join(APP_ROOT, "node_modules", "jest", "bin", "jest.js");
if (!existsSync(JEST_BIN)) {
  console.error("✖ 找不到本地 jest：" + JEST_BIN);
  console.error("  先在 apps/admin-api 执行 npm install。");
  process.exit(1);
}

const args = ["--experimental-vm-modules", JEST_BIN, SPEC_REL];

const result = spawnSync(process.execPath, args, {
  cwd: APP_ROOT,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});

const stdout = result.stdout || "";
const stderr = result.stderr || "";
const ok = result.status === 0;

// 从 jest 输出里抠矩阵摘要（spec 自检用例打印的那一行），给人类看的结论。
const marker = stdout.match(/ROUTE_AUTHZ_SELFTEST_OK ([^\r\n]+)/);
const summary = marker ? marker[1].trim() : null;

if (!ok) {
  console.error("✖ 全路由鉴权矩阵**红**：");
  // 只回放断言失败相关的行，避免把整份 jest 日志倒给用户。
  const lines = (stdout + "\n" + stderr).split(/\r?\n/);
  const keep = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (/●.*route-authz-matrix/.test(lines[i])) {
      keep.push(lines.slice(i, i + 12).join("\n"));
    }
  }
  console.error(keep.length > 0 ? keep.join("\n\n") : lines.slice(-40).join("\n"));
  console.error("");
  console.error("  修法：把新路由显式声明（@Roles / @WriteGuard），或——若它确实应当公开——");
  console.error("  在 route-authz-matrix.spec.ts 的 OPEN_ROUTE_REGISTRY 里登记并写明「为什么可以不鉴权」。");
  process.exit(1);
}

if (!summary) {
  // 退出码 0 但拿不到标记 = 判据根本没执行（被 --passWithNoTests / 路径写错 /
  // testNamePattern 过滤掉）。这是「守卫静默失效」，必须红。
  console.error("✖ jest 退出码为 0，但输出里没有 ROUTE_AUTHZ_SELFTEST_OK 标记——");
  console.error("  说明判据 spec 没有被真正执行（空跑）。这比红更危险，按失败处理。");
  console.error(stderr.slice(-2000));
  process.exit(1);
}

if (selftest) {
  // 规模下界二次核对：外壳自己也算一遍，防止 spec 里那个数字被误改。
  const routes = Number((summary.match(/routes=(\d+)/) || [])[1] || 0);
  const controllers = Number((summary.match(/controllers=(\d+)/) || [])[1] || 0);
  if (!(routes >= 220) || !(controllers >= 30)) {
    console.error("✖ 自检失败：规模下界不达标 routes=" + routes + " controllers=" + controllers);
    process.exit(1);
  }
  console.log("✔ 自检通过：判据被真实执行，矩阵规模 " + routes + " 路由 / " + controllers + " 控制器");
  console.log("  " + summary);
  process.exit(0);
}

console.log("✔ 全路由鉴权矩阵绿：" + summary);
