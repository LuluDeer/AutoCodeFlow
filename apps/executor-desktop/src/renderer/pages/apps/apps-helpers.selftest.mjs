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
  firstDeletable,
  groupStatus,
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
eq(sortAriaOf('name', 'app'), 'ascending', 'name 排序映射 aria-sort');
eq(sortAriaOf('recent', 'deployed'), 'descending', 'recent 排序映射 aria-sort');
eq(sortAriaOf('recent', 'app'), 'none', '非当前排序列为 none');

console.log('apps-helpers selftest passed');
