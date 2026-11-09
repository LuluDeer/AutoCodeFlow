/**
 * R139：上传执行器包弹窗（从 `ExecutorPackagesPage.tsx` 外提）。
 *
 * 外提理由与 `package-meta.ts` 同：页面体量在基线里顶格，新增逻辑必须落到新
 * 文件。这里连带把**只属于上传弹窗**的状态（表单实例 / 上传中 / 进度 / 当前
 * 类型）一并搬进来，页面侧只剩一个 `open` 开关，语义反而更内聚。
 *
 * 行为逐条保留（既有 `executor-packages-audit.test.tsx` 的 B-12 用例锚定）：
 *   · accept 随「类型」收窄（F-3），beforeUpload 二次校验扩展名；
 *   · 超大文件（> `MAX_PACKAGE_SIZE_BYTES`，与后端 FileInterceptor 逐字节对齐）
 *     在本地拦下并提示，不发起注定 413/400 的请求；
 *   · 上传中显示实时进度条（axios onUploadProgress 驱动）；
 *   · 成功后关闭弹窗、重置表单并刷新列表（由 `onUploaded` 回调交给页面）。
 */
import { useState } from 'react';
import { Modal, Form, Upload, Button, Input, Select, Row, Col, Space, Progress } from 'antd';
import { UploadOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { uploadPackage } from '../../api/executor-packages';
import { message } from '../../utils/toast';
import { showApiError } from '../../utils/error';
import { normFileList } from '../../utils/upload';
import {
  MAX_PACKAGE_SIZE_BYTES,
  extensionsFor,
} from './package-meta';

export interface UploadPackageModalProps {
  open: boolean;
  onClose: () => void;
  /** 上传成功后的刷新钩子（页面传 `load`）。 */
  onUploaded: () => void;
  /**
   * 包类型选项（**由页面持有**：展示名走 i18n，页面用 `packageTypeOptions(t)`
   * 渲染后经 prop 传入——弹窗不直接依赖 locales，也就不必自己取 `t`）。
   */
  typeOptions: ReadonlyArray<{ value: string; label: string }>;
}

export default function UploadPackageModal({
  open,
  onClose,
  onUploaded,
  typeOptions,
}: UploadPackageModalProps) {
  const { t } = useTranslation();
  const [form] = Form.useForm();
  const [uploading, setUploading] = useState(false);
  // B-12：上传进度百分比（axios onUploadProgress 驱动）
  const [uploadPercent, setUploadPercent] = useState(0);
  // F-3：监听表单当前类型，据此收窄 Upload 的 accept 并做扩展名二次校验。
  const uploadType = Form.useWatch('type', form);

  const handleUpload = async (values: Record<string, unknown>) => {
    // normFileList 已将字段值收敛为 UploadFile[]（见 utils/upload.ts）。
    const fileObj: File | undefined =
      (values.file as { originFileObj?: File }[] | undefined)?.[0]?.originFileObj;
    if (!fileObj) { message.error(t('execPkg.upload.chooseFile')); return; }
    setUploading(true);
    // B-12：上传进度归零后随 axios onUploadProgress 推进（大文件不再零反馈）
    setUploadPercent(0);
    try {
      const fd = new FormData();
      fd.append('file', fileObj);
      fd.append('name', values.name as string);
      fd.append('version', values.version as string);
      fd.append('type', values.type as string);
      fd.append('platform', values.platform as string);
      if (values.description) fd.append('description', values.description as string);
      await uploadPackage(fd, (e) => {
        if (e.total) setUploadPercent(Math.min(100, Math.round((e.loaded / e.total) * 100)));
      });
      message.success(t('execPkg.upload.success'));
      onClose();
      form.resetFields();
      onUploaded();
    } catch (err: unknown) {
      showApiError(err, t('execPkg.upload.fail'));
    } finally {
      setUploading(false);
      setUploadPercent(0);
    }
  };

  // F-3：accept 只收窄系统选择器；拖拽/手动选「所有文件」仍可绕过，
  // beforeUpload 据当前类型做扩展名二次校验，不符则剔除并提示。
  // B-12：同法做大小上限校验（与后端 FileInterceptor limits 对齐），
  // 超限剔除并提示，不发起注定被 413/400 拒绝的请求。
  const beforePkgUpload = (file: File) => {
    const lower = file.name.toLowerCase();
    const allowed = extensionsFor(uploadType).split(',').map((s) => s.trim());
    if (!allowed.some((ext) => lower.endsWith(ext))) {
      message.error(t('execPkg.upload.extensionMismatch'));
      return Upload.LIST_IGNORE;
    }
    if (file.size > MAX_PACKAGE_SIZE_BYTES) {
      message.error(t('execPkg.upload.tooLarge', { max: `${MAX_PACKAGE_SIZE_BYTES / 1024 / 1024} MB` }));
      return Upload.LIST_IGNORE;
    }
    return false;
  };

  return (
    <Modal
      title={t('execPkg.upload.title')} open={open} onCancel={onClose}
      footer={null} destroyOnHidden
    >
      <Form form={form} layout="vertical" onFinish={handleUpload} style={{ marginTop: 8 }}>
        <Form.Item name="file" label={t('execPkg.upload.field.file')} valuePropName="fileList" getValueFromEvent={normFileList} rules={[{ required: true, message: t('execPkg.upload.chooseFile') }]}>
          <Upload beforeUpload={beforePkgUpload} maxCount={1} accept={extensionsFor(uploadType)}>
            <Button icon={<UploadOutlined />}>{t('execPkg.upload.chooseFileBtn')}</Button>
          </Upload>
        </Form.Item>
        {/* B-12：上传进度条——axios onUploadProgress 驱动，上传中实时可见 */}
        {uploading && (
          <Progress percent={uploadPercent} size="small" style={{ marginBottom: 8 }} />
        )}
        {/* R5 交接：双列行窄屏堆叠——Space flex 布局无断点，375px 弹窗下
            每列仅 ~145px 偏紧；改 Row/Col xs=24 sm=12（对齐 ExecutorInstallWizardPage
            响应式先例），gutter 响应式对象 xs=0/sm=16 使堆叠后与上下整行字段
            （文件/描述）左缘对齐，sm+ 桌面 16px 间距不变。
            UX-WALK R9（走查 A 级 executor-packages@600，.ant-modal-body
            scrollWidth 480 > 472）：归因是本 Row 的 gutter 负 margin 而非
            上传控件内边距——antd 对 gutter 16 施加 margin-inline:-8px/
            padding-inline:8px 补偿，弹窗 body 自身无内边距（v6 内边距在
            .ant-modal-content）且 overflowX=visible，行盒右缘遂超出 body
            恰 8px（实测把行 margin 归零后 sw 480→472，上传子树无越界）。
            ux-gutter-flush（index.css ≥576px 媒体查询）把行盒钉回 body
            边缘，字段几何（0..228 / 244..472）与钳制前逐像素一致；xs 断点
            gutter=0 本无边距，规则不生效，375 不受影响（不走行内 style
            长写覆写的原因见 index.css 该节注释）。
            maxLength 对齐后端 CreateExecutorPackageDto（name ≤255 / version ≤64）：
            本表单随包上传大文件，超长值只在后端 400 才暴露——白等一次
            数百 MB 上传；输入端截断即可 */}
        <Row gutter={{ xs: 0, sm: 16 }} className="ux-gutter-flush">
          <Col xs={24} sm={12}>
            <Form.Item name="name" label={t('execPkg.upload.field.name')} rules={[{ required: true, message: t('execPkg.upload.field.nameRequired') }]}>
              <Input placeholder="python-runner" maxLength={255} />
            </Form.Item>
          </Col>
          <Col xs={24} sm={12}>
            <Form.Item
              name="version"
              label={t('execPkg.upload.field.version')}
              rules={[
                { required: true, message: t('execPkg.upload.field.versionRequired') },
                // P3-1（UI 审计）：宽松 semver 形态校验——X.Y.Z 必填，允许
                // -prerelease / +build 后缀。后端 DTO 只限长（≤64）不限形，
                // 乱版本号会以「最新包」语义比较（compareDottedVersions）时
                // 落到 NaN 兜底序，前端先给出可读提示。
                { pattern: /^\d+\.\d+\.\d+([+-][0-9A-Za-z.-]+)?$/, message: t('execPkg.upload.field.versionPattern') },
              ]}
            >
              <Input placeholder="1.0.0" maxLength={64} />
            </Form.Item>
          </Col>
        </Row>
        {/* 同上：双列行 no-bleed 覆写（机制见上一行注释） */}
        <Row gutter={{ xs: 0, sm: 16 }} className="ux-gutter-flush">
          <Col xs={24} sm={12}>
            <Form.Item name="type" label={t('execPkg.upload.field.type')} initialValue="node" rules={[{ required: true }]}>
              <Select options={[...typeOptions]} />
            </Form.Item>
          </Col>
          <Col xs={24} sm={12}>
            <Form.Item name="platform" label={t('execPkg.upload.field.platform')} initialValue="linux" rules={[{ required: true }]}>
              <Select options={[
                { value: 'linux', label: 'Linux' }, { value: 'windows', label: 'Windows' },
                { value: 'macos', label: 'macOS' }, { value: 'all', label: t('execPkg.upload.platformAll') },
              ]} />
            </Form.Item>
          </Col>
        </Row>
        {/* maxLength 对齐后端 CreateExecutorPackageDto @MaxLength(1024) */}
        <Form.Item name="description" label={t('execPkg.upload.field.description')}>
          <Input.TextArea rows={2} maxLength={1024} />
        </Form.Item>
        <Form.Item style={{ marginBottom: 0, textAlign: 'right' }}>
          <Space>
            <Button onClick={onClose}>{t('execPkg.cancel')}</Button>
            <Button type="primary" htmlType="submit" loading={uploading}>{t('execPkg.upload.confirm')}</Button>
          </Space>
        </Form.Item>
      </Form>
    </Modal>
  );
}
