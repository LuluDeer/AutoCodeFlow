/**
 * REFACTOR-TASKFORM-11：任务表单**页框架**——左侧锚点条 + 校验失败读屏播报区
 * （原 TaskFormPage 内联 JSX 原样迁出）。
 *
 *  - UI-06：锚点条是具名 navigation（aria-label），五分区单页的滚动定位入口；
 *    jsdom 无布局，Anchor 原生滚动监听依赖 getBoundingClientRect——测试环境只
 *    断言锚点渲染与点击可滚，不测监听。
 *  - G-4：宽屏（≥lg）显示锚点条，窄屏隐藏（antd Grid 断点内联自洽，不与外部
 *    CSS 争夺 display 优先级）。
 *  - UI-12：校验失败播报通道（role="status" + aria-live，视觉隐藏）；视觉反馈
 *    由 message + 锚点滚动承担，播报文案由父级 setValidationAnnouncement 写入。
 *  - PLAN-FRONTEND-UX-IMPROVEMENTS §2.3：锚点条顶部显示整体完成度（百分比 +
 *    role="progressbar"），每个锚点项补一个「该分区必填项是否齐」的状态点。
 *    **口径不在此处判定**——`completionPercent` / `sectionStatus` 全部由
 *    父级用 utils/formCompletion 的纯函数算出后下传，本组件只负责呈现，
 *    避免出现第二套完成度口径。
 */
import { Anchor, Grid, Typography, theme } from 'antd';
import { useTranslation } from 'react-i18next';
import '../../i18n';
import { LAYOUT_TOKENS } from '../../theme/tokens';

export interface TaskFormAnchorItem {
  key: string;
  href: string;
  title: string;
}

/** 分区完成态；无状态点 = 该分区没有必填项（无从判定「完成」） */
export type TaskFormSectionStatus = 'complete' | 'incomplete';

export default function TaskFormNavRail({ anchorItems, announcement, completionPercent, sectionStatus }: {
  anchorItems: TaskFormAnchorItem[];
  /** UI-12：最近一次校验失败摘要（空串 = 清空播报，如提交成功后） */
  announcement: string;
  /**
   * §2.3：整体完成度 0–100（父级经 computeFormCompletion 计算，**只数必填项**，
   * 条件性字段不进分母）。不传 = 不渲染完成度区块。
   */
  completionPercent?: number;
  /** §2.3：分区 key → 完成态（父级按 requiredTotal 已筛掉无必填项的分区） */
  sectionStatus?: Record<string, TaskFormSectionStatus>;
}) {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  // G-4：锚点条显隐改由 antd Grid 断点决定（lg 及以上才显示），
  // 不再用内联 display:none 硬编码（会覆盖外部 CSS 媒体查询）。
  const screens = Grid.useBreakpoint();

  const showCompletion = typeof completionPercent === 'number';
  const percent = typeof completionPercent === 'number'
    ? Math.max(0, Math.min(100, Math.round(completionPercent)))
    : 0;

  // 视觉隐藏样式（与下方 UI-12 播报区同款）：状态点的语义文本用。
  const visuallyHidden = {
    position: 'absolute',
    width: 1,
    height: 1,
    overflow: 'hidden',
    clip: 'rect(0 0 0 0)',
    whiteSpace: 'nowrap',
  } as const;

  const items = anchorItems.map((item) => {
    const status = sectionStatus?.[item.key];
    if (!status) return item;
    // 完成 = 实心 success 点；未完成 = 空心中性色点。刻意不用 error 红：
    // 刚打开页面什么都没填并不是「错误」，红色标记只会制造无谓的焦虑。
    const complete = status === 'complete';
    return {
      ...item,
      title: (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          {/* 状态点本体是纯装饰：语义由紧随其后的视觉隐藏文本承载，读屏与
              无障碍树都能从链接名里听到「必填项已填齐 / 还有必填项未填」。 */}
          <span
            aria-hidden="true"
            data-testid={`task-form-section-dot-${item.key}`}
            data-status={status}
            style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              flexShrink: 0,
              background: complete ? token.colorSuccess : 'transparent',
              border: `1px solid ${complete ? token.colorSuccess : token.colorBorder}`,
            }}
          />
          <span>{item.title}</span>
          <span style={visuallyHidden}>
            {/* 两个键必须各自字面量写出：写成 `t(complete ? 'a' : 'b')` 会让
                i18n-key-check 判成「动态键」（静态不可判），从而被迫塞进
                baseline 的 dynamicCallFiles——那是给真正运行期才知道键名的
                场景留的口子，这里不需要。 */}
            {complete
              ? t('taskForm.completion.section.complete', { section: item.title })
              : t('taskForm.completion.section.incomplete', { section: item.title })}
          </span>
        </span>
      ),
    };
  });

  return (
    <>
      {/* 左侧锚点条（jsdom 无布局，Anchor 原生滚动监听依赖 getBoundingClientRect——
          测试环境只断言锚点渲染与点击可滚，不测监听） */}
      <nav
        data-testid="task-form-anchor"
        aria-label={t('taskForm.anchorAria')}
        style={{
          width: 160,
          flexShrink: 0,
          position: 'sticky',
          top: LAYOUT_TOKENS.anchorScrollOffset,
          // G-4：宽屏（≥lg）显示锚点条，窄屏隐藏。断点逻辑内联自洽，
          // 不再与外部 CSS 争夺 display 优先级（此前硬编码 none 会覆盖任何媒体查询）。
          display: screens.lg ? 'block' : 'none',
        }}
        className="task-form-anchor-rail"
      >
        {showCompletion && (
          /* §2.3 整体完成度。aria-valuenow 与可视百分比同源（同一个 percent），
             不会出现「看到 60% 却读出 100%」。放在锚点条**内部顶端**：
             它随锚点条一起 sticky，长表单滚动时始终可见。 */
          <div
            role="progressbar"
            aria-valuenow={percent}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={t('taskForm.completion.aria', { percent })}
            data-testid="task-form-completion"
            style={{ marginBottom: 12 }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 4 }}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {t('taskForm.completion.label')}
              </Typography.Text>
              <Typography.Text strong style={{ fontSize: 12 }} data-testid="task-form-completion-text">
                {t('taskForm.completion.percent', { percent })}
              </Typography.Text>
            </div>
            {/* 进度条视觉本体：数值已由外层 progressbar 播报，此处 aria-hidden
                以免同一信息被读两遍。 */}
            <div
              aria-hidden="true"
              style={{
                marginTop: 4,
                height: 4,
                borderRadius: 2,
                background: token.colorFillSecondary,
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  width: `${percent}%`,
                  height: '100%',
                  background: percent === 100 ? token.colorSuccess : token.colorPrimary,
                  transition: 'width 0.2s',
                }}
              />
            </div>
          </div>
        )}
        <Anchor
          affix={false}
          items={items}
          onClick={(e) => {
            e.preventDefault();
          }}
        />
      </nav>
      {/* UI-12：校验失败播报通道（视觉隐藏；视觉反馈由 message + 锚点滚动承担） */}
      <div
        role="status"
        aria-live="polite"
        data-testid="task-form-validation-announcement"
        style={{
          position: 'absolute',
          width: 1,
          height: 1,
          overflow: 'hidden',
          clip: 'rect(0 0 0 0)',
          whiteSpace: 'nowrap',
        }}
      >
        {announcement}
      </div>
    </>
  );
}
