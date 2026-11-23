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

console.log('agent-matrix selftest passed');
