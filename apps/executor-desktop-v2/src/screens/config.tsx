import * as React from 'react';
import { Controller, useForm } from 'react-hook-form';
import { toast } from 'sonner';
import {
  Bot,
  CheckCircle2,
  Download,
  ExternalLink,
  Globe2,
  Info,
  Link2,
  Loader2,
  Plug,
  RefreshCw,
  ShieldAlert,
  TerminalSquare,
  Upload,
  XCircle,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { bridge, type AppConfig, type PythonEnvStatus } from '@/lib/ipc';
import { UpdatePanel } from '@/components/update-panel';
import { t, type I18nKey } from '@/lib/i18n';
import { cn } from '@/lib/utils';

type SectionId = 'connection' | 'network' | 'python' | 'agent' | 'about';

interface ConfigForm {
  adminApiUrl: string;
  executorName: string;
  token: string;
  maxConcurrentTasks: number;
  executorHost: string;
  executorPort: number;
  executorAddressPublic: string;
  pullMode: boolean;
  uvPath: string;
  uvPythonInstallDir: string;
  uvPythonInstallMirror: string;
  interpreterDownloadTimeoutMs: number;
  pypiRegistryUrl: string;
  workDir: string;
  logLevel: 'info' | 'debug' | 'error';
  uiLanguage: 'zh' | 'en' | 'auto';
  autoStartExecutor: boolean;
  notifyEnabled: boolean;
}

const EMPTY_FORM: ConfigForm = {
  adminApiUrl: '',
  executorName: '',
  token: '',
  maxConcurrentTasks: 4,
  executorHost: '0.0.0.0',
  executorPort: 8001,
  executorAddressPublic: '',
  pullMode: false,
  uvPath: '',
  uvPythonInstallDir: '',
  uvPythonInstallMirror: '',
  interpreterDownloadTimeoutMs: 0,
  pypiRegistryUrl: '',
  workDir: '',
  logLevel: 'info',
  uiLanguage: 'auto',
  autoStartExecutor: true,
  notifyEnabled: true,
};

const SECTIONS: {
  id: SectionId;
  labelKey: I18nKey;
  descriptionKey: I18nKey;
  icon: React.ComponentType<{ className?: string }>;
  keys: (keyof ConfigForm)[];
}[] = [
  {
    id: 'connection',
    labelKey: 'config.section.connection',
    descriptionKey: 'config.section.connectionDesc',
    icon: Link2,
    keys: ['adminApiUrl', 'executorName', 'token', 'maxConcurrentTasks'],
  },
  {
    id: 'network',
    labelKey: 'config.section.network',
    descriptionKey: 'config.section.networkDesc',
    icon: Globe2,
    keys: ['executorHost', 'executorPort', 'executorAddressPublic'],
  },
  {
    id: 'python',
    labelKey: 'config.section.python',
    descriptionKey: 'config.section.pythonDesc',
    icon: TerminalSquare,
    keys: [
      'uvPath',
      'uvPythonInstallDir',
      'uvPythonInstallMirror',
      'interpreterDownloadTimeoutMs',
      'pypiRegistryUrl',
      'workDir',
      'logLevel',
    ],
  },
  {
    id: 'agent',
    labelKey: 'config.section.agent',
    descriptionKey: 'config.section.agentDesc',
    icon: Bot,
    keys: [],
  },
  {
    id: 'about',
    labelKey: 'config.section.about',
    descriptionKey: 'config.section.aboutDesc',
    icon: Info,
    keys: ['uiLanguage', 'autoStartExecutor', 'notifyEnabled'],
  },
];

const UV_SOURCE_KEY: Record<PythonEnvStatus['uvSource'], I18nKey> = {
  configured: 'config.py.srcConfigured',
  bundled: 'config.py.srcBundled',
  'system-env': 'config.py.srcSystemEnv',
  path: 'config.py.srcPath',
  missing: 'config.py.srcMissing',
};

function toForm(cfg: AppConfig): ConfigForm {
  return {
    adminApiUrl: cfg.adminApiUrl,
    executorName: cfg.executorName,
    token: '',
    maxConcurrentTasks: cfg.maxConcurrentTasks,
    executorHost: cfg.executorHost,
    executorPort: cfg.executorPort,
    executorAddressPublic: cfg.executorAddressPublic,
    pullMode: cfg.pullMode === true,
    uvPath: cfg.uvPath,
    uvPythonInstallDir: cfg.uvPythonInstallDir,
    uvPythonInstallMirror: cfg.uvPythonInstallMirror,
    interpreterDownloadTimeoutMs: cfg.interpreterDownloadTimeoutMs,
    pypiRegistryUrl: cfg.pypiRegistryUrl,
    workDir: cfg.workDir,
    logLevel: cfg.logLevel,
    uiLanguage: cfg.uiLanguage,
    autoStartExecutor: cfg.autoStartExecutor,
    notifyEnabled: cfg.notifyEnabled,
  };
}

function Field({
  label,
  htmlFor,
  hint,
  error,
  action,
  children,
  className,
}: {
  label: string;
  htmlFor?: string;
  hint?: string;
  error?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <div className="flex min-h-5 items-center justify-between gap-2">
        <Label htmlFor={htmlFor}>{label}</Label>
        {action}
      </div>
      {children}
      {error ? (
        <p className="text-[11px] text-destructive">{error}</p>
      ) : hint ? (
        <p className="text-[11px] leading-relaxed text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

function ProbeBadge({
  state,
  okText,
  failText,
}: {
  state: { status: 'idle' | 'testing' | 'ok' | 'fail'; detail?: string };
  okText: string;
  failText: string;
}) {
  if (state.status === 'testing') {
    return (
      <Badge variant="muted">
        <Loader2 className="size-3 animate-spin" />
        {t('config.probe.testing')}
      </Badge>
    );
  }
  if (state.status === 'ok') {
    return (
      <Badge variant="success">
        <CheckCircle2 className="size-3" />
        {okText}
        {state.detail ? <span className="opacity-70">· {state.detail}</span> : null}
      </Badge>
    );
  }
  if (state.status === 'fail') {
    return (
      <Badge variant="danger">
        <XCircle className="size-3" />
        {state.detail || failText}
      </Badge>
    );
  }
  return null;
}

export function ConfigScreen({ onOpenWizard }: { onOpenWizard: () => void }) {
  const [section, setSection] = React.useState<SectionId>('connection');
  const [origin, setOrigin] = React.useState<AppConfig | null>(null);
  const [loaded, setLoaded] = React.useState(false);
  const [ioBusy, setIoBusy] = React.useState<'export' | 'import' | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [baseline, setBaseline] = React.useState<ConfigForm>(EMPTY_FORM);
  const [autoLaunch, setAutoLaunch] = React.useState(false);
  const [envStatus, setEnvStatus] = React.useState<PythonEnvStatus | null>(null);
  const [testing, setTesting] = React.useState<{
    status: 'idle' | 'testing' | 'ok' | 'fail';
    detail?: string;
  }>({ status: 'idle' });
  const [port, setPort] = React.useState<{
    status: 'idle' | 'testing' | 'ok' | 'fail';
    detail?: string;
  }>({ status: 'idle' });

  const form = useForm<ConfigForm>({ defaultValues: EMPTY_FORM, mode: 'onBlur' });
  const { register, control, handleSubmit, reset, watch, getValues, formState } = form;
  const values = watch();

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      const [cfg, env, launch] = await Promise.all([
        bridge.getConfig(),
        bridge.getPythonEnvStatus(),
        bridge.getAutoLaunch(),
      ]);
      if (cancelled) return;
      setOrigin(cfg);
      setEnvStatus(env);
      setAutoLaunch(launch);
      const next = toForm(cfg);
      reset(next);
      setBaseline(next);
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [reset]);

  const keys = Object.keys(values) as (keyof ConfigForm)[];
  const changedKeys = loaded
    ? keys.filter((key) => values[key] !== baseline[key])
    : [];
  const dirty = changedKeys.length > 0;

  const sectionDirty = (id: SectionId) => {
    const item = SECTIONS.find((s) => s.id === id);
    return item ? item.keys.some((key) => changedKeys.includes(key)) : false;
  };

  async function exportConfig() {
    setIoBusy('export');
    try {
      const res = await bridge.exportConfig();
      if (res.canceled) return;
      if (!res.ok) {
        toast.error(t('config.io.failed'), { description: res.error ?? res.message });
        return;
      }
      toast.success(t('config.io.exported'), { description: res.path });
    } finally {
      setIoBusy(null);
    }
  }

  async function importConfig() {
    setIoBusy('import');
    try {
      const res = await bridge.importConfig();
      if (res.canceled) return;
      if (!res.ok) {
        toast.error(t('config.io.importFailed'), { description: res.error ?? res.message });
        return;
      }
      const cfg = await bridge.getConfig();
      const next = toForm(cfg);
      setOrigin(cfg);
      reset(next);
      setBaseline(next);
      toast.success(t('config.io.imported'));
    } finally {
      setIoBusy(null);
    }
  }

  async function onSubmit(data: ConfigForm) {
    if (!origin) return;
    setSaving(true);
    try {
      const res = await bridge.saveConfig({
        ...origin,
        ...data,
        // 令牌留空 = 保持原值；只有用户真的输入了新令牌才覆盖。
        executorToken: data.token || origin.executorToken,
        hasSavedToken: Boolean(data.token) || origin.hasSavedToken,
        configured: true,
      });
      if (!res.ok) {
        toast.error(t('config.saveFailed'), { description: res.message });
        return;
      }
      const languageChanged = data.uiLanguage !== origin.uiLanguage;
      const next = { ...data, token: '' };
      reset(next);
      setBaseline(next);
      setOrigin((prev) =>
        prev
          ? {
              ...prev,
              ...data,
              executorToken: data.token || prev.executorToken,
              hasSavedToken: Boolean(data.token) || prev.hasSavedToken,
            }
          : prev,
      );
      toast.success(t('config.saved'), { description: t('config.savedDesc') });
      if (languageChanged) {
        // 与 V1 同口径：界面语言不做热切换，保存后重载窗口。
        window.setTimeout(() => window.location.reload(), 350);
      }
    } catch (err) {
      toast.error(t('config.saveFailed'), {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSaving(false);
    }
  }

  async function runConnectionTest() {
    setTesting({ status: 'testing' });
    const url = getValues('adminApiUrl');
    const res = await bridge.testConnection(url);
    setTesting(
      res.ok
        ? { status: 'ok', detail: res.latencyMs ? `${res.latencyMs}ms` : undefined }
        : { status: 'fail', detail: res.message },
    );
  }

  async function runPortCheck() {
    setPort({ status: 'testing' });
    const res = await bridge.checkPort(getValues('executorPort'), getValues('executorHost'));
    setPort(
      res.available
        ? { status: 'ok' }
        : { status: 'fail', detail: res.reason ?? t('config.portInUse') },
    );
  }

  async function toggleAutoLaunch(next: boolean) {
    setAutoLaunch(next);
    const res = await bridge.setAutoLaunch(next);
    if (!res.ok) {
      setAutoLaunch(!next);
      toast.error(t('config.autoLaunchFailed'), { description: res.message });
      return;
    }
    toast(next ? t('config.autoLaunchOn') : t('config.autoLaunchOff'));
  }

  if (!loaded) {
    return (
      <div className="mx-auto flex w-full max-w-[1180px] flex-col gap-4 p-4 md:p-5">
        <Skeleton className="h-7 w-32" />
        <Skeleton className="h-4 w-80" />
        <div className="mt-2 grid gap-4 lg:grid-cols-[176px_minmax(0,1fr)]">
          <Skeleton className="hidden h-56 lg:block" />
          <Skeleton className="h-96" />
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-[1180px] flex-col gap-4 p-4 md:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-[-0.02em]">{t('config.title')}</h1>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t('config.subtitle')}
          </p>
        </div>
        <Button variant="outline" onClick={onOpenWizard}>
          <RefreshCw />
          {t('config.rerun')}
        </Button>
      </div>

      <div className="grid items-start gap-4 lg:grid-cols-[176px_minmax(0,1fr)]">
        <nav className="flex gap-1 overflow-x-auto pb-1 lg:sticky lg:top-0 lg:flex-col lg:overflow-visible lg:pb-0">
          {SECTIONS.map((item) => {
            const Icon = item.icon;
            const active = section === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setSection(item.id)}
                className={cn(
                  'flex h-8 shrink-0 items-center gap-2 rounded-md px-2.5 text-left text-xs transition-colors',
                  active
                    ? 'bg-secondary font-medium text-foreground'
                    : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                )}
              >
                <Icon className={cn('size-3.5', active && 'text-primary')} />
                <span className="whitespace-nowrap">{t(item.labelKey)}</span>
                {sectionDirty(item.id) ? (
                  <span className="ml-auto size-1.5 rounded-full bg-amber-500" />
                ) : null}
              </button>
            );
          })}
        </nav>

        <div className="flex min-w-0 max-w-[860px] flex-col gap-3">
          {section === 'connection' ? (
            <Card className="py-0">
              <CardHeader className="px-5 py-4">
                <div>
                  <CardTitle>{t('config.conn.title')}</CardTitle>
                  <CardDescription>{t('config.conn.desc')}</CardDescription>
                </div>
              </CardHeader>
              <Separator />
              <CardContent className="flex flex-col gap-4 px-5 py-4">
                <Field
                  label={t('config.conn.url')}
                  htmlFor="adminApiUrl"
                  error={formState.errors.adminApiUrl?.message}
                  hint={t('config.conn.urlHint')}
                  action={<ProbeBadge state={testing} okText={t('config.probe.reachable')} failText={t('config.probe.unreachable')} />}
                >
                  <div className="flex gap-2">
                    <Input
                      id="adminApiUrl"
                      spellCheck={false}
                      className="font-mono text-[12px]"
                      {...register('adminApiUrl', {
                        required: t('config.err.required'),
                        pattern: {
                          value: /^(wss?|https?):\/\/.+/,
                          message: t('config.err.badUrl'),
                        },
                      })}
                    />
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={runConnectionTest}
                      disabled={testing.status === 'testing'}
                    >
                      <Plug />
                      {t('config.conn.test')}
                    </Button>
                  </div>
                </Field>

                <div className="grid gap-4 sm:grid-cols-2">
                  <Field
                    label={t('config.conn.name')}
                    htmlFor="executorName"
                    error={formState.errors.executorName?.message}
                    hint={t('config.conn.nameHint')}
                  >
                    <Input
                      id="executorName"
                      {...register('executorName', {
                        required: t('config.err.required'),
                        maxLength: { value: 64, message: t('config.err.maxLen') },
                      })}
                    />
                  </Field>

                  <Field
                    label={t('config.conn.concurrency')}
                    htmlFor="maxConcurrentTasks"
                    error={formState.errors.maxConcurrentTasks?.message}
                    hint={t('config.conn.concurrencyHint')}
                  >
                    <Input
                      id="maxConcurrentTasks"
                      type="number"
                      inputMode="numeric"
                      className="max-w-[140px]"
                      {...register('maxConcurrentTasks', {
                        valueAsNumber: true,
                        min: { value: 1, message: t('config.err.minOne') },
                        max: { value: 64, message: t('config.err.max64') },
                        validate: (v) => Number.isInteger(v) || t('config.err.integer'),
                      })}
                    />
                  </Field>
                </div>

                <Field
                  label={t('config.conn.token')}
                  htmlFor="token"
                  error={formState.errors.token?.message}
                  hint={
                    origin?.hasSavedToken
                      ? t('config.conn.tokenSaved')
                      : t('config.conn.tokenFirst')
                  }
                >
                  <Input
                    id="token"
                    type="password"
                    autoComplete="off"
                    placeholder={
                      origin?.hasSavedToken
                        ? `•••••••••••• ${t('config.conn.tokenPlaceholderSaved')}`
                        : t('config.conn.tokenPlaceholder')
                    }
                    {...register('token')}
                  />
                </Field>
              </CardContent>
            </Card>
          ) : null}

          {section === 'network' ? (
            <Card className="py-0">
              <CardHeader className="px-5 py-4">
                <div>
                  <CardTitle>{t('config.net.title')}</CardTitle>
                  <CardDescription>
                    {t('config.net.desc')}
                  </CardDescription>
                </div>
              </CardHeader>
              <Separator />
              <CardContent className="flex flex-col gap-4 px-5 py-4">
                <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_160px]">
                  <Field
                    label={t('config.net.host')}
                    htmlFor="executorHost"
                    error={formState.errors.executorHost?.message}
                    hint={t('config.net.hostHint')}
                  >
                    <Input
                      id="executorHost"
                      className="font-mono text-[12px]"
                      {...register('executorHost', { required: t('config.err.required') })}
                    />
                  </Field>

                  <Field
                    label={t('config.net.port')}
                    htmlFor="executorPort"
                    error={formState.errors.executorPort?.message}
                    action={<ProbeBadge state={port} okText={t('config.probe.available')} failText={t('config.probe.inUse')} />}
                  >
                    <div className="flex gap-2">
                      <Input
                        id="executorPort"
                        type="number"
                        inputMode="numeric"
                        className="font-mono text-[12px]"
                        {...register('executorPort', {
                          valueAsNumber: true,
                          min: { value: 1, message: t('config.err.portRange') },
                          max: { value: 65535, message: t('config.err.portRange') },
                          validate: (v) => Number.isInteger(v) || t('config.err.portRequired'),
                        })}
                      />
                      <Button
                        type="button"
                        variant="secondary"
                        size="icon"
                        aria-label={t('config.net.detect')}
                        onClick={runPortCheck}
                      >
                        <Plug />
                      </Button>
                    </div>
                  </Field>
                </div>

                <Field
                  label={t('config.net.public')}
                  htmlFor="executorAddressPublic"
                  hint={t('config.net.publicHint')}
                >
                  <Input
                    id="executorAddressPublic"
                    placeholder={t('config.net.publicPlaceholder')}
                    className="font-mono text-[12px]"
                    {...register('executorAddressPublic')}
                  />
                </Field>

                <div className="flex items-center justify-between gap-4 rounded-lg border border-border px-3 py-2.5">
                  <div>
                    <div className="text-sm">{t('config.net.pullTitle')}</div>
                    <div className="text-[11px] leading-relaxed text-muted-foreground">
                      {t('config.net.pullDesc')}
                    </div>
                  </div>
                  <Controller
                    control={control}
                    name="pullMode"
                    render={({ field }) => (
                      <Switch
                        checked={field.value}
                        onCheckedChange={field.onChange}
                        aria-label={t('config.net.pullLabel')}
                      />
                    )}
                  />
                </div>
              </CardContent>
            </Card>
          ) : null}

          {section === 'python' ? (
            <>
              <Card className="py-0">
                <CardHeader className="px-5 py-4">
                  <div>
                    <CardTitle>{t('config.py.diagTitle')}</CardTitle>
                    <CardDescription>
                      {t('config.py.diagDesc')}
                    </CardDescription>
                  </div>
                  {envStatus ? (
                    <Badge variant={envStatus.uvSource === 'missing' ? 'danger' : 'success'}>
                      {envStatus.uvSource === 'missing' ? t('config.py.missing') : t('config.py.ready')}
                    </Badge>
                  ) : null}
                </CardHeader>
                <Separator />
                <CardContent className="px-5 py-4">
                  {envStatus ? (
                    <dl className="grid grid-cols-[88px_minmax(0,1fr)] gap-y-2 text-xs">
                      <dt className="text-muted-foreground">{t('config.py.uvPath')}</dt>
                      <dd className="truncate font-mono text-[11.5px] text-secondary-foreground">
                        {envStatus.uvPath ?? '—'}
                      </dd>
                      <dt className="text-muted-foreground">{t('config.py.source')}</dt>
                      <dd>{t(UV_SOURCE_KEY[envStatus.uvSource])}</dd>
                      <dt className="text-muted-foreground">{t('config.py.pool')}</dt>
                      <dd className="flex flex-wrap gap-1">
                        {envStatus.poolEntries.length > 0 ? (
                          envStatus.poolEntries.map((entry) => (
                            <Badge key={entry} variant="secondary" className="font-mono">
                              {entry}
                            </Badge>
                          ))
                        ) : (
                          <span className="text-muted-foreground">{t('config.py.poolEmpty')}</span>
                        )}
                      </dd>
                      <dt className="text-muted-foreground">{t('config.py.mirror')}</dt>
                      <dd className="text-muted-foreground">
                        {envStatus.mirrorConfigured ? t('config.py.mirrorOn') : t('config.py.mirrorOff')}
                      </dd>
                    </dl>
                  ) : null}
                </CardContent>
              </Card>

              <Card className="py-0">
                <CardHeader className="px-5 py-4">
                  <div>
                    <CardTitle>{t('config.py.title')}</CardTitle>
                    <CardDescription>
                      {t('config.py.desc')}
                    </CardDescription>
                  </div>
                </CardHeader>
                <Separator />
                <CardContent className="flex flex-col gap-4 px-5 py-4">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label={t('config.py.uvBin')} htmlFor="uvPath" hint={t('config.py.uvBinHint')}>
                      <Input
                        id="uvPath"
                        placeholder="/usr/local/bin/uv"
                        className="font-mono text-[12px]"
                        {...register('uvPath')}
                      />
                    </Field>
                    <Field label={t('config.py.uvDir')} htmlFor="uvPythonInstallDir" hint={t('config.py.uvDirHint')}>
                      <Input
                        id="uvPythonInstallDir"
                        className="font-mono text-[12px]"
                        {...register('uvPythonInstallDir')}
                      />
                    </Field>
                  </div>

                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field
                      label={t('config.py.uvMirror')}
                      htmlFor="uvPythonInstallMirror"
                      hint={t('config.py.uvMirrorHint')}
                    >
                      <Input
                        id="uvPythonInstallMirror"
                        placeholder={t('config.py.uvMirrorPlaceholder')}
                        className="font-mono text-[12px]"
                        {...register('uvPythonInstallMirror')}
                      />
                    </Field>
                    <Field
                      label={t('config.py.pypi')}
                      htmlFor="pypiRegistryUrl"
                      error={formState.errors.pypiRegistryUrl?.message}
                      hint={t('config.py.pypiHint')}
                    >
                      <Input
                        id="pypiRegistryUrl"
                        placeholder={t('config.py.pypiPlaceholder')}
                        className="font-mono text-[12px]"
                        {...register('pypiRegistryUrl', {
                          validate: (v) =>
                            !v || /^https?:\/\/.+/.test(v) || t('config.py.pypiInvalid'),
                        })}
                      />
                    </Field>
                  </div>

                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field
                      label={t('config.py.timeout')}
                      htmlFor="interpreterDownloadTimeoutMs"
                      error={formState.errors.interpreterDownloadTimeoutMs?.message}
                      hint={t('config.py.timeoutHint')}
                    >
                      <div className="flex items-center gap-2">
                        <Input
                          id="interpreterDownloadTimeoutMs"
                          type="number"
                          inputMode="numeric"
                          className="max-w-[160px] font-mono text-[12px]"
                          {...register('interpreterDownloadTimeoutMs', {
                            valueAsNumber: true,
                            min: { value: 0, message: t('config.py.timeoutMin') },
                          })}
                        />
                        <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">{t('config.py.ms')}</span>
                      </div>
                    </Field>
                    <Field label={t('config.py.workDir')} htmlFor="workDir" hint={t('config.py.workDirHint')}>
                      <Input
                        id="workDir"
                        className="font-mono text-[12px]"
                        {...register('workDir', { required: t('config.err.required') })}
                      />
                    </Field>
                  </div>

                  <Field label={t('config.py.logLevel')} htmlFor="logLevel" hint={t('config.py.logLevelHint')}>
                    <Controller
                      control={control}
                      name="logLevel"
                      render={({ field }) => (
                        <Select value={field.value} onValueChange={field.onChange}>
                          <SelectTrigger id="logLevel" className="sm:w-56">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="info">{t('config.py.logInfo')}</SelectItem>
                            <SelectItem value="debug">debug</SelectItem>
                            <SelectItem value="error">error</SelectItem>
                          </SelectContent>
                        </Select>
                      )}
                    />
                  </Field>
                </CardContent>
              </Card>
            </>
          ) : null}

          {section === 'agent' ? (
            <Card className="py-0">
              <CardHeader className="px-5 py-4">
                <div>
                  <CardTitle className="flex items-center gap-2">
                    {t('config.agent.title')}
                    <Badge variant="warning">{t('config.agent.badge')}</Badge>
                  </CardTitle>
                  <CardDescription>
                    {t('config.agent.desc')}
                  </CardDescription>
                </div>
              </CardHeader>
              <Separator />
              <CardContent className="flex flex-col gap-4 px-5 py-4">
                <div className="flex items-start gap-3 rounded-lg border border-amber-600/20 bg-amber-500/8 p-3">
                  <ShieldAlert className="mt-px size-4 shrink-0 text-amber-600" />
                  <p className="text-xs leading-relaxed text-secondary-foreground">
                    {t('config.agent.warning')}
                  </p>
                </div>
                <div className="flex items-center justify-between gap-4 rounded-lg border border-border px-3 py-2.5">
                  <div>
                    <div className="text-sm">{t('config.agent.enable')}</div>
                    <div className="text-[11px] text-muted-foreground">
                      {t('config.agent.state')}
                    </div>
                  </div>
                  <Switch disabled aria-label={t('config.agent.enable')} />
                </div>
                <Button variant="outline" size="sm" className="w-fit">
                  <ExternalLink />
                  {t('config.agent.docs')}
                </Button>
              </CardContent>
            </Card>
          ) : null}

          {section === 'about' ? (
            <>
              <Card className="py-0">
                <CardHeader className="px-5 py-4">
                  <div>
                    <CardTitle>{t('config.about.general')}</CardTitle>
                    <CardDescription>{t('config.about.generalDesc')}</CardDescription>
                  </div>
                </CardHeader>
                <Separator />
                <CardContent className="flex flex-col gap-1 px-5 py-2">
                  <div className="flex items-center justify-between gap-4 py-2.5">
                    <div>
                      <div className="text-sm">{t('config.about.autoLaunch')}</div>
                      <div className="text-[11px] text-muted-foreground">{t('config.about.autoLaunchDesc')}</div>
                    </div>
                    <Switch
                      checked={autoLaunch}
                      onCheckedChange={toggleAutoLaunch}
                      aria-label={t('config.about.autoLaunch')}
                    />
                  </div>
                  <Separator />
                  <div className="flex items-center justify-between gap-4 py-2.5">
                    <div>
                      <div className="text-sm">{t('config.about.autoExecutor')}</div>
                      <div className="text-[11px] text-muted-foreground">
                        {t('config.about.autoExecutorDesc')}
                      </div>
                    </div>
                    <Controller
                      control={control}
                      name="autoStartExecutor"
                      render={({ field }) => (
                        <Switch
                          checked={field.value}
                          onCheckedChange={field.onChange}
                          aria-label={t('config.about.autoExecutor')}
                        />
                      )}
                    />
                  </div>
                  <Separator />
                  <div className="flex items-center justify-between gap-4 py-2.5">
                    <div>
                      <div className="text-sm">{t('config.about.notify')}</div>
                      <div className="text-[11px] text-muted-foreground">
                        {t('config.about.notifyDesc')}
                      </div>
                    </div>
                    <Controller
                      control={control}
                      name="notifyEnabled"
                      render={({ field }) => (
                        <Switch
                          checked={field.value}
                          onCheckedChange={field.onChange}
                          aria-label={t('config.about.notify')}
                        />
                      )}
                    />
                  </div>
                  <Separator />
                  <div className="flex flex-wrap items-center justify-between gap-4 py-2.5">
                    <div>
                      <div className="text-sm">{t('config.io.title')}</div>
                      <div className="text-[11px] text-muted-foreground">{t('config.io.desc')}</div>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={ioBusy !== null}
                        onClick={() => void exportConfig()}
                      >
                        <Download />
                        {t('config.io.export')}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={ioBusy !== null}
                        onClick={() => void importConfig()}
                      >
                        <Upload />
                        {t('config.io.import')}
                      </Button>
                    </div>
                  </div>
                  <Separator />
                  <div className="flex items-center justify-between gap-4 py-2.5">
                    <div>
                      <div className="text-sm">{t('config.about.language')}</div>
                      <div className="text-[11px] text-muted-foreground">{t('config.about.languageDesc')}</div>
                    </div>
                    <Controller
                      control={control}
                      name="uiLanguage"
                      render={({ field }) => (
                        <Select value={field.value} onValueChange={field.onChange}>
                          <SelectTrigger className="w-36" aria-label={t('config.about.language')}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="auto">{t('config.about.langAuto')}</SelectItem>
                            <SelectItem value="zh">{t('config.about.langZh')}</SelectItem>
                            <SelectItem value="en">{t('config.about.langEn')}</SelectItem>
                          </SelectContent>
                        </Select>
                      )}
                    />
                  </div>
                </CardContent>
              </Card>

              <Card className="py-0">
                <CardContent className="flex flex-col gap-3 px-5 py-4">
                  <UpdatePanel />
                  <Separator />
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      variant="outline"
                      onClick={async () => {
                        const res = await bridge.exportDiagnostics();
                        if (res.ok) toast.success(t('config.diagExported'), { description: res.path });
                        else toast.error(t('config.diagFailed'), { description: res.message });
                      }}
                    >
                      <Download />
                      {t('config.about.diagnostics')}
                    </Button>
                    <span className="ml-auto text-[11px] text-muted-foreground">
                      {t('config.about.diagnosticsHint')}
                    </span>
                  </div>
                </CardContent>
              </Card>
            </>
          ) : null}

          {dirty ? (
            <div className="sticky bottom-0 z-10 flex items-center gap-3 rounded-xl border border-border bg-card/95 px-4 py-2.5 shadow-lg backdrop-blur">
              <span className="text-xs">
                {t('config.dirty', { count: changedKeys.length })}
              </span>
              <div className="ml-auto flex items-center gap-2">
                <Button variant="ghost" size="sm" onClick={() => reset(baseline)}>
                  {t('config.discard')}
                </Button>
                <Button size="sm" onClick={handleSubmit(onSubmit)} disabled={saving}>
                  {saving ? <Loader2 className="animate-spin" /> : null}
                  {saving ? t('config.saving') : t('config.save')}
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
