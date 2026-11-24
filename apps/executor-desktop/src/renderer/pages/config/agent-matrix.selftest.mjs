const {
  resolveEffectivePreset,
  resolveAgentAxis,
  fieldErrorProps,
} = await import('./agent-matrix.ts');

const eq = (got, want, msg) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    throw new Error(`agent-matrix.selftest: ${msg} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);
  }
};

eq(resolveEffectivePreset('standard'), 'standard', 'standard 预设保留');
eq(resolveEffectivePreset('minimal'), 'minimal', 'minimal 预设保留');
eq(resolveEffectivePreset('developer'), 'minimal', '未实现预设回落 minimal');
eq(resolveEffectivePreset(undefined), 'minimal', '缺省预设回落 minimal');

eq(resolveAgentAxis('minimal', '', 'codeExecution'), { value: 'off', inherited: true }, 'minimal 默认 codeExecution=off');
eq(resolveAgentAxis('standard', '', 'codeExecution'), { value: 'sandbox', inherited: true }, 'standard 默认 codeExecution=sandbox');
eq(resolveAgentAxis('standard', '', 'hostAccess'), { value: 'none', inherited: true }, 'standard 默认 hostAccess=none');
eq(resolveAgentAxis('standard', '', 'taskExecution'), { value: 'deploy-only', inherited: true }, 'standard 默认 taskExecution=deploy-only');
eq(resolveAgentAxis('minimal', 'sandbox', 'codeExecution'), { value: 'sandbox', inherited: false }, '显式覆盖 sandbox 生效');
eq(resolveAgentAxis('minimal', 'host', 'codeExecution'), { value: 'off', inherited: false }, '未实现覆盖 host 回落预设默认');
eq(resolveAgentAxis('standard', 'app-scoped', 'hostAccess'), { value: 'app-scoped', inherited: false }, 'app-scoped 覆盖生效');
eq(resolveAgentAxis('standard', 'isolated-runner', 'taskExecution'), { value: 'isolated-runner', inherited: false }, 'isolated-runner 覆盖生效');

eq(fieldErrorProps({}, 'adminApiUrl'), { className: 'input' }, '无错时不加 error/aria-invalid');
eq(
  fieldErrorProps({ adminApiUrl: 'bad url' }, 'adminApiUrl'),
  { className: 'input error', 'aria-invalid': true, 'aria-describedby': 'cfgx-err-adminApiUrl' },
  '有错时附加 error + aria-invalid + aria-describedby',
);
eq(
  fieldErrorProps({ agentAllowedDomains: 'bad' }, 'agentAllowedDomains', 'input cfg-list-input'),
  { className: 'input cfg-list-input error', 'aria-invalid': true, 'aria-describedby': 'cfgx-err-agentAllowedDomains' },
  '自定义基类保留并追加 error',
);

// T2：可见文本必须走双语标签，英文枚举只退到 data-*（表外未知值仍原样透出）。
{
  const { readFileSync } = await import('node:fs');
  const { resolve } = await import('node:path');
  const here = resolve(import.meta.dirname);
  const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const matrixCode = strip(readFileSync(resolve(here, 'AgentPermissionMatrix.tsx'), 'utf8'));
  const pageCode = strip(readFileSync(resolve(here, '../ConfigPage.tsx'), 'utf8'));
  const ok = (cond, msg) => { if (!cond) throw new Error(`agent-matrix.selftest: ${msg}`); };

  for (const anchor of [
    "agentValueLabel(localPreset, 'minimal')",
    "agentValueLabel(savedPreset, 'minimal')",
    'agentValueLabel(local.value)',
    'agentValueLabel(effective.value)',
    'data-raw-enum={localPreset}',
    'data-raw-enum={savedPreset}',
    'data-raw-enum={local.value}',
    'data-raw-enum={effective.value}',
  ]) ok(matrixCode.includes(anchor), `矩阵可见文本/原枚举退位锚点丢失：${anchor}`);
  ok(pageCode.includes("agentValueLabel(savedForm.agentPermissionProfile, 'minimal')"),
    '「当前生效」Agent 档位可见文本未走 agentValueLabel');
  ok(pageCode.includes('data-raw-enum={String(savedForm.agentPermissionProfile'),
    '「当前生效」Agent 档位原枚举未退到 data-*');

  // 反面：枚举不得再作为可见 JSX 文本节点直出（title 上的翻译不算可见文本）。
  for (const [code, pattern, name] of [
    [matrixCode, /<\/em>\s*\{localPreset\}/, '矩阵本地预设'],
    [matrixCode, /<\/em>\s*\{savedPreset\}/, '矩阵生效预设'],
    [matrixCode, /^\s*\{\s*local\.value\s*\}/m, '矩阵本地轴值'],
    [matrixCode, /^\s*\{\s*effective\.value\s*\}/m, '矩阵生效轴值'],
    [pageCode, /^\s*\{String\(savedForm\.agentPermissionProfile \|\| 'minimal'\)\}\s*$/m, '当前生效档位'],
  ]) ok(!pattern.test(code), `${name}仍有英文枚举裸文本`);

  // 真执行：从页面抽出标签表与函数体，用桩 t 验证「已知值出键 / 表外值透出」。
  const table = /const AGENT_VALUE_LABEL_KEYS: Record<string, string> = \{([\s\S]*?)\n\};/.exec(pageCode);
  const fn = /function agentValueLabel\(value: unknown, fallback = ''\): string \{([\s\S]*?)\n  \}/.exec(pageCode);
  ok(table && fn, 'AGENT_VALUE_LABEL_KEYS / agentValueLabel 抽取失败（守卫判据失效）');
  const keys = Function(`return {${table[1]}}`)();
  const agentValueLabel = new Function('AGENT_VALUE_LABEL_KEYS', 't',
    `return function (value, fallback = '') {${fn[1]}\n}`)(keys, (key) => `[${key}]`);
  eq(agentValueLabel('minimal', 'minimal'), '[cfg.agent.profileMinimal]', 'minimal 出双语键');
  eq(agentValueLabel('sandbox'), '[cfg.agent.codeExecSandbox]', 'sandbox 出双语键');
  eq(agentValueLabel('custom-enum'), 'custom-enum', '表外未知值原样透出');
}

console.log('agent-matrix selftest passed');
