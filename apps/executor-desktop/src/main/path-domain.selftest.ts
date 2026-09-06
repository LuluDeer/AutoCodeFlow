/**
 * R13 self-check for path-domain.ts (node:assert, no test runner needed).
 * Run via: npm run test:main   (compiles with tsconfig.selftest.json, then node)
 */
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  checkPathWithinDomains,
  hasAllowedLogExtension,
  isValidExecutionId,
} from './path-domain';

function samePath(a: string | undefined, b: string): boolean {
  if (a === undefined) return false;
  return process.platform === 'win32'
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;
}

function main(): void {
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'acf-path-domain-'));
  try {
    const workDir = path.join(tmp, 'work');
    const logsDir = path.join(workDir, 'logs');
    const appsDir = path.join(workDir, 'apps');
    const userDataLogs = path.join(tmp, 'userData', 'logs');
    const dayDir = path.join(logsDir, '2026-09-06');
    fs.mkdirSync(dayDir, { recursive: true });
    fs.mkdirSync(path.join(appsDir, 'appA', 'dep1'), { recursive: true });
    fs.mkdirSync(userDataLogs, { recursive: true });

    const taskLog = path.join(dayDir, 'exec-1.log');
    fs.writeFileSync(taskLog, 'hello');
    const appLog = path.join(appsDir, 'appA', 'dep1', 'app.log');
    fs.writeFileSync(appLog, 'x');
    const mainLog = path.join(userDataLogs, 'main.log');
    fs.writeFileSync(mainLog, 'x');
    const secret = path.join(tmp, 'secret.txt');
    fs.writeFileSync(secret, 'top secret');

    const domains = [logsDir, appsDir, userDataLogs];

    // ── 域内放行 ──────────────────────────────────────────
    assert.equal(checkPathWithinDomains(taskLog, domains).ok, true, 'task log in workDir/logs');
    assert.equal(checkPathWithinDomains(appLog, domains).ok, true, 'app log in workDir/apps');
    assert.equal(checkPathWithinDomains(mainLog, domains).ok, true, 'main.log in userData/logs');
    // 域内、文件尚不存在（未来的日期目录）→ 放行，由调用方处理 ENOENT
    assert.equal(
      checkPathWithinDomains(path.join(logsDir, '2026-09-07', 'exec-2.log'), domains).ok,
      true,
      'non-existent file inside domain',
    );
    // 域根目录本身还不存在（首次运行前 workDir/logs 未建）→ 仍可作为域使用
    const freshRoot = path.join(tmp, 'fresh', 'logs');
    assert.equal(
      checkPathWithinDomains(path.join(freshRoot, 'a.log'), [freshRoot]).ok,
      true,
      'non-existent domain root',
    );
    // 返回的 resolvedPath 已做路径规范化（.. 折叠）
    const withDotDot = `${dayDir}${path.sep}..${path.sep}2026-09-06${path.sep}exec-1.log`;
    const norm = checkPathWithinDomains(withDotDot, domains);
    assert.equal(norm.ok, true, 'in-domain path with .. segment');
    assert.ok(samePath(norm.resolvedPath, taskLog), 'resolvedPath normalized');

    // ── 域外拒绝 ──────────────────────────────────────────
    assert.equal(checkPathWithinDomains(secret, domains).ok, false, 'arbitrary outside file');
    assert.equal(
      checkPathWithinDomains(path.join(logsDir, '..', '..', 'secret.txt'), domains).ok,
      false,
      'traversal via joined ../',
    );
    assert.equal(
      checkPathWithinDomains(`${logsDir}${path.sep}..${path.sep}..${path.sep}secret.txt`, domains).ok,
      false,
      'traversal via raw ../ segments',
    );
    // 前缀相似但非包含关系（logs vs logsX）
    assert.equal(
      checkPathWithinDomains(path.join(workDir, 'logsX', 'a.log'), domains).ok,
      false,
      'sibling dir sharing name prefix',
    );
    // workDir 根本身不在域内（只允许 logs/apps 子域）
    assert.equal(checkPathWithinDomains(path.join(workDir, 'meta', 'x.json'), domains).ok, false);
    // 非法入参
    assert.equal(checkPathWithinDomains('', domains).ok, false, 'empty string');
    assert.equal(checkPathWithinDomains('   ', domains).ok, false, 'blank string');
    assert.equal(checkPathWithinDomains(undefined as any, domains).ok, false, 'undefined');
    assert.equal(checkPathWithinDomains(123 as any, domains).ok, false, 'number');
    assert.equal(checkPathWithinDomains(taskLog, []).ok, false, 'no domains configured');
    // 拒绝时给出明确错误信息
    const denied = checkPathWithinDomains(secret, domains);
    assert.equal(denied.ok, false);
    assert.ok(typeof denied.error === 'string' && denied.error.length > 0, 'error message present');

    // ── executionId 白名单（与 admin-api 心跳消毒口径一致）──
    assert.equal(isValidExecutionId('exec-1'), true);
    assert.equal(isValidExecutionId('Task_2026-09-06_A1'), true);
    assert.equal(isValidExecutionId('../../etc/passwd'), false, 'traversal id');
    assert.equal(isValidExecutionId('a..b'), false, 'dot sequence');
    assert.equal(isValidExecutionId('a/b'), false, 'forward slash');
    assert.equal(isValidExecutionId('a\\b'), false, 'backslash');
    assert.equal(isValidExecutionId('a.log'), false, 'dot');
    assert.equal(isValidExecutionId(''), false, 'empty');
    assert.equal(isValidExecutionId('a b'), false, 'space');
    assert.equal(isValidExecutionId('a;rm -rf'), false, 'shell metachars');
    assert.equal(isValidExecutionId(undefined as any), false);
    assert.equal(isValidExecutionId(42 as any), false);

    // ── open-file 后缀限制 ────────────────────────────────
    assert.equal(hasAllowedLogExtension('exec-1.log'), true);
    assert.equal(hasAllowedLogExtension('main.LOG'), true, 'case-insensitive');
    assert.equal(hasAllowedLogExtension('notes.txt'), true);
    assert.equal(hasAllowedLogExtension('evil.bat'), false, 'bat = executable on Windows');
    assert.equal(hasAllowedLogExtension('shortcut.lnk'), false, 'lnk = executable on Windows');
    assert.equal(hasAllowedLogExtension('tool.exe'), false, 'exe');
    assert.equal(hasAllowedLogExtension('script.ps1'), false, 'powershell');
    assert.equal(hasAllowedLogExtension('noext'), false, 'no extension');
    // 双重后缀伪装：.log 结尾但实际是别的？extname 取最后一段，'a.bat.log' 可打开（内容即 .log），
    // 'a.log.bat' 必须拒绝
    assert.equal(hasAllowedLogExtension('a.bat.log'), true);
    assert.equal(hasAllowedLogExtension('a.log.bat'), false);

    console.log(`path-domain selftest: all assertions passed (${tmp})`);
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

main();
