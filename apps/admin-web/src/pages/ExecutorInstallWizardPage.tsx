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
  theme,
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
import { copyText } from '../utils/clipboard';
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

/**
 * 环境变量参考块里展示的**键名**（供 `__tests__/install-wizard-env-vars.test.ts`
 * 与执行器源码交叉校验）。
 *
 * 为什么单独导出：这个块是「照抄即可用」的参考，键名写错**不会报错**——用户抄了
 * 一个没人读的变量，执行器静默落回默认值，注册还照常成功（唯一键是 address，
 * appName 不唯一），于是每台手工部署的执行器都以同名出现在列表里。本轮审计正是
 * 在这里抓到 `EXECUTOR_NAME`（全仓仅此一处，两侧执行器读的都是 `APP_NAME`）。
 * 把键名提出来，测试就能断言「块里出现的每个键都真的被执行器读取」。
 */
export const INSTALL_ENV_KEYS = [
  'ADMIN_API_URL',
  'EXECUTOR_SHARED_TOKEN',
  'EXECUTOR_ADDRESS_PUBLIC',
  'APP_NAME',
] as const;

/**
 * 第 5 步「执行器已上线」的判据：**本次新出现的**在线执行器。
 *
 * 单独抽成纯函数是为了可被单测直接钉住——这段逻辑此前写在轮询回调里，唯一的
 * 测试从未离开第 1 步，所以「把已有执行器误判成新装的」这个缺陷没有任何守卫。
 *
 * @param executors 当前执行器列表
 * @param knownIds  进入第 5 步**之前**已存在的执行器 id 集合（基线快照）
 * @returns 第一个「在线且不在基线里」的执行器；没有则 null
 */
export function findNewlyOnlineExecutor<T extends { id: string; status: string }>(
  executors: readonly T[],
  knownIds: ReadonlySet<string>,
): T | null {
  return executors.find((e) => e.status === 'online' && !knownIds.has(e.id)) ?? null;
}

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
          // UX-04（本轮体验审查）：此前 `.then(() => message.success(...))`
          // **没有 rejection handler**——剪贴板被拒时点了没反应也无报错，
          // 用户以为命令已复制。改用统一封装按真实结果反馈。
          onClick={async () => {
            const ok = await copyText(code);
            if (ok) {
              message.success(t('install.copiedLabel', { label }));
            } else {
              message.error(t('install.copyFail'));
            }
          }}
          aria-label={t('install.copyLabel', { label })}
        />
      </Tooltip>
    </div>
  );
}

function ReqRow({ label, note }: { label: string; note?: string }) {
  // F-15（DEEP_REVIEW 0ef3bbe）：主色图标走 antd token，暗色主题自适应。
  const { token } = theme.useToken();
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 8 }}>
      <InfoCircleOutlined style={{ color: token.colorPrimary, marginTop: 3 }} />
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
  // F-15（DEEP_REVIEW 0ef3bbe）：浅填充/提示/成功色走 antd token，暗色主题自适应。
  const { token } = theme.useToken();
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
    (startTime: number, knownIds: ReadonlySet<string>) => {
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
        // PERF-10（本轮体验审查）：标签页不可见时**跳过本次请求**，只续期下一次
        // 定时器。安装向导第 5 步在等执行器上线，用户的标准动作正是**切到另一台
        // 机器去装执行器**——即这台浏览器标签长时间处于隐藏态。原实现不管可见性
        // 一直每 5s 打一次 `executorsApi.list()`（全量执行器列表），白白消耗后端
        // 与网络；回前台后下一拍照常继续，**不丢任何一次检测机会**。
        //   · 计时**不暂停**（startTime 是绝对时间戳，超时判定照旧按真实时间走）
        //     ——否则用户装到一半切回来会发现"60s 还没到"，与倒计时显示矛盾；
        //   · 与 ExecutionsPage:105 / ExecutionDetailPage:393 /
        //     AppDeploymentPage:155 三处既有可见性守卫同款。
        if (document.visibilityState !== 'visible') {
          pollTimerRef.current = setTimeout(tick, POLL_INTERVAL_MS);
          return;
        }
        try {
          const executors = await executorsApi.list();
          // **必须是本次新出现的执行器**（id 不在进入本步骤前的基线集合里）。
          //
          // 此前判据只有「status === 'online' 且 lastHeartbeat 比开始时间早不超过
          // 5s」——它没有把这个执行器和用户正在装的那台关联起来。任何一台**已经**
          // 在心跳的执行器都会满足它（心跳 30s 一次、轮询每 5s 一次，而 startTime
          // 是固定值，匹配窗口只增不减），于是在已有健康执行器的环境里，第 5 步会
          // 在几秒内翻成「执行器已上线」并**报出另一台执行器的名字**——而用户真正
          // 要装的那台可能根本没起来。这一步的全部意义就是验证，误报成功比 60s
          // 超时更糟：超时至少给出排查指引。
          const recent = findNewlyOnlineExecutor(executors, knownIds);
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

  const handleGoToStep4 = async () => {
    const now = Date.now();
    // 基线快照：进入本步骤**之前**已存在的执行器 id。取不到（接口失败）时退化为
    // 空集合——即"任何在线执行器都算新"，与修复前行为一致，不会把用户卡在这一步。
    let knownIds: ReadonlySet<string> = new Set<string>();
    try {
      const executors = await executorsApi.list();
      knownIds = new Set(executors.map((e) => e.id));
    } catch {
      // 保持空集合（宽松兜底），下一步的轮询自身还会再试。
    }
    setCurrentStep(4);
    startPolling(now, knownIds);
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
  // 环境变量参考块：键名必须与执行器**真正读取**的变量一致，否则用户照抄后
  // 静默落回默认值。此前末行是 `EXECUTOR_NAME`——该键在**全仓只有这一处**
  // 出现，两侧执行器读的都是 `APP_NAME`（executor-node/src/config.ts:68、
  // executor-python/config.py:96），`scripts/install.sh:24` 写的也是 `APP_NAME`。
  // 后果不是报错而是静默：注册照常成功（唯一键是 address，appName 不唯一），
  // 但每一台手工部署的执行器都以默认名 `executor-node-1` 出现在列表里、无法区分。
  //
  // 键名集中在 INSTALL_ENV_KEYS（与执行器源码交叉校验，见 install-wizard-env-vars.test.ts）。
  const envVarValues: Record<(typeof INSTALL_ENV_KEYS)[number], string> = {
    ADMIN_API_URL: adminApiUrl,
    EXECUTOR_SHARED_TOKEN: sharedToken ?? '<your-executor-shared-token>',
    EXECUTOR_ADDRESS_PUBLIC: '<host-or-ip>:<port>',
    APP_NAME: 'my-executor-1',
  };
  const envVarBlock = INSTALL_ENV_KEYS.map((k) => `${k}=${envVarValues[k]}`).join('\n');

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
          style={{ marginBottom: 24 }}
        />
      ) : null}

      {/* UI 打磨（用户反馈）：去掉 maxWidth 900——宽屏右侧留大片空白，改随内容区全宽 */}
      <Steps
        current={currentStep}
        style={{ marginBottom: 32 }}
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
        <Card>
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
        <Card>
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
                style={{ marginTop: 20, background: token.colorFillQuaternary }}
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
        <Card>
          <Title level={5} style={{ marginTop: 0 }}>{t('install.step3')}</Title>
          <Paragraph type="secondary">
            {t('install.getCmdDesc')}
          </Paragraph>

          <Card size="small" style={{ background: token.colorFillQuaternary, marginBottom: 20 }}>
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
            style={{ background: token.colorWarningBg, border: `1px solid ${token.colorWarningBorder}`, marginBottom: 20 }}
            title={<Space><KeyOutlined /><Text strong>{t('install.tokenShared')}</Text></Space>}
          >
            <Paragraph type="secondary" style={{ marginBottom: 12 }}>
              {t('install.tokenDesc')}
            </Paragraph>
{loadingSharedToken ? (
              <Spin size="small" />
            ) : sharedToken ? (
              <Space wrap>
                <Input
                  readOnly
                  value={sharedTokenVisible ? sharedToken : '•'.repeat(Math.min(sharedToken.length, 64))}
                  style={{ width: 420, maxWidth: '100%', fontFamily: 'monospace' }}
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
                    onClick={async () => {
                      // F-18（DEEP_REVIEW 0ef3bbe）：补错误处理——失败不弹成功提示。
                      const ok = await copyText(sharedToken);
                      if (ok) message.success(t('install.copiedToken'));
                      else message.error(t('common.copyFailed'));
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
        <Card>
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
        <Card>
          <Title level={5} style={{ marginTop: 0 }}>{t('install.step5Title')}</Title>
          <Paragraph type="secondary">
            {t('install.step5Desc')}
          </Paragraph>

          {polling && !foundExecutor && !pollTimedOut && (
            <div style={{ textAlign: 'center', padding: '40px 0' }}>
              <Spin size="large" indicator={<SyncOutlined spin style={{ fontSize: 48, color: token.colorPrimary }} />} />
              <div style={{ marginTop: 20, color: token.colorTextSecondary, fontSize: 15 }}>{t('install.awaiting')}</div>
              <div style={{ marginTop: 8, color: token.colorTextQuaternary, fontSize: 13 }}>
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
                <CheckCircleOutlined style={{ fontSize: 64, color: token.colorSuccess }} />
                <div style={{ marginTop: 12, fontSize: 18, fontWeight: 600, color: token.colorSuccess }}>
                  {t('install.onlineTitle')}
                </div>
                <div style={{ marginTop: 4, color: token.colorTextTertiary }}>
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
              <Card size="small" style={{ background: token.colorWarningBg, border: `1px solid ${token.colorWarningBorder}` }}>
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
                  // 「重新检测」必须**重取基线**，否则用户在超时后又装好了执行器，
                  // 也会因为基线是旧的而被当成"已存在"、永远检测不到。
                  void handleGoToStep4();
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
