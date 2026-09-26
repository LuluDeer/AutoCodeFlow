/**
 * P7a（agent-and-deployment）selftest：Agent 沙箱工作区（07 §5 / ADR-022）。
 *
 * 用**真实文件系统**验证（不 mock fs：symlink/穿越类缺陷在全 mock 下整体
 * 逃逸，同 app-uninstall.selftest.ts 的处置）。
 *
 * ## 这里防的是什么
 * 「Agent 误删用户文件 / 误改系统配置」——**不是防恶意代码**。07 §5 的诚实
 * 结论：能操作本机已登录软件的 Agent 天然拥有用户权限，L1 沙箱防的是误操作。
 * 所以判据不是「加密得多好」，而是「任何路径都出不去 <workDir>/agent-workspace」。
 *
 * ## 反证形态
 * 每条断言都刻意包含一个「若实现退化成朴素 path.join 就会通过/失败」的载荷：
 *   · `../` 穿越 —— 朴素 join 会折叠出域外路径；
 *   · 绝对路径 / 盘符 / `~` —— 朴素 join 会直接返回该绝对路径；
 *   · symlink 指出域外 —— 只做字符串归一化的实现会放行（故必须 realpath 复核）；
 *   · assignmentId 注入路径 —— 它直接拼进目录名，字符集闸是唯一防线。
 *
 * Run via: npm run test:main
 */
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  AGENT_WORKSPACE_DIRNAME,
  ensureWorkspace,
  isValidAssignmentId,
  listWorkspaceFiles,
  readWorkspaceFile,
  resolveWithinWorkspace,
  writeWorkspaceFile,
} from './workspace';

function main(): void {
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'acf-agent-ws-'));
  const outside = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'acf-agent-out-'));
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'TOP SECRET');

  try {
    // ── 1. assignmentId 字符集闸（它直接拼进路径）───────────────────────
    {
      for (const bad of [
        '',
        '.',
        '..',
        '../..',
        'a/b',
        'a\\b',
        '/abs',
        'C:\\Windows',
        'asg 1',
        'asg;rm -rf',
        null,
        42,
        {},
      ]) {
        assert.strictEqual(
          isValidAssignmentId(bad),
          false,
          `assignmentId ${JSON.stringify(bad)} 必须被拒（它直接拼进工作区路径）`,
        );
      }
      assert.strictEqual(isValidAssignmentId('asg-123'), true);
      assert.strictEqual(isValidAssignmentId('ASG_9-x'), true);
      assert.strictEqual(isValidAssignmentId('a'.repeat(129)), false, '长度上限 128');
    }

    // ── 2. ensureWorkspace：按指派隔离 + 越界 id 抛错而非创建目录 ─────────
    {
      const root = ensureWorkspace(tmp, 'asg-1');
      assert.strictEqual(
        root,
        path.join(tmp, AGENT_WORKSPACE_DIRNAME, 'asg-1'),
        '工作区必须落在 <workDir>/agent-workspace/<assignmentId>',
      );
      assert.strictEqual(fs.existsSync(root), true, '目录必须被真实创建');
      // 幂等：同一指派重复创建不抛
      assert.strictEqual(ensureWorkspace(tmp, 'asg-1'), root);
      // 越界 id：必须**抛错**，绝不静默创建出一个域外目录
      let threw = false;
      try {
        ensureWorkspace(tmp, '../escaped');
      } catch {
        threw = true;
      }
      assert.strictEqual(threw, true, '越界 assignmentId 必须抛错');
      assert.strictEqual(
        fs.existsSync(path.join(tmp, 'escaped')),
        false,
        '越界 assignmentId 不得真的创建出目录',
      );
    }

    const ws = ensureWorkspace(tmp, 'asg-test');
    fs.writeFileSync(path.join(ws, 'seed.txt'), 'seed');

    // ── 3. 路径解析：合法相对路径 → 工作区内 ────────────────────────────
    {
      const ok = resolveWithinWorkspace(ws, 'sub/a.py');
      assert.strictEqual(ok.ok, true);
      if (ok.ok) {
        assert.strictEqual(ok.path, path.join(ws, 'sub', 'a.py'));
        assert.ok(ok.path.startsWith(ws), '解析结果必须在工作区内');
      }
      // '.' 与 './x' 形态
      const dot = resolveWithinWorkspace(ws, '.');
      assert.strictEqual(dot.ok, true);
      const rel = resolveWithinWorkspace(ws, './seed.txt');
      assert.strictEqual(rel.ok, true);
    }

    // ── 4. ★ 穿越载荷一律拒绝（朴素 path.join 会放行每一条）──────────────
    // 平台注记（Linux 侧接管）：POSIX 上反斜杠是普通文件名字符，`..\secret.txt`
    // 解析为工作区内一个字面同名文件、不发生穿越——解析器按平台语义放行是
    // 正确行为（workspace.ts 的域校验本身平台感知）。Windows 反斜杠载荷只在
    // win32 断言拒绝；其跨平台再物质化风险（该文件名进 zip 后在 Windows 解出
    // 穿越）由包写入层的条目名卫生负责，不属于本解析层。
    {
      for (const evil of [
        '../secret.txt',
        '../../secret.txt',
        'sub/../../secret.txt',
      ]) {
        const r = resolveWithinWorkspace(ws, evil);
        assert.strictEqual(r.ok, false, `穿越载荷 ${evil} 必须被拒`);
      }
      if (process.platform === 'win32') {
        const r = resolveWithinWorkspace(ws, '..\\secret.txt');
        assert.strictEqual(r.ok, false, '穿越载荷 ..\\secret.txt 必须被拒（win32）');
      }
    }

    // ── 5. ★ 绝对路径 / 盘符 / home 一律拒绝 ────────────────────────────
    {
      for (const evil of [
        '/etc/passwd',
        'C:\\Windows\\win.ini',
        'D:/data',
        '~/secrets',
        '~',
      ]) {
        const r = resolveWithinWorkspace(ws, evil);
        assert.strictEqual(r.ok, false, `绝对路径类载荷 ${evil} 必须被拒`);
      }
    }

    // ── 6. 非字符串/空值 ────────────────────────────────────────────────
    {
      for (const bad of ['', '   ', null, undefined, 42, {}, []]) {
        const r = resolveWithinWorkspace(ws, bad as never);
        assert.strictEqual(r.ok, false, `非路径输入 ${JSON.stringify(bad)} 必须被拒`);
      }
    }

    // ── 7. ★ symlink 指出域外（只做字符串归一化的实现会放行）─────────────
    {
      // 工作区内放一个指向域外的 symlink
      const link = path.join(ws, 'escape-link');
      try {
        fs.symlinkSync(outside, link, 'junction');
      } catch {
        fs.symlinkSync(outside, link);
      }
      const r = resolveWithinWorkspace(ws, 'escape-link/secret.txt');
      assert.strictEqual(
        r.ok,
        false,
        '经 symlink 逃出工作区的路径必须被拒（必须 realpath 复核，不能只归一化字符串）',
      );
      // 目录形态的 symlink 同样拒绝
      const r2 = resolveWithinWorkspace(ws, 'escape-link');
      assert.strictEqual(r2.ok, false, '指向域外的 symlink 目录本身也必须被拒');

      // ★ 列目录**不得跟随** symlink：否则工作区里的一个链接就能把域外文件
      //   列进 Agent 的观察面，而 resolveWithinWorkspace 只校验输入路径、
      //   管不到 walk 到达的路径——这是 walk 独有的漏洞面。
      const listing = listWorkspaceFiles(ws);
      assert.ok(
        !listing.includes('escape-link'),
        '列目录不得跟随指向域外的 symlink（沙箱可见性边界不得被链接悄悄扩大）',
      );
      assert.ok(
        !listing.some((f) => f.startsWith('escape-link/')),
        '不得列出经 symlink 到达的域外文件',
      );
    }

    // ── 7b. 工作区根不存在时，路径解析必须返回 ok:false 而不是抛 ──────────
    //    realpathSync 在根不存在时抛 ENOENT；本模块契约是「返回 ok:false」——
    //    调用方是 LLM 驱动的路径解析，抛出去即一次会话崩溃。
    {
      const missing = path.join(tmp, 'agent-workspace', 'never-created');
      for (const probe of ['a.py', '.', '../x']) {
        let threw = false;
        let res: { ok: boolean } | null = null;
        try {
          res = resolveWithinWorkspace(missing, probe);
        } catch {
          threw = true;
        }
        assert.strictEqual(threw, false, `工作区不存在时解析 ${probe} 不得抛（ENOENT 必须收敛为 ok:false）`);
        assert.strictEqual(res!.ok, false);
      }
    }

    // ── 8. 读/写：大小上限与类型闸 ──────────────────────────────────────
    {
      // 写：会创建父目录
      const w = writeWorkspaceFile(ws, 'pkg/main.py', 'print("hi")\n');
      assert.strictEqual(w.ok, true);
      assert.strictEqual(fs.readFileSync(path.join(ws, 'pkg', 'main.py'), 'utf8'), 'print("hi")\n');

      // 内容上限 1MB（防超大源码塞爆磁盘/上下文）
      const big = writeWorkspaceFile(ws, 'big.txt', 'x'.repeat(1024 * 1024 + 1));
      assert.strictEqual(big.ok, false, '超过 1MB 的内容必须被拒');
      // 空内容是合法语义（"清空文件"/建空占位），不得与超限混淆；
      // 只有**非字符串**与超限才拒。
      const empty = writeWorkspaceFile(ws, 'empty.txt', '');
      assert.strictEqual(empty.ok, true, '空字符串是合法内容（清空文件），不得被拒');
      assert.strictEqual(
        writeWorkspaceFile(ws, 'bad.txt', undefined as never).ok,
        false,
        '非字符串内容必须被拒',
      );

      // 写越界
      assert.strictEqual(writeWorkspaceFile(ws, '../../pwned.txt', 'x').ok, false);
      assert.strictEqual(fs.existsSync(path.join(tmp, 'pwned.txt')), false, '越界写不得真的落盘');

      // 读：正常 + 越界 + 目录 + 超大
      assert.strictEqual(readWorkspaceFile(ws, 'pkg/main.py').ok, true);
      const outsideRead = readWorkspaceFile(ws, '../seed.txt');
      assert.strictEqual(outsideRead.ok, false);
      const dirRead = readWorkspaceFile(ws, 'pkg');
      assert.strictEqual(dirRead.ok, false, '目录必须被拒（不是普通文件）');
      fs.writeFileSync(path.join(ws, 'huge.txt'), 'y'.repeat(300 * 1024));
      const hugeRead = readWorkspaceFile(ws, 'huge.txt');
      assert.strictEqual(hugeRead.ok, false, '超过 256KB 的文件必须被拒读');
      assert.match(String((hugeRead as { error: string }).error), /too large/);
      // 不存在的文件返回 ok:false 而非抛
      assert.strictEqual(readWorkspaceFile(ws, 'nope.txt').ok, false);
    }

    // ── 9. 列目录：相对路径 + 深度/条目上限 + 越界返回空 ──────────────────
    {
      writeWorkspaceFile(ws, 'pkg/util.py', 'x');
      writeWorkspaceFile(ws, 'pkg/deep/a/b/c/d/e.txt', 'x');
      const files = listWorkspaceFiles(ws);
      assert.ok(files.includes('pkg/main.py'), '应列出 pkg/main.py');
      assert.ok(files.includes('seed.txt'), '应列出 seed.txt');
      // 越界 sub → 空数组（不是抛，也不是列出域外）
      assert.deepStrictEqual(listWorkspaceFiles(ws, '../..'), []);
      // 深度上限 4：超深的条目不出现（防环形/超深目录拖垮探测）
      assert.ok(
        !files.some((f) => f.split('/').length > 6),
        '列目录深度必须受限（防超深/环形目录拖垮探测）',
      );
      // 不存在的 sub → 空
      assert.deepStrictEqual(listWorkspaceFiles(ws, 'nope'), []);
      // 排序稳定（供 LLM 观察自身产物时的输出可复现）
      assert.deepStrictEqual(files, [...files].sort());
    }

    // ── 10. 不同指派之间互不可见（隔离是沙箱的语义）──────────────────────
    {
      const other = ensureWorkspace(tmp, 'asg-other');
      writeWorkspaceFile(other, 'other.txt', 'other assignment');
      const cross = resolveWithinWorkspace(ws, '../asg-other/other.txt');
      assert.strictEqual(cross.ok, false, '指派 A 的工作区不得解析到指派 B 的文件');
      assert.strictEqual(readWorkspaceFile(ws, '../asg-other/other.txt').ok, false);
    }

    console.log('agent/workspace selftest: all assertions passed (containment, symlink escape, size caps)');
  } finally {
    for (const dir of [tmp, outside]) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  }
}

main();
