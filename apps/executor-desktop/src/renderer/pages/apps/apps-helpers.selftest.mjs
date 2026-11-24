import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';

const here = resolve(import.meta.dirname);

function loadTs(filePath, deps = {}) {
  const source = readFileSync(filePath, 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: filePath,
  }).outputText;
  const mod = { exports: {} };
  const req = (spec) => {
    if (Object.prototype.hasOwnProperty.call(deps, spec)) return deps[spec];
    throw new Error(`Unexpected dependency in ${filePath}: ${spec}`);
  };
  new Function('exports', 'module', 'require', js)(mod.exports, mod, req);
  return mod.exports;
}

const appsView = loadTs(resolve(here, '../../apps-view.ts'));
const {
  buildAppGroups,
  countAppFilters,
  deleteActionInfo,
  firstDeletable,
  formatDeployLocator,
  groupStatus,
  runningActionGate,
  runModePrefix,
  sortAriaOf,
} = loadTs(resolve(here, './apps-helpers.ts'), { '../../apps-view': appsView });

const eq = (got, want, msg) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    throw new Error(`apps-helpers.selftest: ${msg} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);
  }
};

eq(countAppFilters([]), { all: 0, running: 0, hasCurrent: 0, noCurrent: 0, unnamed: 0, hasLog: 0 }, '空分组计数归零');

const sample = [
  { runningCount: 1, hasCurrent: true, hasName: true, hasLog: true },
  { runningCount: 0, hasCurrent: true, hasName: false, hasLog: false },
  { runningCount: 0, hasCurrent: false, hasName: true, hasLog: true },
];
eq(
  countAppFilters(sample),
  { all: 3, running: 1, hasCurrent: 2, noCurrent: 1, unnamed: 1, hasLog: 2 },
  '6 个筛选项应各自准确汇总分组计数',
);

const entries = [
  {
    appId: 'app-1', appName: 'Order Service', deploymentId: 'dep-1', version: '1.0.0',
    releaseKey: 'rel-1', isCurrent: false, deployedAt: 1000, hasLog: false,
    logPath: '', deployDir: '/d/1', appRoot: '/apps/app-1', runMode: 'daemon',
  },
  {
    appId: 'app-1', appName: 'Order Service', deploymentId: 'dep-2', version: '2.0.0',
    releaseKey: 'rel-2', isCurrent: true, deployedAt: 2000, hasLog: true,
    logPath: '/d/2/app.log', deployDir: '/d/2', appRoot: '/apps/app-1', runMode: 'daemon',
  },
  {
    appId: 'app-2', appName: null, deploymentId: 'dep-3', version: '1.0.0',
    releaseKey: 'rel-3', isCurrent: true, deployedAt: 1500, hasLog: false,
    logPath: '', deployDir: '/d/3', appRoot: '/apps/app-2', runMode: 'scheduled',
  },
];
const running = { 'dep-2': { pid: 42, running: true } };
const groups = buildAppGroups(entries, running, []);
eq(groups.length, 2, '按 appId 聚合为 2 组');
eq(groups[0].current?.deploymentId, 'dep-2', 'current 置顶');
eq(groupStatus(groups[0]), 'running', '运行中状态优先');
eq(groupStatus(groups[1]), 'scheduled', '定时应用返回 scheduled');
eq(runModePrefix(groups[0]), 'daemon · ', '有效 runMode 带分隔前缀');
eq(firstDeletable(groups[0], running)?.releaseKey, 'rel-1', '跳过 current 与 running 版本找到可删旧版');
eq(firstDeletable(groups[1], running), null, '仅 current 版本时不可删');
eq(firstDeletable(groups[0], {}, true), null, '运行态未知时保守判定为不可删（未知 ≠ 全部停止）');

// T1：运行态已知/未知两态的门禁真值表
const knownGate = runningActionGate(running, false);
eq(knownGate.unknown, false, '读取成功：unknown=false');
eq(knownGate.isRunning('dep-2'), true, '读取成功：running 徽标如实显示');
eq(knownGate.isRunning('dep-1'), false, '读取成功：未运行版本不显示 running 徽标');
eq(knownGate.blockedByRunning('dep-2'), true, '读取成功：运行中版本禁止删除');
eq(knownGate.blockedByRunning('dep-1'), false, '读取成功：可删旧版不误伤');
eq(knownGate.displayStatusOf(groups[0]), 'running', '读取成功：状态列仍按真实运行态显示');
eq(knownGate.displayStatusOf(groups[1]), 'scheduled', '读取成功：定时态保留');

const unknownGate = runningActionGate({}, true);
eq(unknownGate.unknown, true, '读取失败：unknown=true');
eq(unknownGate.isRunning('dep-2'), false, '读取失败：不得谎报「运行中」');
eq(unknownGate.blockedByRunning('dep-1'), true, '读取失败：所有版本按运行状态未知处理，删除先禁用');
eq(unknownGate.blockedByRunning('dep-999'), true, '读取失败：未知 deploymentId 同样禁用');
eq(unknownGate.displayStatusOf(groups[1]), 'unknown', '读取失败：状态列显示「运行状态未知」，不冒充已停止/定时');

// T1：deleteActionInfo 四态逐格断言（抽屉与表格菜单共用的唯一口径）。
const oldEntry = groups[0].entries.find(e => e.releaseKey === 'rel-1');
const currentEntry = groups[0].current;
eq(
  deleteActionInfo(currentEntry, knownGate, groups[0]),
  { reason: 'current', disabled: true, titleKey: 'apps.deleteBlockedCurrent', labelKey: 'appx.deleteReason.currentLabel' },
  '当前版本：原因 current，title 指当前版本阻塞',
);
eq(
  deleteActionInfo(oldEntry, knownGate, groups[0]),
  { reason: 'allowed', disabled: false, titleKey: 'apps.deleteAllowedTitle', labelKey: 'appx.deleteReason.allowedLabel' },
  '读取成功且未在跑：可删',
);
eq(
  deleteActionInfo(oldEntry, runningActionGate({ 'dep-1': { pid: 7, running: true } }, false), groups[0]),
  { reason: 'running', disabled: true, titleKey: 'apps.deleteBlockedRunning', labelKey: 'appx.deleteReason.runningLabel' },
  '运行中：原因 running，不误报为 current',
);
eq(
  deleteActionInfo(oldEntry, unknownGate, groups[0]),
  { reason: 'unknown', disabled: true, titleKey: 'appx.deleteBlockedUnknown', labelKey: 'appx.deleteReason.unknownLabel' },
  '运行态未知：原因 unknown，优先于 running 与 current',
);
// 表格菜单（deletable=null）按分组推断：
eq(
  deleteActionInfo(null, unknownGate, groups[0]).reason,
  'unknown',
  '菜单无候选 + 读取失败 → unknown 口径',
);
eq(
  deleteActionInfo(null, runningActionGate({ 'dep-1': { pid: 7, running: true } }, false), groups[0]).reason,
  'running',
  '菜单无候选 + 旧版仍在跑 → running 口径',
);
eq(
  deleteActionInfo(null, knownGate, groups[1]).reason,
  'current',
  '菜单无候选 + 仅 current 版本 → current 口径',
);

// T2：部署定位串——三字段齐全 / 缺字段 / 非法 baseURL 不硬编码域名。
eq(
  formatDeployLocator({ appId: 'app-1', deploymentId: 'dep-1', version: '1.0.0' }, 'http://console.local:3000/api/'),
  'appId=app-1\ndeploymentId=dep-1\nversion=1.0.0\nhttp://console.local:3000/applications/app-1?tab=releases',
  '定位串拼 appId/deploymentId/version 与中台应用页 URL（去尾斜杠与 /api）',
);
eq(
  formatDeployLocator({ appId: 'app-1', deploymentId: 'dep-1', version: null }),
  'appId=app-1\ndeploymentId=dep-1\nversion=—',
  '缺 version 用破折号占位，无 baseURL 时不拼 URL',
);
eq(
  formatDeployLocator({ appId: 'app-2', deploymentId: '', version: '' }, 'not-a-url'),
  'appId=app-2\ndeploymentId=—\nversion=—',
  '缺 deploymentId/version 与非法 baseURL 都不拼出 undefined/null/域名',
);

eq(sortAriaOf('name', 'app'), 'ascending', 'name 排序映射 aria-sort');
eq(sortAriaOf('recent', 'deployed'), 'descending', 'recent 排序映射 aria-sort');
eq(sortAriaOf('recent', 'app'), 'none', '非当前排序列为 none');

console.log('apps-helpers selftest passed');
