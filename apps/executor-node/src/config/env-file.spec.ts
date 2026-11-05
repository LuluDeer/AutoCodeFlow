import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import * as dotenv from "dotenv";

import { SELFTEST_SKIP_ENV_FILE_KEY, shouldLoadEnvFile, shouldSkipEnvFile } from "./env-file";

/**
 * R23（2026-11-05）：executor-node 侧 `.env` 加载开关的**红→绿判据**。
 *
 * 判据不是"函数返回 true/false"（那是自我实现），而是：
 * **伪造一个把 EXECUTOR_SECRET 投毒的 `.env`，在开关打开时，进程环境不得被它污染。**
 * 这正是 R04 在 admin-api 侧立的语义（自检跑在干净环境里）。
 */
describe("R23 — executor-node .env hermeticity（SELFTEST_SKIP_ENV_FILE 三态）", () => {
  it("未设置 ⇒ 加载（生产/CI 行为与引入开关前一致）", () => {
    expect(shouldSkipEnvFile({})).toBe(false);
    expect(shouldLoadEnvFile({})).toBe(true);
  });

  it('显式 "1" ⇒ 跳过（自检唯一认可取值）', () => {
    expect(shouldSkipEnvFile({ [SELFTEST_SKIP_ENV_FILE_KEY]: "1" })).toBe(true);
    expect(shouldLoadEnvFile({ [SELFTEST_SKIP_ENV_FILE_KEY]: "1" })).toBe(false);
  });

  it('其它取值（"0" / "true" / 空串）⇒ 仍加载（不发明宽松真值）', () => {
    for (const v of ["0", "true", "", "yes", " 1"]) {
      expect(shouldSkipEnvFile({ [SELFTEST_SKIP_ENV_FILE_KEY]: v })).toBe(false);
    }
  });

  it("【核心】投毒 .env 在开关打开时**不得**污染进程环境", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acf-r23-"));
    const envPath = path.join(dir, ".env");
    fs.writeFileSync(envPath, "EXECUTOR_SECRET=poisoned-by-dev-env\n", "utf8");
    const key = "EXECUTOR_SECRET";
    const saved = process.env[key];
    delete process.env[key];
    try {
      // 与 main.ts 完全同构的加载形态：**只有** shouldLoadEnvFile() 为真才读文件
      if (shouldLoadEnvFile({ [SELFTEST_SKIP_ENV_FILE_KEY]: "1" })) {
        dotenv.config({ path: envPath });
      }
      expect(process.env[key]).toBeUndefined(); // 开关生效 ⇒ 未被投毒
    } finally {
      if (saved === undefined) delete process.env[key];
      else process.env[key] = saved;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("【对照】同样伪造的 .env 在开关关闭时**会**污染（证明上一条真的在测开关）", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acf-r23b-"));
    const envPath = path.join(dir, ".env");
    fs.writeFileSync(envPath, "EXECUTOR_SECRET=poisoned-by-dev-env\n", "utf8");
    const key = "EXECUTOR_SECRET";
    const saved = process.env[key];
    delete process.env[key];
    try {
      if (shouldLoadEnvFile({})) {
        dotenv.config({ path: envPath });
      }
      expect(process.env[key]).toBe("poisoned-by-dev-env");
    } finally {
      if (saved === undefined) delete process.env[key];
      else process.env[key] = saved;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
