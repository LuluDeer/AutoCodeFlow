import { Alert, Form, Input } from 'antd';
import { useTranslation } from 'react-i18next';
import type { ManifestParam, SupportedParamType } from './manifestParams';

const { TextArea } = Input;

/** 复杂 schema 的降级路径：显式填 JSON 对象（params），解析失败时给出错误，不发请求。 */
export default function RawParamsEditor({
  value,
  onChange,
  entries,
  error,
}: {
  value: string;
  onChange: (raw: string) => void;
  entries: Array<{ name: string; param: ManifestParam; type: SupportedParamType | null }>;
  error: string | null;
}) {
  const { t } = useTranslation();
  const hint = entries.map(({ name, param }) => `${name}: ${param.type ?? 'any'}`).join('\n');

  return (
    <div>
      <Form.Item label={t('templates.useDialog.rawParamsLabel')}>
        <TextArea
          data-testid="instantiate-params-json"
          rows={6}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}
        />
      </Form.Item>
      {error ? <Alert type="error" showIcon title={error} /> : null}
      {hint ? (
        <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: 11, opacity: 0.75 }}>{hint}</pre>
      ) : null}
    </div>
  );
}
