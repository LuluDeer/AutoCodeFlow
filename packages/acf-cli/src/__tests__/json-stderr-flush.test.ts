/**
 * PKG-02（本轮）：`--json` 失败时 stderr 必须是**完整可 parse 的一行 JSON**，
 * 且进程退出码与 JSON 里的 `exitCode` 同源。
 *
 * 缺陷：ui.ts 的 emitError 在 `console.error(JSON.stringify(...))` 之后立刻
 * `process.exit(...)`。管道/文件下 stderr 是非阻塞流（Windows 管道尤甚），
 * 未 flush 的尾部会被 exit 丢掉 —— CI 的 `acf … --json 2> err.json` 拿到空文件，
 * 机读契约破裂。
 *
 * 本用例起**真实 CLI 入口**（node --import tsx src/index.ts），stderr 经 pipe
 * 收集，断言：① JSON.parse 成功；② exitCode 字段与真实退出码一致。
 *
 * 反证：把 emitError 的 writeStderrSyncLine 换回 console.error（异步流写）后，
 * 本用例在 Linux 管道（同步写）下仍能通过——这正是缺陷的隐蔽处；平台无关的
 * 确定性守卫是同目录 error-code.test.ts 里对 fd 2 同步写的断言。
 */
import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

interface CliResult {
  code: number | string | undefined;
  stdout: string;
  stderr: string;
}

/**
 * 用 port 1（必然 ECONNREFUSED）当 API 地址：不依赖网络，也无需 mock 服务端，
 * 错误分类稳定落在「网络失败 → 退出码 4」。
 */
function runCli(args: string[]): Promise<CliResult> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ['--import', 'tsx', join(PKG_DIR, 'src', 'index.ts'), ...args],
      {
        cwd: PKG_DIR,
        timeout: 60_000,
        env: {
          ...process.env,
          ACF_API_URL: 'http://127.0.0.1:1',
          ACF_TOKEN: 'pkg02-test-token',
          NO_COLOR: '1',
        },
      },
      (err, stdout, stderr) => {
        const code = (err as { code?: number | string } | null)?.code;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

describe('--json 失败出口：stderr 一行 JSON 完整落地（PKG-02）', () => {
  it('真实子进程 + 管道 stderr：JSON.parse 成功，exitCode 与进程退出码一致', async () => {
    const { code, stderr } = await runCli(['task', 'list', '--json']);

    // 网络失败 → 4（EXIT_CODES.NETWORK）
    expect(code).toBe(4);

    // non-TTY 下 ora 的进行中帧也走 stderr（"- Fetching tasks…"），这是既有
    // 行为、与本缺陷无关；要钉的是「JSON 行完整且只有一行、能被 parse」。
    const jsonLines = stderr
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .filter((l) => l.trim().startsWith('{'));
    expect(jsonLines).toHaveLength(1);
    // 机读契约：不得混入 "✗ scope" 这类人读行
    expect(jsonLines[0]).not.toContain('✗');
    expect(stderr).not.toContain('✗');

    const payload = JSON.parse(jsonLines[0]) as { ok: boolean; exitCode: number; scope: string };
    expect(payload).toMatchObject({ ok: false, exitCode: 4 });
    // JSON 里的 exitCode 与进程真实退出码同源
    expect(payload.exitCode).toBe(code);
  }, 90_000);
});
