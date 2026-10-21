import * as React from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Globe2,
  Loader2,
  Play,
  Plug,
  Server,
  ShieldCheck,
  Sparkles,
  TerminalSquare,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
import { Switch } from '@/components/ui/switch';
import { bridge } from '@/lib/ipc';
import { t, type I18nKey } from '@/lib/i18n';
import { cn } from '@/lib/utils';

interface WizardForm {
  adminApiUrl: string;
  token: string;
  executorName: string;
  executorHost: string;
  executorPort: number;
  maxConcurrentTasks: number;
  uvPythonInstallMirror: string;
  startAfterSave: boolean;
}

const STEPS = [
  { id: 0, labelKey: 'wizard.step.welcome', icon: Sparkles },
  { id: 1, labelKey: 'wizard.step.connect', icon: Globe2 },
  { id: 2, labelKey: 'wizard.step.executor', icon: Server },
  { id: 3, labelKey: 'wizard.step.python', icon: TerminalSquare },
  { id: 4, labelKey: 'wizard.step.done', icon: ShieldCheck },
] as const satisfies readonly { id: number; labelKey: I18nKey; icon: unknown }[];

const DEFAULT_VALUES: WizardForm = {
  adminApiUrl: 'ws://127.0.0.1:8001',
  token: '',
  executorName: 'executor-local',
  executorHost: '0.0.0.0',
  executorPort: 8001,
  maxConcurrentTasks: 4,
  uvPythonInstallMirror: '',
  startAfterSave: true,
};

const MIRRORS = [
  { id: 'official', labelKey: 'wizard.python.official', url: '' },
  {
    id: 'tuna',
    labelKey: 'wizard.python.tuna',
    url: 'https://mirrors.tuna.tsinghua.edu.cn/github-release/astral-sh/python-build-standalone/',
  },
  {
    id: 'aliyun',
    labelKey: 'wizard.python.aliyun',
    url: 'https://mirrors.aliyun.com/python-build-standalone/',
  },
  { id: 'custom', labelKey: 'wizard.python.custom', url: '' },
] as const;

function StepHeading({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="mb-4">
      <h3 className="text-base font-semibold tracking-[-0.01em]">{title}</h3>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{description}</p>
    </div>
  );
}

function Field({
  label,
  htmlFor,
  hint,
  error,
  action,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: string;
  error?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
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

export function Wizard({
  open,
  onOpenChange,
  standalone = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * 独立向导窗口（V1 的 `#wizard` 窗口）：没有应用壳、没有遮罩，
   * 保存走 `save-and-close-wizard` 而不是 `config:save`。
   */
  standalone?: boolean;
}) {
  const [step, setStep] = React.useState(0);
  const [testing, setTesting] = React.useState(false);
  const [testResult, setTestResult] = React.useState<{
    ok: boolean;
    text: string;
  } | null>(null);
  const [portState, setPortState] = React.useState<{
    ok: boolean;
    text: string;
  } | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [mirrorPreset, setMirrorPreset] = React.useState<string>('official');

  const form = useForm<WizardForm>({ defaultValues: DEFAULT_VALUES, mode: 'onBlur' });
  const { register, handleSubmit, trigger, getValues, setValue, reset, watch, formState } = form;
  const values = watch();

  React.useEffect(() => {
    if (!open) return;
    setStep(0);
    setTestResult(null);
    setPortState(null);
    setMirrorPreset('official');
    (async () => {
      const cfg = await bridge.getConfig();
      reset({
        ...DEFAULT_VALUES,
        adminApiUrl: cfg.adminApiUrl || DEFAULT_VALUES.adminApiUrl,
        executorName: cfg.executorName || DEFAULT_VALUES.executorName,
        executorHost: cfg.executorHost || DEFAULT_VALUES.executorHost,
        executorPort: cfg.executorPort || DEFAULT_VALUES.executorPort,
        maxConcurrentTasks: cfg.maxConcurrentTasks || DEFAULT_VALUES.maxConcurrentTasks,
        uvPythonInstallMirror: cfg.uvPythonInstallMirror || '',
      });
    })();
  }, [open, reset]);

  const STEP_FIELDS: Record<number, (keyof WizardForm)[]> = {
    1: ['adminApiUrl'],
    2: ['executorName', 'executorHost', 'executorPort', 'maxConcurrentTasks'],
  };

  async function next() {
    const fields = STEP_FIELDS[step];
    if (fields && !(await trigger(fields))) return;
    setStep((current) => Math.min(current + 1, STEPS.length - 1));
  }

  async function testConnection() {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await bridge.testConnection(getValues('adminApiUrl'));
      setTestResult({
        ok: res.ok,
        text: res.ok
          ? `${t('config.probe.reachable')} · ${res.latencyMs ?? '—'}ms`
          : res.message ?? t('config.probe.unreachable'),
      });
    } finally {
      setTesting(false);
    }
  }

  async function checkPort() {
    const port = getValues('executorPort');
    const res = await bridge.checkPort(port, getValues('executorHost'));
    setPortState({
      ok: res.available,
      text: res.available ? t('config.probe.available') : res.reason ?? t('config.portInUse'),
    });
  }

  async function finish(data: WizardForm) {
    setSaving(true);
    try {
      const current = await bridge.getConfig();
      const payload = {
        ...current,
        adminApiUrl: data.adminApiUrl,
        executorToken: data.token || current.executorToken,
        hasSavedToken: Boolean(data.token) || current.hasSavedToken,
        executorName: data.executorName,
        executorHost: data.executorHost,
        executorPort: data.executorPort,
        maxConcurrentTasks: data.maxConcurrentTasks,
        uvPythonInstallMirror: data.uvPythonInstallMirror,
        configured: true,
      };
      const res = standalone
        ? await bridge.saveAndCloseWizard(payload)
        : await bridge.saveConfig(payload);
      if (!res.ok) {
        toast.error(t('wizard.saveFailed'), { description: res.message });
        return;
      }
      if (data.startAfterSave) {
        await bridge.startExecutor();
      }
      toast.success(t('wizard.saved'), {
        description: data.startAfterSave ? t('wizard.savedStart') : t('wizard.savedOnly'),
      });
      if (standalone) {
        // 主进程的 save-and-close-wizard 会关窗并唤回主窗；closeWindow 兜底。
        await bridge.closeWindow();
      } else {
        onOpenChange(false);
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} modal={!standalone}>
      <DialogContent
        className={`gap-0 overflow-hidden p-0 ${standalone ? 'max-w-[620px]' : 'max-w-[680px]'}`}
        hideClose={false}
        hideOverlay={standalone}
        disableAnimation={standalone}
      >
        <div className="flex flex-col gap-3 border-b border-border px-6 pt-5 pb-4 pr-12">
          <DialogHeader>
            <DialogTitle className="text-base">{t('wizard.title')}</DialogTitle>
            <DialogDescription>
              {t('wizard.subtitle')}
            </DialogDescription>
          </DialogHeader>

          <div className="flex items-center gap-1.5">
            {STEPS.map((item, index) => {
              const Icon = item.icon;
              const done = index < step;
              const active = index === step;
              return (
                <React.Fragment key={item.id}>
                  <div
                    className={cn(
                      'flex items-center gap-1.5 rounded-full px-2 py-1 text-[11px] transition-colors',
                      active && 'bg-secondary font-medium text-foreground',
                      done && 'text-muted-foreground',
                      !active && !done && 'text-muted-foreground',
                    )}
                  >
                    <span
                      className={cn(
                        'grid size-4 place-items-center rounded-full border text-[9px]',
                        active && 'border-primary bg-primary text-primary-foreground',
                        done && 'border-primary/30 bg-primary/10 text-primary',
                        !active && !done && 'border-border',
                      )}
                    >
                      {done ? <Check className="size-2.5" /> : index + 1}
                    </span>
                    <span className="hidden sm:inline">{t(item.labelKey)}</span>
                    {active ? <Icon className="size-3 sm:hidden" /> : null}
                  </div>
                  {index < STEPS.length - 1 ? (
                    <span className="h-px flex-1 bg-border" aria-hidden />
                  ) : null}
                </React.Fragment>
              );
            })}
          </div>
        </div>

        <div className="max-h-[420px] min-h-[340px] overflow-y-auto px-6 py-5">
          {step === 0 ? (
            <div className="flex flex-col gap-4">
              <StepHeading
                title={t('wizard.welcome.title')}
                description={t('wizard.welcome.desc')}
              />
              <ul className="flex flex-col gap-2.5">
                {[
                  [t('wizard.welcome.b1'), t('wizard.welcome.b1Desc')],
                  [t('wizard.welcome.b2'), t('wizard.welcome.b2Desc')],
                  [t('wizard.welcome.b3'), t('wizard.welcome.b3Desc')],
                ].map(([title, desc]) => (
                  <li key={title} className="flex gap-2.5 rounded-lg border border-border p-3">
                    <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-primary/10 text-[10px] font-semibold text-primary">
                      <Check className="size-3" />
                    </span>
                    <div>
                      <div className="text-sm font-medium">{title}</div>
                      <div className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                        {desc}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {step === 1 ? (
            <div className="flex flex-col gap-4">
              <StepHeading
                title={t('wizard.connect.title')}
                description={t('wizard.connect.desc')}
              />
              <Field
                label={t('config.conn.url')}
                htmlFor="wizard-url"
                error={formState.errors.adminApiUrl?.message}
                action={
                  testResult ? (
                    <Badge variant={testResult.ok ? 'success' : 'danger'}>{testResult.text}</Badge>
                  ) : null
                }
              >
                <div className="flex gap-2">
                  <Input
                    id="wizard-url"
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
                    onClick={testConnection}
                    disabled={testing}
                  >
                    {testing ? <Loader2 className="animate-spin" /> : <Plug />}
                    {t('config.conn.test')}
                  </Button>
                </div>
              </Field>
              <Field
                label={t('config.conn.token')}
                htmlFor="wizard-token"
                hint={t('wizard.connect.tokenHint')}
              >
                <Input
                  id="wizard-token"
                  type="password"
                  autoComplete="off"
                  placeholder={t('wizard.connect.tokenPlaceholder')}
                  {...register('token')}
                />
              </Field>
            </div>
          ) : null}

          {step === 2 ? (
            <div className="flex flex-col gap-4">
              <StepHeading
                title={t('wizard.executor.title')}
                description={t('wizard.executor.desc')}
              />
              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  label={t('config.conn.name')}
                  htmlFor="wizard-name"
                  error={formState.errors.executorName?.message}
                >
                  <Input
                    id="wizard-name"
                    {...register('executorName', {
                      required: t('config.err.required'),
                      maxLength: { value: 64, message: t('config.err.maxLen') },
                    })}
                  />
                </Field>
                <Field
                  label={t('config.conn.concurrency')}
                  htmlFor="wizard-concurrency"
                  error={formState.errors.maxConcurrentTasks?.message}
                >
                  <Input
                    id="wizard-concurrency"
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
              <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_160px]">
                <Field
                  label={t('config.net.host')}
                  htmlFor="wizard-host"
                  error={formState.errors.executorHost?.message}
                >
                  <Input
                    id="wizard-host"
                    className="font-mono text-[12px]"
                    {...register('executorHost', { required: t('config.err.required') })}
                  />
                </Field>
                <Field
                  label={t('config.net.port')}
                  htmlFor="wizard-port"
                  error={formState.errors.executorPort?.message}
                  action={
                    portState ? (
                      <Badge variant={portState.ok ? 'success' : 'danger'}>{portState.text}</Badge>
                    ) : null
                  }
                >
                  <div className="flex gap-2">
                    <Input
                      id="wizard-port"
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
                      onClick={checkPort}
                    >
                      <Plug />
                    </Button>
                  </div>
                </Field>
              </div>
            </div>
          ) : null}

          {step === 3 ? (
            <div className="flex flex-col gap-4">
              <StepHeading
                title={t('wizard.python.title')}
                description={t('wizard.python.desc')}
              />
              <Field label={t('wizard.python.preset')} htmlFor="wizard-mirror-preset">
                <Select
                  value={mirrorPreset}
                  onValueChange={(value) => {
                    setMirrorPreset(value);
                    const preset = MIRRORS.find((item) => item.id === value);
                    if (preset && value !== 'custom') {
                      setValue('uvPythonInstallMirror', preset.url, { shouldDirty: true });
                    }
                  }}
                >
                  <SelectTrigger id="wizard-mirror-preset">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {MIRRORS.map((item) => (
                      <SelectItem key={item.id} value={item.id}>
                        {t(item.labelKey)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field
                label={t('wizard.python.url')}
                htmlFor="wizard-mirror"
                hint={t('wizard.python.urlHint')}
              >
                <Input
                  id="wizard-mirror"
                  spellCheck={false}
                  placeholder="https://…"
                  className="font-mono text-[12px]"
                  {...register('uvPythonInstallMirror')}
                />
              </Field>
              <div className="flex items-start gap-2.5 rounded-lg border border-border bg-secondary/40 p-3">
                <TerminalSquare className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  {t('wizard.python.note')}
                </p>
              </div>
            </div>
          ) : null}

          {step === 4 ? (
            <div className="flex flex-col gap-4">
              <StepHeading
                title={t('wizard.done.title')}
                description={t('wizard.done.desc')}
              />
              <dl className="grid grid-cols-[88px_minmax(0,1fr)] gap-y-2.5 rounded-lg border border-border p-4 text-xs">
                <dt className="text-muted-foreground">{t('wizard.done.controlPlane')}</dt>
                <dd className="truncate font-mono text-[11.5px]">{values.adminApiUrl || '—'}</dd>
                <dt className="text-muted-foreground">{t('wizard.done.executor')}</dt>
                <dd className="truncate">{values.executorName || '—'}</dd>
                <dt className="text-muted-foreground">{t('wizard.done.listen')}</dt>
                <dd className="font-mono text-[11.5px]">
                  {values.executorHost}:{values.executorPort}
                </dd>
                <dt className="text-muted-foreground">{t('wizard.done.concurrency')}</dt>
                <dd className="tabular-nums">{values.maxConcurrentTasks}</dd>
                <dt className="text-muted-foreground">{t('wizard.done.source')}</dt>
                <dd className="truncate font-mono text-[11px] text-muted-foreground">
                  {values.uvPythonInstallMirror || t('wizard.done.officialSource')}
                </dd>
              </dl>
              <label className="flex items-center justify-between gap-4 rounded-lg border border-border px-4 py-3">
                <span>
                  <span className="text-sm">{t('wizard.done.startNow')}</span>
                  <span className="mt-0.5 block text-[11px] text-muted-foreground">
                    {t('wizard.done.startNowDesc')}
                  </span>
                </span>
                <Switch
                  checked={values.startAfterSave}
                  onCheckedChange={(checked) => setValue('startAfterSave', checked)}
                  aria-label={t('wizard.done.startNow')}
                />
              </label>
            </div>
          ) : null}
        </div>

        <Separator />
        <div className="flex items-center gap-2 px-6 py-3">
          <span className="text-[11px] text-muted-foreground">
            {t('wizard.stepOf', { current: step + 1, total: STEPS.length })}
          </span>
          <div className="ml-auto flex items-center gap-2">
            <Button
              variant="ghost"
              onClick={() => setStep((current) => Math.max(0, current - 1))}
              disabled={step === 0 || saving}
            >
              <ChevronLeft />
              {t('wizard.back')}
            </Button>
            {step < STEPS.length - 1 ? (
              <Button onClick={() => void next()}>
                {step === 0 ? t('wizard.begin') : t('wizard.next')}
                <ChevronRight />
              </Button>
            ) : (
              <Button onClick={handleSubmit(finish)} disabled={saving}>
                {saving ? <Loader2 className="animate-spin" /> : <Play />}
                {t('wizard.finish')}
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
