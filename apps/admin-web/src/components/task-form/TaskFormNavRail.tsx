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
 */
import { Anchor, Grid } from 'antd';
import { useTranslation } from 'react-i18next';
import '../../i18n';
import { LAYOUT_TOKENS } from '../../theme/tokens';

export interface TaskFormAnchorItem {
  key: string;
  href: string;
  title: string;
}

export default function TaskFormNavRail({ anchorItems, announcement }: {
  anchorItems: TaskFormAnchorItem[];
  /** UI-12：最近一次校验失败摘要（空串 = 清空播报，如提交成功后） */
  announcement: string;
}) {
  const { t } = useTranslation();
  // G-4：锚点条显隐改由 antd Grid 断点决定（lg 及以上才显示），
  // 不再用内联 display:none 硬编码（会覆盖外部 CSS 媒体查询）。
  const screens = Grid.useBreakpoint();

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
        <Anchor
          affix={false}
          items={anchorItems}
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
