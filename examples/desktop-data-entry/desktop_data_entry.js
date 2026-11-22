/**
 * 桌面数据填报示例（桌面执行器形态，node runtime）
 *
 * 场景：在用户桌面执行器上手动触发 → 读取本地填报数据文件（CSV）→
 *       逐行校验字段 → 汇总结果写回 JSON 文件产物 → 日志输出结果摘要。
 *
 * 这是「桌面执行器 + 填报」类任务的骨架：真实场景把 readFormRows 换成
 * 读取桌面应用导出的数据/剪贴板/UI 自动化结果，把 writeResult 换成回填到
 * 业务系统或上传即可。任务配置用 executorTags:["desktop"] 表达桌面执行器
 * 形态（按标签命中桌面执行器；也可在控制台用 --executor 钉定具体设备）。
 *
 * 运行参数（执行器注入 AUTOFLOW_<KEY> 环境变量，字符串为裸值）：
 *   inputFile            : 填报数据 CSV 路径，默认 /tmp/acf-desktop-data-entry/input.csv
 *   outputFile           : 结果 JSON 路径，默认 /tmp/acf-desktop-data-entry/result.json
 *   formName             : 表单名（仅用于日志/汇总标识）
 *   createSampleIfMissing: 输入文件缺失时是否生成样例数据（默认 true，便于首次成功）
 *
 * 结果查看：acf task trigger <taskId> --wait 看终态，
 *           acf task logs <execId> 看 "RESULT" 行与产出文件路径。
 */
const fs = require("node:fs");
const path = require("node:path");

function param(name, fallback) {
  const value = process.env[`AUTOFLOW_${name}`];
  return value === undefined || value === "" ? fallback : value;
}

function enabled(name, fallback) {
  const value = process.env[`AUTOFLOW_${name}`];
  if (value === undefined || value === "") return fallback;
  return value.toLowerCase() === "true" || value === "1";
}

/** 输入缺失时生成样例 CSV，保证首次成功不依赖外部数据。 */
function ensureInput(inputFile, createSample) {
  if (fs.existsSync(inputFile)) return false;
  if (!createSample) throw new Error(`输入文件不存在：${inputFile}`);
  fs.mkdirSync(path.dirname(inputFile), { recursive: true });
  fs.writeFileSync(
    inputFile,
    "name,amount,remark\n张三,100,示例行1\n李四,200,示例行2\n王五,,缺金额的示例行\n",
    "utf8",
  );
  return true;
}

/** 读 CSV 成对象数组（简单逗号分隔，示例够用）。 */
function readFormRows(inputFile) {
  const lines = fs.readFileSync(inputFile, "utf8").trim().split(/\r?\n/);
  const headers = lines.shift().split(",").map((h) => h.trim());
  return lines.map((line) => {
    const cells = line.split(",");
    return Object.fromEntries(headers.map((h, i) => [h, (cells[i] || "").trim()]));
  });
}

/** 逐行校验：amount 必须是正数；返回有效行与错误明细。 */
function validate(rows) {
  const valid = [];
  const errors = [];
  rows.forEach((row, index) => {
    const amount = Number(row.amount);
    if (!row.name || !Number.isFinite(amount) || amount <= 0) {
      errors.push({ line: index + 2, reason: "name 为空或 amount 非法", row });
    } else {
      valid.push({ name: row.name, amount, remark: row.remark || "" });
    }
  });
  return { valid, errors };
}

function writeResult(outputFile, summary) {
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, JSON.stringify(summary, null, 2), "utf8");
  return outputFile;
}

function main() {
  const inputFile = param("INPUTFILE", "/tmp/acf-desktop-data-entry/input.csv");
  const outputFile = param("OUTPUTFILE", "/tmp/acf-desktop-data-entry/result.json");
  const formName = param("FORMNAME", "日填报");
  const createSample = enabled("CREATESAMPLEIFMISSING", true);

  console.log(`[desktop-data-entry] start form=${formName} input=${inputFile}`);
  const created = ensureInput(inputFile, createSample);
  const rows = readFormRows(inputFile);
  const { valid, errors } = validate(rows);
  const summary = {
    success: true,
    formName,
    total: rows.length,
    validCount: valid.length,
    invalidCount: errors.length,
    sampleCreated: created,
    errors,
    outputFile,
  };
  writeResult(outputFile, summary);
  console.log(`[desktop-data-entry] result written to ${outputFile}`);
  console.log("RESULT " + JSON.stringify(summary));
  return summary;
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(`[desktop-data-entry][ALARM] entry failed: ${err.message}`);
    process.exitCode = 1;
  }
}

module.exports = { main, ensureInput, readFormRows, validate, writeResult };
