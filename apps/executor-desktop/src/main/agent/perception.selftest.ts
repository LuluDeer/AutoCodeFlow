/**
 * P7a（agent-and-deployment）selftest：环境感知层（07 §4 感知层 / §7 ①）。
 *
 * ## 这里钉死的语义
 * `collectEnvironmentReport()` **绝不抛错**——它跑在 Agent 会话的第一步，
 * 抛错等于「Agent 在本机连一次探测都做不了」。而它恰恰是**最容易**抛的
 * 地方：探测的是**本机有没有 python**，`command not found` 是探测的**正常
 * 结果**而不是异常（execFile 的回调会带 err）。若实现把 err 当异常处理，
 * 装了 python 的机器能跑、没装的机器直接崩——正是"环境缺失"这一最需要
 * 探测报告的场景。
 *
 * 同理：探测失败本身就是**环境事实**，必须记为 `available:false`，而不是
 * 让整个报告消失（中台据此做 SOP 可行性预检——10 §建议2："SOP 需要 browser
 * → 该机器没有"应在指派**前**发现）。
 *
 * ## 只读纪律
 * 探测**绝不安装、绝不修改**（试跑阶段才是受控动作）。本测试断言探测前后
 * 工作目录内容不变。
 *
 * Run via: npm run test:main
 */
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { collectEnvironmentReport, type EnvironmentReport } from './perception';

async function main(): Promise<void> {
  const before = fs.readdirSync(process.cwd()).sort();

  let report: EnvironmentReport;
  try {
    report = await collectEnvironmentReport();
  } catch (err) {
    assert.fail(`collectEnvironmentReport() 不得抛错（探测失败是环境事实，不是异常）: ${String(err)}`);
  }

  // ── 1. 基本字段：类型与取值合法性 ────────────────────────────────────
  assert.strictEqual(typeof report.probedAt, 'string');
  assert.ok(!Number.isNaN(Date.parse(report.probedAt)), 'probedAt 必须是可解析的 ISO 时间戳');
  assert.strictEqual(report.platform, os.platform(), 'platform 必须与 os.platform() 一致');
  assert.strictEqual(report.arch, os.arch());
  assert.ok(report.platformRelease.length > 0, 'platformRelease 不得为空');
  assert.ok(report.hostname.length > 0, 'hostname 不得为空');
  assert.ok(report.cpuCount >= 1, 'cpuCount 至少 1');
  assert.ok(report.totalMemoryMB > 0, 'totalMemoryMB 必须为正');
  assert.ok(report.freeMemoryMB >= 0, 'freeMemoryMB 不得为负');
  assert.ok(report.freeMemoryMB <= report.totalMemoryMB, 'freeMemoryMB 不得超过 totalMemoryMB');
  // 整数化：这些值会进 LLM 上下文与中台能力报告，浮点噪声没有价值
  assert.ok(Number.isInteger(report.totalMemoryMB), 'totalMemoryMB 必须是整数（MB）');
  assert.ok(Number.isInteger(report.freeMemoryMB), 'freeMemoryMB 必须是整数（MB）');

  // ── 2. 运行时探测：结构完整，缺失记为 unavailable **而不是消失** ──────
  assert.ok(Array.isArray(report.runtimes), 'runtimes 必须是数组');
  assert.strictEqual(report.runtimes.length, 3, 'P7a 探测 python / python3 / node 三个运行时');
  for (const name of ['python', 'python3', 'node']) {
    const probe = report.runtimes.find((r) => r.name === name);
    assert.ok(probe, `必须包含 ${name} 的探测结果（缺失 = 该运行时"不存在"这条事实被吞掉）`);
    assert.strictEqual(typeof probe!.available, 'boolean');
    if (probe!.available) {
      // 能报版本才算 available——version 不得为空
      assert.ok(
        typeof probe!.version === 'string' && probe!.version.length > 0,
        `${name} 判为 available 时必须带版本号（否则"可用"没有依据）`,
      );
    }
    // 版本串不得无限长（防把整段 stdout 塞进上下文）
    if (typeof probe!.version === 'string') {
      assert.ok(probe!.version.length <= 80, `${name} 版本串必须被裁剪（≤80 字符）`);
    }
  }

  // ── 3. node 必然可用（探测用 process.execPath，不是 PATH 查找）──────────
  const nodeProbe = report.runtimes.find((r) => r.name === 'node')!;
  assert.strictEqual(
    nodeProbe.available,
    true,
    'node 探测走 process.execPath——执行器自身就跑在 node 上，必然可用（若不可用说明探测本身坏了）',
  );

  // ── 4. 能力域自述：P7a 只有 filesystem/http，browser/gui 留 P7b/c ──────
  assert.deepStrictEqual(
    report.capabilities,
    ['filesystem', 'http'],
    'P7a 能力域必须如实自述（声明 browser 会让中台把需要浏览器的 SOP 派过来，然后卡住）',
  );
  assert.ok(
    !report.capabilities.includes('browser'),
    'P7a 未实现浏览器能力，不得声明（10 §建议2：可行性预检依赖这份自述）',
  );

  // ── 5. 只读纪律：探测不写工作目录 ────────────────────────────────────
  const after = fs.readdirSync(process.cwd()).sort();
  assert.deepStrictEqual(
    after,
    before,
    '环境探测必须是只读的——不得在 cwd 留下任何文件（安装属试跑阶段的受控动作）',
  );

  // ── 6. 可序列化（要经 IPC / HTTP 上报中台，不得含循环或不可序列化字段）──
  const round = JSON.parse(JSON.stringify(report)) as EnvironmentReport;
  assert.deepStrictEqual(round, report, 'EnvironmentReport 必须可 JSON 序列化（上报中台的载荷）');

  // ── 7. 探测耗时有界（不得挂住 Agent 会话的第一步）─────────────────────
  //    三个运行时并行探测 + 每个 5s 超时 → 单次采集应远低于串行三倍耗时。
  {
    const t0 = Date.now();
    await collectEnvironmentReport();
    const elapsed = Date.now() - t0;
    assert.ok(
      elapsed < 16_000,
      `collectEnvironmentReport() 必须在有界时间内返回（实测 ${elapsed}ms；三个 5s 超时串行会是 15s+）`,
    );
  }

  console.log('agent/perception selftest: all assertions passed (never throws, unavailable≠missing, read-only)');
}

void main();
