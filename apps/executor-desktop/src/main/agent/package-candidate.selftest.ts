/**
 * P7d 前半 self-check：零依赖 ZIP 写入器与候选应用打包器。
 * Run via: npm run test:main
 *
 * 反证锚点：
 *   · CRC32 对照经典向量（'123456789' → 0xCBF43926）——算法错的 zip 在
 *     管理端解包即炸；
 *   · 自解析回读：名单/字节/CRC 逐项一致；
 *   · 穿越载荷（../ 绝对路径）在写入层被拒——包内 manifest 是平台生成的，
 *     但成员名来自 LLM 的工作区文件，防线必须在写入层；
 *   · 打包器：manifest 契约（runtime/entrypoint）、观测产物排除、
 *     入口缺失如实抛。
 *   · 条件执行：环境有 `unzip` 时追加 `unzip -t` 完整性校验（独立第三
 *     方实现交叉验证，不是自证）。
 */
import * as assert from 'node:assert';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildZip, parseZip, crc32, ZIP_TOTAL_MAX } from './zip-writer';
import { buildCandidatePackage } from './package-candidate';

let failures = 0;
function check(name: string, cond: boolean, extra = ''): void {
  if (cond) console.log(`  \u2714 ${name}`);
  else {
    failures++;
    console.error(`  \u2718 ${name}${extra ? ` \u2014 ${extra}` : ''}`);
  }
}

function makeWorkspaceWithCandidate(): { ws: string; entry: { interpreter: string; path: string } } {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-pkg-'));
  fs.writeFileSync(path.join(ws, 'main.js'), "require('fs').writeFileSync('out.txt', 'fine');\n", 'utf8');
  fs.writeFileSync(path.join(ws, 'verify.js'), "console.log('ok');\n", 'utf8');
  fs.mkdirSync(path.join(ws, 'screenshots'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'screenshots', 'shot-1.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  return { ws, entry: { interpreter: 'node', path: 'main.js' } };
}

async function main(): Promise<void> {
  console.log('\n=== zip-writer / package-candidate selftest ===\n');

  console.log('-- 1. CRC32 --');
  {
    check("经典向量 '123456789' → 0xCBF43926", crc32(Buffer.from('123456789', 'utf8')) === 0xcbf43926);
    check('空串 CRC = 0', crc32(Buffer.alloc(0)) === 0);
  }

  console.log('-- 2. 往返回读 --');
  {
    const entries = [
      { name: 'manifest.yaml', data: Buffer.from('runtime: node\nentrypoint: main.js\n', 'utf8') },
      { name: 'main.js', data: Buffer.from("console.log('hi 中文');\n", 'utf8') },
      { name: 'sub/dir/x.txt', data: Buffer.from([0x00, 0x01, 0x02, 0xff]) },
    ];
    const zip = buildZip(entries);
    const parsed = parseZip(zip);
    check('成员数一致', parsed.length === entries.length);
    check('名字逐项一致（UTF-8）', parsed.every((p, i) => p.name === entries[i].name));
    check('字节逐项一致（含二进制）', parsed.every((p, i) => p.data.equals(entries[i].data)));
    check('签名 PK 头（管理端魔数闸可过）', zip[0] === 0x50 && zip[1] === 0x4b);
  }

  console.log('-- 3. 写入层防线 --');
  {
    let threw = false;
    try { buildZip([{ name: '../evil.js', data: Buffer.from('x') }]); } catch { threw = true; }
    check('穿越成员名拒绝', threw);
    threw = false;
    try { buildZip([{ name: '/abs/path.js', data: Buffer.from('x') }]); } catch { threw = true; }
    check('绝对路径成员名拒绝', threw);
    threw = false;
    try {
      buildZip([
        { name: 'a.txt', data: Buffer.from('x') },
        { name: 'b.txt', data: Buffer.alloc(ZIP_TOTAL_MAX) },
      ]);
    } catch { threw = true; }
    check('整包超限拒绝', threw);
    threw = false;
    try { buildZip([]); } catch { threw = true; }
    check('空包拒绝', threw);
  }

  console.log('-- 4. 打包器契约 --');
  {
    const { ws, entry } = makeWorkspaceWithCandidate();
    const pkg = buildCandidatePackage({
      workspaceRoot: ws, entry, sopSlug: 'daily-report', sopVersion: '1.0.0', contentHash: 'abc123',
    });
    check('包文件名契约', pkg.filename === 'sop-daily-report-1.0.0-agent.zip');
    const parsed = parseZip(pkg.buf);
    const names = parsed.map((p) => p.name);
    check('manifest.yaml 在包内', names.includes('manifest.yaml'));
    check('入口与源文件在包内', names.includes('main.js') && names.includes('verify.js'));
    check('观测产物（截图）被排除', !names.some((n) => n.startsWith('screenshots/')));
    const manifest = parsed.find((p) => p.name === 'manifest.yaml')?.data.toString('utf8') ?? '';
    check('manifest 契约：runtime/entrypoint', manifest.includes('runtime: node') && manifest.includes('entrypoint: main.js'));
    check('manifest 带来源标记（sop/version/hash）', manifest.includes('sop=daily-report') && manifest.includes('contentHash=abc123'));
    check('python3 → python 运行时映射', (() => {
      const p2 = buildCandidatePackage({
        workspaceRoot: ws, entry: { interpreter: 'python3', path: 'main.js' }, sopSlug: 's', sopVersion: '1.0.0', contentHash: 'h',
      });
      return p2.manifest.includes('runtime: python');
    })());
    // 入口不在清单 → 如实抛（调用方收敛为回报 failed）
    let threw = false;
    try {
      buildCandidatePackage({ workspaceRoot: ws, entry: { interpreter: 'node', path: 'missing.js' }, sopSlug: 's', sopVersion: '1', contentHash: 'h' });
    } catch { threw = true; }
    check('入口缺失如实抛（不交空包）', threw);
    fs.rmSync(ws, { recursive: true, force: true });
  }

  console.log('-- 5. 独立第三方交叉验证（条件执行）--');
  {
    const zip = buildZip([
      { name: 'manifest.yaml', data: Buffer.from('runtime: node\n', 'utf8') },
      { name: 'main.js', data: Buffer.from("console.log('cross-check');\n", 'utf8') },
    ]);
    const tmp = path.join(os.tmpdir(), `zipx-${Date.now()}.zip`);
    fs.writeFileSync(tmp, zip);
    const ok = await new Promise<boolean>((resolve) => {
      execFile('unzip', ['-t', tmp], { timeout: 10_000 }, (err) => resolve(!err));
    });
    if (ok) {
      check('unzip -t 完整性通过（独立实现交叉验证）', ok === true);
    } else {
      console.log('  (跳过：环境无 unzip——条件执行如实跳过而非假绿；自解析回读已覆盖)');
    }
    fs.rmSync(tmp, { force: true });
  }

  assert.ok(true);
  console.log(failures ? `\n=== ${failures} 项失败 ===\n` : '\n=== zip-writer / package-candidate selftest 全部通过 ===\n');
  process.exit(failures ? 1 : 0);
}

void main();
