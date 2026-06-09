import { useState, useEffect, useCallback } from 'react';
import { Input, Select, Button, Space, message, Typography } from 'antd';
import { Editor } from '@monaco-editor/react';
import { tasksApi } from '../api/tasks';

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
}

export default function GlueEditor({ taskId, initialSource, initialLanguage, taskRuntime }: GlueEditorProps) {
  const [source, setSource] = useState(initialSource || '');
  const [language, setLanguage] = useState(initialLanguage || taskRuntime || 'python');
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    setSource(initialSource || '');
    setLanguage(initialLanguage || taskRuntime || 'python');
    setDirty(false);
  }, [taskId, initialSource, initialLanguage, taskRuntime]);

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
      message.success('Glue script saved');
      setDirty(false);
    } catch (err: any) {
      message.error(err?.response?.data?.message || 'Failed to save glue script');
    } finally {
      setSaving(false);
    }
  }, [taskId, source, language]);

  const useTemplate = () => {
    const tpl = defaultTemplates[language] || defaultTemplates.python;
    setSource(tpl);
    setDirty(true);
  };

  return (
    <div>
      <Space style={{ marginBottom: 12 }}>
        <Text strong>Glue 脚本编辑器</Text>
        <Select
          value={language}
          onChange={(v) => { setLanguage(v); setDirty(true); }}
          style={{ width: 140 }}
          options={[
            { label: 'Python', value: 'python' },
            { label: 'JavaScript', value: 'javascript' },
            { label: 'Shell', value: 'shell' },
          ]}
        />
        <Button size="small" onClick={useTemplate}>使用模板</Button>
        <Button
          type="primary"
          size="small"
          onClick={handleSave}
          loading={saving}
          disabled={!dirty}
        >
          保存脚本
        </Button>
        {dirty && <Text type="warning">有未保存的更改</Text>}
      </Space>

      <Editor
        height="400px"
        language={editorLang}
        value={source}
        onChange={(v) => { setSource(v || ''); setDirty(true); }}
        theme="vs-dark"
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