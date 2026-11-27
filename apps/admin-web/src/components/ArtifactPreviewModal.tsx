/**
 * 产物预览弹窗：优先调用有界 JSON 预览端点（默认 64 KiB），绝不把整文件
 * blob 读进标签页内存。图片/二进制只展示元数据 + 安全下载入口。
 */
import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Modal, Spin, Typography, theme } from 'antd';
import { DownloadOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import {
  artifactsApi,
  type ArtifactPreview,
  type ArtifactRow,
} from '../api/artifacts';
import { getErrMsg, showApiError } from '../utils/error';
import { message } from '../utils/toast';
import { formatArtifactSize } from '../utils/artifactSize';
import { isPreviewTruncated, previewContent } from './artifact-preview/previewHelpers';

const { Text, Paragraph } = Typography;

interface ArtifactPreviewModalProps {
  row: ArtifactRow | null;
  onClose: () => void;
}

type PreviewState =
  | { status: 'loading' }
  | { status: 'ready'; preview: ArtifactPreview }
  | { status: 'error'; message: string };

export default function ArtifactPreviewModal({ row, onClose }: ArtifactPreviewModalProps) {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  const [state, setState] = useState<PreviewState>({ status: 'loading' });
  const [downloading, setDownloading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!row) return;
    let cancelled = false;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setState({ status: 'loading' });

    artifactsApi
      .previewArtifact(row.executionId, row.name, undefined, controller.signal)
      .then((preview) => {
        if (cancelled) return;
        setState({ status: 'ready', preview });
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
    };
  }, [row, t]);

  const handleDownload = async () => {
    if (!row || downloading) return;
    setDownloading(true);
    try {
      await artifactsApi.downloadArtifact(row.executionId, row.name);
      message.success(t('artifactLibrary.preview.downloadOk'));
    } catch (err: unknown) {
      showApiError(err, t('artifacts.downloadFail'));
    } finally {
      setDownloading(false);
    }
  };

  const renderBody = () => {
    if (state.status === 'loading') {
      return <div style={{ textAlign: 'center', padding: 40 }}><Spin /></div>;
    }
    if (state.status === 'error') {
      const title = t('artifactLibrary.preview.loadFailed');
      return (
        <Alert
          type="error"
          showIcon
          title={title}
          description={state.message === title ? undefined : state.message}
        />
      );
    }

    const preview = state.preview;
    return (
      <div>
        {preview.kind === 'image' ? (
          <Alert
            type="info"
            showIcon
            title={t('artifactLibrary.preview.unsupportedTitle')}
            description={`${t('artifactLibrary.preview.imageDesc')} ${formatArtifactSize(preview.size)}`}
          />
        ) : preview.kind === 'text' ? (
          <>
            {isPreviewTruncated(preview) && (
              <Alert
                type="warning"
                showIcon
                title={t('artifactLibrary.preview.truncatedTitle')}
                style={{ marginBottom: 8 }}
              />
            )}
            <pre
              style={{
                maxHeight: '50vh',
                overflow: 'auto',
                margin: 0,
                padding: 12,
                background: token.colorFillTertiary,
                border: `1px solid ${token.colorBorderSecondary}`,
                borderRadius: 8,
                fontSize: 12,
                fontFamily: 'var(--font-mono)',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {previewContent(preview)}
            </pre>
          </>
        ) : (
          <Alert
            type="info"
            showIcon
            title={t('artifactLibrary.preview.unsupportedTitle')}
            description={`${t('artifactLibrary.preview.unsupportedDesc')} ${formatArtifactSize(preview.size)}`}
          />
        )}
        <Paragraph type="secondary" style={{ marginTop: 12, fontSize: 12, marginBottom: 0 }}>
          {t('artifactLibrary.preview.meta', {
            mimeType: preview.mimeType,
            size: formatArtifactSize(preview.size),
          })}
        </Paragraph>
      </div>
    );
  };

  return (
    <Modal
      open={row != null}
      onCancel={onClose}
      title={row?.name ?? t('artifactLibrary.preview.title')}
      width={720}
      footer={[
        <Button key="download" icon={<DownloadOutlined />} loading={downloading} onClick={() => void handleDownload()}>
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
      {row && state.status === 'ready' && (
        <Paragraph type="secondary" style={{ marginTop: 12, fontSize: 12, marginBottom: 0 }}>
          {t('artifactLibrary.preview.sha256')}: {row.sha256}
        </Paragraph>
      )}
    </Modal>
  );
}
