/**
 * R2-1/P1b · A4：node 补读 `git_repo` / `git_commit` / `git_branch` 别名。
 *
 * ## 这批用例钉住什么
 *
 * 协议 `taskFieldAliases` 登记了三条 git 别名，而 node 侧此前**完全不读**
 * （`grep -rn git_repo apps/executor-node/src/` = 0 命中），python 侧**读**。
 * ⇒ 同一载荷 `{"git_repo": "..."}`：**node 静默忽略（当无 git 任务跑）、
 * python 正常 clone**。
 *
 * ## 两条必须钉住的断言（Lead 明确要求）
 *
 * ① **同一语义两种写法等价**：`{gitRepo}` 与 `{git_repo}` 必须被解析成同一个值；
 * ② **admin 只发 camelCase ⇒ 既有派发路径行为不变**：本改动是「新增接受面」，
 *    不是「改变既有语义」——camelCase 的行为必须逐字节不变。
 */
import { readTaskAlias } from './routes/execute';

describe('A4 别名读取：同一语义两种写法等价', () => {
  it.each([
    ['gitRepo', 'git_repo'],
    ['gitCommit', 'git_commit'],
    ['gitBranch', 'git_branch'],
  ])('%s 与别名等价', (canonical, alias) => {
    const value = 'sentinel-value';
    // 正名
    expect(readTaskAlias({ [canonical]: value }, canonical, alias)).toBe(value);
    // 别名
    expect(readTaskAlias({ [alias]: value }, canonical, alias)).toBe(value);
    // 两种写法给出**同一个值**（等价性）
    expect(readTaskAlias({ [canonical]: value }, canonical, alias)).toBe(
      readTaskAlias({ [alias]: value }, canonical, alias),
    );
  });

  it('正名优先：两者并存时取正名（契约 timeoutPrecedence 的同款纪律）', () => {
    expect(
      readTaskAlias({ gitRepo: 'canonical', git_repo: 'alias' }, 'gitRepo', 'git_repo'),
    ).toBe('canonical');
  });

  it('既有派发路径不变：admin 只发 camelCase ⇒ 行为逐字节不变', () => {
    // admin 的派发载荷由 Prisma 实体序列化 ⇒ 字段恒为 camelCase
    // （task.entity.ts 的 gitRepo/gitCommit/gitBranch）。
    const adminShapedTask = { gitRepo: 'https://github.com/o/r.git', gitCommit: 'abc123' };
    expect(readTaskAlias(adminShapedTask, 'gitRepo', 'git_repo')).toBe(
      'https://github.com/o/r.git',
    );
    expect(readTaskAlias(adminShapedTask, 'gitCommit', 'git_commit')).toBe('abc123');
    // 缺省字段仍回落（与改前 `body.task.gitCommit || body.task.gitBranch || 'main'` 一致）
    expect(readTaskAlias(adminShapedTask, 'gitBranch', 'git_branch')).toBeUndefined();
  });

  it('null / undefined / 空串一律视为缺席（与 python 的 falsy 判定对齐）', () => {
    expect(readTaskAlias({ gitRepo: null, git_repo: 'x' }, 'gitRepo', 'git_repo')).toBe('x');
    expect(readTaskAlias({ gitRepo: undefined, git_repo: 'x' }, 'gitRepo', 'git_repo')).toBe('x');
    expect(readTaskAlias({ gitRepo: '', git_repo: 'x' }, 'gitRepo', 'git_repo')).toBe('x');
    expect(readTaskAlias({}, 'gitRepo', 'git_repo')).toBeUndefined();
    expect(readTaskAlias(null, 'gitRepo', 'git_repo')).toBeUndefined();
  });

  it('snake_case 载荷现在会真的触发 git 通道（改前被静默忽略）', () => {
    // 反证：删掉 accept 段的 readTaskAlias 调用、退回 `body.task.gitRepo`
    // ⇒ `{git_repo}` 会被当成「无 git 任务」，gitRepo 闸也不会跑。
    const snakeOnly = { git_repo: 'http://169.254.169.254/x.git' };
    const resolved = readTaskAlias(snakeOnly, 'gitRepo', 'git_repo');
    expect(resolved).toBe('http://169.254.169.254/x.git');
    // 解析出值后，SSRF 闸才会对它生效（见 git-repo-network-policy.spec.ts）
    expect(resolved).toBeDefined();
  });
});
