import { Badge, Button, Checkbox, Input, Select, Space } from 'antd';
import { CopyOutlined, DownloadOutlined, SearchOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import '../i18n';
import { message } from '../utils/toast';
import { copyText } from '../utils/clipboard';
import { LOG_LEVEL_VALUES } from '../utils/logLevel';

export const LOG_LEVEL_FILTER_ALL = 'ALL';
export type LogLevelFilter = typeof LOG_LEVEL_FILTER_ALL | 'ERROR' | 'WARN' | 'INFO' | 'DEBUG';

export function logPreWrapStyle(wrapLines: boolean): { whiteSpace: 'pre-wrap' | 'pre'; wordBreak: 'break-word' | 'normal' } {
  return wrapLines
    ? { whiteSpace: 'pre-wrap', wordBreak: 'break-word' }
    : { whiteSpace: 'pre', wordBreak: 'normal' };
}

export interface ExecutionLogToolbarProps {
  streaming: boolean;
  inputKeyword: string;
  onInputKeywordChange: (value: string) => void;
  levelFilter: LogLevelFilter;
  loadingFilteredLogs: boolean;
  onLevelFilterChange: (value: LogLevelFilter) => void;
  wrapLines: boolean;
  onWrapLinesChange: (wrap: boolean) => void;
  displayLogs: string;
  execId: string;
}

export default function ExecutionLogToolbar({
  streaming,
  inputKeyword,
  onInputKeywordChange,
  levelFilter,
  loadingFilteredLogs,
  onLevelFilterChange,
  wrapLines,
  onWrapLinesChange,
  displayLogs,
  execId,
}: ExecutionLogToolbarProps) {
  const { t } = useTranslation();

  return (
    <Space wrap className="ui09-log-toolbar">
      {streaming && <Badge status="processing" text={t('execDetail.log.live')} />}
      <Input
        size="small"
        allowClear
        prefix={<SearchOutlined />}
        placeholder={t('execDetail.log.searchPlaceholder')}
        aria-label={t('execDetail.log.searchAria')}
        data-testid="log-search-input"
        style={{ width: 180 }}
        value={inputKeyword}
        onChange={(e) => onInputKeywordChange(e.target.value)}
      />
      <Select<LogLevelFilter>
        size="small"
        style={{ minWidth: 112 }}
        aria-label={t('execDetail.log.levelFilterAria')}
        value={levelFilter}
        loading={loadingFilteredLogs}
        disabled={loadingFilteredLogs}
        onChange={onLevelFilterChange}
        options={[
          { value: LOG_LEVEL_FILTER_ALL, label: t('execDetail.log.levelAll') },
          ...LOG_LEVEL_VALUES.map((lv) => ({ value: lv, label: lv })),
        ]}
      />
      <Checkbox
        checked={wrapLines}
        onChange={(e) => onWrapLinesChange(e.target.checked)}
        data-testid="log-wrap-toggle"
      >
        {t('execLog.wrapLines')}
      </Checkbox>
      <Button
        size="small"
        icon={<CopyOutlined />}
        onClick={async () => {
          const ok = await copyText(displayLogs);
          if (ok) message.success(t('execDetail.log.copied'));
          else message.error(t('execDetail.log.copyFailed'));
        }}
      >
        {t('execDetail.log.copy')}
      </Button>
      <Button
        size="small"
        icon={<DownloadOutlined />}
        onClick={() => {
          const blob = new Blob([displayLogs], { type: 'text/plain;charset=utf-8' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `exec-${execId}-${new Date().toISOString().slice(0, 10)}.log`;
          a.click();
          URL.revokeObjectURL(url);
        }}
      >
        {t('execDetail.log.download')}
      </Button>
    </Space>
  );
}
