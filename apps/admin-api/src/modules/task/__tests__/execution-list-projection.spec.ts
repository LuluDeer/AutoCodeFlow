/**
 * PERF-03（本轮体验审查）：执行列表端点把 512 KB 级的 text 列一起取回来。
 *
 * `task_executions.logs` 是 text 列，回调 DTO 允许单条 512_000 字符
 * （execution-callback.dto.ts 的 @MaxLength(512_000)）。而两个列表端点此前
 * 取整行：
 *   · getExecutions  —— `findAndCount({ where, skip, take, order })`
 *   · getAllExecutions —— `createQueryBuilder("e")` 无 select
 *
 * 一页 20 行满载时仅 logs 就接近 10 MB，全部经 SQL 读取、JSON 序列化、网络
 * 传输，再被前端原样丢弃：TaskDetailPage 执行历史表只渲染 status /
 * executorAddress / startTime / duration / errorMessage；ExecutionsPage 同理；
 * 详情页日志走独立端点 + SSE。
 *
 * 修法：由 TypeORM 元数据派生投影列（全集 − 重型文本排除表），实体新增列时
 * **自动入选**（方向性刻意选"排除表"而非"包含表"——包含表会让新列静默丢失，
 * 正是本轮反复在修的那类静默损坏）。
 *
 * 反证：把排除表清空，前两条用例立即变红；把 `select` 从 service 里删掉，
 * 源码层用例变红。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  EXECUTION_LIST_EXCLUDED_COLUMNS,
  projectExecutionListColumns,
  executionListSelectColumns,
  executionListSelectColumnsAliased,
} from "../execution-list-projection";

const SERVICE_SRC = readFileSync(
  join(__dirname, "..", "task.service.ts"),
  "utf-8",
);
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const SERVICE = stripComments(SERVICE_SRC);

describe("PERF-03 投影纯函数：排除表方向正确", () => {
  it("排除 logs 与 aiAnalysis 两个重型 text 列", () => {
    expect(EXECUTION_LIST_EXCLUDED_COLUMNS).toContain("logs");
    expect(EXECUTION_LIST_EXCLUDED_COLUMNS).toContain("aiAnalysis");
  });

  it("投影结果不含被排除列，且其余列全部保留", () => {
    const all = ["id", "taskId", "status", "logs", "aiAnalysis", "createdAt"];
    const projected = projectExecutionListColumns(all);
    expect(projected).not.toContain("logs");
    expect(projected).not.toContain("aiAnalysis");
    expect(projected).toEqual(["id", "taskId", "status", "createdAt"]);
  });

  it("方向性：实体**新增**列默认入选（排除表不会静默吞掉新列）", () => {
    const projected = projectExecutionListColumns([
      "id",
      "logs",
      "someBrandNewColumn",
    ]);
    expect(projected).toContain("someBrandNewColumn");
    expect(projected).not.toContain("logs");
  });

  it("排除表本身不含列表真正渲染的字段（避免误伤）", () => {
    // 列表页渲染这些：误排除会让页面显示空白，比慢更糟。
    for (const needed of [
      "id",
      "taskId",
      "taskName",
      "status",
      "triggerType",
      "executorAddress",
      "startTime",
      "endTime",
      "duration",
      "errorMessage",
      "failureReason",
      "exitCode",
      "retryCount",
      "taskVersion",
      "traceId",
      "result",
      "createdAt",
    ]) {
      expect(EXECUTION_LIST_EXCLUDED_COLUMNS).not.toContain(needed);
    }
  });

  it("真实实体：投影覆盖除排除项外的全部列（含重试链所需的 retryCount/createdAt）", () => {
    const allColumns = ["id", "logs", "aiAnalysis", "retryCount", "createdAt"];
    const projected = projectExecutionListColumns(allColumns);
    expect(projected).toEqual(["id", "retryCount", "createdAt"]);
  });
});

describe("PERF-03 元数据派生：加别名与不加别名的两种形态", () => {
  const fakeRepo = {
    metadata: {
      columns: [
        { propertyName: "id" },
        { propertyName: "logs" },
        { propertyName: "aiAnalysis" },
        { propertyName: "status" },
      ],
    },
  };

  it("find 用裸属性名（executionListSelectColumns）", () => {
    expect(executionListSelectColumns(fakeRepo)).toEqual(["id", "status"]);
  });

  it("QueryBuilder 用 e. 前缀（executionListSelectColumnsAliased）", () => {
    expect(executionListSelectColumnsAliased(fakeRepo)).toEqual([
      "e.id",
      "e.status",
    ]);
  });

  it("两种形态不可混用——别名形态确实带前缀，裸形态确实不带", () => {
    for (const c of executionListSelectColumns(fakeRepo)) {
      expect(c).not.toContain(".");
    }
    for (const c of executionListSelectColumnsAliased(fakeRepo)) {
      expect(c).toMatch(/^e\./);
    }
  });
});

describe("PERF-03 实体契约：logs 确实是重型 text 列（前提仍然成立）", () => {
  it("TaskExecution 上存在 logs 与 aiAnalysis 两个 text 列", () => {
    // 直接读实体源码断言列类型：装饰器元数据需要 DataSource 初始化才能读，
    // 而这里要钉的是「排除它们的前提」——它们必须确实是 text 列。
    const entitySrc = readFileSync(
      join(__dirname, "..", "entities", "task-execution.entity.ts"),
      "utf-8",
    );
    expect(entitySrc).toMatch(
      /@Column\(\{ type: "text", nullable: true \}\) logs: string;/,
    );
    expect(entitySrc).toMatch(
      /@Column\(\{ type: "text", nullable: true \}\) aiAnalysis: string;/,
    );
  });

  it("回调 DTO 确实允许 512_000 字符（危害量级的前提）", () => {
    const dtoSrc = readFileSync(
      join(__dirname, "..", "dto", "execution-callback.dto.ts"),
      "utf-8",
    );
    expect(dtoSrc).toContain("512_000");
  });
});

describe("PERF-03 源码层：两个列表端点都带上了投影", () => {
  // 断言前把连续空白压成单空格：prettier 会按行宽把调用折行，逐字面量比对会让
  // 「代码没变、只是换行」这种无关改动把守卫弄红——那正是判据失效而非漏网。
  const normalize = (s: string) => s.replace(/\s+/g, " ");
  const NORM_SERVICE = normalize(SERVICE);

  it("getExecutions 的 findAndCount 传了 select", () => {
    const start = SERVICE.indexOf("async getExecutions(");
    expect(start).toBeGreaterThan(-1);
    const body = normalize(SERVICE.slice(start, start + 1400));
    expect(body).toMatch(
      /select:\s*executionListSelectMap\(\s*this\.execRepo,?\s*\)/,
    );
  });

  it("getAllExecutions 的 QueryBuilder 传了 select（别名形态）", () => {
    const start = SERVICE.indexOf("async getAllExecutions(");
    expect(start).toBeGreaterThan(-1);
    const body = normalize(SERVICE.slice(start, start + 1400));
    // 允许 prettier 在括号内任意折行/加尾逗号：判据是「调了别名形态的投影」，
    // 不是「源码恰好长成某一行」。
    expect(body).toMatch(
      /select\(executionListSelectColumnsAliased\(\s*this\.execRepo,?\s*\)\)/,
    );
  });

  it("投影 helper 是从独立模块导入的（唯一事实源，不在 service 里内联）", () => {
    expect(SERVICE).toContain("executionListSelectColumns");
    expect(SERVICE).toContain("executionListSelectColumnsAliased");
    expect(NORM_SERVICE).toContain('from "./execution-list-projection"');
  });
});
