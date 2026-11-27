/**
 * 工作台本地确认记录区。从 WorkbenchPage 外提以守住 300 行天花板。
 * 纯展示；记录数据由 useWorkbenchForm 持有，JSX 与文案逐字保留。
 */
import { Card, Space } from 'antd';
import { useTranslation } from 'react-i18next';
import type { ConfirmRecord } from '../../hooks/workbench-form';

export interface WorkbenchRecordsSectionProps {
  records: ConfirmRecord[];
}

export default function WorkbenchRecordsSection({ records }: WorkbenchRecordsSectionProps) {
  const { t } = useTranslation();
  if (records.length === 0) return null;
  return (
    <Card title={t('workbench.history.title')}>
      <Space orientation="vertical">
        {records.map((record, i) => (
          <div
            key={`${record.cardHash}-${i}`}
            data-testid="workbench-confirm-record"
            data-generation={record.policyGeneration}
          >
            <span>{t('workbench.history.note')}</span>
            <span>{t('workbench.history.cardHash', { hash: record.cardHash })}</span>
            <span>{t('workbench.history.generation', { generation: record.policyGeneration.slice(0, 8) })}</span>
            <span>{t('workbench.history.time', { time: record.at })}</span>
            <span>{t('workbench.history.user', { user: record.user })}</span>
          </div>
        ))}
      </Space>
    </Card>
  );
}
