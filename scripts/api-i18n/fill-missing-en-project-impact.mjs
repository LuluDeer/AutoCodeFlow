#!/usr/bin/env node
/**
 * 补齐 API-I18N 映射表里缺的英文（一次性工具，补完即可删）。
 *
 * 这一批 6 条全部来自 PROJECT-IMPACT-01 新增的
 * `ProjectRemovalImpactResponseDto` 与 `ProjectsController.describeRemovalImpact`
 * ——`npm run swagger:export` 后由 `inject-openapi-en.mjs --check` 实测报缺，
 * 与 CI `api-types-drift` 的红是同 6 条（本地复现结果逐字一致）。
 *
 * 以脚本补而不是手改 JSON：让「补了哪几条」可复核、可复跑（幂等——已存在的
 * 键只计数不覆盖，重复执行不会改坏人工校订过的译文）。
 */
import * as fs from "node:fs";
import * as path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "../..");
const MAP = path.join(root, "scripts/api-i18n/data/openapi-en-map.json");

const ADD = {
  "项目名称（确认框标题回显）":
    "Project name (echoed as the confirmation dialog title)",

  "该项目下未软删除的任务数（status != deleted）。这些任务删除后会退回「未分配」视图":
    "Number of non-soft-deleted tasks in this project (status != deleted). After deletion these tasks fall back to the \"unassigned\" view",

  "其中处于 active 状态的任务数——删除后仍会被 cron 触发，是真正会持续产生副作用的那部分":
    "How many of those tasks are active -- they keep being triggered by cron after the deletion, which is the part that keeps producing side effects",

  "项目成员关系行数（删除时由 FK ON DELETE CASCADE 一并清除）":
    "Number of project member rows (cleared together by FK ON DELETE CASCADE on delete)",

  "是否可删；默认项目恒为 false（remove 会返回 404 PROJECT_DEFAULT_IMMUTABLE）":
    "Whether the project is deletable; always false for the Default project (remove returns 404 PROJECT_DEFAULT_IMMUTABLE)",

  "预览删除该项目的后果":
    "Preview the consequences of deleting this project",
};

const map = JSON.parse(fs.readFileSync(MAP, "utf8"));
let added = 0;
let existed = 0;
for (const [zh, en] of Object.entries(ADD)) {
  if (Object.prototype.hasOwnProperty.call(map, zh)) {
    existed++;
    continue;
  }
  map[zh] = en;
  added++;
}
// 键排序：新增不造成整文件重排，diff 稳定
const sorted = {};
for (const k of Object.keys(map).sort()) sorted[k] = map[k];
fs.writeFileSync(MAP, JSON.stringify(sorted, null, 2) + "\n", "utf8");
console.log(JSON.stringify({ added, existed, total: Object.keys(map).length }, null, 2));
