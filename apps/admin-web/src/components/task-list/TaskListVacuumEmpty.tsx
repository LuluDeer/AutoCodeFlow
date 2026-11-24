/**
 * 任务列表空态（桌面表格 emptyText 与移动端卡片两处复用）。
 *
 * 口径：
 *   · filtered（筛选命中空集）→ 仅「无匹配」空态，不引导；
 *   · vacuum（真空）→ 无任务文案 + 「创建第一个任务」入口；hint 仅移动端卡片
 *     附一行副提示，桌面表格空态不带（既有口径不动）。
 *
 * B1：引导文案键复用既有 taskList.empty.*，未新增状态机——列表空态不派生步骤。
 */
import { Button, Empty, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
// UI-10：导入 i18n 实例（模块副作用完成初始化；树内用 useTranslation 读 key）
import '../../i18n';

const { Text } = Typography;

interface TaskListVacuumEmptyProps {
  /** 当前是否带筛选条件（命中空集，非真空）。 */
  filtered: boolean;
  onCreate: () => void;
  /** 移动端卡片空态附一行引导副提示；桌面表格不传。 */
  hint?: boolean;
}

export default function TaskListVacuumEmpty({ filtered, onCreate, hint = false }: TaskListVacuumEmptyProps) {
  const { t } = useTranslation();
  if (filtered) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('taskList.empty.noMatch')} />;
  }
  return (
    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('taskList.empty.none')}>
      <Button type="primary" onClick={onCreate}>{t('taskList.empty.createFirst')}</Button>
      {hint && (
        <div style={{ marginTop: 8 }}>
          <Text type="secondary" style={{ fontSize: 12 }}>{t('taskList.empty.guideHint')}</Text>
        </div>
      )}
    </Empty>
  );
}
