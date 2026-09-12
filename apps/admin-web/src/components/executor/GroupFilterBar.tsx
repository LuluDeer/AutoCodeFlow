/**
 * UI-07 ②：执行器分组聚合（列表页工具条下方的横向分组条）。
 *
 * 决策：不引入左侧树/Tree 控件——执行器分组是扁平 string（getGroups 返回
 * string[]），单层数据用树形属过度形态；横向 Tag 条 + 「全部」聚合与现有
 * 筛选工具条（搜索/状态/分组 Select）同一视觉层级，点击即等价于设置既有
 * groupFilter（数据面单点过滤，QA-03 测试链路复用）。
 *
 * - 无分组执行器归「未分组」桶（groupName 为空串/undefined/null）；
 * - 每桶计数徽标；计数为 0 的既有分组不显示（getGroups 返回的是去重分组名，
 *   可能含已无归属执行器的历史组）；
 * - 纯函数 groupBuckets 导出可测（聚合 + 排序：未分组恒末位，组内按名称序）。
 */
import { useMemo } from 'react';
import { Space, Tag, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import '../../i18n';

export interface ExecutorGroupLike {
  id: string;
  groupName?: string | null;
}

export interface GroupBucket {
  /** 空串 = 未分组桶（Tag key 唯一化用，展示文案为「未分组」） */
  key: string;
  label: string;
  count: number;
}

/** 聚合分组桶：未分组兜底 + 计数；未分组恒末位、其余按名称 localeCompare */
export function groupBuckets<T extends ExecutorGroupLike>(executors: T[], ungroupedLabel = '未分组'): GroupBucket[] {
  const counts = new Map<string, number>();
  for (const ex of executors) {
    const key = ex.groupName?.trim() || '';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const buckets = Array.from(counts.entries()).map(([key, count]) => ({
    key,
    label: key || ungroupedLabel,
    count,
  }));
  buckets.sort((a, b) => {
    if (a.key === '' && b.key !== '') return 1;
    if (b.key === '' && a.key !== '') return -1;
    return a.label.localeCompare(b.label);
  });
  return buckets;
}

interface GroupFilterBarProps {
  executors: ExecutorGroupLike[];
  value?: string;
  onChange: (group: string | undefined) => void;
}

export default function GroupFilterBar({ executors, value, onChange }: GroupFilterBarProps) {
  const { t } = useTranslation();
  const buckets = useMemo(() => groupBuckets(executors, t('groupFilter.ungrouped')), [executors, t]);
  // 全部执行器都无分组时整条隐藏（与既有 groupFilter Select 的「有分组才显示」策略一致）
  if (buckets.length === 0) return null;
  if (buckets.length === 1 && buckets[0].key === '') return null;

  return (
    <Space size={4} wrap style={{ marginBottom: 12 }} data-testid="executor-group-bar">
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>{t('groupFilter.label')}</Typography.Text>
      <Tag.CheckableTag checked={!value} onChange={() => onChange(undefined)}>{t('groupFilter.all')}</Tag.CheckableTag>
      {buckets.map((b) => (
        <Tag.CheckableTag
          key={b.key || '__ungrouped__'}
          checked={value !== undefined && (b.key || '') === value}
          onChange={(checked) => onChange(checked ? (b.key || '') : undefined)}
        >
          {t('groupFilter.bucketCount', { label: b.label, count: b.count })}
        </Tag.CheckableTag>
      ))}
    </Space>
  );
}
