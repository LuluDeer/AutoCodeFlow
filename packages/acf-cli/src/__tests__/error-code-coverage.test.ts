/**
 * R108：**错误码 → CLI 处置类别 的覆盖率**（未归类即静默无建议）。
 *
 * 背景：admin-api 的错误码目录（`src/common/errors/catalog/*.ts`）已有 **383** 个码；CLI 侧
 * `error-code.ts` 刻意**不逐码写建议**（注释原话：「三百多个码逐条写建议必然腐化」），而是用 6 类
 * 前缀/后缀规则归类，未归类就**不追加**任何提示。
 *
 * 于是一类静默缺口：**新码撞不上任何规则时，用户永远拿不到处置建议**，而且没有任何东西会提醒 ——
 * 它只是安静地退化成原始文案。实测当前 69/383（18%）在这个状态。
 *
 * ## 为什么是一个 vitest 用例而不是 scripts/ 下的守卫脚本
 *
 * 判据必须用**真实的** `classifyErrorCode`（唯一真值源）。先从脚本里「用正则去解析 TS 里的
 * 正则字面量」试过两轮：多行元组格式、转义字符、块内 `];` 边界，每轮都换一种失败方式。
 * 而 vitest 直接 `import { classifyErrorCode }` —— **不做解析，就没有解析器失效**。
 * （同类教训本仓已有两条：openapi 路由覆盖守卫、死导出扫描，都是「静态看代码」不如「执行」）
 *
 * ## 判据
 *
 *  ① 目录里每个码都必须能归类，**或**出现在 `UNCLASSIFIED_BASELINE`（带理由）；
 *  ② 基线里若某码现在**能**归类了 ⇒ 也红（说明基线该瘦身，否则它会一直躺在豁免名单里）。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyErrorCode } from '../error-code.js';

const CATALOG_DIR = join(__dirname, '..', '..', '..', '..', 'apps', 'admin-api', 'src', 'common', 'errors', 'catalog');

/**
 * 当前**无法归入 6 类**的码。这些不是「忘了归类」，而是「归进去会给出误导性建议」——
 * 例如 `TASK_SECRET_DECRYPT_FAILED` 给「修正入参」是错的（它是部署期密钥问题），给「稍后重试」也不对。
 * **加码时可以进来，但必须显式写理由**；反之若某码已能归类，请把它从这里删掉。
 */
const UNCLASSIFIED_BASELINE = new Set<string>([
  // —— 运维/配置类：处置是「补配置或看日志」，6 类里没有这一类 ——
  'APP_UPLOAD_BASE_URL_NOT_CONFIGURED',
  'APP_UPLOAD_SCANNER_UNAVAILABLE',
  'EVENT_OUTBOUND_SUBSCRIPTIONS_LOAD_FAILED',
  'EXECUTOR_CONFIG_PUSH_REJECTED',
  'EXECUTOR_CONFIG_PUSH_REJECTED_FIRST',
  'EXECUTOR_CONFIG_PUSH_UNREACHABLE',
  'EXECUTOR_HOST_DNS_LOOKUP_FAILED',
  'EXECUTOR_HOST_UNRESOLVABLE',
  'EXECUTOR_INSTALL_CMD_NOT_CONFIGURED',
  'EXECUTOR_PACKAGE_PUSH_NO_TARGETS',
  'EXECUTOR_PACKAGE_PUSH_URL_NOT_CONFIGURED',
  'EXECUTOR_PACKAGE_SCANNER_UNAVAILABLE',
  'EXECUTOR_PACKAGE_VIRUS_DETECTED',
  'EXECUTOR_PACKAGE_ZIP_GUARD_REJECTED',
  'EXECUTOR_PULL_UNAVAILABLE',
  'EXECUTOR_URL_PROTOCOL_NOT_HTTP',
  'GIT_REPO_HOST_DNS_LOOKUP_FAILED',
  'GIT_REPO_HOST_UNRESOLVABLE',
  'INTERNAL_ERROR',
  'METRICS_ENDPOINT_DISABLED',
  'NOTIFICATION_ALERT_NOT_DELIVERED',
  'NOTIFICATION_ALERT_PAYLOAD_UNMAPPED',
  'NOTIFICATION_ALERT_WEBHOOK_NOT_CONFIGURED',
  'NOTIFICATION_CHANNEL_UNKNOWN',
  'PACKAGE_URL_NOT_CONFIGURED',
  'PACKAGE_URL_REPO_UNAVAILABLE',
  'REGISTRY_CONNECTION_CLOSED',
  'REGISTRY_UPSTREAM_FAILED',
  'REGISTRY_UPLOAD_FAILED',
  'REGISTRY_UPLOAD_REDIRECTED',
  'TASK_ENQUEUE_FAILED',
  'TASK_SECRET_DECRYPT_FAILED',
  'APP_UPLOAD_MALWARE_DETECTED',
  'APP_UPLOAD_ZIP_GUARD_REJECTED',
  'AI_MEDIA_URL_SCHEME_NOT_ALLOWED',
  // 2026-10-26（P2-4，vitest 活红 409/410）补录两个新码——先读 admin catalog
  // 语义后按「归进 6 类会误导」裁定入基线，而非硬塞规则：
  //  · CORS_ORIGIN_NOT_ALLOWED（catalog/common.ts，403）：**配置面**的预期
  //    拒绝——catalog 原文「调用方该做的是把来源加进 CORS_ALLOWED_ORIGINS，
  //    而不是重试」；6 类任何一条（登录/角色/重试/改入参）都会把用户引向
  //    错误动作（同 `_NOT_ALLOWED` 语义先例 AI_MEDIA_URL_SCHEME_NOT_ALLOWED）。
  //  · EXECUTOR_PACKAGE_STORAGE_PATH_ESCAPED（catalog/executor.ts，400）：
  //    服务端存储包含性闸——filePath（PATCH 写面或 DB 历史脏行）resolve 后
  //    越出上传根，CLI 用户无可修入参；与 SOP_MEDIA_STORAGE_PATH_ESCAPED
  //    同语义先例（领域状态类）。
  'CORS_ORIGIN_NOT_ALLOWED',
  'EXECUTOR_PACKAGE_STORAGE_PATH_ESCAPED',
  // —— 领域状态类：语义介于 conflict / validation，现有 6 类都给不出准确建议 ——
  'APP_DEPLOYMENT_CANCEL_NOT_REQUESTER',
  'APP_ROLLBACK_DEPLOYMENT_NO_VERSION',
  'APP_ROLLBACK_DEPLOYMENT_OTHER_APP',
  'APP_ROLLBACK_VERSION_NO_NUMBER',
  'APP_ROLLBACK_VERSION_NOT_RELEASED',
  'APP_ROLLBACK_VERSION_OTHER_APP',
  'APP_ROLLOUT_VERSION_NOT_RELEASED',
  'ARTIFACT_COUNT_LIMIT_REACHED',
  'BROADCAST_DISPATCH_ALL_FAILED',
  'CONFIG_HISTORY_NO_ROLLBACK_VALUE',
  'CONFIG_HISTORY_SECRET_MASK_ROLLBACK',
  'EVENT_SUBSCRIPTION_EVENT_TYPE_UNKNOWN',
  'EVENT_SUBSCRIPTION_PRIVATE_NETWORK_REQUIRES_ADMIN',
  'GIT_REV_PARSE_FAILED',
  'MUTEX_GROUP_HAS_APPLICATIONS',
  'EXECUTOR_COMMAND_RESULT_NOT_OWNED',
  'SOP_ASSIGNMENT_NOT_OWNED_BY_EXECUTOR',
  'SOP_CLARIFICATION_NOT_IN_ASSIGNMENT',
  'SOP_CLARIFICATION_NOT_REPLIED',
  'SOP_MEDIA_REF_URL_NOT_PLATFORM',
  'SOP_MEDIA_STORAGE_PATH_ESCAPED',
  'SOP_NOT_PUBLISHED',
  'TASK_BLOCK_STRATEGY_REJECTED',
  'TASK_BROADCAST_MUTEX_INCOMPATIBLE',
  'TASK_CODE_SOURCE_ZIP_REQUIRES_APPLICATION',
  'TASK_EXECUTION_SCOPE_UNKNOWN',
  'TASK_EXPORT_SECRET_LEAK',
  'TASK_NAME_UNAVAILABLE',
  'TASK_OPERATE_SCOPE_OWNER',
  'TASK_PINNED_VERSION_GONE',
  'TASK_REQUIREMENT_OPTION_LIKE',
  'TASK_RUNTIME_VERSION_REQUIRES_PYTHON',
  // —— 2026-10-30（R108 覆盖闸补录，AI 视频转 SOP 域）────────────────────
  // 这 4 个码的共同点：**不是 CLI 用户能靠改入参/重登录/重试解决的**，塞进 6 类
  // 任何一条都会给出错误动作（与上面 CORS_ORIGIN_NOT_ALLOWED 的裁定同口径）。
  //  · AI_DRAFT_UNPARSABLE（502）：模型输出不是可解析草稿——下一步是「重试或
  //    换更强模型」，既非入参错（validation）也非服务容量（capacity）；
  //  · AI_MEDIA_PATH_ESCAPED（500）：平台内部的存储包含性闸拒绝——安全不变量，
  //    用户侧无可修项（同 EXECUTOR_PACKAGE_STORAGE_PATH_ESCAPED 先例）；
  //  · AI_VIDEO_MODEL_UNAVAILABLE（400）：需管理员在 AI 设置里接入「支持视频」
  //    的模型——配置面动作，不是调用方改参；
  //  · AI_VIDEO_LINK_UNAVAILABLE（503）：需管理员配置 AI_MEDIA_BASE_URL /
  //    AI_MEDIA_URL_SECRET——同上，属运维配置面。
  'AI_DRAFT_UNPARSABLE',
  'AI_MEDIA_PATH_ESCAPED',
  'AI_VIDEO_MODEL_UNAVAILABLE',
  'AI_VIDEO_LINK_UNAVAILABLE',
]);

function loadCatalogCodes(): string[] {
  const codes = new Set<string>();
  for (const f of readdirSync(CATALOG_DIR)) {
    if (!f.endsWith('.ts')) continue;
    const src = readFileSync(join(CATALOG_DIR, f), 'utf8');
    for (const m of src.matchAll(/^\s{2}([A-Z][A-Z0-9_]{2,}):\s*\{/gm)) codes.add(m[1]);
  }
  return [...codes].sort();
}

describe('R108 错误码覆盖：每个码都要能给用户一句处置建议', () => {
  const codes = loadCatalogCodes();

  it('目录里能扫出足够多的码（扫描器没失效）', () => {
    expect(codes.length).toBeGreaterThan(300);
  });

  it('无法归类的码必须逐一在基线里（新码未归类即红）', () => {
    const unclassified = codes.filter((c) => classifyErrorCode(c) === null);
    const newly = unclassified.filter((c) => !UNCLASSIFIED_BASELINE.has(c));
    expect(newly, `以下新码无法归入 CLI 的 6 类，用户拿不到处置建议：${newly.join(', ')}`).toEqual([]);
  });

  it('基线里的码若已能归类，必须从基线删除（防豁免名单腐烂）', () => {
    const stale = [...UNCLASSIFIED_BASELINE].filter((c) => codes.includes(c) && classifyErrorCode(c) !== null);
    expect(stale, `以下码已能归类，请从 UNCLASSIFIED_BASELINE 删除：${stale.join(', ')}`).toEqual([]);
  });

  it('基线里不应存在目录中已不存在的码', () => {
    const gone = [...UNCLASSIFIED_BASELINE].filter((c) => !codes.includes(c));
    expect(gone, `以下码已从目录移除，请从基线删除：${gone.join(', ')}`).toEqual([]);
  });
});
