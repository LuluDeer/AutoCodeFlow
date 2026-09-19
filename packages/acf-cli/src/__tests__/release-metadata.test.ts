/**
 * 发布物版本号守卫（改名发布 @autocodeflow/cli 时新增）。
 *
 * 缺陷：`src/index.ts` 原写死 `.version('1.0.0')`，而 `package.json` 的 version
 * 才是 `version-guard`（release.yml）与 release-please **唯一**会 bump 的地方。
 * 两者必然漂移，实测证据：包名/版本改成 `@autocodeflow/cli@1.4.3` 后，
 * `npx acf --version` 仍打印 **1.0.0**。
 *
 * 为什么这一处特别要紧：`acf --version` 是发布物里最不该骗人的一个输出——
 * 用户报 issue 时贴的是它、我们判断兼容性时看的是它、脚本按版本做分支时读的
 * 也是它。而且它是**装完就能立刻看到**的第一印象。
 *
 * 修法：从 package.json 读（单一事实源），并由本文件钉死"不得再出现硬编码"。
 * 另在 release.yml 的 version-guard 里把本包纳入 lockstep 校验（第五处）。
 *
 * 反证：把 `.version(pkg.version)` 改回 `.version('1.0.0')` → 本文件变红。
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const PKG_DIR = join(__dirname, '..', '..');
const pkg = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf-8')) as {
  name: string;
  version: string;
  bin: Record<string, string>;
  files: string[];
  publishConfig?: { access?: string };
};
const indexSrc = readFileSync(join(PKG_DIR, 'src', 'index.ts'), 'utf-8');
// 必须剥注释：本文件与 index.ts 的注释里都**引用了**旧写法
// `.version('1.0.0')` 作反例说明。不剥注释的话，守卫会把"解释缺陷的注释"
// 当成缺陷本身，红得毫无线索——本轮已第三次踩到这个坑。
const indexCode = indexSrc
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

describe('acf-cli 发布物：包名与 scope', () => {
  it('包名是 @autocodeflow/cli（不是被占用的 acf-cli）', () => {
    // npm 上 `acf-cli` 已被第三方占用（v1.0.1，一个 NPM+Java 安装指南），
    // 直接 publish 必然 403——这正是本包长期发不出去的原因。
    expect(pkg.name).toBe('@autocodeflow/cli');
  });

  it('用本仓已持有的 @autocodeflow scope（不是被抢注的 @autoflow）', () => {
    // release.yml 的注释记录了 f0f8b96 的教训：@autoflow org 已被抢注。
    expect(pkg.name.startsWith('@autocodeflow/')).toBe(true);
    expect(pkg.name.startsWith('@autoflow/')).toBe(false);
  });

  it('bin 名保持 acf（改名只改包名，不改用户敲的命令）', () => {
    expect(Object.keys(pkg.bin)).toEqual(['acf']);
  });

  it('scoped 包必须显式声明 public（否则发布即 private）', () => {
    expect(pkg.publishConfig?.access).toBe('public');
  });
});

describe('acf-cli 发布物：打包内容不得含测试', () => {
  it('files 排除了 dist/__tests__', () => {
    // tsc 会把 src/__tests__ 一起编译进 dist，若不排除就被打进发布包
    // （实测首版 27 个文件、含 3 个 *.test.js）。没有用 tsconfig 的 exclude
    // 是因为那会连带让 `npm run typecheck` 不再覆盖测试文件——用 files
    // 精准排除可以两者兼得。
    expect(pkg.files).toContain('dist');
    expect(pkg.files).toContain('!dist/__tests__');
  });
});

describe('acf-cli 版本号：必须来自 package.json，不得硬编码', () => {
  it('pkg.version 与 Commander 的版本源一致（不是字面量）', () => {
    expect(indexCode).toMatch(/\.version\(pkg\.version\)/);
  });

  it('源码里不再有 .version(\'x.y.z\') 这类硬编码', () => {
    expect(indexCode).not.toMatch(/\.version\(\s*['"]\d+\.\d+\.\d+/);
  });

  it('行为层：构建产物 self-report 的版本 == package.json（真实执行，非读源码）', () => {
    const entry = join(PKG_DIR, 'dist', 'index.js');

    // 产物缺失时**就地构建**，而不是报错要求调用方先 build。
    //
    // 为什么这么改（真实教训）：首版写成"缺产物就 throw 并提示 npm run build"，
    // 依赖的是"CI 里 build 排在 test 之前"这一**约定**。结果 CI 有两个跑本包
    // 测试的 job（acf-cli-test 与矩阵化的 windows-node-tests），我只给前者加了
    // build，后者立刻以 `MODULE_NOT_FOUND: dist/index.js` 变红——同一个包、同一个
    // 守卫，漏改一处就红一次。把"确保产物在场"收进守卫自身，就从**约定**变成
    // **结构保证**：无论谁在什么顺序下跑本文件，它都自足。
    //
    // 注意仍**不是**静默跳过：构建失败会抛出，断言照旧生效——一个读不到产物
    // 就 skip 的守卫等于不存在。
    if (!existsSync(entry)) {
      try {
        execFileSync('npm', ['run', 'build'], {
          cwd: PKG_DIR,
          stdio: 'ignore',
          shell: process.platform === 'win32',
        });
      } catch (err) {
        throw new Error(
          `构建产物缺失且就地构建失败：${entry}。本守卫读产物而非源码——`
            + `源码里写了什么不代表打出来的包是什么。原始错误：${String(err)}`,
        );
      }
    }

    let out: string;
    try {
      out = execFileSync(process.execPath, [entry, '--version'], {
        encoding: 'utf-8',
      }).trim();
    } catch (err) {
      throw new Error(`无法执行构建产物 ${entry}。原始错误：${String(err)}`);
    }
    expect(out).toBe(pkg.version);
  });
});
