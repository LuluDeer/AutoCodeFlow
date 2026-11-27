import { useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from 'react';
import { Button, Space, Tooltip, Typography, theme } from 'antd';
import { PlusOutlined, MinusOutlined, AimOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import type { DagGraph } from '../dag-layout';
import type { LiveExecutionStatus } from './dagLiveStatus';
import { BRAND_GRADIENT, DESIGN_TOKENS } from '../../theme/tokens';

const { Text } = Typography;

/** 当前节点高亮阴影：品牌绿单源（tokens.ts BRAND_GRADIENT → DESIGN_TOKENS.accent 兜底），不再写 antd 蓝字面量。 */
const BRAND_GREEN_HEX = BRAND_GRADIENT.match(/#[0-9a-f]{6}/i)?.[0] ?? DESIGN_TOKENS.accent;
const BRAND_GREEN_RGB = BRAND_GREEN_HEX.slice(1)
  .match(/[0-9a-f]{2}/gi)!
  .map((channel) => parseInt(channel, 16))
  .join(',');
const CURRENT_NODE_SHADOW = `0 0 0 2px rgba(${BRAND_GREEN_RGB},0.25)`;

/** 依赖 DAG 的可平移/缩放/高亮画布（DOM 节点 + SVG 连线，无第三方图库）。 */
export default function DagCanvas({
  graph,
  positions,
  width,
  height,
  statusOf,
  statusLabel,
  statusColor,
  currentTaskId,
  onNavigate,
}: {
  graph: DagGraph;
  positions: Map<string, { x: number; y: number; w: number; h: number }>;
  width: number;
  height: number;
  statusOf: (id: string) => LiveExecutionStatus | undefined;
  statusLabel: (status: string) => string;
  statusColor: (status: string | undefined, token: ReturnType<typeof theme.useToken>['token']) => string;
  currentTaskId: string;
  onNavigate: (id: string) => void;
}) {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [selected, setSelected] = useState<string | null>(currentTaskId);
  const dragRef = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const movedRef = useRef(false);

  const related = useMemo(() => {
    if (!selected) return { nodes: new Set<string>(), edges: new Set<string>() };
    const nodes = new Set<string>([selected]);
    const edges = new Set<string>();
    for (const edge of graph.edges) {
      if (edge.from === selected || edge.to === selected) {
        nodes.add(edge.from);
        nodes.add(edge.to);
        edges.add(`${edge.from}->${edge.to}`);
      }
    }
    return { nodes, edges };
  }, [graph.edges, selected]);

  const zoom = (delta: number) => setScale((s) => Math.max(0.4, Math.min(2.5, +(s + delta).toFixed(2))));

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    dragRef.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y };
    movedRef.current = false;
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    setOffset({ x: drag.ox + e.clientX - drag.x, y: drag.oy + e.clientY - drag.y });
    if (Math.abs(e.clientX - drag.x) > 3 || Math.abs(e.clientY - drag.y) > 3) movedRef.current = true;
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    dragRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };

  const onWheel = (e: ReactWheelEvent<HTMLDivElement>) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    zoom(e.deltaY < 0 ? 0.1 : -0.1);
  };

  return (
    <div>
      <Space size={4} style={{ marginBottom: 8 }}>
        <Tooltip title={t('depGraph.zoomIn')}>
          <Button size="small" icon={<PlusOutlined />} aria-label={t('depGraph.zoomIn')} onClick={() => zoom(0.1)} />
        </Tooltip>
        <Tooltip title={t('depGraph.zoomOut')}>
          <Button size="small" icon={<MinusOutlined />} aria-label={t('depGraph.zoomOut')} onClick={() => zoom(-0.1)} />
        </Tooltip>
        <Tooltip title={t('depGraph.resetView')}>
          <Button
            size="small"
            icon={<AimOutlined />}
            aria-label={t('depGraph.resetView')}
            onClick={() => { setScale(1); setOffset({ x: 0, y: 0 }); setSelected(currentTaskId); }}
          />
        </Tooltip>
        <Text type="secondary" style={{ fontSize: 12 }}>{Math.round(scale * 100)}%</Text>
      </Space>
      <div
        data-testid="dag-canvas"
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        style={{
          height: Math.min(560, Math.max(280, height * scale)),
          overflow: 'hidden',
          border: `1px solid ${token.colorBorderSecondary}`,
          borderRadius: 8,
          background: token.colorBgContainer,
          cursor: dragRef.current ? 'grabbing' : 'grab',
          touchAction: 'none',
        }}
      >
        <div
          style={{
            width,
            height,
            transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
            transformOrigin: '0 0',
            position: 'relative',
          }}
        >
          <svg width={width} height={height} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
            <defs>
              <marker id="dag-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
                <path d="M0,0 L8,4 L0,8 Z" fill={token.colorTextTertiary} />
              </marker>
            </defs>
            {graph.edges.map((edge) => {
              const from = positions.get(edge.from);
              const to = positions.get(edge.to);
              if (!from || !to) return null;
              const x1 = from.x + from.w;
              const y1 = from.y + from.h / 2;
              const x2 = to.x;
              const y2 = to.y + to.h / 2;
              const mx = (x1 + x2) / 2;
              const active = related.edges.has(`${edge.from}->${edge.to}`);
              return (
                <path
                  key={`${edge.from}->${edge.to}`}
                  d={`M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`}
                  fill="none"
                  stroke={active ? token.colorPrimary : token.colorTextTertiary}
                  strokeWidth={active ? 2.5 : 1.5}
                  opacity={selected && !active ? 0.35 : 1}
                  markerEnd="url(#dag-arrow)"
                />
              );
            })}
          </svg>
          {graph.nodes.map((node) => {
            const pos = positions.get(node.id)!;
            const live = statusOf(node.id);
            const active = !selected || related.nodes.has(node.id);
            const isCurrent = node.id === currentTaskId;
            return (
              <div
                key={node.id}
                data-testid={`dag-node-${node.id}`}
                data-live-status={live ?? ''}
                tabIndex={isCurrent ? -1 : 0}
                role={isCurrent ? undefined : 'button'}
                aria-label={`${node.name} — ${statusLabel(live ?? node.status)}`}
                onClick={(e) => {
                  e.stopPropagation();
                  if (!movedRef.current) setSelected(node.id);
                }}
                onKeyDown={isCurrent ? undefined : (e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onNavigate(node.id);
                  }
                }}
                onDoubleClick={(e) => { e.stopPropagation(); onNavigate(node.id); }}
                title={t('depGraph.nodeNavigate')}
                style={{
                  position: 'absolute',
                  left: pos.x,
                  top: pos.y,
                  width: pos.w,
                  height: pos.h,
                  padding: '6px 10px',
                  borderRadius: 8,
                  border: `${isCurrent ? 2 : 1}px solid ${isCurrent ? token.colorPrimary : token.colorBorder}`,
                  background: isCurrent ? token.colorPrimaryBg : token.colorBgContainer,
                  cursor: 'pointer',
                  overflow: 'hidden',
                  opacity: active ? 1 : 0.4,
                  boxShadow: isCurrent ? CURRENT_NODE_SHADOW : undefined,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, background: statusColor(live, token) }} />
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{node.name}</span>
                </div>
                <div style={{ marginTop: 2, fontSize: 11, color: token.colorTextSecondary }}>
                  {statusLabel(live ?? node.status)}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 8 }}>
        {t('depGraph.legend')}
      </Text>
    </div>
  );
}
