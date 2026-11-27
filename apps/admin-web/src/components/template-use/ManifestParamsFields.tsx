import { Alert, Form, Input, InputNumber, Select, Switch, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import type { ManifestParam, SupportedParamType } from './manifestParams';

const { Text } = Typography;

/** 模板清单 params 的动态控件：只渲染声明为 string/number/boolean/select 的字段。 */
export default function ManifestParamsFields({
  entries,
}: {
  entries: Array<{ name: string; param: ManifestParam; type: SupportedParamType }>;
}) {
  const { t } = useTranslation();
  return (
    <>
      {entries.map(({ name, param, type }) => (
        <Form.Item
          key={name}
          name={['params', name]}
          label={param.title || name}
          extra={param.description}
          valuePropName={type === 'boolean' ? 'checked' : 'value'}
          rules={param.required ? [{ required: true, message: t('templates.useDialog.paramRequired', { name }) }] : []}
        >
          {type === 'boolean' ? (
            <Switch />
          ) : type === 'number' ? (
            <InputNumber style={{ width: '100%' }} />
          ) : type === 'select' ? (
            <Select
              allowClear={!param.required}
              options={(param.options ?? param.enum ?? []).map((option) => ({
                value: typeof option === 'object' && option !== null && 'value' in option
                  ? String((option as { value: unknown }).value)
                  : String(option),
                label: typeof option === 'object' && option !== null && 'label' in option
                  ? String((option as { label: unknown }).label)
                  : String(option),
              }))}
            />
          ) : (
            <Input placeholder={param.description || name} />
          )}
        </Form.Item>
      ))}
      {entries.length === 0 && (
        <Alert
          type="info"
          showIcon
          title={t('templates.useDialog.complexParamsTitle')}
          description={<Text type="secondary">{t('templates.useDialog.complexParamsDesc')}</Text>}
        />
      )}
    </>
  );
}
