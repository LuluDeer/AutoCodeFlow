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
