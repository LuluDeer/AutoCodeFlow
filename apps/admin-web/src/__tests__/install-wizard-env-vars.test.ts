/**
 * 安装向导「环境变量配置参考」块的键名必须被执行器**真正读取**。
 *
 * 背景（本轮审计）：该块末尾此前是 `EXECUTOR_NAME=my-executor-1`——这个键在
 * **全仓只有这一处**出现。两侧执行器读的都是 `APP_NAME`
 * （`apps/executor-node/src/config.ts`、`apps/executor-python/config.py`），
 * `scripts/install.sh` 写的也是 `APP_NAME`。
 *
 * 后果不是报错，而是**静默**：用户照抄参考块后执行器仍以默认名注册
 * （`executor-node-1`），而注册本身会成功（executors 表唯一键是 address，
 * appName 不唯一），于是每台手工部署的执行器在列表里同名、无法区分。
 *
 * 这类漂移的共性是「文案里写了一个没人读的键」——单测与类型检查都看不见它，
 * 只能靠**跨文件交叉校验**把两侧钉在一起。本文件即该守卫。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import * as path from 'node:path';
import {
  INSTALL_ENV_KEYS,
  findNewlyOnlineExecutor,
} from '../pages/ExecutorInstallWizardPage';

/** 向上找到仓库根——硬编码 `../`×N 会随测试文件所在层级漂移。 */
function findRepoRoot(from: string): string {
  let dir = from;
  for (let i = 0; i < 12; i++) {
    if (existsSync(path.join(dir, 'apps', 'executor-node', 'src', 'config.ts'))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  throw new Error(`repo root not found above ${from}`);
}

const ROOT = findRepoRoot(__dirname);

function read(relative: string): string {
  return readFileSync(path.join(ROOT, relative), 'utf-8');
}

describe('安装向导环境变量参考块', () => {
  it('键名集合非空且不含空串（扫描面守卫）', () => {
    // 没有这条，下面那组断言在键名被清空时会变成永真。
    expect(INSTALL_ENV_KEYS.length).toBeGreaterThanOrEqual(4);
    for (const key of INSTALL_ENV_KEYS) {
      expect(typeof key).toBe('string');
      expect(key.trim()).toBe(key);
      expect(key.length).toBeGreaterThan(0);
    }
  });

  it('每个键都被 executor-node 或 executor-python 真正读取', () => {
    const nodeConfig = read('apps/executor-node/src/config.ts');
    const pyConfig = read('apps/executor-python/config.py');
    // 两侧都可能通过 .env.example 声明；一并纳入，避免误报。
    const nodeEnvExample = read('apps/executor-node/.env.example');
    const pyEnvExample = read('apps/executor-python/.env.example');
    const haystack = [nodeConfig, pyConfig, nodeEnvExample, pyEnvExample].join('\n');

    for (const key of INSTALL_ENV_KEYS) {
      expect(
        haystack.includes(key),
        `安装向导展示了 ${key}，但两侧执行器都没有读取它——` +
          `用户照抄后会静默落回默认值。请改为执行器真正读取的键名。`,
      ).toBe(true);
    }
  });

  it('APP_NAME 必须在两侧执行器都被读取（本轮修复的那个键）', () => {
    // 反证：把 INSTALL_ENV_KEYS 里的 'APP_NAME' 改回 'EXECUTOR_NAME'，本例立即转红。
    expect(INSTALL_ENV_KEYS).toContain('APP_NAME');

    const nodeConfig = read('apps/executor-node/src/config.ts');
    expect(nodeConfig).toContain('process.env.APP_NAME');

    const pyConfig = read('apps/executor-python/config.py');
    expect(pyConfig).toMatch(/app_name\s*[:=]/);
  });

  it('不得出现 EXECUTOR_NAME（全仓无人读取的历史错误键名）', () => {
    // 直接钉住这个具体错误，防止有人"照着旧文档"改回去。
    expect(INSTALL_ENV_KEYS).not.toContain('EXECUTOR_NAME');
  });
});

/**
 * 第 5 步「执行器已上线」的判据。
 *
 * 修复前该判据是「status === 'online' 且 lastHeartbeat 比开始时间早不超过 5s」，
 * 没有把候选和用户正在装的那台关联起来——在已有健康执行器的环境里必然误报成功，
 * 并报出**另一台**执行器的名字。下面第一例就是那个场景的回归守卫。
 */
describe('安装向导第 5 步：只认本次新出现的执行器', () => {
  const online = (id: string) => ({ id, status: 'online' });

  it('已有在线执行器不构成"安装成功"（修复前的误报场景）', () => {
    // 反证：把 findNewlyOnlineExecutor 改回「只判 status === 'online'」，
    // 本例立即转红——它会返回那台早就存在的执行器。
    const existing = [online('exec-already-there')];
    const knownIds = new Set(['exec-already-there']);

    expect(findNewlyOnlineExecutor(existing, knownIds)).toBeNull();
  });

  it('本次新注册的执行器被识别出来', () => {
    const afterInstall = [online('exec-already-there'), online('exec-brand-new')];
    const knownIds = new Set(['exec-already-there']);

    expect(findNewlyOnlineExecutor(afterInstall, knownIds)?.id).toBe('exec-brand-new');
  });

  it('新出现但尚未在线的执行器不算成功（心跳没到不算上线）', () => {
    const rows = [
      { id: 'exec-already-there', status: 'online' },
      { id: 'exec-brand-new', status: 'offline' },
    ];
    const knownIds = new Set(['exec-already-there']);

    expect(findNewlyOnlineExecutor(rows, knownIds)).toBeNull();
  });

  it('基线取不到时（空集合）退化为宽松兜底，不把用户卡死', () => {
    // handleGoToStep4 在 list() 失败时传空集合——此时任何在线执行器都算新，
    // 与修复前行为一致。这条钉住"接口抖动不能让向导彻底不可用"。
    const rows = [online('exec-anything')];

    expect(findNewlyOnlineExecutor(rows, new Set())?.id).toBe('exec-anything');
  });
});

/**
 * 安装包类型选项必须与后端 `ExecutorPackageType` 一致。
 *
 * 此前筛选器与上传表单各自内联了一份 `node|python|java|shell`；`java`/`shell`
 * 在后端**不存在**，而 DTO 是 `@IsEnum(ExecutorPackageType)` + 全局
 * `forbidNonWhitelisted`，选中必然 400。UI 里出现一个"选了就报错"的选项，
 * 是纯前端可自证的缺陷——本守卫从后端枚举源头反查，杜绝再次漂移。
 */
describe('安装包类型选项与后端枚举一致', () => {
  it('页面里不出现后端枚举之外的 java / shell', () => {
    const page = read('apps/admin-web/src/pages/ExecutorPackagesPage.tsx');

    // 只允许出现在注释里说明"为什么不能加"——故先剔除注释行再断言。
    const codeOnly = page
      .split('\n')
      .filter((line) => {
        const trimmed = line.trim();
        return !(
          trimmed.startsWith('*') ||
          trimmed.startsWith('//') ||
          trimmed.startsWith('/*')
        );
      })
      .join('\n');

    expect(codeOnly).not.toMatch(/value:\s*'java'/);
    expect(codeOnly).not.toMatch(/value:\s*'shell'/);
    // 后端真正支持的三种必须在
    for (const type of ['node', 'python', 'universal']) {
      expect(codeOnly).toContain(`value: '${type}'`);
    }
  });

  it('后端 ExecutorPackageType 枚举就是这三种（源头核对）', () => {
    // 后端改枚举而前端没跟上时，本断言转红并指向要同步的位置。
    const entity = read(
      'apps/admin-api/src/modules/executor-package/executor-package.entity.ts',
    );
    const enumBlock = entity.slice(
      entity.indexOf('enum ExecutorPackageType'),
      entity.indexOf('enum ExecutorPackageStatus'),
    );
    const values = [...enumBlock.matchAll(/=\s*"([a-z_]+)"/g)].map((m) => m[1]);

    expect(values.sort()).toEqual(['node', 'python', 'universal']);
  });
});
