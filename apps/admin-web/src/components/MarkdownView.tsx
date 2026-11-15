import { useMemo, useState } from 'react';
import { Button, Typography, theme } from 'antd';
import { DownOutlined, UpOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { parseMarkdown, type InlineNode, type MarkdownBlock } from '../utils/markdown';
import { FONT_STACKS } from '../theme/tokens';
import '../i18n';

const { Text, Paragraph } = Typography;

/** 长文判定阈值：块数或字符数超过即默认折叠，给「展开全文」出口。 */
const LONG_BLOCKS = 5;
const LONG_CHARS = 280;
const COLLAPSED_HEIGHT = 120;
const EXPANDED_HEIGHT = 320;

/** 行内 AST → React 节点；文本默认由 React 转义，不注入 HTML。 */
function renderInline(nodes: InlineNode[], keyPrefix: string): React.ReactNode {
  return nodes.map((node, idx) => {
    const key = `${keyPrefix}-${idx}`;
    switch (node.type) {
      case 'code':
        return (
          <Text key={key} code style={{ fontFamily: FONT_STACKS.mono, fontSize: 12 }}>
            {node.text}
          </Text>
        );
      case 'bold':
        return <strong key={key}>{renderInline(node.children, `${key}-b`)}</strong>;
      case 'italic':
        return <em key={key}>{renderInline(node.children, `${key}-i`)}</em>;
      default:
        return <span key={key}>{node.text}</span>;
    }
  });
}

function renderBlock(block: MarkdownBlock, idx: number, token: ReturnType<typeof theme.useToken>['token']): React.ReactNode {
  const key = `block-${idx}`;
  switch (block.type) {
    case 'code':
      return (
        <pre
          key={key}
          style={{
            margin: '8px 0',
            padding: 12,
            borderRadius: 8,
            background: token.colorFillQuaternary,
            border: `1px solid ${token.colorBorderSecondary}`,
            fontFamily: FONT_STACKS.mono,
            fontSize: 12,
            lineHeight: 1.6,
            overflowX: 'auto',
          }}
        >
          <code>{block.text}</code>
        </pre>
      );
    case 'heading': {
      const level = Math.min(block.level, 4);
      const fontSize = level === 1 ? 16 : level === 2 ? 15 : level === 3 ? 14 : 13;
      return (
        <div key={key} style={{ fontSize, fontWeight: 600, margin: '10px 0 6px' }}>
          {renderInline(block.children, `${key}-h`)}
        </div>
      );
    }
    case 'ul':
      return (
        <ul key={key} style={{ margin: '6px 0', paddingLeft: 20 }}>
          {block.items.map((item, i) => <li key={i}>{renderInline(item, `${key}-u${i}`)}</li>)}
        </ul>
      );
    case 'ol':
      return (
        <ol key={key} style={{ margin: '6px 0', paddingLeft: 20 }}>
          {block.items.map((item, i) => <li key={i}>{renderInline(item, `${key}-o${i}`)}</li>)}
        </ol>
      );
    default:
      return (
        <Paragraph key={key} style={{ margin: '6px 0' }}>
          {renderInline(block.children, `${key}-p`)}
        </Paragraph>
      );
  }
}

export interface MarkdownViewProps {
  source: string;
  /** 外层容器追加样式（详情 Descriptions 条目内联消费） */
  style?: React.CSSProperties;
}

/**
 * 受限子集 Markdown 渲染（P2-06）：标题/列表/代码块/行内代码正常排版，
 * 长文默认折叠并提供展开/收起；安全口径见 utils/markdown.ts 注释。
 */
export default function MarkdownView({ source, style }: MarkdownViewProps) {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  const blocks = useMemo(() => parseMarkdown(source), [source]);
  const long = blocks.length > LONG_BLOCKS || source.length > LONG_CHARS;
  const [expanded, setExpanded] = useState(false);

  if (blocks.length === 0) return <Text type="secondary">-</Text>;

  return (
    <div style={{ fontSize: 13, ...style }}>
      <div
        style={{
          maxHeight: long && !expanded ? COLLAPSED_HEIGHT : EXPANDED_HEIGHT,
          overflowY: long || source.length > EXPANDED_HEIGHT ? 'auto' : undefined,
        }}
      >
        {blocks.map((block, idx) => renderBlock(block, idx, token))}
      </div>
      {long && (
        <Button
          type="text"
          size="small"
          style={{ paddingInline: 0, marginTop: 4 }}
          icon={expanded ? <UpOutlined /> : <DownOutlined />}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? t('taskDetail.runbook.collapse') : t('taskDetail.runbook.expand')}
        </Button>
      )}
    </div>
  );
}
