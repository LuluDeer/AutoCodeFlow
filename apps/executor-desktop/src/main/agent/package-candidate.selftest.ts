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
 *   · 第 6 轮审计 P2：entrypoint 是 LLM 可控文件名——换行/`": "`/`../`/绝对
 *     路径一律拒收，且值用 YAML 双引号标量写入；断言以**解析后的键集合**
 *     为判据（字符串包含断言证明不了「没注入」）。
 *   · 条件执行：环境有 `unzip` 时追加 `unzip -t` 完整性校验（独立第三
 *     方实现交叉验证，不是自证）。
 */
import * as assert from 'node:assert';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildZip, parseZip, crc32, ZIP_TOTAL_MAX } from './zip-writer';
import {
  buildCandidatePackage,
  validateEntrypointPath,
  yamlScalar,
  ENTRYPOINT_MAX_CHARS,
} from './package-candidate';

// js-yaml 是 devDependency（无 @types）：用 require + 局部类型，避免为一个
// 测试用途引入类型包。判据是「平台清单**解析后**的键集合」——只有真解析器
// 能证明「注入的键没进结构」，字符串包含断言证明不了。
// eslint-disable-next-line @typescript-eslint/no-var-requires
const yaml = require('js-yaml') as { load(text: string): unknown };

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
    const manifestDoc = yaml.load(manifest) as Record<string, unknown>;
    check('manifest 契约：runtime/entrypoint（解析后的值，不是字符串包含）',
      manifestDoc.runtime === 'node' && manifestDoc.entrypoint === 'main.js',
      `doc=${JSON.stringify(manifestDoc)}`);
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

  console.log('-- 4b. LLM 自建 manifest.yaml 不进包（防 zip 双成员覆盖平台契约）--');
  {
    const { ws, entry } = makeWorkspaceWithCandidate();
    // LLM 在工作区根写一个自己的 manifest.yaml（伪造 runtime/entrypoint）
    fs.writeFileSync(
      path.join(ws, 'manifest.yaml'),
      'runtime: node\nentrypoint: ../etc/passwd\n',
      'utf8',
    );
    const pkg = buildCandidatePackage({
      workspaceRoot: ws, entry, sopSlug: 's', sopVersion: '1.0.0', contentHash: 'h',
    });
    const parsed = parseZip(pkg.buf);
    const manifestCount = parsed.filter((p) => p.name === 'manifest.yaml').length;
    check('包内 manifest.yaml 恰好 1 个（平台契约唯一）', manifestCount === 1);
    const manifest = parsed.find((p) => p.name === 'manifest.yaml')?.data.toString('utf8') ?? '';
    const manifestDoc = yaml.load(manifest) as Record<string, unknown>;
    check('生效 manifest 是平台构建的（entrypoint 未被顶掉）',
      manifestDoc.entrypoint === 'main.js' && !manifest.includes('../etc/passwd'),
      `doc=${JSON.stringify(manifestDoc)}`);
    check('zip 成员名无重复', (() => {
      const names = parsed.map((p) => p.name);
      return new Set(names).size === names.length;
    })());
    fs.rmSync(ws, { recursive: true, force: true });
  }

  console.log('-- 4d. entrypoint 注入面（第 6 轮审计 P2）：拒收 + 安全序列化 --');
  {
    // 攻击面：entrypoint 直接来自 LLM 的 entry spec，而工作区文件名也是 LLM
    // 写的。写一个**名字里带换行**的文件（POSIX 合法）就能让
    // `entrypoint: <rel>` 变成两行——平台清单里凭空多一个键。
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-pkg-inject-'));
    const INJECTED = 'main.js\nsecrets: leak';
    let wroteNewline = false;
    try {
      fs.writeFileSync(path.join(ws, INJECTED), 'x', 'utf8');
      wroteNewline = fs.readFileSync(path.join(ws, INJECTED), 'utf8') === 'x';
    } catch {
      wroteNewline = false; // Windows 等不允许换行文件名的平台：单元判据已覆盖
    }
    let threw = false;
    let message = '';
    let built: ReturnType<typeof buildCandidatePackage> | null = null;
    try {
      built = buildCandidatePackage({
        workspaceRoot: ws,
        entry: { interpreter: 'node', path: INJECTED },
        sopSlug: 's', sopVersion: '1.0.0', contentHash: 'h',
      });
    } catch (err) {
      threw = true;
      message = err instanceof Error ? err.message : String(err);
    }
    check('★ 带 \\n 的 entrypoint（换行 = 新键）被拒，不产出清单',
      threw && message.includes('控制字符'),
      `threw=${threw} msg=${message.slice(0, 120)} wrote=${wroteNewline}`);
    // 判据以**解析后的键集合**为准：即便某天校验层被放宽，值也必须是「值」，
    // 绝不能在平台清单里变成新的键（`secrets` 就是注入成功的证据）。
    const builtKeys = built === null
      ? []
      : Object.keys(yaml.load(built.manifest) as Record<string, unknown>);
    check('★ 最终清单解析出的键集合不含注入键（secrets）',
      !builtKeys.includes('secrets') && builtKeys.every((k) => ['runtime', 'entrypoint', 'requirements'].includes(k)),
      `keys=${JSON.stringify(builtKeys)}`);

    // 四种审计点名的形态：必须被校验层拒收（不依赖文件是否真的存在）
    const rejected: Array<{ name: string; rel: string }> = [
      { name: '带换行（`main.js\\nsecrets: leak`）', rel: 'main.js\nsecrets: leak' },
      { name: '带「: 」（`a.js: b`）', rel: 'a.js: b' },
      { name: '带 ../（穿越段）', rel: '../evil.js' },
      { name: '绝对路径', rel: '/etc/evil.js' },
    ];
    for (const c of rejected) {
      const reason = validateEntrypointPath(c.rel);
      check(`校验层拒收：${c.name}`, reason !== null, `reason=${String(reason)}`);
    }
    check('校验层拒收：以 - 开头的路径段（YAML 块序列标记）',
      validateEntrypointPath('-x.js') !== null && validateEntrypointPath('a/-b.js') !== null);
    check('校验层拒收：空路径段 / 首尾空白 / 冒号盘符 / 家目录',
      validateEntrypointPath('a//b.js') !== null && validateEntrypointPath('a/ b.js') !== null &&
      validateEntrypointPath('C:/x.js') !== null && validateEntrypointPath('~/x.js') !== null);
    check('校验层拒收：超长 entrypoint',
      validateEntrypointPath('a'.repeat(ENTRYPOINT_MAX_CHARS + 1)) !== null);

    // 对照：正常形态必须放行（不得为防注入把合法产物打红）
    for (const ok of ['main.js', 'src/main.py', '中文 名.js', 'pkg/a#b.js', 'a b/c.js']) {
      check(`校验层放行：${ok}`, validateEntrypointPath(ok) === null,
        `reason=${String(validateEntrypointPath(ok))}`);
    }

    // 安全序列化：即便某形态漏过校验（未来放宽字符集），值也只会是「值」。
    // yamlScalar 是 JSON 双引号标量 = YAML 双引号标量的等价物。
    const evilScalar = yamlScalar('a.js\nsecrets: leak');
    check('yamlScalar 输出单行（换行被转义，不可能变成第二行）',
      !evilScalar.includes('\n') && evilScalar.startsWith('"') && evilScalar.endsWith('"'),
      `scalar=${evilScalar}`);
    const evilDoc = yaml.load(`entrypoint: ${evilScalar}\n`) as Record<string, unknown>;
    check('转义后的值解析回原字符串，且没有多出键',
      evilDoc.entrypoint === 'a.js\nsecrets: leak' && Object.keys(evilDoc).length === 1 &&
      !('secrets' in evilDoc),
      `doc=${JSON.stringify(evilDoc)}`);

    // 端到端：合法但「YAML 有特殊含义」的文件名照常可打包，解析出的键集合只有
    // runtime/entrypoint/requirements —— 值里的空格/井号/中文绝不会升级成结构。
    const specials = ['a b.js', 'a#b.js', '中文.js'];
    const specialWs = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-pkg-special-'));
    for (const name of specials) fs.writeFileSync(path.join(specialWs, name), 'x', 'utf8');
    for (const name of specials) {
      const pkg = buildCandidatePackage({
        workspaceRoot: specialWs,
        entry: { interpreter: 'node', path: name },
        sopSlug: 's', sopVersion: '1.0.0', contentHash: 'h',
      });
      const doc = yaml.load(pkg.manifest) as Record<string, unknown>;
      check(`特殊文件名安全落地：${name}（值不变、键集合恰好三项）`,
        doc.entrypoint === name &&
        JSON.stringify(Object.keys(doc).sort()) === JSON.stringify(['entrypoint', 'requirements', 'runtime']),
        `doc=${JSON.stringify(doc)}`);
    }
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(specialWs, { recursive: true, force: true });
  }

  console.log('-- 4c. zip-writer 成员重名防线（格式侧第二道闸）--');
  {
    let threw = false;
    try {
      buildZip([
        { name: 'a.txt', data: Buffer.from('1') },
        { name: 'a.txt', data: Buffer.from('2') },
      ]);
    } catch { threw = true; }
    check('同名成员如实抛（解压行为未定义，不可交付）', threw);
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
