/**
 * NETOPT-2⑧ selftest：执行器降优先级走 os.setPriority 而非一次性 spawn powershell。
 *
 * 背景：ExecutorProcess.start() 此前在 Windows 下 spawn('powershell', …
 * "(Get-Process -Id N).PriorityClass = 'BelowNormal'")——每次启动执行器都
 * 拉起一个 PowerShell 进程（冷启动数百 ms～秒级 CPU、一闪而过的黑窗风险），
 * 只为一条 API 调用。改为 Node 内建 os.setPriority（同步、零进程开销），
 * try/catch 保留 best-effort 语义（失败仅 warn 不阻断启动）。
 *
 * 逻辑本体嵌在 Electron 耦合的类里无法直接驱动（同 updater.selftest.ts 的
 * 处置），按仓库自检惯例用 SYNC 守卫钉住源码形态：正向断言 os.setPriority
 * 接线存在，负向断言 powershell 降优先级旧模式不再回归。
 *
 * Run via: npm run test:main
 */
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

// 路径解析：本文件编译到 dist-selftest/，源码在同级 src/main。
const procSourcePath = path.join(__dirname, '..', 'src', 'main', 'executor-process.ts');
const procSource = fs.readFileSync(procSourcePath, 'utf-8');

// 正向：os.setPriority 接线齐全（import、调用、BELOW_NORMAL 常量、best-effort warn）
for (const needle of [
  "import * as os from 'os';",
  'os.setPriority(this.proc.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);',
  'Failed to set executor priority to BelowNormal',
]) {
  assert.ok(procSource.includes(needle), `SYNC: executor-process.ts 缺少 setPriority 接线片段: ${needle}`);
}

// 负向：powershell 降优先级旧模式不得回归
assert.ok(
  !procSource.includes('PriorityClass'),
  'SYNC: executor-process.ts 出现 powershell PriorityClass 旧模式（NETOPT-2⑧ 回归）',
);
assert.ok(
  !/spawn\(\s*'powershell'/.test(procSource),
  'SYNC: executor-process.ts 仍 spawn powershell（NETOPT-2⑧ 回归）',
);

console.log('executor-priority selftest: all assertions passed (setPriority wiring + powershell regression guard)');
