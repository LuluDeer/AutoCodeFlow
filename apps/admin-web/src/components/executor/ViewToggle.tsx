/**
 * UI-07 ①：列表页视图切换（卡片 / 表格双视图）。
 *
 * - 三态仅两态：table（默认，QA-03 测试锚定的既有形态）/ card；
 * - localStorage 记忆（key 独立命名空间 autoflow-ui07-*，与主题 store 的
 *   autoflow-* 前缀同风格），读写失败静默降级为默认表格视图；
 * - Segmented 形态与 antd5 既有控件语言一致；size="small" 适配工具条行高。
 */
/* eslint-disable react-refresh/only-export-components --
 * 理由：本文件默认导出 ViewToggle 组件，同时导出 3 个非组件成员
 * （ExecutorViewMode / readViewMode / writeViewMode）。
 * readViewMode/writeViewMode 的消费方为 ExecutorListPage（页面组件）与
 * executor-ui07.test.tsx（直接导入断言 localStorage 记忆语义）。挪独立
 * 文件需同步改两处，并把「视图记忆键」与使用它的组件割裂；本文件非热更
 * 迭代热点，disable 换最小改动面。（eslint warning 收敛第三弹决策：
 * 消费方少但含页面连锁 → disable，同 MainLayout 先例） */
import { Segmented } from 'antd';
import { AppstoreOutlined, BarsOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import '../../i18n';

export type ExecutorViewMode = 'table' | 'card';

const STORAGE_KEY = 'autoflow-ui07-executor-view';

/** 读取记忆视图（非法值/读写失败一律回退 table——纯函数导出可测） */
export function readViewMode(storage: Storage | undefined | null): ExecutorViewMode {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    return raw === 'card' ? 'card' : 'table';
  } catch {
    return 'table';
  }
}

/** 写入记忆视图（隐私模式等场景静默失败） */
export function writeViewMode(storage: Storage | undefined | null, mode: ExecutorViewMode): void {
  try {
    storage?.setItem(STORAGE_KEY, mode);
  } catch {
    /* 静默：记忆失败不影响切换本身 */
  }
}

interface ViewToggleProps {
  value: ExecutorViewMode;
  onChange: (mode: ExecutorViewMode) => void;
}

export default function ViewToggle({ value, onChange }: ViewToggleProps) {
  const { t } = useTranslation();
  return (
    <Segmented
      data-testid="executor-view-toggle"
      size="small"
      value={value}
      onChange={(v) => onChange(v as ExecutorViewMode)}
      options={[
        { value: 'table', label: t('viewToggle.table'), icon: <BarsOutlined /> },
        { value: 'card', label: t('viewToggle.card'), icon: <AppstoreOutlined /> },
      ]}
    />
  );
}
