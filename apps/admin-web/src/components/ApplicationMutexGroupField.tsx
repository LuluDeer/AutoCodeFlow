/**
 * R188（P3-3）· 应用表单的**互斥组选择区**（从 `ApplicationListPage` 外提）。
 *
 * ## 为什么外提（两个理由，都不是洁癖）
 *
 * ① **体量棘轮**：`ApplicationListPage` 在 HEAD 上 `nonCommentLines` **993**、
 *    `functionLines` **1118` —— **双顶格**（R188 审计实测：`check:size-caps` 是**逐文件**
 *    「只减不增」棘轮，「加个 state」在这类文件上**直接 exit 1**）。
 *    修 P3-3 必须新增 state + catch + 错误块 + 空态分岔 ⇒ 就地改必然破顶
 *    ⇒ 外提是**唯一**能既修好又不放宽基线的路（照 R176 的 `ExecutionContextParams` 先例）。
 * ② **让「读失败 ≠ 没有互斥组」这件事可测**：做成 **props 驱动**的纯展示组件后，
 *    能直接对**失败态 / 成功态**两种分支写用例，不必驱动整张应用列表页。
 *
 * ## 本组件守的语义（**这是它存在的全部理由**）
 *
 * 互斥组是「**同一时刻只允许一台在跑**」的唯一保障（词条原文：「多个应用都操作紫鸟浏览器时
 * 挂入同一互斥组」）。而互斥组下拉**读失败**此前被 `catch {}` **空吞** ⇒ 下拉空 ⇒
 * 用户以为「这台机器上没有配互斥组」⇒ 保存 ⇒ 应用**不带互斥约束**上线 ⇒
 * **两个都操作同一台设备的应用同时跑、撞机**。
 *
 * ⇒ 三分支：
 * · `loadError` 存在 ⇒ **原位错误块**（含重试）+ 下拉空态说「**这不代表没有互斥组**」；
 * · 否则 `groups` 非空 ⇒ 渲染选项；
 * · 否则（**真的读到且为空**）⇒ 空态说「没有可用的互斥组」。
 *
 * ⚠️ **「读失败」与「真的没有」必须分开**：前者要重试，后者是正常态。
 */
import { Button, Form, Select, Space, Typography } from 'antd';
import { InfoCircleOutlined, PlusOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import StateError from './StateError';

const { Text } = Typography;

/** 互斥组选项的最小形状（对应 `api/applications` 的 `MutexGroup`）。 */
export interface MutexGroupOption {
  id: string;
  name: string;
  scope: string;
  maxConcurrentPerDevice: number;
}

export interface ApplicationMutexGroupFieldProps {
  /** 互斥组列表（空数组 = **真的读到且为空**，与 `loadError` 不同）。 */
  groups: MutexGroupOption[];
  /** **读失败**的原因（`null` = 没失败）。存在时**优先于** `groups`。 */
  loadError: unknown;
  /** 重试回调（重新拉取互斥组）。 */
  onRetry: () => void;
  /** 打开「新建互斥组」弹窗。 */
  onCreateGroup: () => void;
  /** 只有管理员能新建互斥组。 */
  canCreate: boolean;
}

export default function ApplicationMutexGroupField({
  groups,
  loadError,
  onRetry,
  onCreateGroup,
  canCreate,
}: ApplicationMutexGroupFieldProps) {
  const { t } = useTranslation();
  return (
    <>
      {loadError ? (
        <StateError
          error={loadError}
          title={t('appList.mutexGroupListFail')}
          onRetry={onRetry}
          style={{ padding: 12, marginBottom: 16 }}
        />
      ) : null}
      <Form.Item
        label={t('appList.field.mutexGroup')}
        tooltip={{
          title: t('appList.field.mutexGroupTooltip'),
          icon: <InfoCircleOutlined />,
        }}
      >
        <Space.Compact style={{ display: 'flex', width: '100%' }}>
          <Form.Item name="mutexGroupId" noStyle>
            <Select
              allowClear
              showSearch
              // 互斥组随使用持续增长，纯下拉无法高效定位；label 含组名，
              // 按 label 大小写不敏感过滤
              optionFilterProp="label"
              placeholder={t('appList.field.mutexGroupPlaceholder')}
              style={{ flex: 1 }}
              // R188（P3-3）：失败时下拉的空态**不得谎报「没有互斥组」**
              //（互斥组可能存在，只是没读到）——否则用户会保存出一个**不带互斥约束**的应用
              // ⇒ 两个都操作同一台设备的应用同时跑、撞机。
              notFoundContent={
                loadError
                  ? t('appList.mutexGroupListFail')
                  : t('appList.field.mutexGroupEmpty')
              }
              options={groups.map((g) => ({
                value: g.id,
                // N-15：全局组标注全平台并发语义，防用户按设备口径误解
                label:
                  g.scope === 'global'
                    ? t('appList.field.mutexGroupOptionGlobal', {
                        name: g.name,
                        max: g.maxConcurrentPerDevice,
                      })
                    : t('appList.field.mutexGroupOption', {
                        name: g.name,
                        max: g.maxConcurrentPerDevice,
                      }),
              }))}
            />
          </Form.Item>
          <Button
            icon={<PlusOutlined />}
            onClick={onCreateGroup}
            disabled={!canCreate}
            title={t('appList.field.mutexGroupNew')}
          >
            {t('appList.field.mutexGroupNew')}
          </Button>
          <Text type="secondary" style={{ display: 'none' }}>
            {t('appList.field.mutexGroupTooltip')}
          </Text>
        </Space.Compact>
      </Form.Item>
    </>
  );
}
