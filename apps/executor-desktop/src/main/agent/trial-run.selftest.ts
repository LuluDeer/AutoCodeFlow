/**
 * P7a 续批 self-check：试跑执行体（process 沙箱）的闸门与行为。
 * Run via: npm run test:main
 *
 * 反证锚点：
 *   · codeExecution=off 拒绝执行——off 是高合规档，绕过它该档形同虚设；
 *   · 解释器封闭枚举——LLM 要求跑 bash/cmd 一律拒；
 *   · 入口路径域——穿越载荷在解析层被拒；
 *   · env 白名单——父进程的"凭据"变量绝不出现在子进程；
 *   · 超时与输出上限——失控进程被收敛而不是拖垮执行器。
 */
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runTrialInSandbox, buildTrialEnv, parseAcceptanceCommand, TRIAL_OUTPUT_CAP } from './trial-run';

let failures = 0;
function check(name: string, cond: boolean, extra = ''): void {
  if (cond) console.log(`  \u2714 ${name}`);
  else {
    failures++;
    console.error(`  \u2718 ${name}${extra ? ` \u2014 ${extra}` : ''}`);
  }
}

function makeWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-trial-'));
  // node 入口脚本：打印 + 写文件（验证 cwd 与读写都在工作区内）
  fs.writeFileSync(
    path.join(root, 'main.js'),
    [
      "const fs = require('fs');",
      "fs.writeFileSync('out.txt', 'produced ' + (process.env.AGENT_TEST_SECRET === undefined ? 'no-secret' : 'LEAKED'), 'utf8');",
      "console.log('trial stdout line');",
      "console.error('trial stderr line');",
    ].join('\n'),
    'utf8',
  );
  // 验收脚本：exit 0
  fs.writeFileSync(path.join(root, 'verify.js'), "console.log('acceptance ok');\n", 'utf8');
  // 验收脚本：exit 3
  fs.writeFileSync(path.join(root, 'verify_fail.js'), "process.exit(3);\n", 'utf8');
  return root;
}

async function main(): Promise<void> {
  console.log('\n=== trial-run selftest ===\n');

  // ── 1. 档位闸 ──
  console.log('-- 1. 档位闸 --');
  {
    const ws = makeWorkspace();
    const off = await runTrialInSandbox({
      workspaceRoot: ws, interpreter: 'node', entryPath: 'main.js', codeExecution: 'off',
    });
    check('codeExecution=off 拒绝（不执行）', off.ok === false && off.refusal !== undefined && off.exitCode === null);

    const host = await runTrialInSandbox({
      workspaceRoot: ws, interpreter: 'node', entryPath: 'main.js', codeExecution: 'host',
    });
    check('codeExecution=host 如实拒绝（P7a 未实现，不静默降级）', host.ok === false && host.refusal !== undefined && host.refusal.includes('尚未实现'));

    fs.rmSync(ws, { recursive: true, force: true });
  }

  // ── 2. 解释器封闭枚举 ──
  console.log('-- 2. 解释器封闭枚举 --');
  {
    const ws = makeWorkspace();
    for (const evil of ['bash', 'cmd', 'powershell', 'sh', '../../python', 'node.exe -e']) {
      const r = await runTrialInSandbox({
        workspaceRoot: ws, interpreter: evil, entryPath: 'main.js', codeExecution: 'sandbox',
      });
      check(`解释器 ${JSON.stringify(evil)} 被拒`, r.ok === false && r.refusal !== undefined && r.refusal.includes('封闭枚举'));
    }
    fs.rmSync(ws, { recursive: true, force: true });
  }

  // ── 3. 入口路径域 ──
  console.log('-- 3. 入口路径域 --');
  {
    const ws = makeWorkspace();
    for (const evil of ['../outside.js', 'C:\\Windows\\notepad.exe', '/etc/passwd', '~/x.js', 'a/../b.js']) {
      const r = await runTrialInSandbox({
        workspaceRoot: ws, interpreter: 'node', entryPath: evil, codeExecution: 'sandbox',
      });
      check(`入口 ${JSON.stringify(evil)} 被拒`, r.ok === false && r.refusal !== undefined);
    }
    fs.rmSync(ws, { recursive: true, force: true });
  }

  // ── 4. 真实执行（node 恒可用：ELECTRON_RUN_AS_NODE 兼容两种宿主）──
  console.log('-- 4. 真实执行 --');
  {
    const ws = makeWorkspace();
    // 先在父进程注入伪凭据——env 白名单若失效，子进程会看到它（LEAKED）
    process.env.AGENT_TEST_SECRET = 'supersecret-value';
    const r = await runTrialInSandbox({
      workspaceRoot: ws, interpreter: 'node', entryPath: 'main.js', codeExecution: 'sandbox',
    });
    check('node 脚本执行成功', r.ok === true && r.exitCode === 0, `refusal=${r.refusal ?? '-'} stderr=${r.stderr.slice(0, 120)}`);
    check('stdout/stderr 如实捕获', r.stdout.includes('trial stdout line') && r.stderr.includes('trial stderr line'));
    const out = fs.readFileSync(path.join(ws, 'out.txt'), 'utf8');
    check('cwd 锁定在工作区（产物落对位置）', out === 'produced no-secret', `out=${out}`);
    check('env 白名单：父进程的"凭据"变量未泄漏', !out.includes('LEAKED'));

    // env 白名单直接断言：子进程 env 只含白名单 + 强制编码变量
    const env = buildTrialEnv('node');
    check('env 白名单不含 token/secret 类键', Object.keys(env).every((k) => !/token|secret|key|credential/i.test(k)));
    check('env 强制 PYTHONUTF8（I18N-01 教训）', env.PYTHONUTF8 === '1');
    check('node 解释器带 ELECTRON_RUN_AS_NODE（Electron 双环境一致）', env.ELECTRON_RUN_AS_NODE === '1');
    delete process.env.AGENT_TEST_SECRET;
    fs.rmSync(ws, { recursive: true, force: true });
  }

  // ── 5. 超时 ──
  console.log('-- 5. 超时 --');
  {
    const ws = makeWorkspace();
    fs.writeFileSync(path.join(ws, 'spin.js'), 'const t = Date.now(); while (Date.now() - t < 30000) { /* spin */ }\n', 'utf8');
    const r = await runTrialInSandbox({
      workspaceRoot: ws, interpreter: 'node', entryPath: 'spin.js', timeoutMs: 1000, codeExecution: 'sandbox',
    });
    check('失控脚本被超时终止', r.ok === false && r.timedOut === true && r.durationMs < 10_000, `duration=${r.durationMs}`);
    check('超时注记进 stderr', r.stderr.includes('试跑超时'));
    fs.rmSync(ws, { recursive: true, force: true });
  }

  // ── 6. 输出上限 ──
  console.log('-- 6. 输出上限 --');
  {
    const ws = makeWorkspace();
    fs.writeFileSync(path.join(ws, 'flood.js'), `console.log('x'.repeat(${TRIAL_OUTPUT_CAP * 2}));\n`, 'utf8');
    const r = await runTrialInSandbox({
      workspaceRoot: ws, interpreter: 'node', entryPath: 'flood.js', codeExecution: 'sandbox',
    });
    check('超限输出被截断且进程正常收敛', r.truncated === true && r.stdout.length < TRIAL_OUTPUT_CAP * 2 && r.stdout.includes('已截断'));
    fs.rmSync(ws, { recursive: true, force: true });
  }

  // ── 7. acceptance 命令解析 ──
  console.log('-- 7. acceptance 命令解析 --');
  {
    const ok = parseAcceptanceCommand('node verify.js --strict');
    check('合法形态解析（解释器 + 脚本 + 参数）', ok.ok === true && ok.ok && ok.interpreter === 'node' && ok.args.join(' ') === 'verify.js --strict');
    const quoted = parseAcceptanceCommand('node "my script.js" "a b"');
    check('双引号成组', quoted.ok === true && quoted.ok && quoted.args[0] === 'my script.js');
    for (const evil of ['bash verify.sh', 'rm -rf /', 'python -c "import os"', '']) {
      const r = parseAcceptanceCommand(evil);
      check(`acceptance ${JSON.stringify(evil.slice(0, 24))} 被拒`, r.ok === false);
    }
    // 验收执行：过与不过
    const ws = makeWorkspace();
    const pass = await runTrialInSandbox({
      workspaceRoot: ws, interpreter: 'node', entryPath: 'verify.js', codeExecution: 'sandbox',
    });
    const fail = await runTrialInSandbox({
      workspaceRoot: ws, interpreter: 'node', entryPath: 'verify_fail.js', codeExecution: 'sandbox',
    });
    check('验收 exit 0 → ok', pass.ok === true);
    check('验收 exit 3 → 不 ok', fail.ok === false && fail.exitCode === 3);
    fs.rmSync(ws, { recursive: true, force: true });
  }

  console.log(failures ? `\n=== ${failures} 项失败 ===\n` : '\n=== trial-run selftest 全部通过 ===\n');
  process.exit(failures ? 1 : 0);
}

void main();
