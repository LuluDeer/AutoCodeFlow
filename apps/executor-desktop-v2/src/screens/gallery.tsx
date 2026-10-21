import * as React from 'react';
import { ArrowRight, Copy, Loader2, Plus, Search, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Segmented } from '@/components/ui/segmented';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { EmptyState } from '@/components/empty-state';

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2.5">
      <div className="flex items-baseline gap-2">
        <h2 className="text-sm font-semibold tracking-[-0.01em]">{title}</h2>
        {hint ? <span className="text-[11px] text-muted-foreground">{hint}</span> : null}
      </div>
      {children}
    </section>
  );
}

export function GalleryScreen() {
  const [busy, setBusy] = React.useState(false);
  const [checked, setChecked] = React.useState(true);
  const [concurrency, setConcurrency] = React.useState('4');

  function fakeSave() {
    setBusy(true);
    window.setTimeout(() => {
      setBusy(false);
      toast.success('配置已保存', { description: '新的解释器源会在下一次任务生效。' });
    }, 900);
  }

  return (
    <div className="mx-auto flex w-full max-w-[1180px] flex-col gap-7 p-4 md:p-5">
      <div>
        <h1 className="text-xl font-semibold tracking-[-0.02em]">组件画廊</h1>
        <p className="mt-0.5 max-w-[70ch] text-xs leading-relaxed text-muted-foreground">
          V2 的视觉合同：所有状态（默认 / hover / focus / disabled / loading / 空态）都在这一页并排可见。
          改样式先看这里，再看业务页，避免像 V1 那样在 pages.css 里各写各的。
        </p>
      </div>

      <Section title="按钮" hint="高度 32 / 28 / 36，字号 13，圆角 8">
        <Card>
          <CardContent className="flex flex-wrap items-center gap-2">
            <Button>保存配置</Button>
            <Button variant="secondary">次要操作</Button>
            <Button variant="outline">描边</Button>
            <Button variant="ghost">Ghost</Button>
            <Button variant="destructive">
              <Trash2 />
              删除
            </Button>
            <Button variant="link">了解更多</Button>
            <Separator orientation="vertical" className="mx-1 h-6" />
            <Button size="sm">Small</Button>
            <Button size="lg">Large</Button>
            <Button size="icon" variant="outline" aria-label="搜索">
              <Search />
            </Button>
            <Separator orientation="vertical" className="mx-1 h-6" />
            <Button disabled>禁用</Button>
            <Button disabled>
              <Loader2 className="animate-spin" />
              处理中
            </Button>
            <Button variant="outline" onClick={fakeSave} disabled={busy}>
              {busy ? <Loader2 className="animate-spin" /> : <Plus />}
              {busy ? '保存中…' : '触发一次 Toast'}
            </Button>
          </CardContent>
        </Card>
      </Section>

      <Section title="徽章" hint="状态色只表达结果，不表达身份">
        <Card>
          <CardContent className="flex flex-wrap items-center gap-2">
            <Badge>默认</Badge>
            <Badge variant="secondary">次级</Badge>
            <Badge variant="outline">中性</Badge>
            <Badge variant="success">
              <span className="size-1.5 rounded-full bg-primary" />
              在线
            </Badge>
            <Badge variant="info">运行中</Badge>
            <Badge variant="warning">等待中</Badge>
            <Badge variant="danger">失败</Badge>
            <Badge variant="muted">已停止</Badge>
          </CardContent>
        </Card>
      </Section>

      <Section title="表单" hint="标签 12px，控件 32px，帮助文本 11px">
        <div className="grid gap-3 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>连接设置</CardTitle>
              <CardDescription>这些改动即时生效，不需要重启。</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3.5">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="url">控制面地址</Label>
                <Input id="url" defaultValue="ws://127.0.0.1:8001" spellCheck={false} />
                <p className="text-[11px] text-muted-foreground">
                  支持 ws:// 与 wss://，保存前会自动探测可达性。
                </p>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="mirror">解释器镜像源</Label>
                <Select defaultValue="official">
                  <SelectTrigger id="mirror">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="official">官方源（需外网）</SelectItem>
                    <SelectItem value="tsinghua">清华 TUNA</SelectItem>
                    <SelectItem value="aliyun">阿里云</SelectItem>
                    <SelectItem value="custom">自定义…</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="bad">错误态</Label>
                <Input id="bad" aria-invalid defaultValue="not-a-url" />
                <p className="text-[11px] text-destructive">地址必须以 ws:// 或 wss:// 开头。</p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>开关与分段</CardTitle>
              <CardDescription>即时生效项在右侧标注「即时」。</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <label className="flex items-start justify-between gap-4">
                <span className="flex flex-col gap-0.5">
                  <span className="text-sm">开机自启</span>
                  <span className="text-[11px] text-muted-foreground">登录系统后自动拉起执行器</span>
                </span>
                <Switch checked={checked} onCheckedChange={setChecked} />
              </label>
              <Separator />
              <div className="flex items-center justify-between">
                <div className="flex flex-col gap-0.5">
                  <span className="text-sm">并发上限</span>
                  <span className="text-[11px] text-muted-foreground">同时执行的任务数</span>
                </div>
                <Segmented
                  label="Concurrency"
                  value={concurrency}
                  onValueChange={setConcurrency}
                  options={[
                    { value: '2', label: '2' },
                    { value: '4', label: '4' },
                    { value: '8', label: '8' },
                  ]}
                />
              </div>
              <Separator />
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between text-[11px]">
                  <span className="text-muted-foreground">解释器池占用</span>
                  <span className="tabular-nums">3 / 8</span>
                </div>
                <Progress value={37.5} aria-label="Interpreter pool usage" />
              </div>
            </CardContent>
          </Card>
        </div>
      </Section>

      <Section title="弹层" hint="焦点锁定、Esc 关闭、点击遮罩关闭">
        <Card>
          <CardContent className="flex flex-wrap items-center gap-2">
            <Dialog>
              <DialogTrigger asChild>
                <Button variant="outline">打开对话框</Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>要清空执行历史吗？</DialogTitle>
                  <DialogDescription>
                    这会删除本地 128 条执行记录与对应日志文件，无法撤销。控制面侧的记录不受影响。
                  </DialogDescription>
                </DialogHeader>
                <DialogFooter>
                  <DialogClose asChild>
                    <Button variant="ghost">取消</Button>
                  </DialogClose>
                  <DialogClose asChild>
                    <Button variant="destructive">清空</Button>
                  </DialogClose>
                </DialogFooter>
              </DialogContent>
            </Dialog>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="outline">悬停看 Tooltip</Button>
              </TooltipTrigger>
              <TooltipContent>提示文案保持在 12 字以内</TooltipContent>
            </Tooltip>

            <Button
              variant="outline"
              onClick={() => toast('已复制诊断信息', { description: '可直接粘贴到 issue 里。' })}
            >
              <Copy />
              触发 Toast
            </Button>

            <Button
              variant="outline"
              onClick={() =>
                toast.error('连接失败', {
                  description: 'ECONNREFUSED 127.0.0.1:8001 · 已重试 3 次',
                  action: { label: '重试', onClick: () => toast('正在重试…') },
                })
              }
            >
              触发错误 Toast
            </Button>
          </CardContent>
        </Card>
      </Section>

      <Section title="数据展示" hint="等宽数字，行高 32，表头 11px 大写">
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
          <Card className="py-0">
            <CardHeader className="px-4 py-3">
              <CardTitle className="text-xs">最近执行</CardTitle>
              <Badge variant="muted">共 128 条</Badge>
            </CardHeader>
            <Separator />
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-[10px] tracking-[0.06em] text-muted-foreground uppercase">
                  <th className="px-4 py-2 font-medium">任务</th>
                  <th className="px-2 py-2 font-medium">状态</th>
                  <th className="px-2 py-2 text-right font-medium">耗时</th>
                  <th className="px-4 py-2 text-right font-medium">时间</th>
                </tr>
              </thead>
              <tbody>
                {[
                  ['日报汇总', 'failed', '7.4s', '10:43'],
                  ['库存同步', 'ok', '1.2s', '10:43'],
                  ['订单对账', 'ok', '842ms', '10:41'],
                  ['发票归档', 'running', '3.1s', '10:40'],
                ].map(([name, status, dur, at]) => (
                  <tr key={String(name)} className="border-t border-border/70 hover:bg-accent/50">
                    <td className="px-4 py-2">{name}</td>
                    <td className="px-2 py-2">
                      <Badge
                        variant={
                          status === 'ok' ? 'success' : status === 'failed' ? 'danger' : 'info'
                        }
                      >
                        {status === 'ok' ? '成功' : status === 'failed' ? '失败' : '运行中'}
                      </Badge>
                    </td>
                    <td className="px-2 py-2 text-right font-mono text-[11px]">{dur}</td>
                    <td className="px-4 py-2 text-right font-mono text-[11px] text-muted-foreground">
                      {at}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          <Card className="py-0">
            <CardHeader className="px-4 py-3">
              <CardTitle className="text-xs">加载与空态</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <div className="flex flex-col gap-2">
                <Skeleton className="h-3 w-2/3" />
                <Skeleton className="h-3 w-1/2" />
                <Skeleton className="h-3 w-5/6" />
              </div>
              <EmptyState
                className="py-8"
                title="还没有执行记录"
                description="任务跑起来之后，这里会显示耗时、状态和可下载的日志。"
                action={
                  <Button size="sm" variant="outline">
                    查看示例
                    <ArrowRight />
                  </Button>
                }
              />
            </CardContent>
          </Card>
        </div>
      </Section>

      <Section title="排版刻度" hint="UI 正文 13，卡片标题 13 半粗，页面标题 20">
        <Card>
          <CardContent className="flex flex-col gap-2">
            <div className="flex items-baseline justify-between">
              <span className="text-3xl font-semibold tracking-[-0.03em]">24 ms</span>
              <span className="font-mono text-[11px] text-muted-foreground">text-3xl / 32px</span>
            </div>
            <div className="flex items-baseline justify-between">
              <span className="text-xl font-semibold">页面标题</span>
              <span className="font-mono text-[11px] text-muted-foreground">text-xl / 20px</span>
            </div>
            <div className="flex items-baseline justify-between">
              <span className="text-sm font-semibold">卡片标题</span>
              <span className="font-mono text-[11px] text-muted-foreground">text-sm / 13px</span>
            </div>
            <div className="flex items-baseline justify-between">
              <span className="text-sm">界面正文，用于绝大多数可读内容。</span>
              <span className="font-mono text-[11px] text-muted-foreground">13px</span>
            </div>
            <div className="flex items-baseline justify-between">
              <span className="text-xs text-muted-foreground">辅助说明文字，最长两行。</span>
              <span className="font-mono text-[11px] text-muted-foreground">12px</span>
            </div>
            <div className="flex items-baseline justify-between">
              <span className="font-mono text-[11.5px]">const executor = await connect();</span>
              <span className="font-mono text-[11px] text-muted-foreground">mono 11.5px</span>
            </div>
          </CardContent>
        </Card>
      </Section>
    </div>
  );
}
