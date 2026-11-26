/**
 * N27 — ToolSearch 纯函数契约测试。
 *
 * 覆盖：关键词命中/不命中、tags 过滤、limit 截断（含默认 10 / 上限 50）、
 * 稳定排序（score 降序 → 名称字典序）、空 query 默认前 N、纯函数不改动入参，
 * 以及 `tools.ts` 的 re-export 接线（56 工具面本身由 test:mcp-tool-surface 守）。
 */
import { describe, expect, it } from "vitest";

import { searchTools, type ToolDefinition } from "../tool-search";
import { searchTools as reExported } from "../tools";

const TOOLS: ToolDefinition[] = [
  { name: "get_task", description: "Get one task by id", tags: ["read", "task"] },
  { name: "list_tasks", description: "List all tasks", tags: ["read", "task"] },
  { name: "delete_task", description: "Delete a task", tags: ["write", "task"] },
  { name: "deploy_application", description: "Deploy an application", tags: ["write", "deploy"] },
  { name: "list_applications", description: "List all registered applications", tags: ["read", "app"] },
  { name: "get_execution", description: "Get execution detail", tags: ["read", "exec"] },
  { name: "get_execution_stats", description: "Execution statistics", tags: ["read", "exec"] },
  { name: "stop_deployment", description: "Stop a running deployment", tags: ["write", "deploy"] },
];

const names = (tools: ToolDefinition[]): string[] => tools.map((t) => t.name);

describe("searchTools — 关键词", () => {
  it("大小写不敏感，名称与描述都能命中；单复数归一（task ↔ tasks）", () => {
    expect(names(searchTools({ keyword: "TASK" }, TOOLS))).toEqual([
      "delete_task",
      "get_task",
      "list_tasks",
    ]);
  });

  it("只命中描述的关键词也能找到工具", () => {
    expect(names(searchTools({ keyword: "statistics" }, TOOLS))).toEqual([
      "get_execution_stats",
    ]);
  });

  it("完全不相关的关键词返回空数组", () => {
    expect(searchTools({ keyword: "quantum-entanglement" }, TOOLS)).toEqual([]);
  });

  it("多 token 查询按命中 token 数计分（execution stats）", () => {
    expect(names(searchTools({ keyword: "execution stats" }, TOOLS))).toEqual([
      "get_execution_stats",
      "get_execution",
    ]);
  });
});

describe("searchTools — tags 过滤", () => {
  it("命中任一请求 tag（OR），并按名称字典序返回", () => {
    expect(names(searchTools({ tags: ["deploy"] }, TOOLS))).toEqual([
      "deploy_application",
      "stop_deployment",
    ]);
  });

  it("tag 大小写不敏感，且与关键词叠加为 AND", () => {
    expect(names(searchTools({ keyword: "task", tags: ["WRITE"] }, TOOLS))).toEqual([
      "delete_task",
    ]);
  });

  it("不存在的 tag 返回空", () => {
    expect(searchTools({ tags: ["no-such-tag"] }, TOOLS)).toEqual([]);
  });
});

describe("searchTools — limit 与排序", () => {
  const many: ToolDefinition[] = Array.from({ length: 60 }, (_, i) => ({
    name: `tool_${String(i).padStart(2, "0")}`,
    description: "generic utility tool",
  }));

  it("缺省 limit = 10，空 query 返回按名称排序的默认前 N", () => {
    expect(names(searchTools({}, many))).toEqual(
      Array.from({ length: 10 }, (_, i) => `tool_${String(i).padStart(2, "0")}`),
    );
  });

  it("显式 limit 截断到指定数量", () => {
    expect(searchTools({ limit: 3 }, many)).toHaveLength(3);
  });

  it("limit 上限 50", () => {
    expect(searchTools({ limit: 100 }, many)).toHaveLength(50);
  });

  it("limit <= 0 返回空；非法 limit 回落缺省 10", () => {
    expect(searchTools({ limit: 0 }, many)).toEqual([]);
    expect(searchTools({ limit: Number.NaN }, many)).toHaveLength(10);
  });

  it("同分时按名称字典序稳定排序（不用 localeCompare）", () => {
    const tied: ToolDefinition[] = [
      { name: "z_alpha", description: "list" },
      { name: "a_alpha", description: "list" },
      { name: "m_alpha", description: "list" },
    ];
    expect(names(searchTools({ keyword: "list" }, tied))).toEqual([
      "a_alpha",
      "m_alpha",
      "z_alpha",
    ]);
  });

  it("命中数优先、同分再按名称", () => {
    const mixed: ToolDefinition[] = [
      { name: "a_simple", description: "list" },
      { name: "z_simple", description: "list" },
      { name: "m_best", description: "list tasks" },
    ];
    expect(names(searchTools({ keyword: "list tasks" }, mixed))).toEqual([
      "m_best",
      "a_simple",
      "z_simple",
    ]);
  });
});

describe("searchTools — 纯函数与接线", () => {
  it("不修改入参，返回新数组；冻结输入也能正常工作", () => {
    const snapshot = TOOLS.map((t) => ({ ...t, tags: [...(t.tags ?? [])] }));
    const frozen = Object.freeze(TOOLS.map((t) => Object.freeze({ ...t })));
    const result = searchTools({ keyword: "task" }, frozen);
    expect(result).not.toBe(frozen);
    expect(TOOLS).toEqual(snapshot);
    result.pop();
    expect(TOOLS).toHaveLength(snapshot.length);
  });

  it("tools.ts 的 re-export 指向同一实现（未新增第 57 个工具）", () => {
    expect(reExported).toBe(searchTools);
    expect(reExported({ keyword: "task" }, TOOLS)).toEqual(
      searchTools({ keyword: "task" }, TOOLS),
    );
  });
});
