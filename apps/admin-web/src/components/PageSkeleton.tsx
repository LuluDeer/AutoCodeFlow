import { Skeleton as AntSkeleton, Card } from 'antd';

export type SkeletonVariant = 'table' | 'cards';

export interface PageSkeletonProps {
  /** 形态：table=列表页（多行条目）/ cards=卡片页（2 列卡片骨架） */
  variant?: SkeletonVariant;
  /** 行数/卡片数（默认 table 5 行、cards 4 张） */
  rows?: number;
  style?: React.CSSProperties;
}

/**
 * UI-08 加载态标准形态：首屏数据加载用 Skeleton 替代裸 Spin。
 * 两个标准形态——列表页 table（行骨架）与卡片页 cards（卡片骨架）；
 * 非首屏的局部刷新（按钮 loading、表格翻页）继续用 antd 原生 loading 态，不替换。
 */
export default function PageSkeleton({ variant = 'table', rows, style }: PageSkeletonProps) {
  if (variant === 'cards') {
    const count = rows ?? 4;
    return (
      <div data-testid="page-skeleton" style={{ display: 'flex', flexWrap: 'wrap', gap: 16, ...style }}>
        {Array.from({ length: count }, (_, i) => (
          <Card key={i} style={{ width: 280, flex: '1 1 280px' }} styles={{ body: { padding: 16 } }}>
            <AntSkeleton active paragraph={{ rows: 2 }} />
          </Card>
        ))}
      </div>
    );
  }
  const count = rows ?? 5;
  return (
    <div data-testid="page-skeleton" style={{ padding: '8px 0', ...style }}>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} style={{ padding: '10px 0', borderBottom: '1px solid transparent' }}>
          <AntSkeleton active title={false} paragraph={{ rows: 1, width: i % 2 === 0 ? '68%' : '42%' }} />
        </div>
      ))}
    </div>
  );
}
