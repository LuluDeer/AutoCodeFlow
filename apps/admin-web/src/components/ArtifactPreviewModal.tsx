/**
 * P1-3「产物库」产物预览弹窗。
 *
 * 能力分级（与后端契约一致，不夸大）：
 *  - 图片（png/jpg/...）：内联 <img>；
 *  - 文本类（txt/log/json/csv/...）：内联只读 <pre>；
 *  - 其他类型（二进制/压缩包/未知后缀）：不做内联预览，提示走下载。
 *
 * 预览走 download 同源端点取 blob（JWT 在 Authorization 头，<a href> 直链 401），
 * objectURL 在弹窗关闭/切换/卸载时 revoke，避免泄漏。
 */
import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Modal, Spin, Typography } from 'antd';
import { DownloadOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { artifactsApi, type ArtifactRow } from '../api/artifacts';
import { previewKind } from '../utils/artifactLibrary';
import { getErrMsg, showApiError } from '../utils/error';
import { message } from '../utils/toast';

const { Text, Paragraph } = Typography;

interface ArtifactPreviewModalProps {
  row: ArtifactRow | null;
  onClose: () => void;
}

type PreviewState =
  | { status: 'loading' }
  | { status: 'image'; url: string }
  | { status: 'text'; content: string }
  | { status: 'none' }
  | { status: 'error'; message: string };

export default function ArtifactPreviewModal({ row, onClose }: ArtifactPreviewModalProps) {
  const { t } = useTranslation();
  const [state, setState] = useState<PreviewState>({ status: 'loading' });
  const objectUrlRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const revokeUrl = () => {
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
  };

  useEffect(() => {
    if (!row) return;
    const kind = previewKind(row.name);
    if (kind === 'none') {
      setState({ status: 'none' });
      return;
    }

    let cancelled = false;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    revokeUrl();
    setState({ status: 'loading' });

    artifactsApi
      .fetchBlob(row.executionId, row.name, controller.signal)
      .then(async (blob) => {
        if (cancelled) return;
        if (kind === 'image') {
          const url = URL.createObjectURL(blob);
          objectUrlRef.current = url;
          setState({ status: 'image', url });
        } else {
          const content = await blob.text();
          setState({ status: 'text', content });
        }
      })
      .catch((err: unknown) => {
        if (cancelled || controller.signal.aborted) return;
        setState({
          status: 'error',
          message: getErrMsg(err, t('artifactLibrary.preview.loadFailed')),
        });
      });

    return () => {
      cancelled = true;
      controller.abort();
      revokeUrl();
    };
  }, [row, t]);

  const handleDownload = () => {
    if (!row) return;
    artifactsApi
      .downloadArtifact(row.executionId, row.name)
      .then(() => message.success(t('artifactLibrary.preview.downloadOk')))
      .catch((err: unknown) => showApiError(err, t('artifacts.downloadFail')));
  };

  const renderBody = () => {
    switch (state.status) {
      case 'loading':
        return (
          <div style={{ textAlign: 'center', padding: 40 }}>
            <Spin />
          </div>
        );
      case 'image':
        return (
          <img
            src={state.url}
            alt={row?.name}
            style={{ maxWidth: '100%', maxHeight: '60vh', objectFit: 'contain' }}
          />
        );
      case 'text':
        return (
          <pre
            style={{
              maxHeight: '50vh',
              overflow: 'auto',
              margin: 0,
              padding: 12,
              background: 'rgba(128,128,128,0.08)',
              borderRadius: 8,
              fontSize: 12,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {state.content}
          </pre>
        );
      case 'none':
        return (
          <Alert
            type="info"
            showIcon
            message={t('artifactLibrary.preview.unsupportedTitle')}
            description={t('artifactLibrary.preview.unsupportedDesc')}
          />
        );
      case 'error': {
        const title = t('artifactLibrary.preview.loadFailed');
        const description = state.message === title ? undefined : state.message;
        return <Alert type="error" showIcon message={title} description={description} />;
      }
      default:
        return null;
    }
  };

  return (
    <Modal
      open={row != null}
      onCancel={onClose}
      title={row?.name ?? t('artifactLibrary.preview.title')}
      width={720}
      footer={[
        <Button key="download" icon={<DownloadOutlined />} onClick={handleDownload}>
          {t('artifacts.download')}
        </Button>,
      ]}
    >
      <div style={{ marginBottom: 8 }}>
        {row && (
          <Text type="secondary" style={{ fontSize: 12 }}>
            {row.executionId}
          </Text>
        )}
      </div>
      {renderBody()}
      {row && state.status !== 'error' && (
        <Paragraph type="secondary" style={{ marginTop: 12, fontSize: 12, marginBottom: 0 }}>
          {t('artifactLibrary.preview.sha256')}: {row.sha256}
        </Paragraph>
      )}
    </Modal>
  );
}
