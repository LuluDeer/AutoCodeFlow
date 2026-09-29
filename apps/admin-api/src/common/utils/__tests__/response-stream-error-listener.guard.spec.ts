/**
 * P1-2（ARCH-008）全仓守卫：fs.createReadStream 的 error 监听覆盖率。
 *
 * 背景：fs.ReadStream 的 open 是异步的——existsSync/statSync 判定之后、流
 * 真正 open 之前文件被删/改名，ENOENT 作为 'error' 事件发出；EventEmitter
 * 的 error 无监听 → uncaughtException（main.ts ARCH-008 处理器兜住后仍要
 * 整实例 graceful shutdown）。生产两个月内实爆两次。响应下载流的统一修法
 * 是 common/utils/response-stream.util.ts 的 createResponseReadStream
 * （error → warn + destroy，进程崩溃降级为单次下载失败）。
 *
 * 规则：扫描 apps/admin-api/src 下所有 *.ts（排除 __tests__ 目录），凡出现
 * `createReadStream(` 调用点的文件必须满足其一：
 *   1) 使用了 createResponseReadStream 封装；
 *   2) 文件内自带 `.on("error"` / `.once("error"` 监听（含单引号形态）；
 *   3) 在本文件 ALLOWLIST 显式豁免（逐条注释理由）。
 *
 * 反证：把任意一处监听/封装拆掉（如 artifacts.service.ts hashFile 的
 * `.on("error", reject)`），本测试立即变红。
 *
 * 先例：src/common/dto/__tests__/pagination-layering.api07.spec.ts 源码扫描。
 * 注：本仓 admin-api 跑 Jest，expect 只接受单参数，断言消息一律走注释。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// __dirname = apps/admin-api/src/common/utils/__tests__ → 上溯 3 级 = src 根
const SRC_ROOT = join(__dirname, "..", "..", "..");
const GUARD_REL_PATH = "common/utils/__tests__/response-stream-error-listener.guard.spec.ts";

/** 显式豁免名单（相对 src 根的 POSIX 风格路径），逐条注释理由。 */
const ALLOWLIST = new Set<string>([
  // application.controller.ts —— 唯一豁免：clamd 扫描源流（非响应下载流）。
  // 流被传入 scanStreamWithClamd（common/utils/clamd-scan.util.ts），消费侧
  // 在使用前对 input 挂 once("error")（该文件 :172 no-op 兜底 / :208 记录
  // 降级 verdict）——ARCH-008 修复（2026-09-29 prod ENOENT 事故）已在消费
  // 侧闭环，等价于规则 2，只是监听物理上写在消费方文件里。若未来改为把
  // 该流直接回给客户端（StreamableFile），必须改走 createResponseReadStream
  // 并从本名单移除。
  "modules/application/application.controller.ts",
]);

/**
 * 规则 1 对封装本体不可自证：response-stream.util.ts 里出现
 * createResponseReadStream 只是因为它自己就是定义处，不能据此记为"使用了
 * 封装"——封装本体只认规则 2（文件内真实的 .on("error") 监听）。
 */
const RULE1_NON_CREDITABLE = new Set<string>([
  "common/utils/response-stream.util.ts",
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === "__tests__") continue; // 测试与守卫自身不在扫描面
      walk(full, out);
    } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

const RAW_CALL_RE = /\bcreateReadStream\s*\(/;
const ON_ERROR_RE = /\.(on|once)\(\s*["']error["']/;

describe("P1-2 全仓守卫：createReadStream 必须自带 error 监听 / 走封装 / 显式豁免", () => {
  const allFiles = walk(SRC_ROOT)
    .map((f) => f.slice(SRC_ROOT.length + 1).replace(/\\/g, "/"))
    .sort();

  it("扫描面自检：src 树与已知调用点文件都被读到（防守卫退化成空扫描）", () => {
    expect(allFiles.length).toBeGreaterThan(100);
    expect(allFiles).toContain("modules/artifacts/artifacts.service.ts");
    expect(allFiles).toContain(
      "modules/executor-package/executor-package.service.ts",
    );
    expect(allFiles).toContain("modules/sop/sop-media.service.ts");
    expect(allFiles).not.toContain(GUARD_REL_PATH);
  });

  it("每个 createReadStream 调用点满足 封装 / error 监听 / allowlist 三选一", () => {
    const violations: string[] = [];
    const sites: string[] = [];

    for (const rel of allFiles) {
      const src = readFileSync(join(SRC_ROOT, rel), "utf-8");
      if (!RAW_CALL_RE.test(src)) continue;
      sites.push(rel);

      // 规则 1 必须是真实调用（createResponseReadStream( ）——裸 import 语句
      // 不算数（否则"留着 import、改回裸调用"能静默骗过本守卫）。
      const usesWrapper =
        /\bcreateResponseReadStream\s*\(/.test(src) &&
        !RULE1_NON_CREDITABLE.has(rel);
      const hasOwnListener = ON_ERROR_RE.test(src);
      if (!usesWrapper && !hasOwnListener && !ALLOWLIST.has(rel)) {
        violations.push(
          `${rel}: 裸 fs.createReadStream 无 error 监听 —— 改用 ` +
            `createResponseReadStream（common/utils/response-stream.util.ts）、` +
            `自带 .on("error") 监听、或在本守卫 ALLOWLIST 注明豁免理由`,
        );
      }
    }

    // 已知 6 个调用点（4 个文件）必须都在扫描面内——防止正则/路径改动静默失效
    expect(sites.length).toBeGreaterThanOrEqual(4);
    expect(violations).toEqual([]);
  });

  it("封装本体自身必须保留真实 error 监听（规则 1 对其不可自证）", () => {
    const src = readFileSync(
      join(SRC_ROOT, "common/utils/response-stream.util.ts"),
      "utf-8",
    );
    expect(ON_ERROR_RE.test(src)).toBe(true);
  });
});
