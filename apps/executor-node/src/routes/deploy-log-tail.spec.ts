/**
 * P1-8（UX-AUDIT-2026-09-21）：部署失败原因不再被截断成 "Exited with code 1"。
 *
 * 旧实现（修复前）：非 0 退出时 `reportStatus(..., 'Exited with code ' + code)`，
 * 真正的错误（entrypoint 写错、缺依赖、运行时堆栈）全部写在 app.log 里，控制台
 * 用户只看到一个退出码。本文件钉住三个行为：
 *   1. readAppLogTail 只 seek 末尾 N 字节（不整文件入内存），缺失/空文件安全返回 ''；
 *   2. truncateStatusMessage 超长时保留「退出码头行 + 末尾」并插入省略标记；
 *   3. buildFailedExitMessage 同时带上退出码与 app.log 尾部。
 *
 * 修复前这些导出不存在 → 本测试 import 即失败（红）；修复后转绿。
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildFailedExitMessage,
  readAppLogTail,
  truncateStatusMessage,
} from './deploy';

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-log-tail-'));
}

describe('readAppLogTail（P1-8）', () => {
  it('缺失文件返回空串，不抛错（best-effort）', () => {
    expect(readAppLogTail(path.join(os.tmpdir(), 'does-not-exist.log'))).toBe('');
  });

  it('空文件返回空串', () => {
    const dir = makeTempDir();
    const f = path.join(dir, 'app.log');
    fs.writeFileSync(f, '');
    expect(readAppLogTail(f)).toBe('');
  });

  it('只读取末尾 N 字节：包含末尾堆栈，但不含文件头部的早期内容', () => {
    const dir = makeTempDir();
    const f = path.join(dir, 'app.log');
    // 3000 行 LINE-A（约 21000 字节）+ 500 行 SEP 缓冲，末尾才是真正的堆栈行；
    // 尾窗口 2048 字节约 292 行——LINE-A 在窗口之外。
    const head = 'LINE-A\n'.repeat(3000);
    const sep = 'SEP\n'.repeat(500);
    const tail = 'LINE-Z\nREAL-STACK-END: Error: cannot find module ./missing';
    fs.writeFileSync(f, head + sep + tail);
    const out = readAppLogTail(f, 2048);
    // 输出被限制在尾窗口内（±几字节）
    expect(out.length).toBeLessThanOrEqual(2048);
    // 末尾根因在窗口内
    expect(out).toContain('REAL-STACK-END');
    expect(out).toContain('LINE-Z');
    expect(out).toContain('SEP');
    // 文件开头（几千行之前）的内容不应被读进窗口
    expect(out).not.toContain('LINE-A');
  });
});

describe('truncateStatusMessage（P1-8）', () => {
  it('短消息原样返回', () => {
    expect(truncateStatusMessage('Exited with code 1')).toBe('Exited with code 1');
  });

  it('超长时保留头部一行（退出码）+ 末尾（堆栈尾），并插入省略标记', () => {
    const head = 'Exited with code 1; recent app.log:';
    const middle = 'LOG-LINE-'.repeat(3000); // ~27000 chars，远超窗口
    const tail = 'FATAL: TypeError: app crashed at line 999';
    const long = `${head}\n${middle}\n${tail}`;
    const out = truncateStatusMessage(long, 2000);
    expect(out.length).toBeLessThanOrEqual(2000);
    // 头部退出码行保留在最前
    expect(out.startsWith('Exited with code 1')).toBe(true);
    // 末尾根因保留（这正是不能简单"截尾"的原因）
    expect(out).toContain('FATAL: TypeError');
    expect(out).toContain('[truncated]');
  });
});

describe('buildFailedExitMessage（P1-8）', () => {
  it('有 app.log 时同时上报退出码与日志尾部', () => {
    const dir = makeTempDir();
    const f = path.join(dir, 'app.log');
    fs.writeFileSync(f, 'boot ok\n\nError: ENOENT no such file "main.py"\n');
    const msg = buildFailedExitMessage(1, f);
    expect(msg).toContain('Exited with code 1');
    expect(msg).toContain('ENOENT no such file "main.py"');
  });

  it('无 app.log 时退化为退出码（旧行为），不抛错', () => {
    const msg = buildFailedExitMessage(2, path.join(os.tmpdir(), 'nope.log'));
    expect(msg).toBe('Exited with code 2');
  });
});
