import { Radio } from 'antd';
import { useTranslation } from 'react-i18next';

export type InboxFilterMode = 'all' | 'actionable' | 'readonly';

export interface InboxFilterBarProps {
  value: InboxFilterMode;
  onChange: (mode: InboxFilterMode) => void;
}

export default function InboxFilterBar({ value, onChange }: InboxFilterBarProps) {
  const { t } = useTranslation();
  return (
    <div style={{ marginBottom: 16 }} data-testid="inbox-filter-bar">
      <Radio.Group
        value={value}
        onChange={(e) => onChange(e.target.value as InboxFilterMode)}
        optionType="button"
        buttonStyle="solid"
        size="small"
        options={[
          { value: 'all', label: t('inbox.filter.all') },
          { value: 'actionable', label: t('inbox.filter.actionable') },
          { value: 'readonly', label: t('inbox.filter.readonly') },
        ]}
      />
    </div>
  );
}
