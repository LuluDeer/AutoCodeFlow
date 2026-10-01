import { useState, useEffect, useCallback } from 'react';
import { Select, Button, Space, Typography } from 'antd';
import { message } from '../utils/toast';
import { Editor, loader } from '@monaco-editor/react';
import { useTranslation } from 'react-i18next';
import '../i18n';
// F-01（DEEP_REVIEW @0ef3bbe）：Monaco 本地化——此前未配置本地 monaco，
// @monaco-editor/react 默认从 jsdelivr CDN 动态加载，内网/离线部署下编辑器
// 永远 loading。这里注入本地 monaco 实例（worker 装配见 ./monaco-setup.ts，
// 必须先于首次 Editor 挂载执行，故以模块副作用导入）。
// 网络性能审计（2026-09-18）：monaco 实例从 ./monaco-setup 导出——它走
// tree-shaken 的 editor.api + 按需语言贡献（见该文件头注释），不再整车引入
// monaco-editor 全量包（含全部语言贡献与 ts.worker）。
import { monaco } from './monaco-setup';
import { tasksApi } from '../api/tasks';
import { showApiError } from '../utils/error';
// PERF/UX（第四轮审计）：编辑器主题跟随全站明暗主题（theme/store.ts），
// 不再硬编码 vs-dark——亮色主题下此前会出现「页面白、编辑器黑」的割裂。
import { useThemeStore, selectResolvedTheme } from '../theme/store';

// 就地启用本地 monaco（模块级一次性配置；后续 loader.init() 直接解析到该实例，
// 不再发起任何 CDN 请求）。
loader.config({ monaco });

const { Text } = Typography;

const LANGUAGE_MAP: Record<string, string> = {
  python: 'python',
  javascript: 'javascript',
  node: 'javascript',
  shell: 'shell',
};

interface GlueEditorProps {
  taskId: string;
  initialSource?: string;
  initialLanguage?: string;
  taskRuntime?: string;
  /** dirty 变化外抛：父级据此拦截未保存脚本丢失（useBlocker/beforeunload） */
  onDirtyChange?: (dirty: boolean) => void;
}

export default function GlueEditor({ taskId, initialSource, initialLanguage, taskRuntime, onDirtyChange }: GlueEditorProps) {
  const { t } = useTranslation();
  // 第四轮审计：订阅推导后的实际主题（resolved），light→"vs"、dark→"vs-dark"
  // （monaco 内置主题名；仓库无自定义 monaco 主题注册，tokens.ts 无既有映射可循）。
  // store 变化触发重渲染 → theme prop 变化，@monaco-editor/react 内部会调
  // monaco.editor.setTheme，切换即时生效，无需再手写 useEffect 监听。
  const resolvedTheme = useThemeStore(selectResolvedTheme);
  const monacoTheme = resolvedTheme === 'dark' ? 'vs-dark' : 'vs';
  const [source, setSource] = useState(initialSource || '');
  const [language, setLanguage] = useState(initialLanguage || taskRuntime || 'python');
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  // GLUE-DIRTY-01：dirty 原先是纯内部 state——用户改了脚本没保存就关页/刷新，
  // 改动静默丢失且无任何拦截。统一经 markDirty 外抛给父级（表单页把它并进
  // useBlocker/beforeunload 条件，详情页据此挂 beforeunload 守卫）。
  const markDirty = useCallback((v: boolean) => {
    setDirty(v);
    onDirtyChange?.(v);
  }, [onDirtyChange]);

  useEffect(() => {
    setSource(initialSource || '');
    setLanguage(initialLanguage || taskRuntime || 'python');
    markDirty(false);
  }, [taskId, initialSource, initialLanguage, taskRuntime, markDirty]);

  const editorLang = LANGUAGE_MAP[language] || 'python';

  const defaultTemplates: Record<string, string> = {
    python: `# Glue script for task execution
# Access environment variables:
#   os.environ['EXECUTION_ID']
#   os.environ['TASK_ID']
#   os.environ['AUTOFLOW_*'] (custom params)

import os
import json
import sys

def main():
    execution_id = os.environ.get('EXECUTION_ID', 'unknown')
    print(f"Hello from Glue script! Execution: {execution_id}")

    # Your task logic here
    result = {"status": "ok", "message": "Task completed successfully"}
    print(json.dumps(result))
    return 0

if __name__ == '__main__':
    sys.exit(main())
`,
    javascript: `// Glue script for task execution
// Access environment variables:
//   process.env.EXECUTION_ID
//   process.env.TASK_ID
//   process.env.AUTOFLOW_* (custom params)

async function main() {
  const executionId = process.env.EXECUTION_ID || 'unknown';
  console.log(\`Hello from Glue script! Execution: \${executionId}\`);

  // Your task logic here
  const result = { status: 'ok', message: 'Task completed successfully' };
  console.log(JSON.stringify(result));
}

main().catch(console.error);
`,
    shell: `#!/bin/bash
# Glue script for task execution
# Access environment variables:
#   $EXECUTION_ID
#   $TASK_ID
#   $AUTOFLOW_* (custom params)

echo "Hello from Glue script! Execution: $EXECUTION_ID"

# Your task logic here
echo '{"status": "ok", "message": "Task completed successfully"}'
`,
  };

  const handleSave = useCallback(async () => {
    if (!taskId) return;
    setSaving(true);
    try {
      await tasksApi.updateGlue(taskId, source, language);
      message.success(t('glueEditor.saveSuccess'));
      markDirty(false);
    } catch (err: unknown) {
      showApiError(err, t('glueEditor.saveFail'));
    } finally {
      setSaving(false);
    }
  }, [taskId, source, language, markDirty, t]);

  const useTemplate = () => {
    const tpl = defaultTemplates[language] || defaultTemplates.python;
    setSource(tpl);
    markDirty(true);
  };

  return (
    <div>
      <Space style={{ marginBottom: 12 }}>
        <Text strong>{t('glueEditor.title')}</Text>
        <Select
          value={language}
          onChange={(v) => { setLanguage(v); markDirty(true); }}
          style={{ width: 140 }}
          options={[
            { label: 'Python', value: 'python' },
            { label: 'JavaScript', value: 'javascript' },
            { label: 'Shell', value: 'shell' },
          ]}
        />
        <Button size="small" onClick={useTemplate}>{t('glueEditor.useTemplate')}</Button>
        <Button
          type="primary"
          size="small"
          onClick={handleSave}
          loading={saving}
          disabled={!dirty}
        >
          {t('glueEditor.save')}
        </Button>
        {dirty && <Text type="warning">{t('glueEditor.unsaved')}</Text>}
      </Space>

      <Editor
        height="400px"
        language={editorLang}
        value={source}
        onChange={(v) => { setSource(v || ''); markDirty(true); }}
        theme={monacoTheme}
        options={{
          minimap: { enabled: false },
          fontSize: 14,
          lineNumbers: 'on',
          scrollBeyondLastLine: false,
          automaticLayout: true,
          tabSize: 2,
        }}
      />
    </div>
  );
}
