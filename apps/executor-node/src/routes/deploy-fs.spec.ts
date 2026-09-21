import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * 生产故障回归：应用**升级**在 Windows 上必然失败。
 *
 * 症状（用户报）：
 *   EPERM: operation not permitted, rename
 *   '...\tasks\apps\<appId>\current.next-9560-1789962596737'
 *   -> '...\tasks\apps\<appId>\current'
 *   且现象是「部署 1.0.0 成功，之后升级就报这个」。
 *
 * 根因是平台差异：Windows 上 `current` 是 **junction**，而"把 junction 改名
 * 覆盖到已存在的 junction 上"会抛 `EPERM`（POSIX 上同样的 rename 覆盖目录符号
 * 链接是合法的，故 Linux/macOS 从不复现）。原实现只 catch `EEXIST`，于是
 * `EPERM` 直接冒泡：首次部署 current 不存在 → 成功；第二次起必失败。
 *
 * 本文件**刻意不用 mock fs**：deploy.spec.ts 把 fs/child_process 全 mock 了，
 * 这正是该缺陷（以及上一个 Expand-Archive 缺陷）能上线的直接原因——mock 下
 * "junction 覆盖" 这个真实语义根本不存在，测试必然空转。这里用真实文件系统
 * 构造真实的 junction/symlink，断言真实行为。
 *
 * 非 Windows 上 junction 不适用，故 Windows 专属用例做平台跳过；但
 * "重复部署不删活 release" 与 "EPERM 回退路径" 两族用例跨平台都跑。
 */
import {
  buildDeploymentPaths,
  resolveReleasePaths,
  restoreCurrentRelease,
  switchCurrentRelease,
} from './deploy';

const isWindows = process.platform === 'win32';

/** 建真实临时目录，测试结束清理。 */
function makeTmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'acf-deploy-fs-'));
}

function rmrf(target: string): void {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
}

describe('deploy 真实文件系统行为（生产故障回归）', () => {
  let root: string;

  beforeEach(() => {
    root = makeTmpRoot();
  });

  afterEach(() => {
    rmrf(root);
  });

  /**
   * 复现并锁定 Windows 的 junction 覆盖语义。
   *
   * 这个用例的价值在于**证明平台差异真实存在**：它先断言裸 rename 确实抛
   * EPERM（修复前的失败点），再断言修复用的"先 unlink 再 rename"能成功。
   * 若将来 Node 改变了该行为，第一个断言会失败并提醒我们重新评估修复。
   */
  describe('Windows junction 覆盖语义', () => {
    const itWin = isWindows ? it : it.skip;

    itWin('裸 rename 覆盖已存在 junction → EPERM（这就是生产报错）', () => {
      const releases = path.join(root, 'releases');
      const r1 = path.join(releases, 'r1');
      const r2 = path.join(releases, 'r2');
      fs.mkdirSync(r1, { recursive: true });
      fs.mkdirSync(r2, { recursive: true });
      const current = path.join(root, 'current');

      // 第一次部署：current 不存在 → rename 成功（对应"部署 1.0.0 成功"）
      const tmp1 = `${current}.next-1`;
      fs.symlinkSync(r1, tmp1, 'junction');
      expect(() => fs.renameSync(tmp1, current)).not.toThrow();

      // 第二次部署（升级）：current 已存在 → EPERM（对应"升级必失败"）
      const tmp2 = `${current}.next-2`;
      fs.symlinkSync(r2, tmp2, 'junction');
      let code: string | undefined;
      try {
        fs.renameSync(tmp2, current);
      } catch (err: any) {
        code = err?.code;
      }
      expect(code).toBe('EPERM');
    });

    itWin('先 unlink 再 rename → 成功，且不损坏 release 内容', () => {
      const releases = path.join(root, 'releases');
      const r1 = path.join(releases, 'r1');
      const r2 = path.join(releases, 'r2');
      fs.mkdirSync(r1, { recursive: true });
      fs.mkdirSync(r2, { recursive: true });
      fs.writeFileSync(path.join(r1, 'IMPORTANT.txt'), 'live data');
      fs.writeFileSync(path.join(r2, 'index.js'), 'new release');
      const current = path.join(root, 'current');

      fs.symlinkSync(r1, current, 'junction');
      expect(fs.existsSync(path.join(current, 'IMPORTANT.txt'))).toBe(true);

      // 修复所用的手段：unlink 只删链接，不碰目标目录
      const tmp = `${current}.next-3`;
      fs.symlinkSync(r2, tmp, 'junction');
      fs.unlinkSync(current);
      fs.renameSync(tmp, current);

      // current 现在指向 r2
      expect(fs.readFileSync(path.join(current, 'index.js'), 'utf-8')).toBe(
        'new release',
      );
      // 旧 release 内容完好（unlink 未穿透 junction）
      expect(fs.readFileSync(path.join(r1, 'IMPORTANT.txt'), 'utf-8')).toBe(
        'live data',
      );
    });

    itWin('unlink 对 junction 不穿透：目标目录与其内容都在', () => {
      const target = path.join(root, 'releases', 'r1');
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, 'f.txt'), 'x');
      const link = path.join(root, 'current');
      fs.symlinkSync(target, link, 'junction');

      fs.unlinkSync(link);
      expect(fs.existsSync(link)).toBe(false);
      expect(fs.existsSync(target)).toBe(true);
      expect(fs.existsSync(path.join(target, 'f.txt'))).toBe(true);
    });

    itWin('junction 可被 readCurrentTarget 的 isSymbolicLink() 识别', () => {
      const target = path.join(root, 'releases', 'r1');
      fs.mkdirSync(target, { recursive: true });
      const link = path.join(root, 'current');
      fs.symlinkSync(target, link, 'junction');

      // readCurrentTarget 依赖 lstat().isSymbolicLink() —— 对 junction 成立，
      // 否则"回滚到上一个 release"会永远读到 null。
      const st = fs.lstatSync(link);
      expect(st.isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(link)).toBe(target);
    });
  });

  /**
   * 直接驱动修复点 `switchCurrentRelease`。
   *
   * 为什么必须有这组：上面那组只证明了"裸 rename 在 Windows 上抛 EPERM"这个
   * **平台语义**，并没有证明本函数处理了它。实测把 `err?.code !== 'EPERM'` 从
   * catch 条件里删掉（即退回修复前形态），上面那组用例**全绿**——变异存活，
   * 说明它们覆盖不到修复点。这里直接调函数，让"EPERM 被处理"成为断言对象。
   */
  describe('switchCurrentRelease：junction 覆盖必须成功（修复点本身）', () => {
    const itWin = isWindows ? it : it.skip;

    itWin('current 已存在（junction）→ 不抛，且 current 指向新 release', () => {
      const releases = path.join(root, 'releases');
      const r1 = path.join(releases, 'r1');
      const r2 = path.join(releases, 'r2');
      fs.mkdirSync(r1, { recursive: true });
      fs.mkdirSync(r2, { recursive: true });
      fs.writeFileSync(path.join(r1, 'old.txt'), 'old');
      fs.writeFileSync(path.join(r2, 'new.txt'), 'new');
      const current = path.join(root, 'current');

      // 第一次：current 不存在 → 必然成功
      expect(() => switchCurrentRelease(current, r1)).not.toThrow();
      expect(fs.readlinkSync(current)).toBe(r1);

      // 第二次（升级）：current 已存在 → 修复前这里抛 EPERM。
      // 变异测试：删掉 catch 里的 EPERM 判定 → 本断言转红。
      expect(() => switchCurrentRelease(current, r2)).not.toThrow();
      expect(fs.readlinkSync(current)).toBe(r2);

      // 旧 release 内容完好（unlink 只删链接，不穿透）
      expect(fs.readFileSync(path.join(r1, 'old.txt'), 'utf-8')).toBe('old');
      // 新 release 可经 current 访问
      expect(fs.readFileSync(path.join(current, 'new.txt'), 'utf-8')).toBe('new');
    });

    itWin('连续多次切换（模拟反复升级）都不抛', () => {
      const releases = path.join(root, 'releases');
      const current = path.join(root, 'current');
      for (let i = 0; i < 5; i++) {
        const dir = path.join(releases, `r${i}`);
        fs.mkdirSync(dir, { recursive: true });
        expect(() => switchCurrentRelease(current, dir)).not.toThrow();
        expect(fs.readlinkSync(current)).toBe(dir);
      }
    });

    it('非 Windows 上同样可用（symlink 路径不回归）', () => {
      if (isWindows) return; // 该用例只在 POSIX 上有意义
      const releases = path.join(root, 'releases');
      const r1 = path.join(releases, 'r1');
      const r2 = path.join(releases, 'r2');
      fs.mkdirSync(r1, { recursive: true });
      fs.mkdirSync(r2, { recursive: true });
      const current = path.join(root, 'current');

      switchCurrentRelease(current, r1);
      switchCurrentRelease(current, r2);
      expect(fs.readlinkSync(current)).toBe(r2);
    });
  });

  /**
   * 失败回滚：restoreCurrentRelease 把 current 指回上一个 release。
   * 与上一条组合起来正是缺陷最严重的那条链路——修复前 releaseKey 相同会让
   * "上一个 release"恰好是本次被删掉的目录，回滚即指向不存在的目录。
   */
  describe('restoreCurrentRelease：回滚指向的目录必须存在', () => {
    it('有 previousTarget → current 指回它', () => {
      const releases = path.join(root, 'releases');
      const r1 = path.join(releases, 'r1');
      const r2 = path.join(releases, 'r2');
      fs.mkdirSync(r1, { recursive: true });
      fs.mkdirSync(r2, { recursive: true });
      const current = path.join(root, 'current');

      switchCurrentRelease(current, r2);
      restoreCurrentRelease(current, r1);

      expect(fs.readlinkSync(current)).toBe(r1);
      // 回滚目标确实存在（应用可用）
      expect(fs.existsSync(fs.readlinkSync(current))).toBe(true);
    });

    it('previousTarget 为 null → 删掉 current（首次部署失败的回滚）', () => {
      const r1 = path.join(root, 'releases', 'r1');
      fs.mkdirSync(r1, { recursive: true });
      const current = path.join(root, 'current');
      switchCurrentRelease(current, r1);
      expect(fs.existsSync(current)).toBe(true);

      restoreCurrentRelease(current, null);
      expect(fs.existsSync(current)).toBe(false);
      // 目标目录不受影响
      expect(fs.existsSync(r1)).toBe(true);
    });

    it('回滚不抛（best-effort 语义：失败只 warn）', () => {
      const current = path.join(root, 'nonexistent-parent', 'current');
      expect(() => restoreCurrentRelease(current, null)).not.toThrow();
    });
  });

  /**
   * 同 (version, deploymentId) 重复部署时 releaseKey 相同 → finalReleaseDir
   * 恰好是 current 正在指向的活目录，`removePathIfExists` 会把它删掉。
   *
   * 最严重的后果在失败路径：restoreCurrentRelease 会把 current 指回"上一个
   * release"，而那个目录刚被本次部署删除 → current 指向不存在的目录，应用彻底
   * 不可用。resolveReleasePaths 让目标已存在时改用新目录，从而避免整条链路。
   */
  describe('resolveReleasePaths：重复部署必须换新目录', () => {
    it('目标目录不存在 → 原样返回（首次部署布局不变）', () => {
      const paths = buildDeploymentPaths(root, 'app-1', 'deploy-1', '1.0.0');
      const resolved = resolveReleasePaths(paths);

      expect(resolved).toBe(paths); // 同一对象：未做任何改动
      expect(resolved.releaseKey).toBe('1.0.0-deploy-1');
      expect(resolved.finalReleaseDir).toBe(paths.finalReleaseDir);
    });

    it('目标目录已存在 → 换用新目录，且不动原目录', () => {
      const paths = buildDeploymentPaths(root, 'app-1', 'deploy-1', '1.0.0');
      // 模拟"上一次部署已发布到该目录，且 current 指向它"
      fs.mkdirSync(paths.finalReleaseDir, { recursive: true });
      fs.writeFileSync(path.join(paths.finalReleaseDir, 'live.txt'), 'in use');

      const resolved = resolveReleasePaths(paths);

      expect(resolved.finalReleaseDir).not.toBe(paths.finalReleaseDir);
      expect(resolved.releaseKey).not.toBe(paths.releaseKey);
      expect(resolved.releaseKey.startsWith('1.0.0-deploy-1-')).toBe(true);
      // 关键：活目录仍在（没被本次部署"让路"逻辑删掉）
      expect(fs.existsSync(path.join(paths.finalReleaseDir, 'live.txt'))).toBe(
        true,
      );
      // extractDir 也要跟着换，否则会复用上一次的残留解压目录
      expect(resolved.extractDir).not.toBe(paths.extractDir);
      expect(resolved.extractDir).toContain(resolved.releaseKey);
      // 其余字段保持不变
      expect(resolved.appRoot).toBe(paths.appRoot);
      expect(resolved.currentLink).toBe(paths.currentLink);
    });

    it('连续两次重复部署 → 两次都拿到互不相同的新目录', () => {
      const paths = buildDeploymentPaths(root, 'app-1', 'deploy-1', '1.0.0');
      fs.mkdirSync(paths.finalReleaseDir, { recursive: true });

      const a = resolveReleasePaths(paths);
      fs.mkdirSync(a.finalReleaseDir, { recursive: true });
      const b = resolveReleasePaths(paths);

      expect(a.finalReleaseDir).not.toBe(b.finalReleaseDir);
    });

    /**
     * 同一毫秒内的密集调用必须也拿到不同目录。
     *
     * 这条是 CI 抓出来的**真实缺陷**：后缀最初只用 `Date.now()`+pid，同一毫秒
     * 内两次调用得到同一个后缀 → 两次部署指向同一目录 → 又回到"删掉活 release"
     * 的老问题上。本机跑不出来（CI 的 Windows runner 更快），
     * `windows-node-tests` 把它暴露成红。修复是加进程内单调计数器 + 存在性循环。
     */
    it('同一毫秒内密集调用 → 后缀仍然互不相同（CI 抓出的缺陷）', () => {
      const paths = buildDeploymentPaths(root, 'app-1', 'deploy-1', '1.0.0');
      fs.mkdirSync(paths.finalReleaseDir, { recursive: true });

      // 紧凑循环：全部落在同一毫秒内（不 sleep、不建目录）
      const keys = new Set<string>();
      for (let i = 0; i < 50; i++) {
        keys.add(resolveReleasePaths(paths).releaseKey);
      }
      expect(keys.size).toBe(50);
    });

    it('唯一性不依赖"上一次调用者建了目录"', () => {
      const paths = buildDeploymentPaths(root, 'app-1', 'deploy-1', '1.0.0');
      fs.mkdirSync(paths.finalReleaseDir, { recursive: true });

      // 刻意不 mkdir 返回的新目录
      const a = resolveReleasePaths(paths);
      const b = resolveReleasePaths(paths);
      expect(a.releaseKey).not.toBe(b.releaseKey);
      expect(fs.existsSync(a.finalReleaseDir)).toBe(false);
      expect(fs.existsSync(b.finalReleaseDir)).toBe(false);
    });

    /**
     * `fs.existsSync` 恒真（deploy.spec.ts 的 mock 形态）时必须有界返回。
     *
     * 首版实现用了无上限的 `while (fs.existsSync(...))`，在那种 mock 下死循环
     * 并 OOM（实测 "JavaScript heap out of memory"，4GB 堆打满）——把整个
     * deploy.spec.ts 套件拖挂。这里用 jest.spyOn 造同样的恒真形态，断言函数
     * 仍然返回且不挂死。计数器已保证同进程唯一，上限只是防御。
     */
    /**
     * `fs.existsSync` 恒真（deploy.spec.ts 的 mock 形态）时必须有界返回。
     *
     * 首版实现用了无上限的 `while (fs.existsSync(...))`，在那种 mock 下死循环
     * 并 OOM（实测 "JavaScript heap out of memory"，4GB 堆打满）——把整个
     * deploy.spec.ts 套件拖挂。
     *
     * 这条用**源码守卫**而不是行为断言：本套件里 fs 是真实模块，其 exports 属性
     * 只有 getter（"Cannot set property existsSync … which has only a getter"），
     * 无法在本文件内伪造恒真 mock。而真正的行为回归已由 deploy.spec.ts 自身承担
     * —— 它正是用恒真 existsSync 驱动 deploy 路由的，修复前该套件 OOM 崩溃。
     * 这里补一道静态闸，防止有人把上限改回 while(true)。
     */
    it('resolveReleasePaths 的查找循环必须有硬上限（源码守卫，防 OOM 回归）', async () => {
      const fsMod = await import('node:fs/promises');
      const pathMod = await import('node:path');
      const src = await fsMod.readFile(
        pathMod.resolve(process.cwd(), 'src/routes/deploy.ts'),
        'utf-8',
      );

      // 取出 resolveReleasePaths 函数体，并**剥掉注释行**再匹配 —— 函数头注释里
      // 就写着反面示例（"无上限的 `while (fs.existsSync(...))` 会死循环"），
      // 不剥注释会让守卫被自己的说明文字绊倒（同类教训见 zip-safety.spec.ts
      // 的源码守卫）。
      const start = src.indexOf('export function resolveReleasePaths');
      expect(start).toBeGreaterThan(-1);
      const body = src
        .slice(start, src.indexOf('\n}', start))
        .split('\n')
        .filter((line) => {
          const t = line.trim();
          return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
        })
        .join('\n');

      // 必须是有界 for 循环，且不得出现无上限的 while(…existsSync…)
      expect(body).toMatch(/for\s*\(\s*let attempt = 0;\s*attempt < \d+;/);
      expect(body).not.toMatch(/while\s*\(\s*!?fs\.existsSync/);
      expect(body).not.toMatch(/do\s*\{[\s\S]*\}\s*while\s*\(\s*!?fs\.existsSync/);
    });

    it('修复后：删除落在新目录上，活 release 完好（核心保证）', () => {
      const paths = buildDeploymentPaths(root, 'app-1', 'deploy-1', '1.0.0');
      // 上一次部署已发布，current 指向它，目录里有正在被使用的内容
      fs.mkdirSync(paths.finalReleaseDir, { recursive: true });
      const liveFile = path.join(paths.finalReleaseDir, 'live.txt');
      fs.writeFileSync(liveFile, 'in use');

      // 修复后的真实顺序：**先** resolveReleasePaths 让路，再删目标目录。
      const resolved = resolveReleasePaths(paths);
      expect(resolved.finalReleaseDir).not.toBe(paths.finalReleaseDir);
      fs.rmSync(resolved.finalReleaseDir, { recursive: true, force: true });

      // 活目录与其中的内容都还在 —— 失败回滚把 current 指回它时仍然有效。
      expect(fs.existsSync(liveFile)).toBe(true);
      expect(fs.readFileSync(liveFile, 'utf-8')).toBe('in use');
    });

    it('修复前对照：删除落在活目录上，release 被毁（证明缺陷真实）', () => {
      const paths = buildDeploymentPaths(root, 'app-1', 'deploy-1', '1.0.0');
      fs.mkdirSync(paths.finalReleaseDir, { recursive: true });
      const liveFile = path.join(paths.finalReleaseDir, 'live.txt');
      fs.writeFileSync(liveFile, 'in use');

      // 修复前没有 resolveReleasePaths 这一步，直接
      // removePathIfExists(paths.finalReleaseDir) —— 目标恰是活目录。
      fs.rmSync(paths.finalReleaseDir, { recursive: true, force: true });
      expect(fs.existsSync(liveFile)).toBe(false);

      // 此后失败路径的 restoreCurrentRelease 会把 current 指向这个已不存在的
      // 目录 → 应用彻底不可用。这正是本缺陷最严重的后果。
      expect(fs.existsSync(paths.finalReleaseDir)).toBe(false);
    });
  });

  /**
   * buildDeploymentPaths 是纯函数（被 deploy.spec.ts 按精确路径断言），
   * resolveReleasePaths 是运行时判定 —— 分离职责，避免把 fs 依赖塞进路径推导。
   */
  describe('职责分离：路径推导保持纯函数', () => {
    it('buildDeploymentPaths 不触碰文件系统（同参数同结果）', () => {
      const a = buildDeploymentPaths('/nonexistent-root', 'app-1', 'd-1', '1.0.0');
      const b = buildDeploymentPaths('/nonexistent-root', 'app-1', 'd-1', '1.0.0');
      expect(a).toEqual(b);
      // 路径不必存在也能推导出来
      expect(fs.existsSync(a.finalReleaseDir)).toBe(false);
    });
  });
});
