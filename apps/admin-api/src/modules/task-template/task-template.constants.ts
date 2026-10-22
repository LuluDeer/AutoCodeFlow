/**
 * CORE-03：官方预置任务模板。
 *
 * 五个 key（scheduled_backup/health_check/data_sync/log_cleanup/webhook_ping）
 * 与定位保持历史口径；config 字段名/默认值以 CreateTaskDto 白名单为准（落库前经
 * `assertValidTaskTemplateConfig` 校验），此处省略 `name`（实例化任务时提供）。
 *
 * ## 「开箱即跑」：config 自带 glueSource
 *
 * 历史 config 只预填 trigger/runtime/entrypoint，而 entrypoint 指向的
 * backup.sh/check.sh/sync.py/cleanup.sh/ping.js 在执行器工作目录里**并不存在**，
 * 于是「从模板创建」得到的任务必然以「找不到脚本」失败。现在改为内联脚本：
 * `glueSource` + `glueLanguage`，执行器会把它写进工作目录并直接跑起来，零外部文件。
 *
 * 内联脚本的四条硬约束（改脚本时必须保持）：
 * 1. **零第三方依赖**：只用语言内置模块（Node 的 fs/os/path、Python 的 json/os）；
 * 2. **跨平台**：只用 path/os.tmpdir 等平台无关 API，不写死 / 或 C:\；
 * 3. **确定性**：不依赖随机数、当前时间做数据内容（最多把时间写进日志/元信息）；
 * 4. **默认安全**：备份/清理类只读或只动 os.tmpdir 下的演示目录，清理默认 dry-run。
 *
 * ## 执行器的注入契约（写脚本时别踩）
 *
 * - Node glue 是**普通 CommonJS 脚本**（`node glue_script.js`），执行器**不注入**
 *   全局 `ctx`/SDK 上下文；只能用 console.log、process.env、require。
 *   CJS 下顶层 `return` 合法，但没有顶层 `await`——异步逻辑用 IIFE + `.catch`。
 * - Python glue 用 `print` / `os.environ`，不依赖任何 SDK。
 * - 参数两条通道：`AUTOFLOW_PARAMS_JSON`（整个 params 的 JSON，保留类型）与
 *   `AUTOFLOW_<KEY>`（键名大写；字符串为裸值、其它类型为 JSON）。
 *   官方脚本以 JSON 通道为准（能区分 `false` 与 `"false"` 的意图，见 log_cleanup）。
 * - 失败必须抛错/非零退出（Node 侧 `throw new Error` + `process.exitCode = 1`），
 *   绝不「打印错误但退出 0」——那会把故障伪装成成功。
 *
 * 本常量是**运行时**的单一事实源。迁移 1789800000000 是冻结快照（首次 seed 的
 * 旧 config），可运行化由后续迁移 1790000000060 幂等覆盖；parity spec 允许后续
 * 迁移覆盖 config，并断言本文件的 config 出现在该迁移的 up SQL 里。
 *
 * MCP 侧（packages/mcp-server/src/tools.ts 的 create_task_from_template）已改为
 * 经 `GET /task-templates` 解析、`POST /task-templates/:id/instantiate` 创建，
 * 不再持有本地副本——所以这里改 config 不会被第二份模板表拖漂。
 */

export interface OfficialTaskTemplateSeed {
  key: string;
  name: string;
  description: string;
  category: string;
  config: Record<string, unknown>;
}

/**
 * scheduled_backup：只读清单。扫描 params.dir 顶层文件（≤50），把 manifest 写进
 * AUTOFLOW_ARTIFACTS_DIR（未注入时写 os.tmpdir）。**不写、不删、不改 mtime**。
 */
const SCHEDULED_BACKUP_GLUE = String.raw`'use strict';
// AutoCodeFlow official template: scheduled_backup (read-only manifest).
const fs = require('fs');
const os = require('os');
const path = require('path');

function readParams() {
  const raw = process.env.AUTOFLOW_PARAMS_JSON;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (err) {
    console.error('[scheduled_backup] AUTOFLOW_PARAMS_JSON is not valid JSON: ' + err.message);
    return {};
  }
}

const params = readParams();
function paramValue(name) {
  if (Object.prototype.hasOwnProperty.call(params, name)) return params[name];
  // AUTOFLOW_<KEY> 通道（键名大写；字符串为裸值）。两条通道都支持，脚本在
  // 老执行器（只注入逐键通道）与新执行器（额外注入 JSON）上都能跑。
  return process.env['AUTOFLOW_' + name.toUpperCase()];
}

const dirParam = paramValue('dir');
const dirValue = typeof dirParam === 'string' ? dirParam.trim() : '';
const sourceDir = path.resolve(dirValue || process.cwd());
const artifactsDir = process.env.AUTOFLOW_ARTIFACTS_DIR || os.tmpdir();

let names;
try {
  names = fs.readdirSync(sourceDir);
} catch (err) {
  throw new Error('cannot read params.dir=' + sourceDir + ': ' + err.message);
}

const files = [];
for (const name of names.sort()) {
  if (files.length >= 50) break;
  const abs = path.join(sourceDir, name);
  let stat;
  try {
    stat = fs.lstatSync(abs);
  } catch (err) {
    continue;
  }
  // lstat + isFile：跳过目录与符号链接（不跟随链接，避免读到源目录之外）。
  if (!stat.isFile()) continue;
  files.push({ name: name, size: stat.size });
}

const totalBytes = files.reduce(function (sum, file) { return sum + file.size; }, 0);
const manifest = {
  template: 'scheduled_backup',
  sourceDir: sourceDir,
  fileLimit: 50,
  fileCount: files.length,
  totalBytes: totalBytes,
  files: files,
};

fs.mkdirSync(artifactsDir, { recursive: true });
const manifestPath = path.join(artifactsDir, 'backup-manifest.json');
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

console.log('[scheduled_backup] sourceDir=' + sourceDir);
console.log('[scheduled_backup] files=' + files.length + ' totalBytes=' + totalBytes);
console.log('[scheduled_backup] manifest=' + manifestPath);
console.log('[scheduled_backup] read-only: source files were not modified');`;

/**
 * health_check：GET params.url（默认 https://example.com），5s AbortController 超时，
 * 打印状态码与耗时；非 2xx / 网络错误 / 超时一律抛错（执行如实失败）。
 */
const HEALTH_CHECK_GLUE = String.raw`'use strict';
// AutoCodeFlow official template: health_check.
const TIMEOUT_MS = 5000;

function readParams() {
  const raw = process.env.AUTOFLOW_PARAMS_JSON;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (err) {
    console.error('[health_check] AUTOFLOW_PARAMS_JSON is not valid JSON: ' + err.message);
    return {};
  }
}

const params = readParams();
function paramValue(name) {
  if (Object.prototype.hasOwnProperty.call(params, name)) return params[name];
  // AUTOFLOW_<KEY> 通道（键名大写；字符串为裸值）。两条通道都支持，脚本在
  // 老执行器（只注入逐键通道）与新执行器（额外注入 JSON）上都能跑。
  return process.env['AUTOFLOW_' + name.toUpperCase()];
}

const urlParam = paramValue('url');
const urlValue = typeof urlParam === 'string' ? urlParam.trim() : '';
const targetUrl = urlValue || 'https://example.com';

async function main() {
  if (typeof fetch !== 'function') {
    throw new Error('global fetch is unavailable; Node.js 18+ is required for health_check');
  }
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    const response = await fetch(targetUrl, { method: 'GET', signal: controller.signal });
    const elapsedMs = Date.now() - startedAt;
    console.log('[health_check] url=' + targetUrl);
    console.log('[health_check] status=' + response.status + ' elapsedMs=' + elapsedMs);
    if (!response.ok) {
      throw new Error('unhealthy status ' + response.status + ' from ' + targetUrl);
    }
    console.log('[health_check] OK');
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw new Error('request to ' + targetUrl + ' timed out after ' + TIMEOUT_MS + 'ms');
    }
    throw err instanceof Error ? err : new Error(String(err));
  } finally {
    clearTimeout(timer);
  }
}

main().catch(function (err) {
  console.error('[health_check] failed: ' + (err && err.message ? err.message : String(err)));
  process.exitCode = 1;
  throw err;
});`;

/**
 * data_sync：Python 生成确定性示例行（默认 10 行，params.rows 可调），打印行数与
 * JSON 摘要后正常退出。零第三方依赖、无网络。
 */
const DATA_SYNC_GLUE = String.raw`# AutoCodeFlow official template: data_sync.
# Emits deterministic sample rows; no third-party dependency, no network access.
import json
import os


def read_params():
    raw = os.environ.get("AUTOFLOW_PARAMS_JSON")
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
    except ValueError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def as_positive_int(value, fallback):
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return fallback
    return parsed if parsed > 0 else fallback


def param_value(values, name):
    if name in values:
        return values[name]
    # AUTOFLOW_<KEY> 通道（键名大写）；与 JSON 通道并存。
    return os.environ.get("AUTOFLOW_" + name.upper())


params = read_params()
row_count = min(as_positive_int(param_value(params, "rows"), 10), 1000)

rows = []
for index in range(1, row_count + 1):
    rows.append({
        "id": index,
        "key": "user-" + str(index).zfill(2),
        "value": index * 10,
        "status": "ok" if index % 2 == 1 else "skipped",
    })

status_counts = {"ok": 0, "skipped": 0}
for row in rows:
    status_counts[row["status"]] += 1

summary = {
    "rows": len(rows),
    "firstId": rows[0]["id"] if rows else None,
    "lastId": rows[-1]["id"] if rows else None,
    "totalValue": sum(row["value"] for row in rows),
    "statusCounts": status_counts,
}

print("[data_sync] rows=" + str(len(rows)))
print("[data_sync] summary=" + json.dumps(summary, sort_keys=True, ensure_ascii=False))
if rows:
    print("[data_sync] sample=" + json.dumps(rows[0], sort_keys=True, ensure_ascii=False))`;

/**
 * log_cleanup：默认只操作 os.tmpdir()/acf-demo-logs 演示目录（不存在则建目录 +
 * 2 个 30 天前的示例文件）。默认 dry-run 只列不删；仅 params.dryRun=false 且目标
 * 确实位于演示目录内时删除。拒绝 /、home、cwd 这几类高危根目录。
 */
const LOG_CLEANUP_GLUE = String.raw`'use strict';
// AutoCodeFlow official template: log_cleanup (dry-run by default; demo dir only).
const fs = require('fs');
const os = require('os');
const path = require('path');
const DAY_MS = 24 * 60 * 60 * 1000;

function readParams() {
  const raw = process.env.AUTOFLOW_PARAMS_JSON;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (err) {
    console.error('[log_cleanup] AUTOFLOW_PARAMS_JSON is not valid JSON: ' + err.message);
    return {};
  }
}

function isInside(root, target) {
  return target === root || target.indexOf(root + path.sep) === 0;
}

function asAgeDays(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

const params = readParams();
function paramValue(name) {
  if (Object.prototype.hasOwnProperty.call(params, name)) return params[name];
  // AUTOFLOW_<KEY> 通道（键名大写；字符串为裸值）。两条通道都支持，脚本在
  // 老执行器（只注入逐键通道）与新执行器（额外注入 JSON）上都能跑。
  return process.env['AUTOFLOW_' + name.toUpperCase()];
}

const demoRoot = path.resolve(os.tmpdir(), 'acf-demo-logs');
const dirParam = paramValue('dir');
const dirValue = typeof dirParam === 'string' ? dirParam.trim() : '';
const targetDir = path.resolve(dirValue || demoRoot);
const maxAgeDays = asAgeDays(paramValue('maxAgeDays'), 7);
// 默认 dry-run。显式 false（布尔，或经 env/UI 传递时的字符串 "false"）才删除。
const dryRunParam = paramValue('dryRun');
const deleteEnabled = dryRunParam === false || dryRunParam === 'false';

// 高危根目录直接拒绝：宁可任务失败，也不在 /、home、cwd 上做任何扫描/删除。
const protectedDirs = [
  path.parse(targetDir).root,
  path.resolve(os.homedir()),
  path.resolve(process.cwd()),
];
if (protectedDirs.indexOf(targetDir) !== -1) {
  throw new Error('refusing to operate on a protected directory: ' + targetDir);
}

function seedDemoFiles() {
  fs.mkdirSync(demoRoot, { recursive: true });
  const seeds = ['demo-app.log', 'demo-worker.log'];
  for (let i = 0; i < seeds.length; i += 1) {
    const file = path.join(demoRoot, seeds[i]);
    if (fs.existsSync(file)) continue;
    fs.writeFileSync(file, 'AutoCodeFlow demo log line ' + (i + 1) + '\n', 'utf8');
    // 回拨 mtime 到 30 天前，让默认 7 天阈值下有「过期文件」可列（内容仍确定）。
    const old = new Date(Date.now() - 30 * DAY_MS);
    fs.utimesSync(file, old, old);
  }
}

if (targetDir === demoRoot) {
  seedDemoFiles();
} else if (!fs.existsSync(targetDir)) {
  if (!isInside(demoRoot, targetDir)) {
    throw new Error('params.dir does not exist and is outside the demo directory: ' + targetDir);
  }
  fs.mkdirSync(targetDir, { recursive: true });
}

// 目录级软链防护：params.dir 若是指向演示目录之外的符号链接，词法前缀检查会
// 被骗过（lstat 只能挡文件级软链）。realpath 后再判定，删除分支据此整体拒绝。
let deleteRoot = demoRoot;
let deleteTarget = targetDir;
try {
  deleteRoot = fs.realpathSync(demoRoot);
  deleteTarget = fs.realpathSync(targetDir);
} catch (err) {
  // 演示目录尚未建立等：保留词法路径，删除仍受下面的前缀检查约束。
  deleteRoot = demoRoot;
  deleteTarget = targetDir;
}

let entries;
try {
  entries = fs.readdirSync(targetDir);
} catch (err) {
  throw new Error('cannot read params.dir=' + targetDir + ': ' + err.message);
}

const cutoff = Date.now() - maxAgeDays * DAY_MS;
const expired = [];
for (const name of entries.sort()) {
  if (expired.length >= 100) break;
  const abs = path.resolve(targetDir, name);
  let stat;
  try {
    stat = fs.lstatSync(abs);
  } catch (err) {
    continue;
  }
  // 跳过目录与符号链接：链接可能指向演示目录之外，绝不跟随。
  if (!stat.isFile()) continue;
  if (stat.mtimeMs >= cutoff) continue;
  expired.push({ name: name, path: abs, size: stat.size, mtime: new Date(stat.mtimeMs).toISOString() });
}

console.log('[log_cleanup] targetDir=' + targetDir);
console.log('[log_cleanup] maxAgeDays=' + maxAgeDays + ' expired=' + expired.length + ' dryRun=' + !deleteEnabled);
for (const item of expired) {
  console.log('[log_cleanup] expired ' + item.name + ' size=' + item.size + ' mtime=' + item.mtime);
}

if (!deleteEnabled) {
  console.log('[log_cleanup] dry-run: no file was deleted (set params.dryRun=false to delete)');
} else if (!isInside(deleteRoot, deleteTarget)) {
  console.log('[log_cleanup] delete skipped: targetDir resolves outside the demo directory ' + demoRoot);
} else {
  let deleted = 0;
  for (const item of expired) {
    const abs = path.resolve(targetDir, item.name);
    // 双保险：目标必须在（realpath 后的）演示目录内，且是 targetDir 的直接子文件。
    if (!isInside(deleteRoot, abs) || path.dirname(abs) !== targetDir) {
      console.log('[log_cleanup] refused to delete outside ' + demoRoot + ': ' + abs);
      continue;
    }
    fs.unlinkSync(abs);
    deleted += 1;
  }
  console.log('[log_cleanup] deleted=' + deleted);
}`;

/**
 * webhook_ping：有 params.url 就 POST 一份固定 JSON（5s 超时，打印状态码）；
 * 没有就只打印 payload 并成功退出（手动触发的冒烟/串联占位任务）。
 */
const WEBHOOK_PING_GLUE = String.raw`'use strict';
// AutoCodeFlow official template: webhook_ping.
const TIMEOUT_MS = 5000;
const PAYLOAD = { event: 'webhook_ping', source: 'AutoCodeFlow', message: 'ping' };

function readParams() {
  const raw = process.env.AUTOFLOW_PARAMS_JSON;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (err) {
    console.error('[webhook_ping] AUTOFLOW_PARAMS_JSON is not valid JSON: ' + err.message);
    return {};
  }
}

const params = readParams();
function paramValue(name) {
  if (Object.prototype.hasOwnProperty.call(params, name)) return params[name];
  // AUTOFLOW_<KEY> 通道（键名大写；字符串为裸值）。两条通道都支持，脚本在
  // 老执行器（只注入逐键通道）与新执行器（额外注入 JSON）上都能跑。
  return process.env['AUTOFLOW_' + name.toUpperCase()];
}

const urlParam = paramValue('url');
const urlValue = typeof urlParam === 'string' ? urlParam.trim() : '';

async function main() {
  if (!urlValue) {
    console.log('[webhook_ping] params.url is not set - nothing to send');
    console.log('[webhook_ping] payload=' + JSON.stringify(PAYLOAD));
    console.log('[webhook_ping] OK (payload preview only)');
    return;
  }
  if (!/^https?:\/\//i.test(urlValue)) {
    throw new Error('params.url must start with http:// or https:// (got ' + urlValue + ')');
  }
  if (typeof fetch !== 'function') {
    throw new Error('global fetch is unavailable; Node.js 18+ is required for webhook_ping');
  }
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    const response = await fetch(urlValue, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(PAYLOAD),
      signal: controller.signal,
    });
    const elapsedMs = Date.now() - startedAt;
    console.log('[webhook_ping] url=' + urlValue);
    console.log('[webhook_ping] status=' + response.status + ' elapsedMs=' + elapsedMs);
    if (!response.ok) {
      throw new Error('webhook endpoint returned status ' + response.status);
    }
    console.log('[webhook_ping] OK');
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw new Error('request to ' + urlValue + ' timed out after ' + TIMEOUT_MS + 'ms');
    }
    throw err instanceof Error ? err : new Error(String(err));
  } finally {
    clearTimeout(timer);
  }
}

main().catch(function (err) {
  console.error('[webhook_ping] failed: ' + (err && err.message ? err.message : String(err)));
  process.exitCode = 1;
  throw err;
});`;

export const OFFICIAL_TASK_TEMPLATES: OfficialTaskTemplateSeed[] = [
  {
    key: "scheduled_backup",
    name: "定时备份",
    description:
      "开箱即跑：Node 脚本扫描 params.dir（默认当前工作目录）顶层文件（最多 50 个），把 manifest JSON 写入 AUTOFLOW_ARTIFACTS_DIR（未注入时写系统临时目录），并打印文件数与总大小；只读源文件、绝不修改。可改参数：params.dir。",
    category: "备份",
    config: {
      triggerType: "cron",
      cronExpression: "0 2 * * *",
      runtime: "node",
      glueLanguage: "javascript",
      glueSource: SCHEDULED_BACKUP_GLUE,
      timeoutSeconds: 3600,
      maxRetry: 3,
      retryDelay: 60,
      blockStrategy: "discard",
    },
  },
  {
    key: "health_check",
    name: "健康巡检",
    description:
      "开箱即跑：Node 脚本 GET params.url（默认 https://example.com），5 秒超时，打印 HTTP 状态码与耗时；网络失败或非 2xx 会抛错让执行如实失败。可改参数：params.url。",
    category: "巡检",
    config: {
      triggerType: "fixed_rate",
      fixedRate: 60,
      runtime: "node",
      glueLanguage: "javascript",
      glueSource: HEALTH_CHECK_GLUE,
      timeoutSeconds: 30,
      maxRetry: 0,
    },
  },
  {
    key: "data_sync",
    name: "数据同步",
    description:
      "开箱即跑：Python 脚本生成 10 行确定性示例数据（可用 params.rows 调整，默认 10、上限 1000），打印行数与 JSON 摘要后正常退出，无第三方依赖。可改参数：params.rows。",
    category: "同步",
    config: {
      triggerType: "fixed_rate",
      fixedRate: 1800,
      runtime: "python",
      glueLanguage: "python",
      glueSource: DATA_SYNC_GLUE,
      timeoutSeconds: 7200,
      maxRetry: 2,
      retryDelay: 300,
      blockStrategy: "discard",
    },
  },
  {
    key: "log_cleanup",
    name: "日志清理",
    description:
      "开箱即跑：Node 脚本默认清理 os.tmpdir()/acf-demo-logs 演示目录（不存在则创建并放入 2 个示例文件），按 params.maxAgeDays（默认 7）列出过期文件；默认 dry-run 只列不删，只有 params.dryRun=false 且在演示目录内才真正删除。可改参数：params.dir、params.maxAgeDays、params.dryRun。",
    category: "清理",
    config: {
      triggerType: "cron",
      cronExpression: "30 3 * * *",
      runtime: "node",
      glueLanguage: "javascript",
      glueSource: LOG_CLEANUP_GLUE,
      timeoutSeconds: 600,
      maxRetry: 1,
    },
  },
  {
    key: "webhook_ping",
    name: "Webhook 通知",
    description:
      "开箱即跑：Node 脚本在 params.url 存在时 POST 一份 JSON（5 秒超时）并打印状态码；未配置时只打印 payload 并成功退出，可作为手动触发的冒烟任务。可改参数：params.url。",
    category: "通知",
    config: {
      triggerType: "manual",
      runtime: "node",
      glueLanguage: "javascript",
      glueSource: WEBHOOK_PING_GLUE,
      timeoutSeconds: 60,
      maxRetry: 1,
    },
  },
];

/** 官方模板 key 集合（列表排序 / 删除保护判定用）。 */
export const OFFICIAL_TEMPLATE_KEYS = OFFICIAL_TASK_TEMPLATES.map((t) => t.key);

/**
 * 派生迁移内幂等 seed 的 INSERT 语句（`ON CONFLICT (key) DO NOTHING`）。
 * 对 JSON 与字符串做单引号转义——官方模板数据虽为常量，转义保证 SQL 结构安全
 * 且可读回；`isOfficial` 恒 true。config 以参数化 jsonb 文本插入。
 *
 * 注意：首次 seed 已由冻结迁移 1789800000000 完成；本函数只描述「当前常量的
 * 形状」，新环境的最终形态由后续迁移 1790000000060 覆盖。生产路径不再调用它。
 */
export function officialSeedSql(): string {
  const esc = (s: string) => s.replace(/'/g, "''");
  const values = OFFICIAL_TASK_TEMPLATES.map((t) => {
    const configJson = esc(JSON.stringify(t.config));
    return `('${esc(t.key)}', '${esc(t.name)}', '${esc(t.description)}', '${esc(
      t.category,
    )}', '${configJson}'::jsonb, true)`;
  }).join(",\n        ");
  return `
      INSERT INTO "task_templates" ("key", "name", "description", "category", "config", "isOfficial")
      VALUES
        ${values}
      ON CONFLICT ("key") DO NOTHING
  `;
}
