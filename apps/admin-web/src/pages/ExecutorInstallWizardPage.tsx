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
import {
  executorPackagesApi,
  ExecutorPackage,
  InstallTokenResult,
} from '../api/executor-packages';
import { executorsApi, Executor } from '../api/executors';
import { getErrMsg } from '../utils/error';

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

function CodeBlock({ code, label }: { code: string; label: string }) {
  return (
    <div style={CODE_BLOCK_STYLE}>
      <span style={{ whiteSpace: 'pre-wrap' }}>{code}</span>
      <Tooltip title="复制">
        <Button
          type="text"
          size="small"
          icon={<CopyOutlined />}
          style={{ position: 'absolute', top: 6, right: 6, color: '#aaa' }}
          onClick={() =>
            navigator.clipboard
              .writeText(code)
              .then(() => message.success(`已复制 ${label}`))
          }
          aria-label={`复制 ${label}`}
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
  const [currentStep, setCurrentStep] = useState(0);

  const [packages, setPackages] = useState<ExecutorPackage[]>([]);
  const [loadingPackages, setLoadingPackages] = useState(false);
  const [selectedType, setSelectedType] = useState<string | undefined>();
  const [selectedPlatform, setSelectedPlatform] = useState<string | undefined>();
  const [selectedPackage, setSelectedPackage] = useState<ExecutorPackage | null>(null);
  const [tokenResult, setTokenResult] = useState<InstallTokenResult | null>(null);
  const [generatingToken, setGeneratingToken] = useState(false);
  const [sharedToken, setSharedToken] = useState<string | null>(null);
  const [loadingSharedToken, setLoadingSharedToken] = useState(false);
  const [sharedTokenVisible, setSharedTokenVisible] = useState(false);
  const [installScriptUrl, setInstallScriptUrl] = useState('');

  const POLL_INTERVAL_MS = 5000;
  const POLL_TIMEOUT_MS = 60000;
  const [polling, setPolling] = useState(false);
  const [_pollStartTime, setPollStartTime] = useState<number | null>(null);
  const [foundExecutor, setFoundExecutor] = useState<Executor | null>(null);
  const [pollTimedOut, setPollTimedOut] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);

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

  const handleStep1Next = () => {
    if (!matchedPackage) {
      message.warning('请先选择执行器类型和目标平台');
      return;
    }
    setSelectedPackage(matchedPackage);
    setLoadingSharedToken(true);
    import('../api/config')
      .then(({ configApi }) => configApi.getExecutorToken())
      .then((r: any) => setSharedToken(r.token))
      .catch(() => {
        setSharedToken(null);
        message.warning('获取共享 Token 失败，请手动生成');
      })
      .finally(() => setLoadingSharedToken(false));
    setCurrentStep(2);
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
      setCurrentStep(3);
    } catch (err: unknown) {
      message.error(getErrMsg(err, '生成安装凭证失败，请重试'));
    } finally {
      setGeneratingToken(false);
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
    setPollStartTime(now);
    setCurrentStep(4);
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
    setElapsedSeconds(0);
  };

  const curlCmd = installScriptUrl ? `curl -fsSL "${installScriptUrl}" | bash` : '';
  const wgetCmd = installScriptUrl ? `wget -qO- "${installScriptUrl}" | bash` : '';
  const adminApiUrl = window.location.origin;
  const envVarBlock = [
    `ADMIN_API_URL=${adminApiUrl}`,
    `EXECUTOR_TOKEN=${sharedToken ?? '<your-executor-token>'}`,
    `EXECUTOR_NAME=my-executor-1`,
  ].join('\n');

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
        style={{ marginBottom: 32, maxWidth: 900 }}
        items={[
          { title: '系统要求', icon: <DesktopOutlined /> },
          { title: '选择安装包', icon: <DownloadOutlined /> },
          { title: '生成安装凭证', icon: <KeyOutlined /> },
          { title: '执行安装', icon: <CodeOutlined /> },
          { title: '验证上线', icon: <CheckCircleOutlined /> },
        ]}
      />

      {/* Step 0: 系统要求 */}
      {currentStep === 0 && (
        <Card style={{ maxWidth: 720 }}>
          <Title level={5} style={{ marginTop: 0 }}>系统要求</Title>
          <Paragraph type="secondary">
            在开始安装前，请确认目标服务器满足以下要求：
          </Paragraph>

          <div style={{ marginBottom: 20 }}>
            <ReqRow label="Node.js 16+ 或 Python 3.8+" note="根据所选执行器类型" />
            <ReqRow label="Git 2.0+" note="用于克隆仓库和版本管理" />
            <ReqRow label="curl 或 wget" note="用于下载安装脚本" />
            <ReqRow label="网络连接" note={`能访问本平台 API：${adminApiUrl}`} />
            <ReqRow label="sudo 权限（可选）" note="某些系统级安装可能需要" />
          </div>

          <Alert
            type="info"
            showIcon
            message="提示"
            description="安装过程中会自动检测和配置环境，如遇问题请参考文档或联系管理员。"
            style={{ marginBottom: 20 }}
          />

          <Divider />
          <Space>
            <Button onClick={() => navigate('/executors')}>取消</Button>
            <Button type="primary" onClick={() => setCurrentStep(1)}>
              下一步
            </Button>
          </Space>
        </Card>
      )}

      {/* Step 1: 选择安装包 */}
      {currentStep === 1 && (
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
            <Button onClick={() => setCurrentStep(0)}>上一步</Button>
            <Button type="primary" disabled={!matchedPackage} onClick={handleStep1Next}>
              下一步
            </Button>
          </Space>
        </Card>
      )}

      {/* Step 2: 生成安装凭证 */}
      {currentStep === 2 && selectedPackage && (
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

          <Card
            size="small"
            style={{ background: '#fffbe6', border: '1px solid #ffe58f', marginBottom: 20 }}
            title={<Space><KeyOutlined /><Text strong>执行器接入 Token（共享）</Text></Space>}
          >
            <Paragraph type="secondary" style={{ marginBottom: 12 }}>
              执行器启动时需携带此 Token 向调度中心注册。如尚未生成，请先在「系统设置」页面创建。
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
                      message.success('已复制 Token');
                    }}
                  >
                    复制
                  </Button>
                )}
              </Space>
            ) : (
              <Alert
                type="warning"
                showIcon
                message="尚未配置执行器共享 Token，请先前往「系统设置」页面生成 Token 后再安装执行器。"
              />
            )}
          </Card>

          <Divider />
          <Space>
            <Button onClick={() => setCurrentStep(1)}>上一步</Button>
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

      {/* Step 3: 执行安装 */}
      {currentStep === 3 && tokenResult && selectedPackage && (
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
            <div>
              <Space style={{ marginBottom: 8 }}>
                <Text strong>使用 curl 安装</Text>
                <Tag color="green">推荐</Tag>
              </Space>
              <CodeBlock code={curlCmd} label="curl 命令" />
            </div>

            <div>
              <Text strong style={{ display: 'block', marginBottom: 8 }}>使用 wget 安装</Text>
              <CodeBlock code={wgetCmd} label="wget 命令" />
            </div>

            <div>
              <Text strong style={{ display: 'block', marginBottom: 8 }}>环境变量配置参考</Text>
              <Paragraph type="secondary" style={{ marginBottom: 8, fontSize: 13 }}>
                安装脚本会自动配置以下环境变量。如需手动配置或调试，可参考：
              </Paragraph>
              <CodeBlock code={envVarBlock} label="环境变量" />
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
            <Button type="primary" onClick={handleGoToStep4}>下一步：等待执行器上线</Button>
          </Space>
        </Card>
      )}

      {/* Step 4: 验证执行器上线 */}
      {currentStep === 4 && (
        <Card style={{ maxWidth: 720 }}>
          <Title level={5} style={{ marginTop: 0 }}>等待执行器上线</Title>
          <Paragraph type="secondary">
            系统正在自动检测目标服务器上的执行器是否已成功注册并上线，每 5 秒轮询一次，最长等待 1 分钟。
          </Paragraph>

          {polling && !foundExecutor && !pollTimedOut && (
            <div style={{ textAlign: 'center', padding: '40px 0' }}>
              <Spin size="large" indicator={<SyncOutlined spin style={{ fontSize: 48, color: '#1677ff' }} />} />
              <div style={{ marginTop: 20, color: '#666', fontSize: 15 }}>正在等待执行器上线...</div>
              <div style={{ marginTop: 8, color: '#aaa', fontSize: 13 }}>
                已等待 {elapsedSeconds} / 60 秒，每 5 秒检测一次
              </div>
            </div>
          )}

          {foundExecutor && (
            <>
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
<div style={{ textAlign: 'center', padding: '16px 0' }}>
                <CheckCircleOutlined style={{ fontSize: 64, color: '#52c41a' }} />
                <div style={{ marginTop: 12, fontSize: 18, fontWeight: 600, color: '#52c41a' }}>
                  执行器已上线
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
                message="验证超时（60 秒）"
                description="1 分钟内未检测到执行器上线，请参考以下排查步骤。"
                style={{ marginBottom: 20 }}
              />
              <Card size="small" style={{ background: '#fffbe6', border: '1px solid #ffe58f' }}>
                <Title level={5} style={{ marginTop: 0 }}>排查建议</Title>
                <ul style={{ paddingLeft: 20, lineHeight: 2, margin: 0 }}>
                  <li>确认安装命令已在目标服务器上执行完毕，且无报错</li>
                  <li>检查目标服务器网络是否能访问本平台 API 地址</li>
                  <li>安装脚本可能需要 <code>sudo</code> 权限，请以合适权限重试</li>
                  <li>查看执行器进程日志排查启动失败原因</li>
                  <li>确认执行器共享 Token 已正确配置</li>
<li>确认安装凭证 Token 未过期（有效期 1 小时）</li>
                </ul>
              </Card>
            </>
          )}

          <Divider />
          <Space>
            {!foundExecutor && (
              <Button onClick={() => { stopPolling(); setCurrentStep(3); }}>返回上一步</Button>
            )}
            {pollTimedOut && (
              <Button
                onClick={() => {
                  const now = Date.now();
                  setPollStartTime(now);
                  startPolling(now);
                }}
              >
                重新检测
              </Button>
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
