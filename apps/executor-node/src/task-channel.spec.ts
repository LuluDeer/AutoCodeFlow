/**
 * R75（2026-11-06）：**渠道判定**与 python `_zip_channel_enabled` 逐条对齐。
 *
 * 真值表的来源是 python 侧的唯一事实源
 * `apps/executor-python/routers/execute.py:2318`（函数体 2342-2360），条件逐条：
 *   1. `codeSource == 'application_zip'` ⇒ zip；
 *   2. 无 `codeSource` 且 `applicationId` **且** `packageUrl` ⇒ zip；
 *   3. 其余 ⇒ 非 zip；
 *   4. 前两步成立但命中 `gitRepo` / `glueSource` ⇒ 非 zip（优先级 git > glue > application_zip）。
 *
 * 这张表同时是 node 两道 accept 闸（同步 R70 / DNS R72）与 prepare 下载前判定的
 * **同一份输入**——任何一处改判据，本文件先红。
 */
import { isZipChannelEnabled, readTaskAlias } from './task-channel';

type Case = {
  name: string;
  task: Record<string, unknown>;
  enabled: boolean;
  override: 'gitRepo' | 'glueSource' | null;
};

const URL = 'https://acf.example.com/uploads/pkg.zip';

const CASES: Case[] = [
  // ① 显式信号
  {
    name: '① codeSource=application_zip（显式信号）',
    task: { codeSource: 'application_zip', applicationId: 'app', packageUrl: URL },
    enabled: true,
    override: null,
  },
  // ② 歧义推断：无 codeSource + applicationId + packageUrl
  {
    name: '② 无 codeSource + applicationId + packageUrl（歧义推断）',
    task: { applicationId: 'app', packageUrl: URL },
    enabled: true,
    override: null,
  },
  // ③ 歧义但不全：缺 packageUrl ⇒ 非 zip（R75 的过阻修复点之一）
  {
    name: '③ 无 codeSource + applicationId，但**无** packageUrl ⇒ 非 zip',
    task: { applicationId: 'app' },
    enabled: false,
    override: null,
  },
  // ④ 歧义但不全：缺 applicationId ⇒ 非 zip（另一个过阻修复点）
  {
    name: '④ 无 codeSource + packageUrl，但**无** applicationId ⇒ 非 zip',
    task: { packageUrl: URL },
    enabled: false,
    override: null,
  },
  // ⑤ 优先级：git 让位
  {
    name: '⑤ zip 信号 + gitRepo ⇒ 让位于 git',
    task: { codeSource: 'application_zip', applicationId: 'app', packageUrl: URL, gitRepo: 'https://github.com/o/r.git' },
    enabled: false,
    override: 'gitRepo',
  },
  // ⑥ 优先级：glue 让位（R75 的过阻修复点之三）
  {
    name: '⑥ zip 信号 + glueSource ⇒ 让位于 glue',
    task: { codeSource: 'application_zip', applicationId: 'app', packageUrl: URL, glueSource: 'console.log(1)' },
    enabled: false,
    override: 'glueSource',
  },
  // ⑦ 优先级顺序：两者都在 ⇒ 报 git（python 的日志口径）
  {
    name: '⑦ zip 信号 + gitRepo + glueSource ⇒ 报 git（git 优先于 glue）',
    task: { codeSource: 'application_zip', applicationId: 'app', packageUrl: URL, gitRepo: 'https://github.com/o/r.git', glueSource: 'x' },
    enabled: false,
    override: 'gitRepo',
  },
  // ⑧ 推断路径也受优先级约束
  {
    name: '⑧ 推断 zip（无 codeSource）+ gitRepo ⇒ 让位于 git',
    task: { applicationId: 'app', packageUrl: URL, gitRepo: 'https://github.com/o/r.git' },
    enabled: false,
    override: 'gitRepo',
  },
  // ⑨ 空串等价于缺失（python 侧是 `or` 语义）
  {
    name: '⑨ codeSource 为空串 ⇒ 视为缺失，走歧义推断',
    task: { codeSource: '', applicationId: 'app', packageUrl: URL },
    enabled: true,
    override: null,
  },
  // ⑩ 显式 zip 但没 URL：渠道成立（prepare 会报「缺 packageUrl」），闸不判 URL
  {
    name: '⑩ codeSource=application_zip 但无 packageUrl ⇒ 渠道成立（无 URL 可判）',
    task: { codeSource: 'application_zip', applicationId: 'app' },
    enabled: true,
    override: null,
  },
  // ⑪ 其它 codeSource 不参与推断
  {
    name: '⑪ codeSource=glue + packageUrl ⇒ 非 zip（codeSource 非空即不走推断）',
    task: { codeSource: 'glue', applicationId: 'app', packageUrl: URL },
    enabled: false,
    override: null,
  },
  // ⑫ snake_case 别名
  {
    name: '⑫ snake_case 别名（application_id/package_url）',
    task: { application_id: 'app', package_url: URL },
    enabled: true,
    override: null,
  },
];

describe('R75: isZipChannelEnabled 与 python _zip_channel_enabled 逐组合对齐', () => {
  it.each(CASES)('$name', ({ task, enabled, override }) => {
    expect(isZipChannelEnabled(task)).toEqual({ enabled, precedenceOverride: override });
  });

  it('非对象 / 空任务 ⇒ 非 zip（不抛）', () => {
    expect(isZipChannelEnabled(null)).toEqual({ enabled: false, precedenceOverride: null });
    expect(isZipChannelEnabled(undefined)).toEqual({ enabled: false, precedenceOverride: null });
    expect(isZipChannelEnabled({})).toEqual({ enabled: false, precedenceOverride: null });
  });

  it('别名读取规则与全仓同一份 readTaskAlias（规范名优先、空串视为缺失）', () => {
    expect(readTaskAlias({ gitRepo: 'canonical', git_repo: 'alias' }, 'gitRepo', 'git_repo')).toBe(
      'canonical',
    );
    expect(readTaskAlias({ gitRepo: '', git_repo: 'alias' }, 'gitRepo', 'git_repo')).toBe('alias');
    expect(readTaskAlias(null, 'a', 'b')).toBeUndefined();
  });
});
