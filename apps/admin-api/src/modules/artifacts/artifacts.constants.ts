import * as path from "path";
import { getEnvVar } from "../../config/env";

/**
 * FEAT-05：执行产物（artifacts）在 admin 侧的落盘根目录（惰性求值，便于测试注入）。
 *
 * 与包上传统一放在 `<cwd>/uploads` 卷下（见 executor-package.service.ts 的
 * `path.join(process.cwd(), "uploads", "executor-packages")`），产物按执行 ID
 * 分子目录：`<root>/<execId>/<name>`。该布局既服务鉴权下载端点，也供每日 TTL
 * 清理按目录回收。
 *
 * 计划书把该目录概念化为 "LOG_ARTIFACT_DIR"：优先读环境变量 LOG_ARTIFACT_DIR，
 * 缺省回退到 uploads/artifacts（与包上传同卷、少一处必配项）。测试可临时改写
 * LOG_ARTIFACT_DIR 指向 OS 临时目录，避免污染仓库。
 */
export function getArtifactRootDir(): string {
  // ARCH-27 豁免位：模块求值期读取（ConfigService 尚未就绪），经
  // src/config/env.ts 的 getEnvVar() 集中放行（W-22 教训）。
  const override = getEnvVar("LOG_ARTIFACT_DIR");
  if (override && override.trim()) return override.trim();
  return path.join(process.cwd(), "uploads", "artifacts");
}

/** 单执行最多收集的产物数（与回调 DTO @ArrayMaxSize、执行器侧上限对齐）。 */
export const MAX_ARTIFACT_COUNT = 20;

/** 单产物最大字节数：100 MB。超限的产物在执行器侧跳过（仅记日志），admin 侧 PUT 亦拒绝。 */
export const MAX_ARTIFACT_SIZE_BYTES = 100 * 1024 * 1024;

/** 产物裸文件名字符集：以字母/数字开头，仅含 [A-Za-z0-9._-]，杜绝路径分隔符与 `..`。 */
export const SAFE_ARTIFACT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;

/**
 * R31（本轮审计）：产物路径的**纵深防御判定**——纯函数，便于直接钉住。
 *
 * 为什么单独抽出来：原实现在 `resolveArtifactPath` 里写成
 * `if (full !== path.join(base, name) || !full.startsWith(base + path.sep))`，
 * 其中**第一个合取项恒为假**（`full` 就是 `path.join(base, name)`，纯函数、
 * 同一个表达式），是典型的「看起来很严、其实永远不触发」的死守卫：注释宣称
 * 「基名与拼接双保险」，实际只有 startsWith 在起作用。一旦将来有人放宽
 * `SAFE_ARTIFACT_NAME_RE`（例如允许子目录分组），这层纸会直接消失而无人察觉。
 *
 * 判据（三条，前两条是原先缺失的那层）：
 *   ① 必须是**裸文件名**（不含分隔符；`basename(name) === name`）；
 *   ② 拼接后的**父目录必须正好是** base —— 保证文件直接落在 `<root>/<execId>/`
 *      下，不允许出现子路径，也不允许 `.` / `..` 这类把落点挪走的写法；
 *   ③ 拼接结果仍在 base 之下（前缀 + 分隔符，防 `/root/abc` 被 `/root/abcdef`
 *      前缀误判）。
 */
export function isArtifactPathWithin(baseDir: string, name: string): boolean {
  if (!name || path.basename(name) !== name) return false;
  const full = path.join(baseDir, name);
  if (path.dirname(full) !== baseDir) return false;
  const prefix = baseDir.endsWith(path.sep) ? baseDir : baseDir + path.sep;
  return full.startsWith(prefix);
}
