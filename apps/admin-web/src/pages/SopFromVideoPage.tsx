import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Alert,
  Button,
  Card,
  Col,
  Divider,
  Form,
  Input,
  Row,
  Select,
  Space,
  Tag,
  Typography,
  Upload,
} from 'antd';
import { InboxOutlined, SendOutlined, VideoCameraAddOutlined } from '@ant-design/icons';
import PageHeader from '../components/PageHeader';
import { message } from '../utils/toast';
import { showApiError } from '../utils/error';
import {
  aiApi,
  type AiProviderView,
  type SopSession,
  type SopSessionDraft,
} from '../api/ai';
import { sopsApi } from '../api/sops';

/**
 * 视频转 SOP（交互式，面向普通员工）。
 *
 * ## 为什么是"会话"而不是"一次生成"
 * 录屏只能证明"人做了什么"，证不出"什么算做完了"，也常常漏拍。所以模型可以：
 *   · 追问一个**阻塞性**缺口（一句话就够）；
 *   · 要求补录（`needsVideo`）；
 * 用户随时补文字、随时再传一段录屏。会话 id 写进 URL（`?session=`），
 * 刷新/换设备都能续——每重问一轮都要重算全部视频，续不上就是真金白银。
 *
 * ## 平台不替你发布
 * 模型产出的永远只是**草稿**：验收项（acceptance）必须由人补，保存走既有
 * `POST /api/sop`，发布仍是独立动作。
 */
export default function SopFromVideoPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const sessionId = searchParams.get('session') ?? '';

  const [providers, setProviders] = useState<AiProviderView[]>([]);
  const [sessions, setSessions] = useState<
    Array<{ id: string; status: string; updatedAt: string; title: string | null }>
  >([]);
  const [providerId, setProviderId] = useState('');
  const [hint, setHint] = useState('');
  const [input, setInput] = useState('');
  const [session, setSession] = useState<SopSession | null>(null);
  const [uploading, setUploading] = useState(false);
  const [sending, setSending] = useState(false);
  /** 流式增量（先给人看字，出完再用整条会话替换） */
  const [streamingText, setStreamingText] = useState('');
  const [saving, setSaving] = useState(false);
  const [booting, setBooting] = useState(false);
  const [form] = Form.useForm<{
    title: string;
    slug: string;
    bodyMarkdown: string;
    frontMatterYaml: string;
  }>();

  const videoProviders = useMemo(
    () => providers.filter((p) => p.enabled && p.supportsVideo),
    [providers],
  );

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const view = await aiApi.listProviders();
        if (alive) setProviders(view.providers);
      } catch (err) {
        showApiError(err);
      }
      try {
        const list = await aiApi.listSopSessions({ pageSize: 20 });
        if (alive) setSessions(list.items);
      } catch {
        // 列表失败不影响主流程（新建会话仍然可用）
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // 续跑：URL 里有 session 就拉回状态（刷新/换设备都不丢）
  useEffect(() => {
    if (!sessionId) return;
    let alive = true;
    (async () => {
      try {
        const s = await aiApi.getSopSession(sessionId);
        if (!alive) return;
        setSession(s);
      } catch (err) {
        showApiError(err);
      }
    })();
    return () => {
      alive = false;
    };
  }, [sessionId]);

  const applySession = useCallback(
    (s: SopSession) => {
      setSession(s);
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set('session', s.id);
          return next;
        },
        { replace: true },
      );
      if (s.draft) {
        form.setFieldsValue({
          title: s.draft.title,
          slug: s.draft.slug,
          bodyMarkdown: s.draft.bodyMarkdown,
          frontMatterYaml: s.draft.frontMatterYaml,
        });
      }
    },
    [form, setSearchParams],
  );

  /** 首段录屏：上传后建会话并跑第一轮。 */
  const start = async (file: File) => {
    setUploading(true);
    try {
      const media = await aiApi.uploadVideo(file);
      setBooting(true);
      const s = await aiApi.createSopSession({
        mediaId: media.id,
        ...(providerId ? { providerId } : {}),
        ...(hint.trim() ? { hint: hint.trim() } : {}),
      });
      applySession(s);
    } catch (err) {
      showApiError(err);
    } finally {
      setUploading(false);
      setBooting(false);
    }
  };

  const send = async () => {
    if (!session) return;
    if (!input.trim()) {
      message.warning(t('sopFromVideo.chat.emptyInput'));
      return;
    }
    setSending(true);
    setStreamingText('');
    try {
      // 流式：慢轮次（看视频出稿）先让人看到字，出完再用整条会话替换
      const s = await aiApi.sopSessionTurnStream(
        session.id,
        { text: input.trim() },
        { onDelta: (t) => setStreamingText((prev) => prev + t) },
      );
      setInput('');
      applySession(s);
    } catch (err) {
      showApiError(err);
    } finally {
      setStreamingText('');
      setSending(false);
    }
  };

  /** 中途补录：先上传，再把 mediaId 作为一轮发过去。 */
  const addVideo = async (file: File) => {
    if (!session) return;
    setUploading(true);
    try {
      const media = await aiApi.uploadVideo(file);
      setSending(true);
      const s = await aiApi.sopSessionTurn(session.id, { mediaId: media.id });
      applySession(s);
    } catch (err) {
      showApiError(err);
    } finally {
      setUploading(false);
      setSending(false);
    }
  };

  const saveDraft = async () => {
    if (!session) return;
    const values = await form.validateFields();
    setSaving(true);
    try {
      await sopsApi.draft({
        slug: values.slug,
        title: values.title,
        frontMatterYaml: values.frontMatterYaml,
        bodyMarkdown: values.bodyMarkdown,
      });
      await aiApi.markSopSessionSaved(session.id).catch(() => undefined);
      message.success(t('sopFromVideo.saved'));
      navigate('/sops');
    } catch (err) {
      showApiError(err);
    } finally {
      setSaving(false);
    }
  };

  const draft: SopSessionDraft | null = session?.draft ?? null;
  const lastAsk = [...(session?.messages ?? [])]
    .reverse()
    .find((m) => m.role === 'assistant');

  return (
    <div>
      <PageHeader
        title={t('sopFromVideo.title')}
        description={t('sopFromVideo.description')}
        extra={
          sessions.length > 0 ? (
            <Select
              style={{ minWidth: 260 }}
              placeholder={t('sopFromVideo.sessions.pick')}
              value={sessionId || undefined}
              onChange={(value) =>
                setSearchParams((prev) => {
                  const next = new URLSearchParams(prev);
                  next.set('session', value);
                  return next;
                })
              }
              options={sessions.map((s) => ({
                value: s.id,
                label: `${s.title ?? s.id.slice(0, 8)} · ${
                  s.status === 'drafted' || s.status === 'saved'
                    ? t('sopFromVideo.sessions.drafted')
                    : t('sopFromVideo.sessions.active')
                }`,
              }))}
            />
          ) : null
        }
      />

      {videoProviders.length === 0 && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          title={t('sopFromVideo.model.none')}
          description={t('sopFromVideo.model.hint')}
        />
      )}

      <Row gutter={24}>
        <Col xs={24} lg={9}>
          <Card title={t('sopFromVideo.step.upload')}>
            {!session ? (
              <Space direction="vertical" style={{ width: '100%' }} size={12}>
                <Select
                  style={{ width: '100%' }}
                  placeholder={t('sopFromVideo.model.placeholder')}
                  value={providerId || undefined}
                  onChange={setProviderId}
                  options={videoProviders.map((p) => ({
                    value: p.id,
                    label: `${p.label || p.id} · ${p.model}`,
                  }))}
                />
                <Input.TextArea
                  rows={2}
                  maxLength={2000}
                  value={hint}
                  onChange={(e) => setHint(e.target.value)}
                  placeholder={t('sopFromVideo.hint.placeholder')}
                />
                <Upload.Dragger
                  accept="video/mp4,video/webm,video/quicktime,video/x-m4v"
                  showUploadList={false}
                  multiple={false}
                  disabled={uploading || booting || videoProviders.length === 0}
                  beforeUpload={(file) => {
                    void start(file);
                    return false;
                  }}
                >
                  <p className="ant-upload-drag-icon">
                    <InboxOutlined />
                  </p>
                  <p className="ant-upload-text">{t('sopFromVideo.upload.dragger')}</p>
                  <p className="ant-upload-hint">{t('sopFromVideo.upload.hint')}</p>
                </Upload.Dragger>
                <Typography.Text type="secondary">{t('sopFromVideo.draft.frontMatter')}</Typography.Text>
              </Space>
            ) : (
              <Space direction="vertical" style={{ width: '100%' }} size={8}>
                <Typography.Text type="secondary">
                  {t('sopFromVideo.chat.videos', { n: session.media.length })}
                </Typography.Text>
                {session.media.map((m) => (
                  <Tag key={m.mediaId} color="blue">
                    {m.name}
                  </Tag>
                ))}
                <Divider style={{ margin: '8px 0' }} />
                <Upload
                  showUploadList={false}
                  accept="video/mp4,video/webm,video/quicktime,video/x-m4v"
                  multiple={false}
                  disabled={uploading || sending}
                  beforeUpload={(file) => {
                    void addVideo(file);
                    return false;
                  }}
                >
                  <Button icon={<VideoCameraAddOutlined aria-hidden />} loading={uploading}>
                    {t('sopFromVideo.chat.addVideo')}
                  </Button>
                </Upload>
                {lastAsk?.action === 'ask' && session.needsVideo ? (
                  <Alert type="info" showIcon title={t('sopFromVideo.chat.needsVideo')} />
                ) : null}
              </Space>
            )}
          </Card>
        </Col>

        <Col xs={24} lg={15}>
          <Card
            title={t('sopFromVideo.chat.title')}
            extra={
              session ? (
                <Typography.Text type="secondary">
                  {t('sopFromVideo.chat.remaining', { n: session.remainingQuestions })}
                </Typography.Text>
              ) : null
            }
          >
            {!session ? (
              <Typography.Paragraph type="secondary">
                {t('sopFromVideo.chat.beforeStart')}
              </Typography.Paragraph>
            ) : (
              <Space direction="vertical" style={{ width: '100%' }} size={12}>
                <div style={{ maxHeight: 420, overflowY: 'auto' }}>
                  {session.messages.map((m, i) => (
                    <div
                      key={`${m.at}-${i}`}
                      style={{
                        display: 'flex',
                        justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start',
                        marginBottom: 10,
                      }}
                    >
                      <div
                        style={{
                          maxWidth: '86%',
                          padding: '8px 12px',
                          borderRadius: 10,
                          background: m.role === 'user' ? '#e6f4ff' : '#fafafa',
                          border: '1px solid #f0f0f0',
                          whiteSpace: 'pre-wrap',
                        }}
                      >
                        {m.text}
                      </div>
                    </div>
                  ))}
                  {sending && streamingText ? (
                    <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
                      <div
                        style={{
                          maxWidth: '86%',
                          padding: '8px 12px',
                          borderRadius: 10,
                          background: '#f6ffed',
                          border: '1px solid #f0f0f0',
                          whiteSpace: 'pre-wrap',
                        }}
                      >
                        {streamingText}
                        <span style={{ opacity: 0.45 }}>▍</span>
                      </div>
                    </div>
                  ) : null}
                </div>

                <Space.Compact style={{ width: '100%' }}>
                  <Input.TextArea
                    rows={2}
                    maxLength={4000}
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    placeholder={t('sopFromVideo.chat.placeholder')}
                    onPressEnter={(e) => {
                      if (!e.shiftKey) {
                        e.preventDefault();
                        void send();
                      }
                    }}
                    disabled={sending}
                  />
                  <Button
                    type="primary"
                    icon={<SendOutlined aria-hidden />}
                    loading={sending}
                    onClick={() => void send()}
                  >
                    {t('sopFromVideo.chat.send')}
                  </Button>
                </Space.Compact>

                {draft ? (
                  <Card size="small" title={t('sopFromVideo.draft.title')} style={{ marginTop: 8 }}>
                    {draft.assumptions.length > 0 && (
                      <Alert
                        type="info"
                        showIcon
                        style={{ marginBottom: 12 }}
                        title={t('sopFromVideo.draft.assumptions')}
                        description={
                          <ul style={{ margin: 0, paddingLeft: 18 }}>
                            {draft.assumptions.map((a) => (
                              <li key={a}>{a}</li>
                            ))}
                          </ul>
                        }
                      />
                    )}
                    <Typography.Paragraph type="secondary">
                      {t('sopFromVideo.draft.model', {
                        provider: draft.provider,
                        model: draft.model,
                      })}
                    </Typography.Paragraph>
                    <Form form={form} layout="vertical">
                      <Row gutter={12}>
                        <Col span={14}>
                          <Form.Item
                            name="title"
                            label={t('sopFromVideo.draft.sopTitle')}
                            rules={[{ required: true }]}
                          >
                            <Input maxLength={255} />
                          </Form.Item>
                        </Col>
                        <Col span={10}>
                          <Form.Item
                            name="slug"
                            label={t('sopFromVideo.draft.slug')}
                            rules={[
                              { required: true },
                              {
                                pattern: /^[a-z0-9][a-z0-9-]{0,127}$/,
                                message: t('sopFromVideo.draft.slug'),
                              },
                            ]}
                          >
                            <Input maxLength={128} />
                          </Form.Item>
                        </Col>
                      </Row>
                      <Form.Item
                        name="bodyMarkdown"
                        label={t('sopFromVideo.draft.body')}
                        rules={[{ required: true }]}
                      >
                        <Input.TextArea rows={12} />
                      </Form.Item>
                      <Form.Item
                        name="frontMatterYaml"
                        label={t('sopFromVideo.draft.frontMatter')}
                      >
                        <Input.TextArea rows={6} />
                      </Form.Item>
                      <Space>
                        <Button type="primary" loading={saving} onClick={() => void saveDraft()}>
                          {t('sopFromVideo.save')}
                        </Button>
                        <Button onClick={() => navigate('/sops')}>
                          {t('sopFromVideo.openSops')}
                        </Button>
                      </Space>
                    </Form>
                  </Card>
                ) : null}
              </Space>
            )}
          </Card>
        </Col>
      </Row>
    </div>
  );
}
