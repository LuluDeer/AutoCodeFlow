import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { classifyFailure } from "../failure-patterns";
import { ExecutionFailureReason } from "../../../modules/task/entities/task-execution.entity";

/**
 * admin 文本分支**逐条对齐协议向量**（单轨验收）。
 *
 * 判据本体已迁到 `./generated/failure-classifier.ts`（由 protocol.json 生成），
 * 本文件从 `packages/contract-fixtures/contract.json` 读 `failureClassification.vectors`
 * 并断言：wrapper 的文本分支（无 errorCode / 无 exitCode / 无 no-matching 文本）
 * 对每条向量都等于 `expected.admin`。另钉住三类非文本判据未因切换而回归。
 *
 * 注意：向量只带 `parts`，不带非文本字段，因此这里走的是纯文本通路；若把
 * `errorCode` / `exitCode` / no-matching 判据塞进生成物，本文件会立刻暴露。
 */

interface FailureVector {
  id: string;
  parts: string[];
  expected: {
    executor?: string | null;
    admin?: string;
  };
}

const CONTRACT_PATH = resolve(
  __dirname,
  "../../../../../../packages/contract-fixtures/contract.json",
);

const contract = JSON.parse(readFileSync(CONTRACT_PATH, "utf8")) as {
  failureClassification?: { vectors?: FailureVector[] };
};
const vectors = contract.failureClassification?.vectors ?? [];

describe("admin 文本分支逐条对齐协议向量", () => {
  it("契约向量非空", () => {
    expect(vectors.length).toBeGreaterThan(0);
  });

  for (const vector of vectors) {
    it(`${vector.id} → expected.admin=${String(vector.expected.admin)}`, () => {
      const actual = classifyFailure({
        errorMessage: vector.parts[0],
        logs: vector.parts[1],
      });
      expect(actual).toBe(vector.expected.admin);
    });
  }
});

describe("非文本判据未回归", () => {
  it("errorCode 码化优先：命中码表时完全跳过生成物文本", () => {
    expect(
      classifyFailure({
        errorCode: "PINNED_EXECUTOR_OFFLINE",
        errorMessage: "some entirely unrelated failure text",
      }),
    ).toBe(ExecutionFailureReason.EXECUTOR_OFFLINE);

    // 栈首 exception 会被生成物 script_error 规则吞掉，码化必须确定性落 UNKNOWN。
    expect(
      classifyFailure({
        errorCode: "NO_EXECUTOR_MATCHING_FILTERS",
        errorMessage: "Traceback (most recent call last)",
        logs: "ServiceUnavailableException: no online executor matches the requested filters",
      }),
    ).toBe(ExecutionFailureReason.UNKNOWN);
  });

  it("errorCode 未映射时回落到生成物文本分支", () => {
    expect(
      classifyFailure({
        errorCode: "SOME_UNMAPPED_CODE",
        errorMessage: "execution timed out after 600s",
      }),
    ).toBe(ExecutionFailureReason.TIMEOUT);
  });

  it("exitCode 非零：无文本命中时充分判 SCRIPT_ERROR", () => {
    expect(classifyFailure({ exitCode: 1 })).toBe(
      ExecutionFailureReason.SCRIPT_ERROR,
    );
    expect(
      classifyFailure({ errorMessage: "进程以退出码 1 结束", exitCode: 1 }),
    ).toBe(ExecutionFailureReason.SCRIPT_ERROR);
  });

  it("exitCode 不抢具体文本规则（timeout 优先）", () => {
    expect(
      classifyFailure({ errorMessage: "execution timed out", exitCode: 1 }),
    ).toBe(ExecutionFailureReason.TIMEOUT);
  });

  it("no matching executor 在生成物 script_error 之前拦截为 UNKNOWN", () => {
    expect(
      classifyFailure({
        errorMessage: "没有在线执行器匹配所请求的 group/tags/runtime",
        logs:
          "ServiceUnavailableException: 没有在线执行器匹配所请求的 group/tags/runtime\n" +
          "    at ExecutorService.dispatch (executor.service.js:2032:27)",
      }),
    ).toBe(ExecutionFailureReason.UNKNOWN);
    expect(
      classifyFailure({
        errorMessage: "No online executors match the requested group/tags/runtime",
      }),
    ).toBe(ExecutionFailureReason.UNKNOWN);
  });

  it("no available executor 族仍归 EXECUTOR_OFFLINE（两族不可混）", () => {
    expect(
      classifyFailure({
        errorMessage:
          "No available executor (all candidates are offline or at capacity)",
      }),
    ).toBe(ExecutionFailureReason.EXECUTOR_OFFLINE);
  });

  it("最后兜底：无关键词且 exitCode=0 → UNKNOWN", () => {
    expect(
      classifyFailure({
        errorMessage: "some entirely unrelated failure text",
        exitCode: 0,
      }),
    ).toBe(ExecutionFailureReason.UNKNOWN);
  });
});
