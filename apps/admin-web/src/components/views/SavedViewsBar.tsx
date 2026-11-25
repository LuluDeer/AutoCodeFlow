/**
 * 保存筛选视图工具条（切换 / 保存 / 重命名 / 删除），任务 / 执行列表复用。
 *
 * 纯展示 + 回调：视图列表与持久化在 useSavedViews；本组件负责
 *  - Select 切换已保存视图（allowClear 回到「当前未保存口径」）；
 *  - 内联输入框保存当前口径 / 重命名；
 *  - 删除二次确认。
 *
 * 文案走组件内 useTranslation（views.* 词条）；校验结果由父级回调回传
 * `{ ok, reason }`，行内报错。
 */
import { useRef, useState } from 'react';
import { Button, Input, Popconfirm, Select, Space, Typography } from 'antd';
import {
  CheckOutlined,
  DeleteOutlined,
  EditOutlined,
  SaveOutlined,
} from '@ant-design/icons';
import type { InputRef } from 'antd';
import { useTranslation } from 'react-i18next';
import type { SavedView } from '../../utils/savedViews';
import { VIEW_NAME_MAX } from '../../utils/savedViews';

const { Text } = Typography;

export interface SaveResult {
  ok: boolean;
  reason?: 'empty' | 'tooLong';
}

export interface SavedViewsBarProps<F> {
  views: SavedView<F>[];
  activeId: string | null;
  onSave: (name: string) => SaveResult;
  onRename: (id: string, name: string) => SaveResult;
  onRemove: (id: string) => void;
  onApply: (view: SavedView<F>) => void;
  onClearActive: () => void;
}

type Mode = 'idle' | 'save' | 'rename';

export default function SavedViewsBar<F>({
  views,
  activeId,
  onSave,
  onRename,
  onRemove,
  onApply,
  onClearActive,
}: SavedViewsBarProps<F>) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<Mode>('idle');
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<InputRef>(null);

  const active = views.find((v) => v.id === activeId) ?? null;

  const failLabel = (reason?: 'empty' | 'tooLong') =>
    reason === 'tooLong' ? t('views.nameTooLong') : t('views.nameRequired');

  const startSave = () => {
    setMode('save');
    setDraft('');
    setError(null);
  };

  const startRename = () => {
    if (!active) return;
    setMode('rename');
    setDraft(active.name);
    setError(null);
  };

  const submitSave = () => {
    const res = onSave(draft);
    if (res.ok) {
      setMode('idle');
      setDraft('');
    } else {
      setError(failLabel(res.reason));
    }
  };

  const submitRename = () => {
    if (!active) return;
    const res = onRename(active.id, draft);
    if (res.ok) {
      setMode('idle');
      setDraft('');
    } else {
      setError(failLabel(res.reason));
    }
  };

  const onSelectChange = (val: string | undefined) => {
    if (!val) {
      onClearActive();
      return;
    }
    const view = views.find((v) => v.id === val);
    if (view) onApply(view);
  };

  const renderInlineInput = (onSubmit: () => void, placeholder: string) => (
    <Input
      ref={inputRef}
      autoFocus
      size="small"
      style={{ width: 180 }}
      value={draft}
      maxLength={VIEW_NAME_MAX}
      placeholder={placeholder}
      onChange={(e) => { setDraft(e.target.value); setError(null); }}
      onPressEnter={onSubmit}
      suffix={
        <Button
          type="text"
          size="small"
          aria-label={t('inbox.action.confirm')}
          icon={<CheckOutlined />}
          onClick={onSubmit}
        />
      }
    />
  );

  return (
    <Space wrap align="center" size={8}>
      <Select
        data-testid="saved-views-select"
        style={{ minWidth: 180 }}
        size="small"
        allowClear
        placeholder={t('views.current')}
        value={activeId ?? undefined}
        onChange={onSelectChange}
        notFoundContent={t('views.empty')}
        options={views.map((v) => ({ value: v.id, label: v.name }))}
      />
      {mode === 'save' ? (
        renderInlineInput(submitSave, t('views.savePlaceholder'))
      ) : (
        <Button size="small" icon={<SaveOutlined />} onClick={startSave}>
          {t('views.save')}
        </Button>
      )}
      {active && mode !== 'save' && (
        <>
          {mode === 'rename' ? (
            renderInlineInput(submitRename, t('views.rename'))
          ) : (
            <Button size="small" icon={<EditOutlined />} onClick={startRename}>
              {t('views.rename')}
            </Button>
          )}
          <Popconfirm
            title={t('views.removeConfirm')}
            onConfirm={() => onRemove(active.id)}
            okText={t('views.remove')}
            cancelText={t('taskList.cancel')}
          >
            <Button size="small" danger icon={<DeleteOutlined />}>
              {t('views.remove')}
            </Button>
          </Popconfirm>
        </>
      )}
      {error && (
        <Text type="danger" role="alert" style={{ fontSize: 12 }}>
          {error}
        </Text>
      )}
    </Space>
  );
}
