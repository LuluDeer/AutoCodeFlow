/**
 * GLUE-DIRTY-NAV：任务详情页 Glue 脚本未保存改动的统一守卫。
 *
 * 只负责两件事：站内导航（react-router useBlocker + antd Modal 二次确认）
 * 与浏览器关闭/刷新（beforeunload）。刻意不 import GlueEditor/monaco——
 * 编辑器仍由页面 lazy 挂载，守卫本身不碰首屏 chunk 边界。
 */
import { useEffect, type ReactNode } from 'react';
import { Modal, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import { useBlocker } from 'react-router-dom';
import '../../i18n';

const UNBLOCKED = {
  state: 'unblocked' as const,
  reset: undefined,
  proceed: undefined,
  location: undefined,
};
const DATA_ROUTER_ERROR = /must be used within a data router/;

/**
 * useBlocker 只在 data router 下可用；仓内仍有少量详情页测试挂普通 MemoryRouter。
 * 这类渲染路径退化成「无站内弹窗、保留 beforeunload」，不抛错、不吞掉真实故障。
 */
function useSafeBlocker(dirty: boolean) {
  try {
    return useBlocker(dirty);
  } catch (err) {
    if (err instanceof Error && DATA_ROUTER_ERROR.test(err.message)) return UNBLOCKED;
    throw err;
  }
}

export default function TaskDetailUnsavedGuard({ dirty, children }: {
  dirty: boolean;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const blocker = useSafeBlocker(dirty);

  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  return (
    <>
      {children}
      <Modal
        open={blocker.state === 'blocked'}
        title={t('taskDetail.glueUnsaved.title')}
        okText={t('taskDetail.glueUnsaved.ok')}
        cancelText={t('taskDetail.glueUnsaved.cancel')}
        okButtonProps={{ danger: true }}
        onOk={() => blocker.proceed?.()}
        onCancel={() => blocker.reset?.()}
        destroyOnHidden
      >
        <Typography.Paragraph>{t('taskDetail.glueUnsaved.message')}</Typography.Paragraph>
      </Modal>
    </>
  );
}
