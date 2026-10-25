/**
 * P1-1 / P3-2 / P3-5 self-check：配置存储的落盘卫生决策层（node:assert，无测试
 * 框架）。config-recovery.ts 是纯模块（fs/path + 注入面，无 electron 依赖），
 * 这里用真实临时目录 + 假 store 构造器逐分支驱动真实实现。
 * Run via: npm run test:main
 *
 * 覆盖：
 *  - P1-1 quarantineCorruptConfigFile：坏文件改名 .corrupt-<ts> 留证、
 *    原路径消失、内容原样保留；文件缺失 no-op；
 *  - P1-1 createStoreToleratingCorruption：坏 JSON 输入 → 构造成功、坏文件
 *    被改名留证、重建后返回默认配置；非 SyntaxError 不做恢复直接上抛；
 *  - P3-2 hardenConfigFilePermissions：0600 生效、缺文件静默 false
 *    （Windows 无 POSIX 权限位，该组断言只在 POSIX 下跑）；
 *  - P3-5 validateWorkDirForSave：绝对路径/存在目录/不存在可建/文件/只读/
 *    相对路径/空值放行各分支（注入 fs，不碰真实磁盘）；
 *  - 接线守卫：config-store.ts / ipc-handlers.ts / crash-guard.ts 的修复
 *    锚点被静默拆除即红。
 */
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createStoreToleratingCorruption,
  hardenConfigFilePermissions,
  quarantineCorruptConfigFile,
  validateWorkDirForSave,
} from './config-recovery';

/** 断言辅助：verdict 必须失败且 error 文案含关键字。 */
function assertRejected(
  verdict: { ok: true } | { ok: false; error: string },
  keyword: string,
  message: string,
): void {
  assert.strictEqual(verdict.ok, false, `${message}（应当被拒却放行了）`);
  if (!verdict.ok) {
    assert.ok(
      verdict.error.includes(keyword),
      `${message}：错误文案应含「${keyword}」，实际「${verdict.error}」`,
    );
  }
}

function main(): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acf-cfgrec-'));

  try {
    // ── 1. P1-1：坏文件改名留证 ────────────────────────────────────────
    {
      const configPath = path.join(dir, 'config.json');
      fs.writeFileSync(configPath, '{"configured": true, "executorTok', 'utf-8');
      const res = quarantineCorruptConfigFile(configPath, 1_700_000_000_000);
      assert.strictEqual(res.quarantined, true, '坏文件必须被改名留证');
      assert.strictEqual(
        res.backupPath,
        `${configPath}.corrupt-1700000000000`,
        '留证名必须是 <原路径>.corrupt-<毫秒时间戳>（同目录）',
      );
      assert.ok(!fs.existsSync(configPath), '原路径必须已空出（重建走 defaults）');
      assert.strictEqual(
        fs.readFileSync(res.backupPath!, 'utf-8'),
        '{"configured": true, "executorTok',
        '留证文件内容必须原样保留（证据不损毁）',
      );
      // 时间戳缺省 = Date.now()（形态断言）。
      fs.writeFileSync(configPath, 'not json', 'utf-8');
      const res2 = quarantineCorruptConfigFile(configPath);
      assert.strictEqual(res2.quarantined, true, '缺省时间戳仍要留证');
      assert.ok(
        /^\.corrupt-\d+$/.test(res2.backupPath!.slice(configPath.length)),
        '缺省时间戳取当前毫秒',
      );
    }

    // ── 2. P1-1：文件缺失 no-op（不算失败） ───────────────────────────
    {
      const res = quarantineCorruptConfigFile(path.join(dir, 'nope.json'));
      assert.strictEqual(res.quarantined, false);
      assert.strictEqual(res.backupPath, null);
      assert.strictEqual(res.error, undefined, '文件缺失不是错误');
    }

    // ── 3. P1-1：createStoreToleratingCorruption 的完整恢复流 ──────────
    {
      const configPath = path.join(dir, 'flow-config.json');
      fs.writeFileSync(configPath, '{"configured": tr', 'utf-8');
      const warns: string[] = [];
      const DEFAULTS = { configured: false, workDir: '<defaults>' };
      let built = 0;
      // 假 store：构造时读配置文件并 JSON.parse（与 conf 16 同故障形态：
      // clearInvalidConfig=false → SyntaxError 原样上抛；文件缺失 = 全新
      // store，读 defaults——conf 的 ENOENT 分支同款），成功则把文件内容
      // 当作 store 值。
      const outcome = createStoreToleratingCorruption<Record<string, unknown>>({
        createStore: () => {
          built++;
          let raw: string;
          try {
            raw = fs.readFileSync(configPath, 'utf-8');
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ...DEFAULTS };
            throw err;
          }
          return { ...DEFAULTS, ...(JSON.parse(raw) as Record<string, unknown>) };
        },
        configPath,
        logWarn: (m) => warns.push(m),
        now: () => 1_700_000_000_123,
      });
      assert.strictEqual(built, 2, '坏文件必须只重试一次构造（留证后重建）');
      assert.strictEqual(outcome.recovered, true, '必须如实上报经历了恢复');
      assert.strictEqual(outcome.backupPath, `${configPath}.corrupt-1700000000123`);
      assert.deepStrictEqual(
        outcome.store,
        { configured: false, workDir: '<defaults>' },
        '恢复后必须以 defaults 继续启动（P1-1：构造成功 + 返回默认配置）',
      );
      assert.ok(!fs.existsSync(configPath), '原坏文件路径必须已空出');
      assert.strictEqual(
        fs.readFileSync(outcome.backupPath!, 'utf-8'),
        '{"configured": tr',
        '坏文件留证内容不变',
      );
      assert.strictEqual(warns.length, 1, '恢复过程必须落 warn 日志');
      assert.ok(warns[0].includes(outcome.backupPath!), '日志必须指到留证文件');
    }

    // ── 4. P1-1：正常路径零开销（不额外构造） ──────────────────────────
    {
      const configPath = path.join(dir, 'good-config.json');
      fs.writeFileSync(configPath, '{"configured": true}', 'utf-8');
      let built = 0;
      const outcome = createStoreToleratingCorruption<Record<string, unknown>>({
        createStore: () => {
          built++;
          return JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
        },
        configPath,
        logWarn: () => {
          throw new Error('healthy path must not log');
        },
        // 真实 chmod 对 0600 的已存在文件是幂等的；这里注入 no-op 聚焦本组断言。
        hardenPermissions: () => true,
      });
      assert.strictEqual(built, 1, '健康配置绝不能二次构造');
      assert.strictEqual(outcome.recovered, false);
      assert.strictEqual(outcome.backupPath, null);
      assert.deepStrictEqual(outcome.store, { configured: true });
    }

    // ── 5. P1-1：非 SyntaxError 不做恢复（不拿 defaults 静默清配置） ────
    {
      let built = 0;
      assert.throws(
        () =>
          createStoreToleratingCorruption({
            createStore: () => {
              built++;
              throw new Error('EACCES: permission denied');
            },
            configPath: path.join(dir, 'never.json'),
            logWarn: () => undefined,
          }),
        /EACCES/,
        '权限类构造失败必须原样上抛',
      );
      assert.strictEqual(built, 1, '非 SyntaxError 绝不重试（重试 = 以 defaults 清空配置）');
    }

    // ── 6. P1-1：留证后坏文件又被写回 → 二次构造失败原样上抛 ────────────
    {
      const configPath = path.join(dir, 'always-bad.json');
      fs.writeFileSync(configPath, '}}}', 'utf-8');
      assert.throws(
        () =>
          createStoreToleratingCorruption({
            createStore: () => {
              // 模拟"留证后坏文件又出现"（外部进程写回等竞态）：每次构造
              // 都确保坏文件在场 → 二次构造仍撞 SyntaxError。
              fs.writeFileSync(configPath, '}}}', 'utf-8');
              return JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
            },
            configPath,
            logWarn: () => undefined,
          }),
        SyntaxError,
        '二次构造仍读到坏文件时必须上抛（交给 crash-guard，不能吞）',
      );
    }

    // ── 7. P3-2：chmod 0600（POSIX 语义；win32 直接跳过） ──────────────
    if (process.platform !== 'win32') {
      const f = path.join(dir, 'perm.json');
      fs.writeFileSync(f, '{}', 'utf-8');
      fs.chmodSync(f, 0o644);
      assert.strictEqual(hardenConfigFilePermissions(f), true, '收紧应成功');
      assert.strictEqual(fs.statSync(f).mode & 0o777, 0o600, '权限必须收成 0600');
      // 缺文件：best-effort 静默 false（conf 惰性写盘的正常时序）。
      assert.strictEqual(
        hardenConfigFilePermissions(path.join(dir, 'missing.json')),
        false,
        '文件不存在必须静默跳过（不抛）',
      );
    }

    // ── 8. P3-5：validateWorkDirForSave（注入 fs 逐分支） ──────────────
    {
      const ok = {
        isAbsolute: (p: string) => p.startsWith('/'),
        exists: () => false,
        isDirectory: () => false,
        canWrite: () => true,
        ensureDirectory: () => true,
      };
      assert.deepStrictEqual(validateWorkDirForSave('/tmp/tasks', ok), { ok: true }, '不存在但可创建 → 放行');
      assertRejected(validateWorkDirForSave('relative/path', ok), '绝对路径', '相对路径必须被拒');
      assert.deepStrictEqual(validateWorkDirForSave('', ok), { ok: true }, '空白 = 「不修改」语义，放行');
      assert.deepStrictEqual(validateWorkDirForSave(42, ok), { ok: true }, '非字符串兜底放行（sanitize 已剔除）');
      const existingDir = { ...ok, exists: () => true, isDirectory: () => true };
      assert.deepStrictEqual(validateWorkDirForSave('/data/tasks', existingDir), { ok: true }, '存在且可写 → 放行');
      assertRejected(
        validateWorkDirForSave('/data/tasks', { ...existingDir, canWrite: () => false }),
        '不可写',
        '只读目录必须被拒',
      );
      assertRejected(
        validateWorkDirForSave('/data/tasks', { ...ok, exists: () => true, isDirectory: () => false }),
        '不是文件夹',
        '指向文件必须被拒',
      );
      assertRejected(
        validateWorkDirForSave('/data/tasks', { ...ok, ensureDirectory: () => false }),
        '无法创建',
        '创建失败必须被拒',
      );
      // 真实 fs 冒烟（default deps）：临时目录放行、相对路径拒绝。
      assert.deepStrictEqual(validateWorkDirForSave(dir), { ok: true });
      assert.ok(!validateWorkDirForSave('acf-relative').ok, '真实 fs 下相对路径必须被拒');
    }

    // ── 9. 接线守卫：config-store / ipc-handlers / crash-guard 的锚点 ───
    {
      const storeSrc = fs.readFileSync(
        path.join(__dirname, '..', 'src', 'main', 'config-store.ts'),
        'utf-8',
      );
      assert.ok(
        storeSrc.includes('createStoreToleratingCorruption'),
        'P1-1: ConfigStore 构造必须走损坏容错决策层',
      );
      assert.ok(
        storeSrc.includes('name: STORE_FILE_NAME') && storeSrc.includes("STORE_FILE_NAME = 'config'"),
        'P1-1: store 必须显式声明文件名（configFilePath 与实际落盘路径同源的契约）',
      );
      assert.ok(
        (storeSrc.match(/hardenConfigFilePermissions\(ConfigStore\.configFilePath\(\)\)/g) ?? []).length >= 2,
        'P3-2: 构造**与**保存两条路径都必须收紧 config.json 权限',
      );
      const ipcSrc = fs.readFileSync(
        path.join(__dirname, '..', 'src', 'main', 'ipc-handlers.ts'),
        'utf-8',
      );
      assert.ok(
        ipcSrc.includes('validateWorkDirForSave'),
        'P3-5: config:save 必须对变化的 workDir 做落盘前校验',
      );
      const guardSrc = fs.readFileSync(
        path.join(__dirname, '..', 'src', 'main', 'crash-guard.ts'),
        'utf-8',
      );
      assert.ok(
        guardSrc.includes('config.json') && guardSrc.includes('.corrupt-*'),
        'P1-1: 崩溃对话框必须补「删除 config.json」的恢复指引',
      );
    }

    console.log('config-recovery selftest: all assertions passed (quarantine+rebuild, healthy fast path, non-syntax rethrow, chmod 0600, workDir save gate, wiring anchors)');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main();
