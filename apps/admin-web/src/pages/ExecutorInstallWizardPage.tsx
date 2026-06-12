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
  Modal,
} from 'antd';
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
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import {
  executorPackagesApi,
  ExecutorPackage,
  InstallTokenResult,
} from '../api/executor-packages';
import { executorsApi, Executor } from '../api/executors';

const { Title, Text, Paragraph } = Typography;

const PLATFORM_LABELS: Record<string, string> = {
  linux_amd64: 'Linux (x86_64)',
  linux_arm64: 'Linux (ARM64)',
  darwin_amd64: 'macOS (Intel)',
  darwin_arm64: 'macOS (Apple Silicon)',
  windows_amd64: 'Windows (x86_64)',
};

const TYPE_LABELS: Record<string, string> = {
  node: 'Node.js',
  python: 'Python',
  universal: '通用',
};

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

export default function ExecutorInstallWizardPage() {
  const navigate = useNavigate();
  const [currentStep, setCurrentStep] = useState(0);

  // Step 0
  const [packages, setPackages] = useState<ExecutorPackage[]>([]);
  const [loadingPackages, setLoadingPackages] = useState(false);
  const [selectedType, setSelectedType] = useState<string | undefined>();
  const [selectedPlatform, setSelectedPlatform] = useState<string | undefined>();

  // Step 1
  const [selectedPackage, setSelectedPackage] = useState<ExecutorPackage | null>(null);
  const [tokenResult, setTokenResult] = useState<InstallTokenResult | null>(null);
  const [generatingToken, setGeneratingToken] = useState(false);

  // Step 2
  const [installScriptUrl, setInstallScriptUrl] = useState('');

  // Step 3 — poll for executor online
  const POLL_INTERVAL_MS = 3000;
  const POLL_TIMEOUT_MS = 120000; // 2 minutes
  const [polling, setPolling] = useState(false);
  const [pollStartTime, setPollStartTime] = useState<number | null>(null);
  const [foundExecutor, setFoundExecutor] = useState<Executor | null>(null);
  const [pollTimedOut, setPollTimedOut] = useState(false);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setLoadingPackages(true);
    executorPackagesApi
      .listLatest()
      .then((data) => setPackages(Array.isArray(data) ? data : []))
      .catch(() => message.error('加载安装包列表失败，请检查 admin-api 服务'))
      .finally(() => setLoadingPackages(false));
  }, []);

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

  const handleStep0Next = () => {
    if (!matchedPackage) {
      message.warning('请先选择执行器类型和目标平台');
      return;
    }
    setSelectedPackage(matchedPackage);
    setCurrentStep(1);
  };

  const handleGenerateToken = async () => {
    setGeneratingToken(true);
    try {
      const result = await executorPackagesApi.generateInstallToken();
      setTokenResult(result);
      if (selectedPackage) {
        setInstallScriptUrl(
          executorPackagesApi.getInstallScriptUrl(selectedPackage.id, result.token),
        );
      }
      setCurrentStep(2);
    } catch {
      message.error('生成安装凭证失败，请重试');
    } finally {
      setGeneratingToken(false);
    }
  };

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    setPolling(false);
  }, []);

  const startPolling = useCallback(
    (startTime: number) => {
      setPolling(true);
      setPollTimedOut(false);
      setFoundExecutor(null);

      const tick = async () => {
        const elapsed = Date.now() - startTime;
        if (elapsed >= POLL_TIMEOUT_MS) {
          setPollTimedOut(true);
          setPolling(false);
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
            setFoundExecutor(recent);
            setPolling(false);
            return;
          }
        } catch {
          // ignore errors, keep polling
        }
        pollTimerRef.current = setTimeout(tick, POLL_INTERVAL_MS);
      };

      pollTimerRef.current = setTimeout(tick, POLL_INTERVAL_MS);
    },
    [stopPolling],
  );

  // Cleanup on unmount
  useEffect(() => () => stopPolling(), [stopPolling]);

  const handleGoToStep3 = () => {
    const now = Date.now();
    setPollStartTime(now);
    setCurrentStep(3);
    startPolling(now);
  };

  const handleReset = () => {
    stopPolling();
    setCurrentStep(0);
    setSelectedType(undefined);
    setSelectedPlatform(undefined);
    setSelectedPackage(null);
    setTokenResult(null);
    setInstallScriptUrl('');
    setFoundExecutor(null);
    setPollTimedOut(false);
    setPollStartTime(null);
  };

  const curlCmd = installScriptUrl ? `curl -fsSL "${installScriptUrl}" | bash` : '';
  const wgetCmd = installScriptUrl ? `wget -qO- "${installScriptUrl}" | bash` : '';

  const copyText = (text: string, label: string) => {
    navigator.clipboard.writeText(text).then(() => message.success(`已复制 ${label}`));
  };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 24, gap: 12 }}>
        <Button
          icon={<ArrowLeftOutlined />}
          type="text"
          onClick={() => navigate('/executors')}
          aria-label="返回执行器列表"
        />
        <Title level={4} style={{ margin: 0 }}>执行器安装向导</Title>
      </div>

      <Steps
        current={currentStep}
        style={{ marginBottom: 32, maxWidth: 800 }}
        items={[
          { title: '选择安装包', icon: <DesktopOutlined /> },
          { title: '生成安装凭证', icon: <KeyOutlined /> },
          { title: '执行安装', icon: <CodeOutlined /> },
          { title: '验证上线', icon: <CheckCircleOutlined /> },
        ]}
      />

      {/* ── Step 0: 选择安装包 ── */}
      {currentStep === 0 && (
        <Card style={{ maxWidth: 720 }}>
          <Title level={5} style={{ marginTop: 0 }}>选择执行器类型与目标平台</Title>
          <Paragraph type="secondary">
            根据目标服务器的操作系统和所需执行器类型，选择对应的安装包。
          </Paragraph>

          <Spin spinning={loadingPackages}>
            <Row gutter={[16, 16]}>
              <Col xs={24} sm={12}>
                <Text strong style={{ display: 'block', marginBottom: 6 }}>执行器类型</Text>
                <Select
                  placeholder="请选择类型"
                  style={{ width: '100%' }}
                  value={selectedType}
                  onChange={(v) => { setSelectedType(v); setSelectedPlatform(undefined); }}
                  allowClear
                >
                  {availableTypes.map((t) => (
                    <Select.Option key={t} value={t}>
                      <Tag color={TYPE_COLORS[t] ?? 'default'} style={{ marginRight: 0 }}>
                        {TYPE_LABELS[t] ?? t}
                      </Tag>
                    </Select.Option>
                  ))}
                </Select>
              </Col>
              <Col xs={24} sm={12}>
                <Text strong style={{ display: 'block', marginBottom: 6 }}>目标平台</Text>
                <Select
                  placeholder="请选择平台"
                  style={{ width: '100%' }}
                  value={selectedPlatform}
                  onChange={setSelectedPlatform}
                  allowClear
                  disabled={availablePlatforms.length === 0}
                >
                  {availablePlatforms.map((p) => (
                    <Select.Option key={p} value={p}>
                      {PLATFORM_LABELS[p] ?? p}
                    </Select.Option>
                  ))}
                </Select>
              </Col>
            </Row>

            {matchedPackage && (
              <Card
                size="small"
                style={{ marginTop: 20, background: '#fafafa' }}
                title={<Text strong>已匹配安装包：{matchedPackage.name}</Text>}
              >
                <Row gutter={[16, 8]}>
                  <Col span={8}>
                    <Text type="secondary">版本</Text>
                    <div><Text strong>{matchedPackage.version}</Text></div>
                  </Col>
                  <Col span={8}>
                    <Text type="secondary">文件大小</Text>
                    <div><Text strong>{formatBytes(matchedPackage.fileSize)}</Text></div>
                  </Col>
                  <Col span={8}>
                    <Text type="secondary">下载次数</Text>
                    <div><Text strong>{matchedPackage.downloadCount}</Text></div>
                  </Col>
                  {matchedPackage.sha256 && (
                    <Col span={24}>
                      <Text type="secondary">SHA256</Text>
                      <div>
                        <Text code copyable style={{ fontSize: 12, wordBreak: 'break-all' }}>
                          {matchedPackage.sha256}
                        </Text>
                      </div>
                    </Col>
                  )}
                  {matchedPackage.changelog && (
                    <Col span={24}>
                      <Text type="secondary">更新日志</Text>
                      <div><Text>{matchedPackage.changelog}</Text></div>
                    </Col>
                  )}
                </Row>
              </Card>
            )}

            {!loadingPackages && packages.length === 0 && (
              <Alert
                type="warning"
                message="暂无可用安装包"
                description="请先上传执行器安装包，再使用本向导。"
                showIcon
                style={{ marginTop: 16 }}
                action={
                  <Button size="small" type="primary" onClick={() => navigate('/executors/packages')}>
                    去上传安装包
                  </Button>
                }
              />
            )}
          </Spin>

          <Divider />
          <Space>
            <Button onClick={() => navigate('/executors')}>取消</Button>
            <Button type="primary" disabled={!matchedPackage} onClick={handleStep0Next}>
              下一步
            </Button>
          </Space>
        </Card>
      )}

      {/* ── Step 1: 生成安装凭证 ── */}
      {currentStep === 1 && selectedPackage && (
        <Card style={{ maxWidth: 720 }}>
          <Title level={5} style={{ marginTop: 0 }}>生成一次性安装凭证</Title>
          <Paragraph type="secondary">
            系统将生成一个有时效的一次性 Token，仅用于本次安装，使用后自动失效。
          </Paragraph>

          <Card size="small" style={{ background: '#fafafa', marginBottom: 20 }}>
            <Row gutter={16}>
              <Col span={8}>
                <Text type="secondary">安装包</Text>
                <div><Text strong>{selectedPackage.name}</Text></div>
              </Col>
              <Col span={8}>
                <Text type="secondary">版本</Text>
                <div><Text strong>{selectedPackage.version}</Text></div>
              </Col>
              <Col span={8}>
                <Text type="secondary">平台</Text>
                <div><Text strong>{PLATFORM_LABELS[selectedPackage.platform] ?? selectedPackage.platform}</Text></div>
              </Col>
            </Row>
          </Card>

          <Alert
            type="info"
            showIcon
            message="安全提示"
            description="Token 有效期为 1 小时，且只能使用一次。请在目标服务器上立即执行安装命令，不要将 Token 泄露给他人。"
            style={{ marginBottom: 20 }}
          />

          <Divider />
          <Space>
            <Button onClick={() => setCurrentStep(0)}>上一步</Button>
            <Button
              type="primary"
              icon={<KeyOutlined />}
              loading={generatingToken}
              onClick={handleGenerateToken}
            >
              生成安装凭证
            </Button>
          </Space>
        </Card>
      )}

      {/* ── Step 2: 执行安装 ── */}
      {currentStep === 2 && tokenResult && selectedPackage && (
        <Card style={{ maxWidth: 720 }}>
          <Title level={5} style={{ marginTop: 0 }}>在目标服务器上执行安装</Title>
          <Paragraph type="secondary">
            复制以下命令，在目标服务器终端中执行即可完成安装。
          </Paragraph>

          <Alert
            type="success"
            showIcon
            icon={<CheckCircleOutlined />}
            message="安装凭证已生成"
            description={
              <span>
                Token 有效期：<Text strong>{Math.floor(tokenResult.expiresIn / 60)} 分钟</Text>，
                过期时间：<Text strong>{new Date(tokenResult.expiresAt).toLocaleString('zh-CN')}</Text>
              </span>
            }
            style={{ marginBottom: 24 }}
          />

          <Space direction="vertical" style={{ width: '100%' }} size={20}>
            {/* curl */}
            <div>
              <Space style={{ marginBottom: 8 }}>
                <Text strong>使用 curl 安装</Text>
                <Tag color="green">推荐</Tag>
              </Space>
              <div style={CODE_BLOCK_STYLE}>
                {curlCmd}
                <Tooltip title="复制命令">
                  <Button
                    type="text"
                    size="small"
                    icon={<CopyOutlined />}
                    style={{ position: 'absolute', top: 6, right: 6, color: '#aaa' }}
                    onClick={() => copyText(curlCmd, 'curl 命令')}
                    aria-label="复制 curl 安装命令"
                  />
                </Tooltip>
              </div>
            </div>

            {/* wget */}
            <div>
              <Text strong style={{ display: 'block', marginBottom: 8 }}>使用 wget 安装</Text>
              <div style={CODE_BLOCK_STYLE}>
                {wgetCmd}
                <Tooltip title="复制命令">
                  <Button
                    type="text"
                    size="small"
                    icon={<CopyOutlined />}
                    style={{ position: 'absolute', top: 6, right: 6, color: '#aaa' }}
                    onClick={() => copyText(wgetCmd, 'wget 命令')}
                    aria-label="复制 wget 安装命令"
                  />
                </Tooltip>
              </div>
            </div>

            <Alert
              type="warning"
              showIcon
              message="注意"
              description="安装脚本可能需要 sudo 权限。请确保目标服务器已安装 curl 或 wget，且网络可以访问本平台的 API 地址。"
            />
          </Space>

          <Divider />
          <Space>
            <Button icon={<DownloadOutlined />} onClick={handleReset}>重新安装</Button>
            <Button type="primary" onClick={handleGoToStep3}>下一步：等待执行器上线</Button>
          </Space>
        </Card>
      )}

      {/* ── Step 3: 验证执行器上线 ── */}
      {currentStep === 3 && (
        <Card style={{ maxWidth: 720 }}>
          <Title level={5} style={{ marginTop: 0 }}>等待执行器上线</Title>
          <Paragraph type="secondary">
            系统正在自动检测目标服务器上的执行器是否已成功注册并上线，每 3 秒轮询一次，最长等待 2 分钟。
          </Paragraph>

          {/* 轮询中 */}
          {polling && !foundExecutor && !pollTimedOut && (
            <div style={{ textAlign: 'center', padding: '40px 0' }}>
              <Spin size="large" indicator={<SyncOutlined spin style={{ fontSize: 48, color: '#1677ff' }} />} />
              <div style={{ marginTop: 20, color: '#666', fontSize: 15 }}>正在等待执行器上线...</div>
              {pollStartTime && (
                <div style={{ marginTop: 8, color: '#aaa', fontSize: 13 }}>
                  已等待约 {Math.floor((Date.now() - pollStartTime) / 1000)} 秒
                </div>
              )}
            </div>
          )}

          {/* 已上线 */}
          {foundExecutor && (
            <Alert
              type="success"
              showIcon
              icon={<CheckCircleOutlined />}
              message="执行器已成功上线！"
              description={
                <span>
                  检测到执行器：<strong>{foundExecutor.appName}</strong>（{foundExecutor.address}）已注册上线，安装成功。
                </span>
              }
              style={{ marginBottom: 20 }}
            />
          )}

          {/* 超时 */}
          {pollTimedOut && (
            <Alert
              type="warning"
              showIcon
              icon={<CloseCircleOutlined />}
              message="等待超时"
              description="2 分钟内未检测到执行器上线。请检查目标服务器上的安装日志，确认安装命令是否成功执行，或检查网络连通性。"
              style={{ marginBottom: 20 }}
            />
          )}

          <Divider />
          <Space>
            {!foundExecutor && (
              <Button onClick={() => { stopPolling(); setCurrentStep(2); }}>返回上一步</Button>
            )}
            {pollTimedOut && (
              <Button onClick={() => startPolling(Date.now())}>重新检测</Button>
            )}
            <Button
              type="primary"
              onClick={() => navigate('/executors')}
            >
              前往执行器列表
            </Button>
          </Space>
        </Card>
      )}
    </div>
  );
}
