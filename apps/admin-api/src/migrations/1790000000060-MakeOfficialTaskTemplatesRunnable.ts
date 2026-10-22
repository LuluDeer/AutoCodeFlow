import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * 让 5 个官方任务模板真正「开箱即跑」：把 config 里的 `entrypoint`（指向
 * backup.sh / check.sh / sync.py / cleanup.sh / ping.js——执行器工作目录里
 * **并不存在**这些文件）换成内联的 `glueSource` + `glueLanguage`。
 *
 * ## 为什么新增迁移而不是改 1789800000000-CreateTaskTemplates
 *
 * 已执行过的迁移是**冻结快照**：改历史迁移只会让「已升级的库」与「新装的库」
 * 分叉——老库不会重放，新库拿到新 snapshot，同一版本号对应两种 schema/data。
 * 因此初始 seed 保持原样（仍是旧 config），由本条 data-only 迁移按 key 幂等覆盖，
 * 两条路径殊途同归。
 *
 * ## 变更范围（刻意最小化）
 *
 * - 只 UPDATE `task_templates` 的 `config`（jsonb）与面向用户的 `description`；
 * - 只命中 `isOfficial = true` **且** key 在五元组内的行——用户自建模板即使
 *   key 撞名也不会被改写（官方 key 本就被 create 端点的唯一索引挡住，这里是
 *   第二道防线）；
 * - 不动 `key` / `name` / `category`（定位不变），也不动 `updatedAt`
 *   （数据校准不是用户编辑，与 1790000000059 的取舍一致）。
 *
 * ## 幂等与回滚
 *
 * 幂等：UPDATE 的 SET 是固定值、WHERE 由 key + isOfficial 命中，重放结果逐字节
 * 相同；空表只是 0 行受影响。本迁移是 data-only（无 DDL、无索引），因此没有
 * IF EXISTS / IF NOT EXISTS 可加——表的创建由前置迁移 1789800000000 负责。
 *
 * down：恢复 1789800000000 里逐字复制的旧 config 与旧 description（含
 * entrypoint），同样按 key + isOfficial 幂等回写。
 *
 * ## SQL 字符串口径
 *
 * config 用单引号字符串 + ::jsonb 写入，反斜杠按 PostgreSQL **标准字符串**处理
 * （standard_conforming_strings=on，9.1+ 默认）：JSON 里的换行转义序列（反斜杠
 * 加 n）原样交给 jsonb 解析器，不会被当成 SQL 转义。若库被显式设为 off，迁移会
 * 以 jsonb 解析失败**响亮回滚**（不会静默写坏），届时请先把该开关恢复默认。
 *
 * ## 脚本契约（改这些 SQL 里的脚本时必须保持）
 *
 * 零第三方依赖、跨平台、确定性、默认安全；Node 是普通 CommonJS 脚本（无全局
 * ctx、无顶层 await），参数走 `AUTOFLOW_PARAMS_JSON`；失败必须抛错/非零退出。
 * 运行时单一事实源见 task-template.constants.ts，两边由
 * task-template.migration.spec.ts 的 parity 断言钉住。
 */
export class MakeOfficialTaskTemplatesRunnable1790000000060 implements MigrationInterface {
  name = "MakeOfficialTaskTemplatesRunnable1790000000060";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 每行 = (key, config, description)。config 的 glueSource 是内联脚本全文，
    // JSON 里的单引号已按 SQL 规则转义为 ''。脚本本身不含模板插值写法。
    await queryRunner.query(String.raw`
      UPDATE "task_templates" AS t
      SET "config" = v."config",
          "description" = v."description"
      FROM (VALUES
        ('scheduled_backup',
         '{"triggerType":"cron","cronExpression":"0 2 * * *","runtime":"node","glueLanguage":"javascript","glueSource":"''use strict'';\n// AutoCodeFlow official template: scheduled_backup (read-only manifest).\nconst fs = require(''fs'');\nconst os = require(''os'');\nconst path = require(''path'');\n\nfunction readParams() {\n  const raw = process.env.AUTOFLOW_PARAMS_JSON;\n  if (!raw) return {};\n  try {\n    const parsed = JSON.parse(raw);\n    return parsed && typeof parsed === ''object'' && !Array.isArray(parsed) ? parsed : {};\n  } catch (err) {\n    console.error(''[scheduled_backup] AUTOFLOW_PARAMS_JSON is not valid JSON: '' + err.message);\n    return {};\n  }\n}\n\nconst params = readParams();\nfunction paramValue(name) {\n  if (Object.prototype.hasOwnProperty.call(params, name)) return params[name];\n  // AUTOFLOW_<KEY> 通道（键名大写；字符串为裸值）。两条通道都支持，脚本在\n  // 老执行器（只注入逐键通道）与新执行器（额外注入 JSON）上都能跑。\n  return process.env[''AUTOFLOW_'' + name.toUpperCase()];\n}\n\nconst dirParam = paramValue(''dir'');\nconst dirValue = typeof dirParam === ''string'' ? dirParam.trim() : '''';\nconst sourceDir = path.resolve(dirValue || process.cwd());\nconst artifactsDir = process.env.AUTOFLOW_ARTIFACTS_DIR || os.tmpdir();\n\nlet names;\ntry {\n  names = fs.readdirSync(sourceDir);\n} catch (err) {\n  throw new Error(''无法读取 params.dir='' + sourceDir + '': '' + err.message);\n}\n\nconst files = [];\nfor (const name of names.sort()) {\n  if (files.length >= 50) break;\n  const abs = path.join(sourceDir, name);\n  let stat;\n  try {\n    stat = fs.lstatSync(abs);\n  } catch (err) {\n    continue;\n  }\n  // lstat + isFile：跳过目录与符号链接（不跟随链接，避免读到源目录之外）。\n  if (!stat.isFile()) continue;\n  files.push({ name: name, size: stat.size });\n}\n\nconst totalBytes = files.reduce(function (sum, file) { return sum + file.size; }, 0);\nconst manifest = {\n  template: ''scheduled_backup'',\n  sourceDir: sourceDir,\n  fileLimit: 50,\n  fileCount: files.length,\n  totalBytes: totalBytes,\n  files: files,\n};\n\nfs.mkdirSync(artifactsDir, { recursive: true });\nconst manifestPath = path.join(artifactsDir, ''backup-manifest.json'');\nfs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + ''\\n'', ''utf8'');\n\nconsole.log(''[scheduled_backup] sourceDir='' + sourceDir);\nconsole.log(''[scheduled_backup] files='' + files.length + '' totalBytes='' + totalBytes);\nconsole.log(''[scheduled_backup] manifest='' + manifestPath);\nconsole.log(''[scheduled_backup] read-only: source files were not modified'');","timeoutSeconds":3600,"maxRetry":3,"retryDelay":60,"blockStrategy":"discard"}'::jsonb,
         '开箱即跑：Node 脚本扫描 params.dir（默认当前工作目录）顶层文件（最多 50 个），把 manifest JSON 写入 AUTOFLOW_ARTIFACTS_DIR（未注入时写系统临时目录），并打印文件数与总大小；只读源文件、绝不修改。可改参数：params.dir。'),
        ('health_check',
         '{"triggerType":"fixed_rate","fixedRate":60,"runtime":"node","glueLanguage":"javascript","glueSource":"''use strict'';\n// AutoCodeFlow official template: health_check.\nconst TIMEOUT_MS = 5000;\n\nfunction readParams() {\n  const raw = process.env.AUTOFLOW_PARAMS_JSON;\n  if (!raw) return {};\n  try {\n    const parsed = JSON.parse(raw);\n    return parsed && typeof parsed === ''object'' && !Array.isArray(parsed) ? parsed : {};\n  } catch (err) {\n    console.error(''[health_check] AUTOFLOW_PARAMS_JSON is not valid JSON: '' + err.message);\n    return {};\n  }\n}\n\nconst params = readParams();\nfunction paramValue(name) {\n  if (Object.prototype.hasOwnProperty.call(params, name)) return params[name];\n  // AUTOFLOW_<KEY> 通道（键名大写；字符串为裸值）。两条通道都支持，脚本在\n  // 老执行器（只注入逐键通道）与新执行器（额外注入 JSON）上都能跑。\n  return process.env[''AUTOFLOW_'' + name.toUpperCase()];\n}\n\nconst urlParam = paramValue(''url'');\nconst urlValue = typeof urlParam === ''string'' ? urlParam.trim() : '''';\nconst targetUrl = urlValue || ''https://example.com'';\n\nasync function main() {\n  if (typeof fetch !== ''function'') {\n    throw new Error(''全局 fetch 不可用；health_check 需要 Node.js 18+'');\n  }\n  const controller = new AbortController();\n  const timer = setTimeout(function () { controller.abort(); }, TIMEOUT_MS);\n  const startedAt = Date.now();\n  try {\n    const response = await fetch(targetUrl, { method: ''GET'', signal: controller.signal });\n    const elapsedMs = Date.now() - startedAt;\n    console.log(''[health_check] url='' + targetUrl);\n    console.log(''[health_check] status='' + response.status + '' elapsedMs='' + elapsedMs);\n    if (!response.ok) {\n      throw new Error(''健康检查异常状态 '' + response.status + '' from '' + targetUrl);\n    }\n    console.log(''[health_check] OK'');\n  } catch (err) {\n    if (err && err.name === ''AbortError'') {\n      throw new Error(''请求 '' + targetUrl + '' timed out after '' + TIMEOUT_MS + ''ms'');\n    }\n    throw err instanceof Error ? err : new Error(String(err));\n  } finally {\n    clearTimeout(timer);\n  }\n}\n\nmain().catch(function (err) {\n  console.error(''[health_check] failed: '' + (err && err.message ? err.message : String(err)));\n  process.exitCode = 1;\n  throw err;\n});","timeoutSeconds":30,"maxRetry":0}'::jsonb,
         '开箱即跑：Node 脚本 GET params.url（默认 https://example.com），5 秒超时，打印 HTTP 状态码与耗时；网络失败或非 2xx 会抛错让执行如实失败。可改参数：params.url。'),
        ('data_sync',
         '{"triggerType":"fixed_rate","fixedRate":1800,"runtime":"python","glueLanguage":"python","glueSource":"# AutoCodeFlow official template: data_sync.\n# Emits deterministic sample rows; no third-party dependency, no network access.\nimport json\nimport os\n\n\ndef read_params():\n    raw = os.environ.get(\"AUTOFLOW_PARAMS_JSON\")\n    if not raw:\n        return {}\n    try:\n        parsed = json.loads(raw)\n    except ValueError:\n        return {}\n    return parsed if isinstance(parsed, dict) else {}\n\n\ndef as_positive_int(value, fallback):\n    try:\n        parsed = int(value)\n    except (TypeError, ValueError):\n        return fallback\n    return parsed if parsed > 0 else fallback\n\n\ndef param_value(values, name):\n    if name in values:\n        return values[name]\n    # AUTOFLOW_<KEY> 通道（键名大写）；与 JSON 通道并存。\n    return os.environ.get(\"AUTOFLOW_\" + name.upper())\n\n\nparams = read_params()\nrow_count = min(as_positive_int(param_value(params, \"rows\"), 10), 1000)\n\nrows = []\nfor index in range(1, row_count + 1):\n    rows.append({\n        \"id\": index,\n        \"key\": \"user-\" + str(index).zfill(2),\n        \"value\": index * 10,\n        \"status\": \"ok\" if index % 2 == 1 else \"skipped\",\n    })\n\nstatus_counts = {\"ok\": 0, \"skipped\": 0}\nfor row in rows:\n    status_counts[row[\"status\"]] += 1\n\nsummary = {\n    \"rows\": len(rows),\n    \"firstId\": rows[0][\"id\"] if rows else None,\n    \"lastId\": rows[-1][\"id\"] if rows else None,\n    \"totalValue\": sum(row[\"value\"] for row in rows),\n    \"statusCounts\": status_counts,\n}\n\nprint(\"[data_sync] rows=\" + str(len(rows)))\nprint(\"[data_sync] summary=\" + json.dumps(summary, sort_keys=True, ensure_ascii=False))\nif rows:\n    print(\"[data_sync] sample=\" + json.dumps(rows[0], sort_keys=True, ensure_ascii=False))","timeoutSeconds":7200,"maxRetry":2,"retryDelay":300,"blockStrategy":"discard"}'::jsonb,
         '开箱即跑：Python 脚本生成 10 行确定性示例数据（可用 params.rows 调整，默认 10、上限 1000），打印行数与 JSON 摘要后正常退出，无第三方依赖。可改参数：params.rows。'),
        ('log_cleanup',
         '{"triggerType":"cron","cronExpression":"30 3 * * *","runtime":"node","glueLanguage":"javascript","glueSource":"''use strict'';\n// AutoCodeFlow official template: log_cleanup (dry-run by default; demo dir only).\nconst fs = require(''fs'');\nconst os = require(''os'');\nconst path = require(''path'');\nconst DAY_MS = 24 * 60 * 60 * 1000;\n\nfunction readParams() {\n  const raw = process.env.AUTOFLOW_PARAMS_JSON;\n  if (!raw) return {};\n  try {\n    const parsed = JSON.parse(raw);\n    return parsed && typeof parsed === ''object'' && !Array.isArray(parsed) ? parsed : {};\n  } catch (err) {\n    console.error(''[log_cleanup] AUTOFLOW_PARAMS_JSON is not valid JSON: '' + err.message);\n    return {};\n  }\n}\n\nfunction isInside(root, target) {\n  return target === root || target.indexOf(root + path.sep) === 0;\n}\n\nfunction asAgeDays(value, fallback) {\n  if (value === undefined || value === null || value === '''') return fallback;\n  const parsed = Number(value);\n  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;\n}\n\nconst params = readParams();\nfunction paramValue(name) {\n  if (Object.prototype.hasOwnProperty.call(params, name)) return params[name];\n  // AUTOFLOW_<KEY> 通道（键名大写；字符串为裸值）。两条通道都支持，脚本在\n  // 老执行器（只注入逐键通道）与新执行器（额外注入 JSON）上都能跑。\n  return process.env[''AUTOFLOW_'' + name.toUpperCase()];\n}\n\nconst demoRoot = path.resolve(os.tmpdir(), ''acf-demo-logs'');\nconst dirParam = paramValue(''dir'');\nconst dirValue = typeof dirParam === ''string'' ? dirParam.trim() : '''';\nconst targetDir = path.resolve(dirValue || demoRoot);\nconst maxAgeDays = asAgeDays(paramValue(''maxAgeDays''), 7);\n// 默认 dry-run。显式 false（布尔，或经 env/UI 传递时的字符串 \"false\"）才删除。\nconst dryRunParam = paramValue(''dryRun'');\nconst deleteEnabled = dryRunParam === false || dryRunParam === ''false'';\n\n// 高危根目录直接拒绝：宁可任务失败，也不在 /、home、cwd 上做任何扫描/删除。\nconst protectedDirs = [\n  path.parse(targetDir).root,\n  path.resolve(os.homedir()),\n  path.resolve(process.cwd()),\n];\nif (protectedDirs.indexOf(targetDir) !== -1) {\n  throw new Error(''拒绝操作受保护目录：'' + targetDir);\n}\n\nfunction seedDemoFiles() {\n  fs.mkdirSync(demoRoot, { recursive: true });\n  const seeds = [''demo-app.log'', ''demo-worker.log''];\n  for (let i = 0; i < seeds.length; i += 1) {\n    const file = path.join(demoRoot, seeds[i]);\n    if (fs.existsSync(file)) continue;\n    fs.writeFileSync(file, ''AutoCodeFlow demo log line '' + (i + 1) + ''\\n'', ''utf8'');\n    // 回拨 mtime 到 30 天前，让默认 7 天阈值下有「过期文件」可列（内容仍确定）。\n    const old = new Date(Date.now() - 30 * DAY_MS);\n    fs.utimesSync(file, old, old);\n  }\n}\n\nif (targetDir === demoRoot) {\n  seedDemoFiles();\n} else if (!fs.existsSync(targetDir)) {\n  if (!isInside(demoRoot, targetDir)) {\n    throw new Error(''params.dir 不存在且位于 demo 目录之外：'' + targetDir);\n  }\n  fs.mkdirSync(targetDir, { recursive: true });\n}\n\n// 目录级软链防护：params.dir 若是指向演示目录之外的符号链接，词法前缀检查会\n// 被骗过（lstat 只能挡文件级软链）。realpath 后再判定，删除分支据此整体拒绝。\nlet deleteRoot = demoRoot;\nlet deleteTarget = targetDir;\ntry {\n  deleteRoot = fs.realpathSync(demoRoot);\n  deleteTarget = fs.realpathSync(targetDir);\n} catch (err) {\n  // 演示目录尚未建立等：保留词法路径，删除仍受下面的前缀检查约束。\n  deleteRoot = demoRoot;\n  deleteTarget = targetDir;\n}\n\nlet entries;\ntry {\n  entries = fs.readdirSync(targetDir);\n} catch (err) {\n  throw new Error(''无法读取 params.dir='' + targetDir + '': '' + err.message);\n}\n\nconst cutoff = Date.now() - maxAgeDays * DAY_MS;\nconst expired = [];\nfor (const name of entries.sort()) {\n  if (expired.length >= 100) break;\n  const abs = path.resolve(targetDir, name);\n  let stat;\n  try {\n    stat = fs.lstatSync(abs);\n  } catch (err) {\n    continue;\n  }\n  // 跳过目录与符号链接：链接可能指向演示目录之外，绝不跟随。\n  if (!stat.isFile()) continue;\n  if (stat.mtimeMs >= cutoff) continue;\n  expired.push({ name: name, path: abs, size: stat.size, mtime: new Date(stat.mtimeMs).toISOString() });\n}\n\nconsole.log(''[log_cleanup] targetDir='' + targetDir);\nconsole.log(''[log_cleanup] maxAgeDays='' + maxAgeDays + '' expired='' + expired.length + '' dryRun='' + !deleteEnabled);\nfor (const item of expired) {\n  console.log(''[log_cleanup] expired '' + item.name + '' size='' + item.size + '' mtime='' + item.mtime);\n}\n\nif (!deleteEnabled) {\n  console.log(''[log_cleanup] dry-run: no file was deleted (set params.dryRun=false to delete)'');\n} else if (!isInside(deleteRoot, deleteTarget)) {\n  console.log(''[log_cleanup] delete skipped: targetDir resolves outside the demo directory '' + demoRoot);\n} else {\n  let deleted = 0;\n  for (const item of expired) {\n    const abs = path.resolve(targetDir, item.name);\n    // 双保险：目标必须在（realpath 后的）演示目录内，且是 targetDir 的直接子文件。\n    if (!isInside(deleteRoot, abs) || path.dirname(abs) !== targetDir) {\n      console.log(''[log_cleanup] refused to delete outside '' + demoRoot + '': '' + abs);\n      continue;\n    }\n    fs.unlinkSync(abs);\n    deleted += 1;\n  }\n  console.log(''[log_cleanup] deleted='' + deleted);\n}","timeoutSeconds":600,"maxRetry":1}'::jsonb,
         '开箱即跑：Node 脚本默认清理 os.tmpdir()/acf-demo-logs 演示目录（不存在则创建并放入 2 个示例文件），按 params.maxAgeDays（默认 7）列出过期文件；默认 dry-run 只列不删，只有 params.dryRun=false 且在演示目录内才真正删除。可改参数：params.dir、params.maxAgeDays、params.dryRun。'),
        ('webhook_ping',
         '{"triggerType":"manual","runtime":"node","glueLanguage":"javascript","glueSource":"''use strict'';\n// AutoCodeFlow official template: webhook_ping.\nconst TIMEOUT_MS = 5000;\nconst PAYLOAD = { event: ''webhook_ping'', source: ''AutoCodeFlow'', message: ''ping'' };\n\nfunction readParams() {\n  const raw = process.env.AUTOFLOW_PARAMS_JSON;\n  if (!raw) return {};\n  try {\n    const parsed = JSON.parse(raw);\n    return parsed && typeof parsed === ''object'' && !Array.isArray(parsed) ? parsed : {};\n  } catch (err) {\n    console.error(''[webhook_ping] AUTOFLOW_PARAMS_JSON is not valid JSON: '' + err.message);\n    return {};\n  }\n}\n\nconst params = readParams();\nfunction paramValue(name) {\n  if (Object.prototype.hasOwnProperty.call(params, name)) return params[name];\n  // AUTOFLOW_<KEY> 通道（键名大写；字符串为裸值）。两条通道都支持，脚本在\n  // 老执行器（只注入逐键通道）与新执行器（额外注入 JSON）上都能跑。\n  return process.env[''AUTOFLOW_'' + name.toUpperCase()];\n}\n\nconst urlParam = paramValue(''url'');\nconst urlValue = typeof urlParam === ''string'' ? urlParam.trim() : '''';\n\nasync function main() {\n  if (!urlValue) {\n    console.log(''[webhook_ping] params.url is not set - nothing to send'');\n    console.log(''[webhook_ping] payload='' + JSON.stringify(PAYLOAD));\n    console.log(''[webhook_ping] OK (payload preview only)'');\n    return;\n  }\n  if (!/^https?:\\/\\//i.test(urlValue)) {\n    throw new Error(''params.url 必须以 http:// 或 https:// 开头（收到 '' + urlValue + '')'');\n  }\n  if (typeof fetch !== ''function'') {\n    throw new Error(''全局 fetch 不可用；webhook_ping 需要 Node.js 18+'');\n  }\n  const controller = new AbortController();\n  const timer = setTimeout(function () { controller.abort(); }, TIMEOUT_MS);\n  const startedAt = Date.now();\n  try {\n    const response = await fetch(urlValue, {\n      method: ''POST'',\n      headers: { ''content-type'': ''application/json'' },\n      body: JSON.stringify(PAYLOAD),\n      signal: controller.signal,\n    });\n    const elapsedMs = Date.now() - startedAt;\n    console.log(''[webhook_ping] url='' + urlValue);\n    console.log(''[webhook_ping] status='' + response.status + '' elapsedMs='' + elapsedMs);\n    if (!response.ok) {\n      throw new Error(''Webhook 端点返回状态 '' + response.status);\n    }\n    console.log(''[webhook_ping] OK'');\n  } catch (err) {\n    if (err && err.name === ''AbortError'') {\n      throw new Error(''请求 '' + urlValue + '' timed out after '' + TIMEOUT_MS + ''ms'');\n    }\n    throw err instanceof Error ? err : new Error(String(err));\n  } finally {\n    clearTimeout(timer);\n  }\n}\n\nmain().catch(function (err) {\n  console.error(''[webhook_ping] failed: '' + (err && err.message ? err.message : String(err)));\n  process.exitCode = 1;\n  throw err;\n});","timeoutSeconds":60,"maxRetry":1}'::jsonb,
         '开箱即跑：Node 脚本在 params.url 存在时 POST 一份 JSON（5 秒超时）并打印状态码；未配置时只打印 payload 并成功退出，可作为手动触发的冒烟任务。可改参数：params.url。')
      ) AS v("key", "config", "description")
      WHERE t."key" = v."key"
        AND t."isOfficial" = true
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 旧值逐字复制自 1789800000000-CreateTaskTemplates 的 seed（含 entrypoint）。
    await queryRunner.query(String.raw`
      UPDATE "task_templates" AS t
      SET "config" = v."config",
          "description" = v."description"
      FROM (VALUES
        ('scheduled_backup',
         '{"triggerType":"cron","cronExpression":"0 2 * * *","runtime":"shell","entrypoint":"backup.sh","timeoutSeconds":3600,"maxRetry":3,"retryDelay":60,"blockStrategy":"discard"}'::jsonb,
         '周期性备份任务：Cron 定时触发（默认每天 02:00），失败按重试预算退避重试，冲突丢弃。'),
        ('health_check',
         '{"triggerType":"fixed_rate","fixedRate":60,"runtime":"shell","entrypoint":"check.sh","timeoutSeconds":30,"maxRetry":0}'::jsonb,
         '端点/服务健康探针：固定间隔轮询（默认 60s），低超时、不重试——快速失败暴露问题。'),
        ('data_sync',
         '{"triggerType":"fixed_rate","fixedRate":1800,"runtime":"python","entrypoint":"sync.py","timeoutSeconds":7200,"maxRetry":2,"retryDelay":300,"blockStrategy":"discard"}'::jsonb,
         '数据同步流水线：较长超时、串行不重叠、失败退避重试（默认每 30 分钟一次）。'),
        ('log_cleanup',
         '{"triggerType":"cron","cronExpression":"30 3 * * *","runtime":"shell","entrypoint":"cleanup.sh","timeoutSeconds":600,"maxRetry":1}'::jsonb,
         '每日清理：在执行器主机上剪除过期文件/日志（默认每天 03:30），失败轻试一次。'),
        ('webhook_ping',
         '{"triggerType":"manual","runtime":"node","entrypoint":"ping.js","timeoutSeconds":60,"maxRetry":1}'::jsonb,
         '手动/API 触发的出站 Webhook 通知器，通常作为下游依赖串联，不排程。')
      ) AS v("key", "config", "description")
      WHERE t."key" = v."key"
        AND t."isOfficial" = true
    `);
  }
}
