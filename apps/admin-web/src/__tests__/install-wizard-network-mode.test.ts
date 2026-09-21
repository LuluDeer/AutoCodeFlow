/**
 * P0-9（UX-AUDIT-2026-09-21）：安装向导必须能指导 **NAT/内网** 场景。
 *
 * ## 这条守的是什么
 *
 * 执行器有两种接入方式：
 *   · push —— 中台主动 POST 到执行器（需要中台可达地址）；
 *   · pull —— 执行器主动长轮询中台取任务（ADR-016，**NAT 后唯一可用**）。
 *
 * 而向导此前只产出 push-only 配置：`INSTALL_ENV_KEYS` 与 `scripts/install.sh`
 * 里 pull 的引用数是 **0**，`executor.service.ts` 里却有 51 处。后果不是报错，
 * 而是一个**必然失败的拓扑**——内网机器照官方引导装完后：注册成功、执行器列表
 * 显示"在线"、向导第 5 步打绿勾，但中台入站 POST 永远到不了它，任务派过去永不
 * 执行（只能等 stale sweep 判失败）。用户被官方引导进了一个死局。
 *
 * ## 为什么用源码契约断言而非端到端点击
 *
 * 走完整向导需要依次选类型/平台/包（多层 gating），与本缺陷无关且脆弱。
 * 本缺陷的全部实质是"**向导教不教 pull 这一课**"——它落在三处可静态检查的
 * 事实上：键表是否含回连开关、值构造是否产出 true、pull 时是否剔除公网地址要求。
 * 这三条断言即完整覆盖修复面，改坏任一条都会转红。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import * as path from 'node:path';
import { INSTALL_ENV_KEYS } from '../pages/ExecutorInstallWizardPage';

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
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf-8');
const WIZARD = 'apps/admin-web/src/pages/ExecutorInstallWizardPage.tsx';

describe('P0-9: 安装向导的网络模式（NAT/内网可达性）', () => {
  it('环境变量键表包含 EXECUTOR_PULL_MODE（回连开关）', () => {
    // 反证：把该键从 INSTALL_ENV_KEYS 删掉 → 本例转红（NAT 用户又将无路可走）
    expect(INSTALL_ENV_KEYS).toContain('EXECUTOR_PULL_MODE');
  });

  it('回连模式写入 EXECUTOR_PULL_MODE=true，push 模式写 false（语义明确）', () => {
    const src = read(WIZARD);
    // 写 'false' 而非省略：push 用户抄到的块与执行器默认值一致，且语义显式。
    expect(src).toMatch(
      /EXECUTOR_PULL_MODE:\s*networkMode === 'pull' \? 'true' : 'false'/,
    );
  });

  it('渲染面存在模式选择器（用户可见的入口，不是只存在于常量里）', () => {
    const src = read(WIZARD);
    expect(src).toContain('install-network-mode');
    expect(src).toMatch(/Radio\.Button value="pull"/);
    expect(src).toMatch(/Radio\.Button value="push"/);
  });

  it('pull 模式剔除"中台可达地址"要求（NAT 场景本就没有公网地址）', () => {
    const src = read(WIZARD);
    // 留着 ADDRESS_PUBLIC 会让用户以为仍必须配一个公网可达地址——正是 NAT
    // 场景**没有**的东西，直接把人卡死在第一步。
    expect(src).toMatch(
      /INSTALL_ENV_KEYS\.filter\(\(k\) => k !== 'EXECUTOR_ADDRESS_PUBLIC'\)/,
    );
  });

  it('回连模式有显式说明（用户要知道它不是可选优化而是必需）', () => {
    const zh = read('apps/admin-web/src/locales/zh.ts');
    const en = read('apps/admin-web/src/locales/en.ts');
    for (const key of [
      'install.networkMode',
      'install.networkMode.push',
      'install.networkMode.pull',
      'install.networkMode.pullDesc',
      'install.networkMode.pullNoticeDesc',
    ]) {
      expect(zh, `${key} 缺中文词条`).toContain(`'${key}'`);
      expect(en, `${key} 缺英文词条`).toContain(`'${key}'`);
    }
  });

  it('执行器真正读取 EXECUTOR_PULL_MODE（键名不是编的）', () => {
    // 两侧执行器的 config 必须真的读这个键，否则向导教了个没人认的变量——
    // 与历史上 EXECUTOR_NAME 那次是同一种病（见 install-wizard-env-vars.test.ts）。
    const nodeConfig = read('apps/executor-node/src/config.ts');
    expect(nodeConfig).toContain('process.env.EXECUTOR_PULL_MODE');
  });
});
