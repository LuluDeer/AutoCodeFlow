/**
 * R150（F1）：应用详情「下发到设备」弹窗（从 `ApplicationDetailPage.tsx` 外提）。
 *
 * ## 为什么外提
 *
 * `apps/admin-web/src/pages/ApplicationDetailPage.tsx` 在体量棘轮顶格
 * （scripts/source-size-baseline.json：nonCommentLines=1302 / ceiling 1302，
 * **零余量**）⇒ 弹窗的 JSX 与提示逻辑必须外提，页面里只留调用与状态。
 * 先例：R139 `pages/executor-packages/UploadPackageModal.tsx`、
 * R141 `pages/sops/AssignSopModal.tsx`（整块 JSX 逐字搬移、props 全显式、
 * 行为零变更）。
 *
 * ## 本文件修的缺陷（F1）
 *
 * 取数 `deploymentsApi.list(app.id, 1, 100)` 只拿**前 100 行**且**丢弃了
 * `total`**；后端按 `createdAt DESC` 排序 ⇒ 被截掉的恰是**最老**、最可能仍在
 * `running` 的部署行。那些设备于是既不在勾选列表里、也不在默认勾选集里，
 * 用户只会得到「这台机器没部署过」这一种解释（真相是分页窗口）。
 *
 * 本文件把「截断」变成**显式可见的事实**：
 *   · `total > 已取行数` ⇒ 渲染告警条，写明**已列多少 / 共有多少 / 还有多少更早
 *     的未显示**，并给出**可去的地方**（跳到本应用的「部署实例」页，那里是
 *     全量分页视图）；
 *   · 真空态与截断态**分开**：`rows.length === 0 && total === 0` ⇒ 真空态
 *     （"该应用暂无部署行"）；`rows.length === 0 && total > 0` ⇒ **不能**说
 *     "没有部署"（那是另一个假事实），改为如实说明"本次未取到部署行、共 N 条"。
 *
 * 告警条形态照抄同文件 `ReleasesTab` 的 P8 截断告警（Alert type=warning +
 * title/description/action 三段 + data-testid），**不自造**（仅把 antd v6 已
 * 弃用的 `message` prop 换成 `title`，与同页另两处 Alert 一致）。
 *
 * ## 另一处静默丢弃（同一次取数里）
 *
 * `applicationsApi.getReleases(app.id, 1, 200).catch(() => null)`：包地址
 * （packageUrl）是确认前的提示信息，读取失败**不阻断**下发面（这一条保持
 * 不变）。但「读失败」与「快照确实不含包地址」此前都表现为**什么都不显示**
 * ⇒ 用户无法区分「这份快照没有包地址（安全）」与「我们没读到（未知）」。
 * 未知状态下「本次下发会不会回退安装包」是**真的不知道** ⇒ 给出可见告警
 * （`deployPkgUnknown*`），不承诺任何不存在的能力。
 */
import { Modal, Alert, Button, Checkbox, Empty, Spin, Tag, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import type { AppDeployment } from '../../api/applications';
import { RELEASE_DEPLOY_STATUS_COLOR } from '../../utils/status-color';
import { releaseStatusLabel } from '../../utils/trigger-label';
import type { DeployPkgState } from './deploy-pkg-state';

const { Text } = Typography;

/** 下发弹窗的读取结果（一次取数落地后的全部事实）。 */
export interface DeployModalData {
  /** 本次取到的部署行（按 createdAt DESC，最多 100 行）。 */
  rows: AppDeployment[];
  /** 该应用的部署行总数（后端 total）——用于识别「被截断」。 */
  total: number;
  /** 快照包地址的确认状态。 */
  pkg: DeployPkgState;
}

/** 执行器可读名解析（页面侧 hook 提供，见 useExecutorNames）。 */
export type ExecutorNameResolver = (
  deployment: { executorId?: string | null; executorAddress?: string | null },
) => string | null;

export interface DeployToDevicesModalProps {
  /** 弹窗开关（null = 无下发目标）。 */
  open: boolean;
  /** 目标版本号（标题用）。 */
  version: string | null;
  /** 读取结果：null = 读取中（只给加载指示）。 */
  data: DeployModalData | null;
  /** 已勾选的执行器 id 集合。 */
  checkedExecutors: string[];
  /** 下发中（确认键 loading）。 */
  deploying: boolean;
  /** 执行器可读名解析。 */
  nameOf: ExecutorNameResolver;
  /** 勾选变更（新增/移除一个执行器 id）。 */
  onToggleExecutor: (executorId: string, checked: boolean) => void;
  /** 关闭弹窗。 */
  onCancel: () => void;
  /** 确认下发。 */
  onOk: () => void;
}

/**
 * 「下发到设备」对话框：勾选部署行 + 截断/空态/包地址三类可见提示。
 */
export default function DeployToDevicesModal({
  open,
  version,
  data,
  checkedExecutors,
  deploying,
  nameOf,
  onToggleExecutor,
  onCancel,
  onOk,
}: DeployToDevicesModalProps) {
  const { t } = useTranslation();
  // 截断告警条的出口：本应用的「部署实例」页（那里是全量分页视图）。
  // 用 ?tab=deep-link（页面既有约定，见 ApplicationDetailPage 的 setSearchParams）。
  const [, setSearchParams] = useSearchParams();

  // 截断判据：**后端总数 > 本次实取行数** ⇒ 有更早的部署行没被取到。
  const shown = data?.rows.length ?? 0;
  const total = data?.total ?? 0;
  const truncated = !!data && total > shown;
  const hidden = truncated ? total - shown : 0;

  return (
    <Modal
      open={open}
      title={t('appDetail.history.deployTitle', { version: version ?? '' })}
      okText={t('appDetail.history.deployOk')}
      okButtonProps={{ danger: true, disabled: checkedExecutors.length === 0 }}
      confirmLoading={deploying}
      cancelText={t('appDetail.cancel')}
      onCancel={onCancel}
      onOk={onOk}
      destroyOnHidden
    >
      {data === null ? (
        <Spin style={{ display: 'block', margin: '16px auto' }} />
      ) : (
        <>
          {/* 快照包地址三态：确认有 / 确认没有 / **未确认**（读失败或定位不到）。 */}
          {data.pkg.kind === 'present' ? (
            <Alert
              type="success"
              showIcon
              style={{ marginBottom: 12 }}
              data-testid="deploy-pkg-alert"
              title={t('appDetail.history.deployPkgPresent', { url: data.pkg.url })}
            />
          ) : data.pkg.kind === 'missing' ? (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 12 }}
              data-testid="deploy-pkg-alert"
              title={t('appDetail.history.deployPkgMissing')}
            />
          ) : (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 12 }}
              data-testid="deploy-pkg-alert"
              title={(
                data.pkg.reason === 'readFailed'
                  ? t('appDetail.history.deployPkgUnknownReadFail')
                  : t('appDetail.history.deployPkgUnknownNotLocated')
              )}
            />
          )}
          {/* F1：部署行被静默截断 ⇒ 显式告警 + 给出可去的地方（同文件 ReleasesTab 的 P8 形态）。 */}
          {truncated && (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 12 }}
              data-testid="deploy-rows-truncated"
              title={t('appDetail.history.deployTruncated.title')}
              description={t('appDetail.history.deployTruncated.desc', {
                shown,
                total,
                hidden,
              })}
              action={(
                <Button
                  size="small"
                  data-testid="deploy-truncated-goto-deployments"
                  // 先关弹窗再切页签：弹窗是遮罩层，不关掉的话用户看不到切过去的页
                  onClick={() => {
                    onCancel();
                    setSearchParams({ tab: 'deployments' });
                  }}
                >
                  {t('appDetail.history.deployTruncated.gotoDeployments')}
                </Button>
              )}
            />
          )}
          {shown === 0 ? (
            /* 真空态（total === 0）与「取不到行但确有部署行」（total > 0）**必须**分开：
               后者说「没有部署」是另一个假事实。 */
            <Empty
              description={(
                total === 0
                  ? t('appDetail.history.deployEmpty')
                  : t('appDetail.history.deployEmptyUnknown', { total })
              )}
            />
          ) : (
            <>
              {data.rows.map((d) => {
                const name = nameOf(d);
                const label = name ? `${name} (${d.executorAddress})` : (d.executorAddress ?? d.id);
                // 仅 RUNNING 且带执行器 id 的行可勾选；其余行如实展示状态（不可下发）
                const canDispatch = d.status === 'running' && !!d.executorId;
                return (
                  <div
                    key={d.id}
                    style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 0' }}
                  >
                    <Checkbox
                      checked={!!d.executorId && checkedExecutors.includes(d.executorId)}
                      disabled={!canDispatch}
                      onChange={(e) => {
                        if (!d.executorId) return;
                        onToggleExecutor(d.executorId, e.target.checked);
                      }}
                    >
                      {label}
                    </Checkbox>
                    <Tag color={RELEASE_DEPLOY_STATUS_COLOR[d.status] ?? 'default'}>
                      {releaseStatusLabel(d.status, t) ?? d.status}
                    </Tag>
                  </div>
                );
              })}
              <Text type="secondary" style={{ fontSize: 12 }}>
                {t('appDetail.history.deployHint')}
              </Text>
            </>
          )}
        </>
      )}
    </Modal>
  );
}
