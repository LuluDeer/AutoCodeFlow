/**
 * 每日报表导出示例（node runtime）
 *
 * 场景：cron 每天定时触发 → 生成报表 CSV 文件产物 → 落盘共享目录 →
 *       通过回调上报产物路径；失败时打 error 日志触发任务级告警占位。
 *
 * 这是「定时 + 产物」类任务的骨架：把 buildReportRows 换成真实数据查询，
 * 把 writeArtifact 换成真实落盘/上传即可复用到生产。
 *
 * 运行参数（由执行器注入 AUTOFLOW_<KEY> 环境变量，KEY 大写；字符串为裸值）：
 *   参数键 reportDate → AUTOFLOW_REPORTDATE : 报表日期 YYYY-MM-DD，传 auto（默认）取当天
 *   参数键 rowCount   → AUTOFLOW_ROWCOUNT   : 模拟数据条数，默认 5
 *   参数键 outputDir  → AUTOFLOW_OUTPUTDIR  : 产物目录，默认 /tmp/acf-daily-report
 *   REPORT_EXPORT_TOKEN : 报表系统导出令牌（secrets 注入，示例不实际调用外部 API）
 *
 * 结果查看：acf task trigger <taskId> --wait 看终态，
 *           acf task logs <execId> 看 "RESULT" 行里的产物路径。
 */
const fs = require("node:fs");
const path = require("node:path");

function param(name, fallback) {
  const value = process.env[`AUTOFLOW_${name}`];
  return value === undefined || value === "" ? fallback : value;
}

function today() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** 演示数据；真实场景里这里查数据库/数仓并组装成行。 */
function buildReportRows(reportDate, rowCount) {
  const rows = [["date", "metric", "value"]];
  for (let i = 1; i <= rowCount; i += 1) {
    rows.push([reportDate, `metric_${i}`, String(i * 100)]);
  }
  return rows;
}

/** 产物落盘：生成 CSV 文件并返回绝对路径。 */
function writeArtifact(outputDir, reportDate, rows) {
  fs.mkdirSync(outputDir, { recursive: true });
  const file = path.join(outputDir, `daily-report-${reportDate}.csv`);
  const csv = rows.map((row) => row.join(",")).join("\n") + "\n";
  fs.writeFileSync(file, csv, "utf8");
  return file;
}

function main() {
  const reportDate = param("REPORTDATE", "auto") === "auto"
    ? today()
    : param("REPORTDATE", "auto");
  const rowCount = Number(param("ROWCOUNT", "5"));
  const outputDir = param("OUTPUTDIR", "/tmp/acf-daily-report");
  console.log(`[daily-report] start reportDate=${reportDate} rowCount=${rowCount}`);

  try {
    const rows = buildReportRows(reportDate, rowCount);
    const artifact = writeArtifact(outputDir, reportDate, rows);
    // 告警占位：失败分支打 error 日志，由任务级 alarmEmail / alarmChannels
    // 触发通知（本例正常路径不打，故首次成功不产生噪音告警）。
    console.log(`[daily-report] artifact=${artifact}`);
    const result = {
      success: true,
      reportDate,
      rowCount: rows.length - 1,
      artifact,
      alarmPlaceholder: "失败时 console.error + 任务级 alarmEmail 告警",
    };
    console.log("RESULT " + JSON.stringify(result));
    return result;
  } catch (err) {
    // 告警占位：真实场景在这里调用告警通道（钉钉/邮件/webhook）。
    console.error(`[daily-report][ALARM] export failed: ${err.message}`);
    throw err;
  }
}

if (require.main === module) {
  main();
}

module.exports = { main, buildReportRows, writeArtifact };
