import { Button, Typography } from 'antd';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
// BRAND（2026-11-02）：404 是「用户走丢了」的一屏——用狐狸做形象位，比 antd 默认的
// 灰脸剪影更愿意被读一眼；它仍是装饰（标题已经说明了问题），所以 alt 留空。
import BrandFox from '../components/BrandFox';
// 头部高度是布局常量（LAYOUT_TOKENS.headerHeight），404 的「整屏居中」必须扣掉它
// 与 Content 的上下内边距，否则 `100vh` 会在壳层里多出 96px：整页出现滚动条，
// 且狐狸被顶到视口之外（截图里肉眼可见地不居中）。
import { LAYOUT_TOKENS } from '../theme/tokens';
import '../i18n';

const { Title, Text } = Typography;

/**
 * 404 页。
 *
 * 为什么不再用 antd `<Result status="404">` 的默认插图：
 *   · 那张插图是「抱头小人」的通用占位，与本产品没有任何关系；暗色主题下整体偏灰，
 *     与 #020617 底色糊在一起；
 *   · 且 `Result` 的 `title` 渲染成 `div`——404 页此前是「全页无 h1」的一页（a11y
 *     审计口径）。这里改用 `Typography.Title level={1}`（真 `<h1>`）与二级文案，
 *     颜色/字号全部走 antd token，随明暗主题翻转，不再手写十六进制。
 * 交互不变：一个主按钮回控制台（仍是 `navigate('/', { replace: true })`）。
 */
export default function NotFoundPage() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        // 壳层内的高度：视口 - 头部 - Content 上下 padding(2×20)。写成算式而不是
        // 硬编码 804，是为了将来改 headerHeight 时这里自动跟上。
        minHeight: `calc(100vh - ${LAYOUT_TOKENS.headerHeight + 40}px)`,
        gap: 8,
        padding: 24,
        textAlign: 'center',
        background: 'var(--color-background)',
      }}
    >
      <BrandFox size={160} style={{ marginBottom: 8 }} />
      <Title level={1} style={{ margin: 0 }}>
        {t('notFound.title')}
      </Title>
      <Text type="secondary" style={{ marginBottom: 16, fontSize: 14 }}>
        {t('notFound.subTitle')}
      </Text>
      <Button type="primary" onClick={() => navigate('/', { replace: true })}>
        {t('notFound.backHome')}
      </Button>
    </div>
  );
}
