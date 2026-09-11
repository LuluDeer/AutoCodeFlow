import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Steps,
  Card,
  Select,
  Button,
  Typography,
  Space,
  Alert,
  Spin,
  Tag,
  Divider,
  message,
  Tooltip,
  Row,
  Col,
  Input,
} from 'antd';
import PageHeader from '../components/PageHeader';
import StateError from '../components/StateError';
import {
  DownloadOutlined,
  CopyOutlined,
  CheckCircleOutlined,
  DesktopOutlined,
  CodeOutlined,
  KeyOutlined,
  ArrowLeftOutlined,
  SyncOutlined,
  CloseCircleOutlined,
  EyeOutlined,
  EyeInvisibleOutlined,
  InfoCircleOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { executorPackagesApi, ExecutorPackage } from '../api/executor-packages';
import { executorsApi, Executor, InstallCmdResult } from '../api/executors';
import { getErrMsg } from '../utils/error';
import { useTranslation, Trans } from 'react-i18next';
// UI-10：导入 i18n 实例（模块副作用完成初始化；树内用 useTranslation 读 key）
import '../i18n';

const { Title, Text, Paragraph } = Typography;

const PLATFORM_LABELS = (t: (k: string) => string): Record<string, string> => ({
  linux_amd64: t('install.platform.linux_amd64'),
  linux_arm64: t('install.platform.linux_arm64'),
  darwin_amd64: t('install.platform.darwin_amd64'),
  darwin_arm64: t('install.platform.darwin_arm64'),
  windows_amd64: t('install.platform.windows_amd64'),
});

const TYPE_LABELS = (t: (k: string) => string): Record<string, string> => ({
  node: t('install.type.node'),
  python: t('install.type.python'),
  universal: t('install.type.universal'),
});

const TYPE_COLORS: Record<string, string> = {
  node: 'green',
  python: 'blue',
  universal: 'purple',
};

function formatBytes(bytes: number): string {
  if (!bytes) return '-';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const CODE_BLOCK_STYLE: React.CSSProperties = {
  background: '#1d1e27',
  borderRadius: 6,
  padding: '12px 16px',
  position: 'relative',
  fontFamily: 'monospace',
  fontSize: 13,
  color: '#e8e8e8',
  wordBreak: 'break-all',
  lineHeight: 1.6,
};

function CodeBlock({ code, label }: { code: string; label: string }) {
  const { t } = useTranslation();
  return (
    <div style={CODE_BLOCK_STYLE}>
      <span style={{ whiteSpace: 'pre-wrap' }}>{code}</span>
      <Tooltip title={t('install.copy')}>
        <Button
          type="text"
          size="small"
          icon={<CopyOutlined />}
          style={{ position: 'absolute', top: 6, right: 6, color: '#aaa' }}
          onClick={() =>
            navigator.clipboard
              .writeText(code)
              .then(() => message.success(t('install.copiedLabel', { label })))
          }
          aria-label={t('install.copyLabel', { label })}
        />
      </Tooltip>
    </div>
  );
}

function ReqRow({ label, note }: { label: string; note?: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 8 }}>
      <InfoCircleOutlined style={{ color: '#1677ff', marginTop: 3 }} />
      <div>
        <Text>{label}</Text>
        {note && <div><Text type="secondary" style={{ fontSize: 12 }}>{note}</Text></div>}
      </div>
    </div>
  );
}

export default function ExecutorInstallWizardPage() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const platformLabels = PLATFORM_LABELS(t);
  const typeLabels = TYPE_LABELS(t);
  const [currentStep, setCurrentStep] = useState(0);

  const [packages, setPackages] = useState<ExecutorPackage[]>([]);
  const [loadingPackages, setLoadingPackages] = useState(false);
  const [selectedType, setSelectedType] = useState<string | undefined>();
  const [selectedPlatform, setSelectedPlatform] = useState<string | undefined>();
  const [selectedPackage, setSelectedPackage] = useState<ExecutorPackage | null>(null);
  const [installCmd, setInstallCmd] = useState<InstallCmdResult | null>(null);
  const [generatingCmd, setGeneratingCmd] = useState(false);
  const [sharedToken, setSharedToken] = useState<string | null>(null);
  const [loadingSharedToken, setLoadingSharedToken] = useState(false);
  const [sharedTokenVisible, setSharedTokenVisible] = useState(false);

  const POLL_INTERVAL_MS = 5000;
  const POLL_TIMEOUT_MS = 60000;
  const [polling, setPolling] = useState(false);
  const [foundExecutor, setFoundExecutor] = useState<Executor | null>(null);
  const [pollTimedOut, setPollTimedOut] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // UI-16：安装包列表是向导的读入口，失败需页内可见并可重试（此前只有一闪而过的 toast，
  // 步骤 2 的类型/平台选择会静默为空，用户以为「没有可用包」）。
  const [packagesError, setPackagesError] = useState<unknown>(null);

  const loadPackages = useCallback(() => {
    setLoadingPackages(true);
    setPackagesError(null);
    return executorPackagesApi
      .listLatest()
      .then((data) => setPackages(data))
      .catch((err: unknown) => {
        setPackagesError(err);
        message.error(t('install.loadPackagesFail'));
      })
      .finally(() => setLoadingPackages(false));
  }, [t]);

  useEffect(() => {
    void loadPackages();
  }, [loadPackages]);

  const availableTypes = Array.from(new Set(packages.map((p) => p.type)));
  const availablePlatforms = Array.from(
    new Set(
      packages
        .filter((p) => !selectedType || p.type === selectedType)
        .map((p) => p.platform),
    ),
  );

  const matchedPackage =
    packages.find(
      (p) =>
        (!selectedType || p.type === selectedType) &&
        (!selectedPlatform || p.platform === selectedPlatform),
    ) ?? null;

  const handleStep1Next = () => {
    if (!matchedPackage) {
      message.warning(t('install.selectFirst'));
      return;
    }
    setSelectedPackage(matchedPackage);
    setLoadingSharedToken(true);
    import('../api/config')
      .then(({ configApi }) => configApi.getExecutorToken())
      .then((r) => setSharedToken(r.token))
      .catch(() => {
        setSharedToken(null);
        message.warning(t('install.getTokenFail'));
      })
      .finally(() => setLoadingSharedToken(false));
    setCurrentStep(2);
  };

  const handleGenerateInstallCmd = async () => {
    setGeneratingCmd(true);
    try {
      // 采纳后端已实现的文档化流程：GET /executors/install-cmd（npx 一键启动命令）。
      // 原 /executor-packages/:id/install-script 路由后端不存在（404）；
      // R5 已删除无消费方的 POST /executor-packages/install-token 端点。
      const result = await executorsApi.getInstallCmd();
      setInstallCmd(result);
      setCurrentStep(3);
    } catch (err: unknown) {
      message.error(getErrMsg(err, t('install.getCmdFail')));
    } finally {
      setGeneratingCmd(false);
    }
  };

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    if (countdownRef.current) {
      clearInterval(countdownRef.current);
      countdownRef.current = null;
    }
    setPolling(false);
  }, []);

  const startPolling = useCallback(
    (startTime: number) => {
      stopPolling();
      setPolling(true);
      setPollTimedOut(false);
      setFoundExecutor(null);
      setElapsedSeconds(0);

      countdownRef.current = setInterval(() => {
        setElapsedSeconds(Math.floor((Date.now() - startTime) / 1000));
      }, 1000);

      const tick = async () => {
        const elapsed = Date.now() - startTime;
        if (elapsed >= POLL_TIMEOUT_MS) {
          stopPolling();
          setPollTimedOut(true);
          return;
        }
        try {
          const executors = await executorsApi.list();
          const recent = executors.find(
            (e) =>
              e.status === 'online' &&
              new Date(e.lastHeartbeat).getTime() > startTime - 5000,
          );
          if (recent) {
            stopPolling();
            setFoundExecutor(recent);
            return;
          }
        } catch {
          // ignore
        }
        pollTimerRef.current = setTimeout(tick, POLL_INTERVAL_MS);
      };

      pollTimerRef.current = setTimeout(tick, POLL_INTERVAL_MS);
    },
    [stopPolling],
  );

  useEffect(() => () => stopPolling(), [stopPolling]);

  const handleGoToStep4 = () => {
    const now = Date.now();
    setCurrentStep(4);
    startPolling(now);
  };

  const handleReset = () => {
    stopPolling();
    setCurrentStep(0);
    setSelectedType(undefined);
    setSelectedPlatform(undefined);
    setSelectedPackage(null);
    setInstallCmd(null);
    setFoundExecutor(null);
    setPollTimedOut(false);
    setElapsedSeconds(0);
  };

  const adminApiUrl = window.location.origin;
  const envVarBlock = [
    `ADMIN_API_URL=${adminApiUrl}`,
    `EXECUTOR_SHARED_TOKEN=${sharedToken ?? '<your-executor-shared-token>'}`,
    `EXECUTOR_ADDRESS_PUBLIC=<host-or-ip>:<port>`,
    `EXECUTOR_NAME=my-executor-1`,
  ].join('\n');

  return (
    <div>
      {/* UI-03/UI-08：页头标准化（返回按钮迁入 PageHeader extra，行为不变） */}
      <PageHeader
        title={t('install.title')}
        description={t('install.description')}
        breadcrumb={[{ title: t('install.breadcrumbList'), to: '/executors' }, { title: t('install.breadcrumbWizard') }]}
        extra={
          <Button
            icon={<ArrowLeftOutlined />}
            type="text"
            onClick={() => navigate('/executors')}
            aria-label={t('install.back')}
          >
            {t('install.back')}
          </Button>
        }
      />

      {/* UI-16：安装包列表加载失败 → 页内错误块（重试=重新拉取），不进入必然失败的下一步 */}
      {packagesError ? (
        <StateError
          error={packagesError}
          title={t('install.packagesLoadFail')}
          onRetry={() => { void loadPackages(); }}
          style={{ marginBottom: 24, maxWidth: 900 }}
        />
      ) : null}

      <Steps
        current={currentStep}
        style={{ marginBottom: 32, maxWidth: 900 }}
        items={[
          { title: t('install.step1'), icon: <DesktopOutlined /> },
          { title: t('install.step2'), icon: <DownloadOutlined /> },
          { title: t('install.step3'), icon: <KeyOutlined /> },
          { title: t('install.step4'), icon: <CodeOutlined /> },
          { title: t('install.step5'), icon: <CheckCircleOutlined /> },
        ]}
      />

      {/* Step 0: 系统要求 */}
      {currentStep === 0 && (
        <Card style={{ maxWidth: 720 }}>
          <Title level={5} style={{ marginTop: 0 }}>{t('install.reqTitle')}</Title>
          <Paragraph type="secondary">
            {t('install.reqIntro')}
          </Paragraph>

          <div style={{ marginBottom: 20 }}>
            <ReqRow label={t('install.req1Label')} note={t('install.req1Note')} />
            <ReqRow label={t('install.req2Label')} note={t('install.req2Note')} />
            <ReqRow label={t('install.req3Label')} note={t('install.req3Note')} />
            <ReqRow label={t('install.req4Label')} note={t('install.req4Note', { url: adminApiUrl })} />
            <ReqRow label={t('install.req5Label')} note={t('install.req5Note')} />
          </div>

          <Alert
            type="info"
            showIcon
            title={t('install.tip')}
            description={t('install.tipDesc')}
            style={{ marginBottom: 20 }}
          />

          <Divider />
          <Space>
            <Button onClick={() => navigate('/executors')}>{t('install.cancel')}</Button>
            <Button type="primary" onClick={() => setCurrentStep(1)}>
              {t('install.next')}
            </Button>
          </Space>
        </Card>
      )}

      {/* Step 1: 选择安装包 */}
      {currentStep === 1 && (
        <Card style={{ maxWidth: 720 }}>
          <Title level={5} style={{ marginTop: 0 }}>{t('install.selectTitle')}</Title>
          <Paragraph type="secondary">
            {t('install.selectDesc')}
          </Paragraph>

<Spin spinning={loadingPackages}>
            <Row gutter={[16, 16]}>
              <Col xs={24} sm={12}>
                <Text strong style={{ display: 'block', marginBottom: 6 }}>{t('install.type')}</Text>
                <Select
                  placeholder={t('install.typePlaceholder')}
                  style={{ width: '100%' }}
                  value={selectedType}
                  onChange={(v) => { setSelectedType(v); setSelectedPlatform(undefined); }}
                  allowClear
                >
                  {availableTypes.map((t) => (
                    <Select.Option key={t} value={t}>
                      <Tag color={TYPE_COLORS[t] ?? 'default'} style={{ marginRight: 0 }}>
                        {typeLabels[t] ?? t}
                      </Tag>
                    </Select.Option>
                  ))}
                </Select>
              </Col>
              <Col xs={24} sm={12}>
                <Text strong style={{ display: 'block', marginBottom: 6 }}>{t('install.platform')}</Text>
                <Select
                  placeholder={t('install.platformPlaceholder')}
                  style={{ width: '100%' }}
                  value={selectedPlatform}
                  onChange={setSelectedPlatform}
                  allowClear
                  disabled={availablePlatforms.length === 0}
                >
                  {availablePlatforms.map((p) => (
                    <Select.Option key={p} value={p}>
                      {platformLabels[p] ?? p}
                    </Select.Option>
                  ))}
                </Select>
              </Col>
            </Row>

            {matchedPackage && (
              <Card
                size="small"
                style={{ marginTop: 20, background: '#fafafa' }}
                title={<Text strong>{t('install.matchedTitle', { name: matchedPackage.name })}</Text>}
              >
                <Row gutter={[16, 8]}>
                  <Col span={8}>
                    <Text type="secondary">{t('install.version')}</Text>
                    <div><Text strong>{matchedPackage.version}</Text></div>
                  </Col>
                  <Col span={8}>
                    <Text type="secondary">{t('install.fileSize')}</Text>
                    <div><Text strong>{formatBytes(matchedPackage.fileSize)}</Text></div>
                  </Col>
                  <Col span={8}>
                    <Text type="secondary">{t('install.downloadCount')}</Text>
                    <div><Text strong>{matchedPackage.downloadCount}</Text></div>
                  </Col>
{matchedPackage.sha256 && (
                    <Col span={24}>
                      <Text type="secondary">{t('install.sha256')}</Text>
                      <div>
                        <Text code copyable style={{ fontSize: 12, wordBreak: 'break-all' }}>
                          {matchedPackage.sha256}
                        </Text>
                      </div>
                    </Col>
                  )}
                  {matchedPackage.changelog && (
                    <Col span={24}>
                      <Text type="secondary">{t('install.changelog')}</Text>
                      <div><Text>{matchedPackage.changelog}</Text></div>
                    </Col>
                  )}
                </Row>
              </Card>
            )}

            {!loadingPackages && packages.length === 0 && (
              <Alert
                type="warning"
                title={t('install.noPackages')}
                description={t('install.noPackagesDesc')}
                showIcon
                style={{ marginTop: 16 }}
                action={
                  <Button size="small" type="primary" onClick={() => navigate('/executors/packages')}>
                    {t('install.upload')}
                  </Button>
                }
              />
            )}
          </Spin>

          <Divider />
          <Space>
            <Button onClick={() => setCurrentStep(0)}>{t('install.prev')}</Button>
            <Button type="primary" disabled={!matchedPackage} onClick={handleStep1Next}>
              {t('install.next')}
            </Button>
          </Space>
        </Card>
      )}

      {/* Step 2: 获取安装命令 */}
      {currentStep === 2 && selectedPackage && (
        <Card style={{ maxWidth: 720 }}>
          <Title level={5} style={{ marginTop: 0 }}>{t('install.step3')}</Title>
          <Paragraph type="secondary">
            {t('install.getCmdDesc')}
          </Paragraph>

          <Card size="small" style={{ background: '#fafafa', marginBottom: 20 }}>
            <Row gutter={16}>
              <Col span={8}>
                <Text type="secondary">{t('install.package')}</Text>
                <div><Text strong>{selectedPackage.name}</Text></div>
              </Col>
              <Col span={8}>
                <Text type="secondary">{t('install.version')}</Text>
                <div><Text strong>{selectedPackage.version}</Text></div>
              </Col>
              <Col span={8}>
                <Text type="secondary">{t('install.platformCol')}</Text>
                <div><Text strong>{platformLabels[selectedPackage.platform] ?? selectedPackage.platform}</Text></div>
              </Col>
            </Row>
          </Card>

          <Alert
            type="info"
            showIcon
            title={t('install.securityTip')}
            description={t('install.securityTipDesc')}
            style={{ marginBottom: 20 }}
          />

          <Card
            size="small"
            style={{ background: '#fffbe6', border: '1px solid #ffe58f', marginBottom: 20 }}
            title={<Space><KeyOutlined /><Text strong>{t('install.tokenShared')}</Text></Space>}
          >
            <Paragraph type="secondary" style={{ marginBottom: 12 }}>
              {t('install.tokenDesc')}
            </Paragraph>
{loadingSharedToken ? (
              <Spin size="small" />
            ) : sharedToken ? (
              <Space>
                <Input
                  readOnly
                  value={sharedTokenVisible ? sharedToken : '•'.repeat(Math.min(sharedToken.length, 64))}
                  style={{ width: 420, fontFamily: 'monospace' }}
                />
                <Button
                  size="small"
                  icon={sharedTokenVisible ? <EyeInvisibleOutlined /> : <EyeOutlined />}
                  onClick={() => setSharedTokenVisible((v) => !v)}
                />
                {sharedTokenVisible && (
                  <Button
                    size="small"
                    icon={<CopyOutlined />}
                    onClick={() => {
                      navigator.clipboard.writeText(sharedToken);
                      message.success(t('install.copiedToken'));
                    }}
                  >
                    {t('install.copy')}
                  </Button>
                )}
              </Space>
            ) : (
              <Alert
                type="warning"
                showIcon
                title={t('install.tokenMissing')}
              />
            )}
          </Card>

          <Divider />
          <Space>
            <Button onClick={() => setCurrentStep(1)}>{t('install.prev')}</Button>
            <Button
              type="primary"
              icon={<KeyOutlined />}
              loading={generatingCmd}
              onClick={handleGenerateInstallCmd}
            >
              {t('install.getCmd')}
            </Button>
          </Space>
        </Card>
      )}

      {/* Step 3: 执行安装 */}
      {currentStep === 3 && installCmd && (
        <Card style={{ maxWidth: 720 }}>
          <Title level={5} style={{ marginTop: 0 }}>{t('install.step4Title')}</Title>
          <Paragraph type="secondary">
            {t('install.step4Desc')}
          </Paragraph>

          <Alert
            type="success"
            showIcon
            icon={<CheckCircleOutlined />}
            title={t('install.cmdGenerated')}
            description={t('install.cmdGeneratedDesc')}
            style={{ marginBottom: 24 }}
          />

          <Space orientation="vertical" style={{ width: '100%' }} size={20}>
            <div>
              <Space style={{ marginBottom: 8 }}>
                <Text strong>{t('install.oneClickCmd')}</Text>
                <Tag color="green">{t('install.recommend')}</Tag>
              </Space>
              <CodeBlock code={installCmd.cmd} label={t('install.cmdLabel')} />
            </div>

            <div>
              <Text strong style={{ display: 'block', marginBottom: 8 }}>{t('install.envLabel')}</Text>
              <Paragraph type="secondary" style={{ marginBottom: 8, fontSize: 13 }}>
                {t('install.envDesc')}
              </Paragraph>
              <CodeBlock code={envVarBlock} label={t('install.envBlockLabel')} />
            </div>

            <Alert
              type="warning"
              showIcon
              title={t('install.noteTitle')}
              description={t('install.noteDesc')}
            />
          </Space>

<Divider />
          <Space>
            <Button icon={<DownloadOutlined />} onClick={handleReset}>{t('install.reinstall')}</Button>
            <Button type="primary" onClick={handleGoToStep4}>{t('install.nextAwait')}</Button>
          </Space>
        </Card>
      )}

      {/* Step 4: 验证执行器上线 */}
      {currentStep === 4 && (
        <Card style={{ maxWidth: 720 }}>
          <Title level={5} style={{ marginTop: 0 }}>{t('install.step5Title')}</Title>
          <Paragraph type="secondary">
            {t('install.step5Desc')}
          </Paragraph>

          {polling && !foundExecutor && !pollTimedOut && (
            <div style={{ textAlign: 'center', padding: '40px 0' }}>
              <Spin size="large" indicator={<SyncOutlined spin style={{ fontSize: 48, color: '#1677ff' }} />} />
              <div style={{ marginTop: 20, color: '#666', fontSize: 15 }}>{t('install.awaiting')}</div>
              <div style={{ marginTop: 8, color: '#aaa', fontSize: 13 }}>
                {t('install.elapsed', { seconds: elapsedSeconds })}
              </div>
            </div>
          )}

          {foundExecutor && (
            <>
              <Alert
                type="success"
                showIcon
                icon={<CheckCircleOutlined />}
                title={t('install.onlineSuccess')}
                description={
                  <span>
                    <Trans i18nKey="install.detected" values={{ appName: foundExecutor.appName, address: foundExecutor.address }}><strong>appName</strong></Trans>
                  </span>
                }
                style={{ marginBottom: 20 }}
              />
<div style={{ textAlign: 'center', padding: '16px 0' }}>
                <CheckCircleOutlined style={{ fontSize: 64, color: '#52c41a' }} />
                <div style={{ marginTop: 12, fontSize: 18, fontWeight: 600, color: '#52c41a' }}>
                  {t('install.onlineTitle')}
                </div>
                <div style={{ marginTop: 4, color: '#888' }}>
                  {foundExecutor.appName} · {foundExecutor.address}
                </div>
              </div>
            </>
          )}

          {pollTimedOut && (
            <>
              <Alert
                type="warning"
                showIcon
                icon={<CloseCircleOutlined />}
                title={t('install.timeoutTitle')}
                description={t('install.timeoutDesc')}
                style={{ marginBottom: 20 }}
              />
              <Card size="small" style={{ background: '#fffbe6', border: '1px solid #ffe58f' }}>
                <Title level={5} style={{ marginTop: 0 }}>{t('install.troubleTitle')}</Title>
                <ul style={{ paddingLeft: 20, lineHeight: 2, margin: 0 }}>
                  <li>{t('install.trouble1')}</li>
                  <li>{t('install.trouble2')}</li>
                  <li><Trans i18nKey="install.trouble3"><code>sudo</code></Trans></li>
                  <li>{t('install.trouble4')}</li>
                  <li><Trans i18nKey="install.trouble5"><code>EXECUTOR_SHARED_TOKEN</code></Trans></li>
                  <li><Trans i18nKey="install.trouble6"><code>EXECUTOR_ADDRESS_PUBLIC</code></Trans></li>
                  <li>{t('install.trouble7')}</li>
                </ul>
              </Card>
            </>
          )}

          <Divider />
          <Space>
            {!foundExecutor && (
              <Button onClick={() => { stopPolling(); setCurrentStep(3); }}>{t('install.prevStep')}</Button>
            )}
            {pollTimedOut && (
              <Button
                onClick={() => {
                  const now = Date.now();
                  startPolling(now);
                }}
              >
                {t('install.redetect')}
              </Button>
            )}
            <Button
              type="primary"
              onClick={() => navigate('/executors')}
            >
              {t('install.gotoList')}
            </Button>
          </Space>
        </Card>
      )}
    </div>
  );
}
