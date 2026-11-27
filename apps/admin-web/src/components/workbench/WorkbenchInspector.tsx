/**
 * Right inspector: collapsible Plan / Approvals / Artifacts. Artifacts use
 * previewUrl (falling back to downloadUrl) and render the JSON preview in a
 * modal. Verification details (cardHash / policyGeneration) stay hidden behind
 * an accordion so the calm surface shows facts, not internal identifiers.
 */
import { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Collapse,
  Image,
  Modal,
  Space,
  Spin,
  Typography,
} from 'antd';
import { DownloadOutlined, EyeOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { fetchWorkbenchArtifactPreview } from '../../api/workbench';
import { artifactsApi } from '../../api/artifacts';
import type {
  WorkbenchApprovalDecision,
  WorkbenchApprovalItem,
  WorkbenchArtifact,
  WorkbenchArtifactPreview,
  WorkbenchSessionDetail,
} from '../../pages/workbench/types-public';
import { formatBytes, formatTime, parseArtifactUrl } from '../../pages/workbench/format';
import { artifactPreviewErrorLabel } from './statusLabel';
import { ApprovalList } from './WorkbenchTimeline';

const { Text, Paragraph } = Typography;

interface PreviewState {
  loading: boolean;
  data: WorkbenchArtifactPreview | null;
  error: string | null;
  imageUrl: string | null;
}

function useArtifactPreview(artifact: WorkbenchArtifact | null) {
  const [state, setState] = useState<PreviewState>({ loading: false, data: null, error: null, imageUrl: null });

  useEffect(() => {
    if (!artifact) return;
    const controller = new AbortController();
    const parsed = parseArtifactUrl(artifact);
    setState({ loading: true, data: null, error: null, imageUrl: null });
    if (!parsed) {
      setState({ loading: false, data: null, error: 'invalid artifact url', imageUrl: null });
      return;
    }

    let objectUrl: string | null = null;
    void (async () => {
      try {
        // Image preview endpoints return content=null; fetch the authenticated
        // blob and show it through an object URL instead of a bare <img src>.
        const ext = artifact.name.split('.').pop()?.toLowerCase() ?? '';
        const imageLike = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'].includes(ext);
        if (imageLike) {
          const blob = await artifactsApi.fetchBlob(parsed.execId, parsed.name, controller.signal);
          if (controller.signal.aborted) return;
          objectUrl = URL.createObjectURL(blob);
          setState({
            loading: false,
            data: {
              name: artifact.name,
              mimeType: blob.type || `image/${ext}`,
              size: blob.size,
              truncated: false,
              kind: 'image',
              content: null,
            },
            error: null,
            imageUrl: objectUrl,
          });
          return;
        }
        const data = await fetchWorkbenchArtifactPreview(artifact, controller.signal);
        if (!controller.signal.aborted) setState({ loading: false, data, error: null, imageUrl: null });
      } catch (err: unknown) {
        if (controller.signal.aborted) return;
        const message = err instanceof Error ? err.message : String(err);
        setState({ loading: false, data: null, error: message, imageUrl: null });
      }
    })();

    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [artifact]);

  return state;
}

export interface WorkbenchInspectorProps {
  detail: WorkbenchSessionDetail | null;
  actingKey: string | null;
  onDecide: (key: string, decision: WorkbenchApprovalDecision) => void;
  verification?: { cardHash?: string; policyGeneration?: string } | null;
}

export default function WorkbenchInspector({
  detail, actingKey, onDecide, verification,
}: WorkbenchInspectorProps) {
  const { t } = useTranslation();
  const [previewTarget, setPreviewTarget] = useState<WorkbenchArtifact | null>(null);
  const preview = useArtifactPreview(previewTarget);
  const approvals: WorkbenchApprovalItem[] = detail?.approvalItems ?? [];
  const artifacts = detail?.artifacts ?? [];
  const hasPlan = Boolean(detail?.phase || detail?.waitingFor || detail?.conclusion);

  const items: Array<{ key: string; label: string; children: React.ReactNode }> = [
    {
      key: 'plan',
      label: t('workbench.inspector.plan'),
      children: hasPlan ? (
        <Space orientation="vertical" size={6} style={{ width: '100%' }}>
          {detail?.phase ? (
            <div>
              <Text type="secondary" style={{ fontSize: 11 }}>{t('workbench.inspector.phase')}</Text>
              <div>{detail.phase}</div>
            </div>
          ) : null}
          {detail?.waitingFor ? (
            <div>
              <Text type="secondary" style={{ fontSize: 11 }}>{t('workbench.inspector.waiting')}</Text>
              <div>{detail.waitingFor}</div>
            </div>
          ) : null}
          {detail?.conclusion ? (
            <div>
              <Text type="secondary" style={{ fontSize: 11 }}>{t('workbench.timeline.conclusion')}</Text>
              <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                {typeof detail.conclusion === 'string'
                  ? detail.conclusion
                  : JSON.stringify(detail.conclusion, null, 2)}
              </div>
            </div>
          ) : null}
        </Space>
      ) : <Text type="secondary">{t('workbench.inspector.noPlan')}</Text>,
    },
    {
      key: 'approvals',
      label: t('workbench.inspector.approvals', { count: approvals.length }),
      children: approvals.length > 0 ? (
        <ApprovalList
          items={approvals}
          toolCalls={detail?.toolCalls ?? []}
          actingKey={actingKey}
          onDecide={onDecide}
        />
      ) : <Text type="secondary">{t('workbench.inspector.noApprovals')}</Text>,
    },
    {
      key: 'artifacts',
      label: t('workbench.inspector.artifacts', { count: artifacts.length }),
      children: artifacts.length > 0 ? (
        <Space orientation="vertical" size={6} style={{ width: '100%' }}>
          {artifacts.map((artifact) => {
            const parsed = parseArtifactUrl(artifact);
            return (
              <div
                key={artifact.id}
                data-testid="workbench-artifact"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  border: '1px solid rgba(127,127,127,0.14)',
                  borderRadius: 8,
                  padding: '6px 8px',
                }}
              >
                <div style={{ minWidth: 0, flex: 1 }}>
                  <Text strong ellipsis style={{ fontSize: 12, display: 'block' }}>{artifact.name}</Text>
                  <Text type="secondary" style={{ fontSize: 11 }}>
                    {formatBytes(artifact.size)} · {formatTime(artifact.createdAt)}
                  </Text>
                </div>
                {parsed ? (
                  <Button
                    size="small"
                    type="text"
                    icon={<EyeOutlined aria-hidden />}
                    aria-label={t('workbench.artifact.preview')}
                    data-testid="workbench-artifact-preview"
                    onClick={() => setPreviewTarget(artifact)}
                  />
                ) : null}
                {parsed ? (
                  <Button
                    size="small"
                    type="text"
                    icon={<DownloadOutlined aria-hidden />}
                    aria-label={t('workbench.artifact.download')}
                    data-testid="workbench-artifact-download"
                    onClick={() => { void artifactsApi.downloadArtifact(parsed.execId, parsed.name); }}
                  />
                ) : null}
              </div>
            );
          })}
        </Space>
      ) : <Text type="secondary">{t('workbench.inspector.noArtifacts')}</Text>,
    },
  ];

  if (verification && (verification.cardHash || verification.policyGeneration)) {
    items.push({
      key: 'verification',
      label: t('workbench.inspector.verification'),
      children: (
        <Space orientation="vertical" size={4}>
          {verification.cardHash ? (
            <Text type="secondary" style={{ fontSize: 11, wordBreak: 'break-all' }}>
              {t('workbench.history.cardHash', { hash: verification.cardHash })}
            </Text>
          ) : null}
          {verification.policyGeneration ? (
            <Text type="secondary" style={{ fontSize: 11, wordBreak: 'break-all' }}>
              {t('workbench.history.generation', { generation: verification.policyGeneration })}
            </Text>
          ) : null}
        </Space>
      ),
    });
  }

  const statusTag = detail ? (
    <div style={{ marginBottom: 10 }}>
      <Space size={4} wrap>
        <Text type="secondary" style={{ fontSize: 11 }}>{t('workbench.inspector.session')}</Text>
        <Text style={{ fontSize: 12 }} copyable={{ text: detail.sessionId }}>
          {detail.sessionId.slice(0, 8)}…
        </Text>
      </Space>
    </div>
  ) : null;

  return (
    <div data-testid="workbench-inspector" style={{ height: '100%', minHeight: 0 }}>
      {statusTag}
      <Collapse defaultActiveKey={['plan', 'approvals', 'artifacts']} items={items} ghost />

      <Modal
        open={previewTarget !== null}
        onCancel={() => setPreviewTarget(null)}
        title={previewTarget?.name ?? t('workbench.artifact.preview')}
        footer={null}
        width={720}
        destroyOnHidden
      >
        {preview.loading ? <div style={{ textAlign: 'center', padding: 40 }}><Spin /></div> : null}
        {preview.error ? (
          <Space orientation="vertical" size={4} style={{ width: '100%' }}>
            <Alert type="error" showIcon title={artifactPreviewErrorLabel(t, preview.error)} />
            <Collapse
              ghost
              size="small"
              items={[{
                key: 'artifact-error-detail',
                label: <Text type="secondary" style={{ fontSize: 11 }}>{t('statusLabel.technicalDetails')}</Text>,
                children: <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 11 }}>{preview.error}</pre>,
              }]}
            />
          </Space>
        ) : null}
        {preview.data ? (
          <div>
            <Paragraph type="secondary" style={{ fontSize: 12 }}>
              {preview.data.mimeType} · {formatBytes(preview.data.size)}
              {preview.data.truncated ? ` · ${t('workbench.artifact.truncated')}` : ''}
            </Paragraph>
            {preview.data.kind === 'text' ? (
              <pre
                style={{
                  maxHeight: '55vh',
                  overflow: 'auto',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  padding: 12,
                  background: 'rgba(127,127,127,0.07)',
                  borderRadius: 8,
                  fontSize: 12,
                  margin: 0,
                }}
              >
                {preview.data.content ?? ''}
              </pre>
            ) : preview.data.kind === 'image' && preview.imageUrl ? (
              <Image src={preview.imageUrl} alt={previewTarget?.name} style={{ maxHeight: '55vh' }} />
            ) : (
              <Alert type="info" showIcon title={t('workbench.artifact.binary')} />
            )}
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
