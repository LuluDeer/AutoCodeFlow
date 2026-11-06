import { useCallback, useEffect, useState } from 'react';
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
import { aiApi, type SopSession, type SopSessionDraft } from '../api/ai';
import { sopsApi } from '../api/sops';
// R139 / P2-1：模型列表三态（加载中 / 读取失败 / 真空）外提到本目录新文件——
// 本页体量已在 source-size-baseline 顶格，新增逻辑不再往页面里加行。
import ChatTranscript from './sop-from-video/ChatTranscript';
import ProviderStatusAlert from './sop-from-video/ProviderStatusAlert';
import { useVideoProviders } from './sop-from-video/useVideoProviders';

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

  /** R139 / P2-1：三态读取（loading/ready/error）+ 重试；不再用「数组空」当判据。 */
  const providers = useVideoProviders();
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

  /** 已知没有视频模型（= ready 且集合为空）；「未知」绝不当作「没有」。 */
  const noVideoModel = providers.state === 'ready' && providers.video.length === 0;

  /**
   * 主操作（上传录屏）的禁用判据 = **三态**，不是一个布尔：
   *   · `loading` → 禁用（还没拿到任何事实，不能让人点一个注定要用错默认值的操作）；
   *   · `error`   → **不禁用**：失败是可恢复的（错误块自带重试），不该再叠一层
   *     死禁用把用户关在页面里；
   *   · `ready` 且真空 → 禁用（这才是「没有可用模型」该说的话）。
   */
  const uploadBlocked = providers.state === 'loading' || noVideoModel;

  useEffect(() => {
    let alive = true;
    (async () => {
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

  // 第 6 轮审计 P2：表单回填的**唯一事实源** = session 本身。
  // 此前只在 applySession 里回填，URL 深链续跑/顶栏切会话都不碰 form：
  // 刷新后续跑标题正文为空（保存被 required 拦下，用户以为稿子丢了），
  // 切会话时表单留着**上一个会话**的正文（保存会把 A 写成 B 的草稿）。
  useEffect(() => {
    form.resetFields();
    const draft = session?.draft;
    if (draft) {
      form.setFieldsValue({
        title: draft.title,
        slug: draft.slug,
        bodyMarkdown: draft.bodyMarkdown,
        frontMatterYaml: draft.frontMatterYaml,
      });
    }
  }, [session?.id, session?.draft, form]);

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
      // 表单回填由 session 变化驱动的 effect 统一处理（避免两条写入路径漂移）。
    },
    [setSearchParams],
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
    /**
     * R139 / P3-3：`validateFields()` 校验不通过时是 **reject**，必须被消费。
     *
     * 旧实现是裸 `await form.validateFields()`：reject 直接逃出本函数 ⇒ 变成
     * 常驻 `unhandledRejection`（`main.tsx` 的全局兜底会打
     * `[admin-web][unhandled-rejection]`，线上错误聚合每次校验失败多一条）。
     * 全仓 `validateFields` 调用点只剩本处未消费（R92 修过设置页 4 处）。
     *
     * 处置与全站一致：**校验错误不是请求错误**——不发请求、不走 `showApiError`；
     * 字段标红是主提示，这里再补一条动作级可见提示（同页 `send()` 对「空输入」
     * 的处理口径），让用户知道"点了但没保存"而不是以为页面卡了。
     */
    let values: {
      title: string;
      slug: string;
      bodyMarkdown: string;
      frontMatterYaml: string;
    };
    try {
      values = await form.validateFields();
    } catch {
      message.warning(t('sopFromVideo.draft.invalid'));
      return;
    }
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

      {/* R139 / P2-1：三态各自呈现——加载中不再先报「没有模型」，失败给错误块
          + 重试（而不是把读请求失败伪装成「你还没接入模型」）。 */}
      <ProviderStatusAlert providers={providers} />

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
                  options={providers.video.map((p) => ({
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
                  disabled={uploading || booting || uploadBlocked}
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
                <ChatTranscript
                  messages={session.messages}
                  streaming={sending}
                  streamingText={streamingText}
                />

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
