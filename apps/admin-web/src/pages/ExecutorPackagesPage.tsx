import { useState, useEffect, useCallback, useRef } from 'react';
import { Table,
  Button,
  Input,
  Select,
  Row,
  Col,
  Space,
  Tag,
  Tooltip,
  Modal,
  Form,
  Upload,
  Checkbox,
  Alert,
  Typography,
  Badge,
  Card,
  Progress,
  Switch,
  theme } from 'antd';
import { message } from '../utils/toast';
// MODAL-01：命令式 Modal.* 从 utils/modal 取（吃暗色主题 + i18n locale）；<Modal> JSX 仍用 antd。
import { Modal as confirmModal } from '../utils/modal';
import type { ColumnsType } from 'antd/es/table';
import {
  UploadOutlined, CloudDownloadOutlined, SendOutlined, DeleteOutlined,
  ReloadOutlined, PlusOutlined, StopOutlined, CheckCircleOutlined,
  LeftOutlined, RightOutlined,
} from '@ant-design/icons';
import {
  listPackages, uploadPackage, deletePackage, pushPackage,
  deprecatePackage, activatePackage, downloadPackage,
} from '../api/executor-packages';
import { executorsApi } from '../api/executors';
import { getErrMsg, showApiError } from '../utils/error';
import { normFileList } from '../utils/upload';
// UI 打磨：时间列统一走 timeFormat 工具（对齐 ProjectsPage/ApplicationListPage 用法）
import { formatDateTime } from '../utils/timeFormat';
// D-P2-02b（设计审计 2026-09-22）：包类型读面走唯一事实源 runtimeLabel
// （node/python 映射成展示名；universal 不在映射表，按设计回退原始 token）。
import { runtimeLabel } from '../utils/runtime-label';
import { useTranslation } from 'react-i18next';
import PageHeader from '../components/PageHeader';
import PageSkeleton from '../components/PageSkeleton';
import StateError from '../components/StateError';
import { Empty as AntEmpty } from 'antd';
// B-4：包名搜索防抖——复用既有 useDebounce hook（CommandPalette 同源）
import { useDebounce } from '../hooks/useDebounce';
// UI-10：导入 i18n 实例（模块副作用完成初始化；树内用 useTranslation 读 key）
import '../i18n';

const { Text } = Typography;

interface PkgRow {
  id: string; name: string; version: string; type: string;
  platform?: string; status: string; fileSize?: number;
  uploadedBy?: string; createdAt: string; originalFilename?: string;
}
interface Executor { id: string; name: string; address: string; status: string; executorVersion?: string; }
interface PushResult { executorId: string; address: string; success: boolean; error?: string; queued?: boolean; commandId?: string; status?: 'queued' | 'success' | 'error'; }

/**
 * 安装包类型选项——必须与后端 `ExecutorPackageType`
 * （`apps/admin-api/src/modules/executor-package/executor-package.entity.ts`：
 * `node` / `python` / `universal`）一致。
 *
 * 此前筛选器与上传表单各自内联了一份 `node|python|java|shell`：`java` 与 `shell`
 * 后端**根本不存在**，而 DTO 上是 `@IsEnum(ExecutorPackageType)` + 全局
 * `forbidNonWhitelisted`，于是选中这两项必然 400——筛选时整页变成加载失败块，
 * 上传时只得到一个泛化的「上传失败」。两处内联副本正是漂移的根源，故提到这里共用。
 */
const PACKAGE_TYPES = [
  { value: 'node', label: 'Node.js' },
  { value: 'python', label: 'Python' },
  { value: 'universal', label: 'Universal' },
] as const;

// F-3：包类型 ↔ 可上传扩展名联动。后端 ExecutorPackageType 只有 node/python/universal，
// 不存在 java/.jar；.whl 是 Python 专属（uv/pip wheel），不应在 node/universal 下可选。
// 此前 accept 写死 `.zip,.tar.gz,.whl,.jar`，与类型枚举漂移——选 python 传 .jar 也能选，
// 直到后端 400 才暴露。这里按当前选中类型收窄 accept，并在 beforeUpload 二次校验。
const PACKAGE_ACCEPT: Record<string, string> = {
  python: '.whl,.zip,.tar.gz,.tgz',
  node: '.zip,.tar.gz,.tgz',
  universal: '.zip,.tar.gz,.tgz',
};
const PACKAGE_ACCEPT_FALLBACK = '.zip,.tar.gz,.tgz,.whl';

// B-12：上传大小上限——与后端 FileInterceptor limits 逐字节对齐
// （apps/admin-api/src/modules/executor-package/executor-package.controller.ts:
// `limits: { fileSize: 500 * 1024 * 1024 }`）。超限请求后端必然 413/400，
// 前端先拦，避免用户白等一次大文件上传才发现被拒。
const MAX_PACKAGE_SIZE_BYTES = 500 * 1024 * 1024;

function extensionsFor(type: string | undefined): string {
  return (type && PACKAGE_ACCEPT[type]) || PACKAGE_ACCEPT_FALLBACK;
}

// B-9：补后端真实枚举 uploading（executor-package.entity.ts:19）——此前缺失，
// 上传中的包被渲染成裸 token，状态筛选也筛不出「上传中」。
const STATUS_TAG = (t: (k: string) => string): Record<string, { color: string; label: string }> => ({
  active: { color: 'green', label: t('execPkg.status.active') },
  deprecated: { color: 'orange', label: t('execPkg.status.deprecated') },
  uploading: { color: 'blue', label: t('execPkg.status.uploading') },
  deleted: { color: 'red', label: t('execPkg.status.deleted') },
});

function fmtBytes(b?: number) {
  if (!b) return '-';
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 「上传者」列的可读化（导出供测试）。
 *
 * 该字段有两个来源，长度差一个数量级：
 *   · 真人上传 → `admin`（用户名，短）；
 *   · 执行器 Agent 自动产包 → `agent:sop:<executorUuid>`（46 字符）。
 * 后者在 100px 列里会被折成 4 行，把行高撑开。这里保留**可辨认的前缀**
 * （`agent:sop:` + uuid 前 8 位），完整值由调用方放进 tooltip。
 */
export function shortUploader(v: string): string {
  const m = /^agent:sop:([0-9a-f-]{8})/i.exec(v);
  if (m) return `agent:sop:${m[1]}`;
  return v;
}

/**
 * §2.1 keyset 分页的前端状态：游标**栈** + 当前索引。
 *
 * 照抄 ExecutionsPage 的同一套范式（那边已被 14 条用例钉死，不另造一套）：
 * 游标分页没有「跳到第 N 页」——后端只给「下一页」令牌（`nextCursor`），
 * **没有**「上一页」令牌，要支持「上一页」客户端必须自己记住走过的路径。
 *
 * 约定：`stack[0]` 恒为第 1 页的起点，`stack[i]` 是「要显示第 i+1 页时要发给
 * 后端的 cursor」。栈里存的是**不透明**令牌，前端一律原样回传，绝不解析拼接。
 */
type CursorStack = {
  /** stack[0] 恒为 null（= 不带 cursor 参数）；stack[i] 为第 i+1 页的游标。 */
  stack: (string | null)[];
  /** 当前页在栈中的下标（0-based）。 */
  index: number;
};

/**
 * 栈的初始形态。
 *
 * `firstPageCursor === undefined` → `stack = [null]`：第 1 页**不带** cursor 参数，
 * 后端走原 OFFSET 路径（关闭开关时的现有行为，逐字节不变）。
 * `firstPageCursor === ''` → `stack = ['']`：第 1 页带 `cursor=`（空串），
 * 后端走 keyset 分支的起点。
 *
 * 这两种形态必须在**状态层**就分开，而不是在渲染期用 `??` 归一——一旦糊成
 * 「空串也当没传」，keyset 起点就永远进不去（axios 会把 undefined 的键整个丢掉，
 * 把空串序列化成 `cursor=`，两者在网络层是可区分的，别在本地先毁掉这个区分）。
 */
const initialCursorStack = (
  firstPageCursor: string | undefined,
): CursorStack => ({ stack: [firstPageCursor ?? null], index: 0 });

export default function ExecutorPackagesPage() {
  const { t } = useTranslation();
  // F-15（DEEP_REVIEW 0ef3bbe）：浅填充走 antd token，暗色主题自适应。
  const { token } = theme.useToken();
  const statusTags = STATUS_TAG(t);
  const [rows, setRows] = useState<PkgRow[]>([]);
  const [total, setTotal] = useState(0);
  /**
   * keyset 分支专有的「下一页」令牌。`null` = 末页；关掉开关时恒为 `null`
   * （OFFSET 响应里连这个键都没有，见 `ExecutorPackageListResult#nextCursor`）。
   */
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [search, setSearch] = useState('');
  // B-4：search 直接进 load 的 useCallback 依赖 + useEffect [load]，此前每个
  // 键入字符都触发一次全量请求。输入框仍绑定原始 search（即时回显），列表
  // 查询读 300ms 防抖后的值（CommandPalette 同款纪律）。
  const debouncedSearch = useDebounce(search, 300);
  const [typeFilter, setTypeFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 20;

  /**
   * §2.1「稳定翻页」开关——默认**关闭**。
   *
   * 关闭 = 完全走既有的 OFFSET 分页：请求里**不带** `cursor` 参数，后端走原
   * 路径、响应逐字节不变（连 `nextCursor` 这个键都不出现），页面行为与本轮改动
   * 之前完全一致。这是刻意保留的零风险默认值：keyset 是加性能力，不是默认切换。
   *
   * 打开 = 走 keyset 分页：列表底部换自绘的「上一页 / 下一页」+ 游标栈，
   * **不再提供页码跳转**（游标分页没有"第 N 页"这个概念）。
   */
  const [stablePaging, setStablePaging] = useState(false);
  /**
   * 游标栈（仅 keyset 模式有意义）。`stack[0]` 在关闭开关时是 `null`（第 1 页
   * **不带** cursor 参数）；开关打开时由 `toggleStablePaging` 重置成 `''`
   * （空串 = keyset 起点）。两种形态在状态里就是不同的值，不在渲染期糊成同一个。
   */
  const [cursorState, setCursorState] = useState<CursorStack>(() => initialCursorStack(undefined));

  /**
   * 重置游标栈（回到第 1 页）。
   *
   * **所有会改变结果集的入口都必须调用它**：带着旧筛选的游标继续翻，游标里的
   * (createdAt, id) 与新的过滤条件毫无关系，后端的游标条件与过滤器取交集后会
   * 返回"从某条不相干的行往后"的错乱结果——不报错、不空白，只是内容错了。
   *
   * `keysetStart` 决定重置到哪条路径的首页：
   *   · `false` → `stack = [null]`（第 1 页不带 cursor 参数，OFFSET 路径）；
   *   · `true`  → `stack = ['']`（第 1 页带 `cursor=`，keyset 起点）。
   */
  const resetCursorStack = (keysetStart: boolean) => {
    setCursorState(initialCursorStack(keysetStart ? '' : undefined));
  };

  /**
   * 当前请求应携带的游标。
   *
   * `undefined` = 不带该参数（axios 把键整个丢掉）→ 后端 OFFSET 分支；
   * `''`        = `?cursor=` → 后端 keyset 起点；
   * 非空串      = keyset 中途页。
   *
   * 关闭开关时恒为 `undefined`（外加把栈重置回 `[null]` 双保险）：默认路径的
   * 请求参数里**不可能**出现 cursor——这是"旧路径没被碰到"的可执行保证。
   */
  const activeCursor = stablePaging ? cursorState.stack[cursorState.index] ?? '' : undefined;

  // UI-16 竞态守卫：筛选、分页、刷新或重试快速重入时，仅最新请求允许更新列表状态。
  const loadSeq = useRef(0);

  // 2026-10-23：多选批量删除。此前只有逐行删除，6 个 agent 产出的
  // `sop-candidate` 包要清 6 次；批量卸载/清理历史包是常态操作。
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [batchDeleting, setBatchDeleting] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadForm] = Form.useForm();
  const [uploading, setUploading] = useState(false);
  // B-12：上传进度百分比（axios onUploadProgress 驱动）
  const [uploadPercent, setUploadPercent] = useState(0);
  // F-3：监听上传表单当前类型，据此收窄 Upload 的 accept 并做扩展名二次校验。
  const uploadType = Form.useWatch('type', uploadForm);

  const [pushTarget, setPushTarget] = useState<PkgRow | null>(null);
  const [executors, setExecutors] = useState<Executor[]>([]);
  // P3-12（executor lifecycle audit）：执行器列表拉取失败必须与「机群为空」
  // 区分——旧实现 catch 里直接 setExecutors([])，弹窗断言「暂无在线调度机」，
  // 把一次网络失败渲染成了从未观测过的机群状态。
  const [executorsLoadError, setExecutorsLoadError] = useState(false);
  const [pushAll, setPushAll] = useState(true);
  const [selectedExecutors, setSelectedExecutors] = useState<string[]>([]);
  const [pushing, setPushing] = useState(false);
  const [pushResults, setPushResults] = useState<PushResult[] | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  // B-3：弃用/激活行级 pending——此前快速双击连发两个请求（第二次对已翻转
  // 的状态再翻转，后端 400/状态抖动）。与 downloadingId/pushing 同纪律。
  const [togglingId, setTogglingId] = useState<string | null>(null);

  // P2-8：「推送全部」的唯一目标集合——推送范围/按钮禁用/计数文案三处共用。
  const onlineExecutors = executors.filter(e => e.status === 'online');

  // 补充 P2：机队执行器版本分布——包表与机队 executorVersion 关联，让管理员一眼
  // 看到执行器是否处在混合版本（漂移）状态。旧实现整页无任何机队版本信息，
  // 推送了新包也不知道哪些执行器还跑旧版。
  const [fleetVersions, setFleetVersions] = useState<Record<string, number>>({});
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await executorsApi.list();
        if (cancelled) return;
        const dist: Record<string, number> = {};
        for (const e of list ?? []) {
          const v = e.executorVersion || 'unknown';
          dist[v] = (dist[v] ?? 0) + 1;
        }
        setFleetVersions(dist);
      } catch {
        // 机队版本摘要非关键路径：失败静默，不影响包表主流程。
      }
    })();
    return () => { cancelled = true; };
  }, []);
  const fleetVersionKeys = Object.keys(fleetVersions);
  const fleetDriftCount = fleetVersionKeys.length;

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setLoading(true);
    setLoadError(null);
    try {
      const res = await listPackages({
        page, pageSize: PAGE_SIZE,
        name: debouncedSearch || undefined,
        type: typeFilter || undefined,
        status: statusFilter || undefined,
        // keyset 三态的**唯一**出口，落在下面这个三元里：
        //   · 关闭开关 → 整个 `cursor` 键都不出现（`{}`），请求与改动前完全一致；
        //   · 打开开关 → 空串（`?cursor=`，keyset 起点）或上一页返回的不透明游标。
        //
        // 为什么不是恒传 `cursor: activeCursor` 让 axios 丢弃 undefined：键要
        // 不要在**我们**这一层就必须确定——"旧路径逐字节不变"是硬要求，把它押在
        // axios 的序列化细节上等于把风险外包给库版本。
        ...(activeCursor === undefined ? {} : { cursor: activeCursor }),
      });
      if (seq !== loadSeq.current) return;
      // 后端响应里本就带 `status`（executor_packages.status 列）。此前这里用
      // `pkg.isLatest ? 'active' : 'deprecated'` 覆盖它，而 `isLatest` 在后端
      // **不存在**（恒 undefined）——后果不是"少显示一个字段"：每个包都被渲染成
      // 已弃用，且推送按钮的 `disabled={row.status !== 'active'}` 使**推送功能
      // 对全部包不可达**。如实使用响应里的值即可。
      setRows(res.items);
      setTotal(res.total);
      // `nextCursor` 只在 keyset 分支出现（OFFSET 分支连键都没有），如实落库；
      // 关闭开关时强制清空，避免切回 OFFSET 后残留上一模式的末页标记。
      setNextCursor(stablePaging ? res.nextCursor ?? null : null);
      setLoadError(null);
    } catch (err: unknown) {
      if (seq !== loadSeq.current) return;
      setLoadError(err);
      showApiError(err, t('execPkg.loadFail'));
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, [page, debouncedSearch, typeFilter, statusFilter, activeCursor, stablePaging, t]);

  useEffect(() => {
    load();
    // 与 AppDeploymentPage 对齐：依赖变化/卸载时作废本 effect 发起的旧请求。
    return () => { loadSeq.current += 1; };
  }, [load]);

  /**
   * keyset 模式下本页是否还有下一页。
   *
   * 严谨区分三种来源（**不能**用 `!!nextCursor` 一句糊过去）：
   *   · 关闭开关 → 根本不是 keyset 模式，`nextCursor` 键不存在 → 这里恒为 null；
   *   · keyset 且 `nextCursor === null` → 后端明确说「已到末页」→ 禁用下一页；
   *   · keyset 且拿到了字符串 → 还有下一页。
   *
   * 关闭开关时即使 state 里残留了值也不认（`stablePaging &&`）——那只会让
   * 页码分页的底部凭空多出一个禁用的自绘分页器。
   */
  const canNext = stablePaging && nextCursor !== null;

  /**
   * 下一页：把刚拿到的游标压栈并前进一格（无游标或到末页时不动）。
   *
   * 连点安全：第二次点击时 `nextCursor` 可能仍是同一个令牌（state 尚未被新响应
   * 覆盖），下面「同一游标不重复压栈」的判据会把第二下变成空操作，不会在栈里
   * 堆出重复条目、也不会跳过一页。
   */
  const goNext = () => {
    if (!canNext || nextCursor === null) return;
    setCursorState((s) => {
      const stack = s.stack.slice(0, s.index + 1);
      if (stack[stack.length - 1] === nextCursor) return s;
      stack.push(nextCursor);
      return { stack, index: stack.length - 1 };
    });
  };

  /** 上一页：在栈内回退一格（栈首禁用）。 */
  const goPrev = () => {
    setCursorState((s) => (s.index > 0 ? { ...s, index: s.index - 1 } : s));
  };

  /** 开关切换：两条路径的首页语义不同，必须重置栈，否则会带着上一模式的游标越界。 */
  const toggleStablePaging = (next: boolean) => {
    setStablePaging(next);
    resetCursorStack(next);
    // keyset 没有"第 N 页"的坐标系，切模式后页码回 1（关闭时也回 1，避免
    // 「页码 5 + 无游标」的自相矛盾组合）。
    setPage(1);
  };

  // 补充 P2：自动刷新——包表/推送结果会异步变化（入队任务完成、状态翻转），
  // 旧实现必须手动点刷新。30s 轮询一次；弹窗打开或正在加载时跳过，避免打断交互。
  useEffect(() => {
    const timer = setInterval(() => {
      if (loading || uploadOpen || !!pushTarget) return;
      void load();
    }, 30000);
    return () => clearInterval(timer);
  }, [load, loading, uploadOpen, pushTarget]);

  const handleUpload = async (values: Record<string, unknown>) => {
    // normFileList 已将字段值收敛为 UploadFile[]（见 utils/upload.ts）。
    const fileObj: File | undefined =
      (values.file as { originFileObj?: File }[] | undefined)?.[0]?.originFileObj;
    if (!fileObj) { message.error(t('execPkg.upload.chooseFile')); return; }
    setUploading(true);
    // B-12：上传进度归零后随 axios onUploadProgress 推进（大文件不再零反馈）
    setUploadPercent(0);
    try {
      const fd = new FormData();
      fd.append('file', fileObj);
      fd.append('name', values.name as string);
      fd.append('version', values.version as string);
      fd.append('type', values.type as string);
      fd.append('platform', values.platform as string);
      if (values.description) fd.append('description', values.description as string);
      await uploadPackage(fd, (e) => {
        if (e.total) setUploadPercent(Math.min(100, Math.round((e.loaded / e.total) * 100)));
      });
      message.success(t('execPkg.upload.success'));
      setUploadOpen(false);
      uploadForm.resetFields();
      load();
    } catch (err: unknown) { showApiError(err, t('execPkg.upload.fail')); } finally { setUploading(false); setUploadPercent(0); }
  };

  // F-3：accept 只收窄系统选择器；拖拽/手动选「所有文件」仍可绕过，
  // beforeUpload 据当前类型做扩展名二次校验，不符则剔除并提示。
  // B-12：同法做大小上限校验（与后端 FileInterceptor limits 对齐），
  // 超限剔除并提示，不发起注定被 413/400 拒绝的请求。
  const beforePkgUpload = (file: File) => {
    const lower = file.name.toLowerCase();
    const allowed = extensionsFor(uploadType).split(',').map((s) => s.trim());
    if (!allowed.some((ext) => lower.endsWith(ext))) {
      message.error(t('execPkg.upload.extensionMismatch'));
      return Upload.LIST_IGNORE;
    }
    if (file.size > MAX_PACKAGE_SIZE_BYTES) {
      message.error(t('execPkg.upload.tooLarge', { max: `${MAX_PACKAGE_SIZE_BYTES / 1024 / 1024} MB` }));
      return Upload.LIST_IGNORE;
    }
    return false;
  };

  const loadPushExecutors = async () => {
    setExecutorsLoadError(false);
    try {
      const list = await executorsApi.list();
      setExecutors(list.map(e => ({ id: e.id, name: e.appName, address: e.address, status: e.status })));
    } catch {
      // P3-12：失败不再伪装成「空机群」——保留旧列表（若有）并显式报错，
      // 由弹窗给出重试入口。
      setExecutorsLoadError(true);
    }
  };

  const handleOpenPush = async (pkg: PkgRow) => {
    setPushTarget(pkg);
    setPushResults(null);
    setPushAll(true);
    setSelectedExecutors([]);
    setExecutors([]);
    await loadPushExecutors();
  };

  const handlePush = async () => {
    if (!pushTarget) return;
    setPushing(true);
    try {
      // P2-8（executor lifecycle audit）：按钮文案是「推送到全部在线调度机」，
      // 后端空名单语义也已对齐为「仅在线行」——但为了让请求本身就兑现承诺
      // （并兼容旧版后端：空名单曾推给全部行含离线机），勾选「全部」时显式
      // 发送当前在线 id 列表；0 台在线时按钮禁用，不会对离线机群发起推送。
      const ids = pushAll ? onlineExecutors.map(e => e.id) : selectedExecutors;
      const results = await pushPackage(pushTarget.id, ids);
      setPushResults(results);
    } catch (e: unknown) {
      // D-P2-12（设计审计 2026-09-22）：裸 `(e as Error).message` 对 HTTPError
      // 拿到的是 "Request failed with 500" 之类壳，不读后端 message；走 getErrMsg
      // 统一解析后端错误体/校验错误/网络错误，兜底文案给可执行提示。
      setPushResults([{ executorId: '', address: '', success: false, error: getErrMsg(e, t('execPkg.pushFail')) }]);
    } finally { setPushing(false); }
  };

  const handleDelete = (id: string) => {
    confirmModal.confirm({
      title: t('execPkg.deleteConfirm'),
      content: t('execPkg.deleteConfirmDesc'),
      okText: t('execPkg.delete'), okType: 'danger', cancelText: t('execPkg.cancel'),
      // B-2：此前 onOk 仅 await deletePackage(id); load() 无 catch——失败零
      // 反馈（对照 handleStatusToggle 的 showApiError）。失败时 rethrow 让
      // antd 保持确认框打开（可重试/取消），错误经 showApiError 归一提示。
      onOk: async () => {
        try {
          await deletePackage(id);
          load();
        } catch (err: unknown) {
          showApiError(err, t('execPkg.deleteFail'));
          throw err;
        }
      },
    });
  };

  /**
   * 批量删除（2026-10-23）：逐台异步 + 逐条结果汇总。
   *
   * 与单条删除的差别只在**确认文案**：批量不可撤销、列出数量，且部分失败时
   * 必须逐条报错（只报"失败 2 条"等于让用户自己翻是哪个）。
   * 失败台**保留在选中集合里**，方便直接重试；成功台清掉。
   */
  const handleBatchDelete = () => {
    const targets = rows.filter((r) => selectedIds.includes(r.id));
    if (targets.length === 0) return;
    confirmModal.confirm({
      title: t('execPkg.batchDeleteConfirm', { count: targets.length }),
      content: t('execPkg.batchDeleteConfirmDesc'),
      okText: t('execPkg.delete'), okType: 'danger', cancelText: t('execPkg.cancel'),
      onOk: async () => {
        setBatchDeleting(true);
        const failed: string[] = [];
        for (const pkg of targets) {
          try {
            await deletePackage(pkg.id);
          } catch (err: unknown) {
            failed.push(pkg.id);
            // 逐条报错（成功台不打扰）——批量里"静默跳过"比单条失败更危险
            showApiError(err, t('execPkg.deleteFailItem', { name: `${pkg.name}@${pkg.version}` }));
          }
        }
        setBatchDeleting(false);
        setSelectedIds(failed);
        const okCount = targets.length - failed.length;
        if (failed.length === 0) {
          message.success(t('execPkg.batchDeleteOk', { count: okCount }));
        } else if (okCount > 0) {
          message.warning(t('execPkg.batchDeletePartial', { ok: okCount, fail: failed.length }));
        }
        // 失败台留在选中集合里（重试入口 = 再点一次批量删除），成功台已不在列表。
        // 刻意**不 rethrow**：单条删除 rethrow 是为了让确认框保持打开可直接重试，
        // 而批量场景的重试入口是「保留的选中集合 + 批量条」，再弹一个未处理
        // rejection 只会污染控制台（测试里实测为 unhandled rejection）。
        void load();
      },
    });
  };

  const handleStatusToggle = async (pkg: PkgRow) => {
    // B-3：行级 pending 防双击竞态——已有切换在途时忽略重复触发
    if (togglingId) return;
    setTogglingId(pkg.id);
    try {
      if (pkg.status === 'active') await deprecatePackage(pkg.id);
      else await activatePackage(pkg.id);
      load();
    } catch (err: unknown) { showApiError(err, t('execPkg.operateFail')); }
    finally { setTogglingId(null); }
  };

  // download 路由在 JwtAuthGuard 后，<a href> 无法携带 Authorization（会 401），
  // 改为带 JWT 的 axios blob 请求下载
  const handleDownload = async (pkg: PkgRow) => {
    setDownloadingId(pkg.id);
    try {
      await downloadPackage(pkg.id, pkg.originalFilename ?? `${pkg.name}-${pkg.version}`);
    } catch (err: unknown) {
      showApiError(err, t('execPkg.downloadFail'));
    } finally {
      setDownloadingId(null);
    }
  };

  const columns: ColumnsType<PkgRow> = [
    {
      title: t('execPkg.col.name'), dataIndex: 'name',
      render: (n: string, r: PkgRow) => (
        // UI 打磨：名称/原始文件名单行 ellipsis——弹性列内 minWidth:0 + display:block 让省略号生效
        <div style={{ minWidth: 0 }}>
          <Text strong style={{ display: 'block' }} ellipsis={{ tooltip: n }}>{n}</Text>
          {r.originalFilename && (
            <Text type="secondary" style={{ fontSize: 12, display: 'block' }} ellipsis={{ tooltip: r.originalFilename }}>
              {r.originalFilename}
            </Text>
          )}
        </div>
      ),
    },
    { title: t('execPkg.col.version'), dataIndex: 'version', width: 100, render: (v: string) => <Tag color="blue">{v}</Tag> },
    { title: t('execPkg.col.type'), dataIndex: 'type', width: 90, render: (v: string) => <Tag>{runtimeLabel(v, t)}</Tag> },
    // UI-09 第三轮：平台/大小/上传者是次要列——窄屏（≤768px）由媒体查询隐藏
    // （onHeaderCell/onCell 双端挂类，对齐 mobile-ui09 既有模式），
    // 值班关键列（包名/版本/类型/状态/上传时间）+ 操作列 fixed right 保留。
    {
      title: t('execPkg.col.platform'), dataIndex: 'platform', width: 90,
      onHeaderCell: () => ({ className: 'ui09-hide-mobile' }),
      onCell: () => ({ className: 'ui09-hide-mobile' }),
      render: (v?: string) => v ?? '-',
    },
    {
      title: t('execPkg.col.size'), dataIndex: 'fileSize', width: 90,
      onHeaderCell: () => ({ className: 'ui09-hide-mobile' }),
      onCell: () => ({ className: 'ui09-hide-mobile' }),
      render: (v?: number) => fmtBytes(v),
    },
    {
      title: t('execPkg.col.status'), dataIndex: 'status', width: 100,
      render: (v: string) => {
        const s = statusTags[v] ?? { color: 'default', label: v };
        return <Tag color={s.color}>{s.label}</Tag>;
      },
    },
    {
      title: t('execPkg.col.createdAt'), dataIndex: 'createdAt', width: 170,
      render: (v: string) => formatDateTime(v),
    },
    {
      // 2026-10-23 实测修正：`uploadedBy` 不是用户名——agent 自动产包写的是
      // `agent:sop:<executorUuid>`（46 字符），而这一列只有 100px 且**没有
      // ellipsis**，于是整行被折成 4 行、把行高撑成别人的三倍（截图实证）。
      // 现在：主显可读前缀（`agent:sop:98c5a61a`），完整值进 tooltip；
      // 用户上传的普通用户名（短）原样显示。
      title: t('execPkg.col.uploadedBy'), dataIndex: 'uploadedBy', width: 130, ellipsis: true,
      onHeaderCell: () => ({ className: 'ui09-hide-mobile' }),
      onCell: () => ({ className: 'ui09-hide-mobile' }),
      render: (v?: string) => {
        if (!v) return '-';
        const short = shortUploader(v);
        return short === v ? (
          <Text style={{ fontSize: 12 }}>{v}</Text>
        ) : (
          <Tooltip title={v}>
            <Text style={{ fontSize: 12 }}>{short}</Text>
          </Tooltip>
        );
      },
    },
    {
      title: t('execPkg.col.actions'), key: 'actions', width: 160, align: 'center' as const, fixed: 'right' as const,
      render: (_: unknown, row: PkgRow) => (
        // A11Y-ICON-01（对齐 TaskListPage 既有惯例）：纯图标按钮必须补
        // aria-label——antd Tooltip 不自动注入 aria-label，读屏此前只能念出
        // 图标自带的英文 aria-label（cloud-download/send/…）。
        <Space size="small">
          <Tooltip title={t('execPkg.action.download')}>
            <Button size="small" icon={<CloudDownloadOutlined />} aria-label={t('execPkg.action.download')}
              loading={downloadingId === row.id} onClick={() => handleDownload(row)} />
          </Tooltip>
          <Tooltip title={t('execPkg.action.push')}>
            <Button size="small" icon={<SendOutlined />} type="primary" aria-label={t('execPkg.action.push')}
              disabled={row.status !== 'active'} onClick={() => handleOpenPush(row)} />
          </Tooltip>
          {/* B-9：uploading 包的弃用/激活禁用（后端对非 active/deprecated 翻转会 400）；
              B-3：行级 loading 防双击连发 */}
          <Tooltip title={
            row.status === 'uploading'
              ? t('execPkg.action.uploadingLockedTip')
              : row.status === 'active' ? t('execPkg.action.deprecate') : t('execPkg.action.activate')
          }>
            <Button size="small"
              icon={row.status === 'active' ? <StopOutlined /> : <CheckCircleOutlined />}
              aria-label={row.status === 'active' ? t('execPkg.action.deprecate') : t('execPkg.action.activate')}
              disabled={row.status === 'uploading'}
              loading={togglingId === row.id}
              onClick={() => handleStatusToggle(row)} />
          </Tooltip>
          <Tooltip title={t('execPkg.delete')}>
            <Button size="small" danger icon={<DeleteOutlined />} aria-label={t('execPkg.delete')} onClick={() => handleDelete(row.id)} />
          </Tooltip>
        </Space>
      ),
    },
  ];

  return (
    <div>
      {/* UI-03/UI-08：页头标准化（原 Typography.Title+操作区迁入 PageHeader） */}
      <PageHeader
        title={t('execPkg.title')}
        description={t('execPkg.description')}
        extra={<Button type="primary" icon={<PlusOutlined />} onClick={() => setUploadOpen(true)}>{t('execPkg.uploadNew')}</Button>}
      />

      {loadError !== null && !loading && (
        <StateError
          error={loadError}
          title={t('execPkg.error.title')}
          onRetry={load}
          style={{ marginBottom: 16 }}
        />
      )}

      <Space style={{ marginBottom: 16 }} wrap>
        <Input.Search
          placeholder={t('execPkg.searchPlaceholder')} value={search} allowClear style={{ width: 200 }}
          // §2.1：筛选变化必须同时重置游标栈（原因见 resetCursorStack 注释）
          onChange={e => { setSearch(e.target.value); setPage(1); resetCursorStack(stablePaging); }}
        />
        <Select
          placeholder={t('execPkg.filter.type')} value={typeFilter || undefined} allowClear style={{ width: 120 }}
          onChange={v => { setTypeFilter(v ?? ''); setPage(1); resetCursorStack(stablePaging); }}
          options={[...PACKAGE_TYPES]}
        />
        <Select
          placeholder={t('execPkg.filter.status')} value={statusFilter || undefined} allowClear style={{ width: 120 }}
          onChange={v => { setStatusFilter(v ?? ''); setPage(1); resetCursorStack(stablePaging); }}
          options={[
            { value: 'active', label: t('execPkg.status.active') },
            { value: 'deprecated', label: t('execPkg.status.deprecated') },
            // B-9：状态筛选与后端枚举同步（uploading 可筛）
            { value: 'uploading', label: t('execPkg.status.uploading') },
          ]}
        />
        <Button icon={<ReloadOutlined />} onClick={load}>{t('execPkg.refresh')}</Button>
        <Text type="secondary">{t('execPkg.count', { count: total })}</Text>
        {/* §2.1：稳定翻页开关（默认关闭）。
            用 antd Switch——它本身就是 role="switch" + 原生 button 语义，
            Tab 可聚焦、Space/Enter 可切换，无需再补键盘处理；aria-label 给出
            可访问名（开关没有可见文字标签时，纯靠旁边的文字不构成可访问名）。
            关闭时不发任何 cursor 参数，后端与页面行为都回到改动前。 */}
        <Space size={6} style={{ marginLeft: 'auto' }}>
          <Switch
            size="small"
            checked={stablePaging}
            onChange={toggleStablePaging}
            aria-label={t('execPkg.stablePaging.aria')}
          />
          <Tooltip title={t('execPkg.stablePaging.hint')}>
            <Text type="secondary" style={{ fontSize: 12 }}>{t('execPkg.stablePaging')}</Text>
          </Tooltip>
        </Space>
      </Space>

      {/* 2026-10-23：批量删除条。只在有选中时出现，避免常驻占位。
          按钮上带数量，点击后二次确认列出条数；部分失败时失败台留在选中集合。 */}
      {selectedIds.length > 0 && (
        <Space
          data-testid="execPkg-batch-bar"
          size={8}
          style={{ marginBottom: 12, padding: '6px 12px', background: token.colorFillQuaternary, borderRadius: 6 }}
        >
          <Text type="secondary" style={{ fontSize: 12 }}>
            {t('execPkg.selected', { count: selectedIds.length })}
          </Text>
          <Button
            size="small"
            danger
            icon={<DeleteOutlined aria-hidden />}
            loading={batchDeleting}
            data-testid="execPkg-batch-delete"
            onClick={handleBatchDelete}
          >
            {t('execPkg.batchDelete', { count: selectedIds.length })}
          </Button>
          <Button size="small" type="text" onClick={() => setSelectedIds([])}>
            {t('execPkg.clearSelection')}
          </Button>
        </Space>
      )}

      {/* 补充 P2：机队执行器版本分布摘要——多版本并存即漂移，橙色 Tag 提示。 */}
      {fleetVersionKeys.length > 0 && (
        <Space style={{ marginBottom: 12 }} size={4} wrap>
          <Text type="secondary" style={{ fontSize: 12 }}>{t('execPkg.fleetVersions.label')}:</Text>
          {fleetVersionKeys.sort().map(v => (
            <Tag key={v} color={fleetDriftCount > 1 ? 'orange' : 'default'}>
              {v} × {fleetVersions[v]}
            </Tag>
          ))}
          {fleetDriftCount > 1 && (
            <Text type="warning" style={{ fontSize: 12 }}>{t('execPkg.fleetVersions.drift')}</Text>
          )}
        </Space>
      )}

      <Table<PkgRow>
        rowKey="id" columns={columns} dataSource={rows} size="small"
        rowSelection={{
          selectedRowKeys: selectedIds,
          onChange: (keys) => setSelectedIds(keys as string[]),
        }}
        // UI 打磨：loading 直传——此前恒 false，翻页/刷新期间无任何反馈；
        // 首屏 emptyText 骨架（UI-08）原样保留
        loading={loading}
        // 2026-10-23：上传者列 100→130（`agent:sop:<uuid8>` 要放得下），
        // scroll.x 同步 1060→1090，保持「列宽合计 = 横向滚动阈值」这条口径。
        scroll={{ x: 1090 }}
        // §2.1：两种分页形态**互斥**——这是本页最关键的一处语义切换。
        //
        // keyset 模式（开关打开）下 `pagination={false}`：游标分页没有"第 N 页"
        // 这个概念，页码器必须**整体消失**而不是留在原地。若只禁用它、或保留
        // 页码却把 current 硬钉在 1，用户点「第 5 页」会被告知"在第 1 页"，
        // 或更糟——页码变了但列表没变（静默错乱）。宁可没有页码，也不能给一个
        // 骗人的页码。翻页改由表格下方自绘的「上一页 / 下一页」承担。
        //
        // OFFSET 模式（开关关闭）保持原样，逐字节不变。
        pagination={stablePaging ? false : {
          current: page, pageSize: PAGE_SIZE, total,
          // §2.1：pageSize/页码变更同样要重置游标栈——每页条数变了，旧的
          // (createdAt,id) 游标与新的切片边界不再对应。
          onChange: (p) => { setPage(p); resetCursorStack(stablePaging); },
          showTotal: (totalCount) => t('execPkg.countRows', { count: totalCount }),
        }}
        locale={{
          // UI-08：首屏加载（无数据）以骨架屏替代表格 Spin；错误态不误显示空态
          emptyText: loading && rows.length === 0
            ? <PageSkeleton variant="table" rows={4} />
            : loadError
              ? null
              : <AntEmpty image={AntEmpty.PRESENTED_IMAGE_SIMPLE} description={t('execPkg.empty')} />,
        }}
      />

      {/* §2.1：keyset 模式的自绘分页器。
          游标分页只有「下一页」令牌，没有「上一页」令牌——上一页靠游标栈回退，
          故这里**只有两个按钮，没有页码、没有页码跳转**（见上方 pagination 注释）。
          关闭开关时整块不渲染（`stablePaging ?`），旧页面形态零变化。 */}
      {stablePaging ? (
        <div
          style={{
            marginTop: 16,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            gap: 12,
          }}
        >
          <Text type="secondary" style={{ fontSize: 12 }}>
            {t('execPkg.countRows', { count: total })}
          </Text>
          <Button
            size="small"
            icon={<LeftOutlined />}
            // 栈首禁用：没有上一页可回（此时再点只会重复请求同一游标）
            disabled={cursorState.index === 0}
            onClick={goPrev}
          >
            {t('execPkg.pager.prev')}
          </Button>
          <Button
            size="small"
            // 后端说没有下一页（nextCursor === null，含"游标行被删"的提前结束）
            disabled={!canNext}
            onClick={goNext}
          >
            {t('execPkg.pager.next')}
            <RightOutlined />
          </Button>
        </div>
      ) : null}

      {/* 上传弹窗 */}
      <Modal
        title={t('execPkg.upload.title')} open={uploadOpen} onCancel={() => setUploadOpen(false)}
        footer={null} destroyOnHidden
      >
        <Form form={uploadForm} layout="vertical" onFinish={handleUpload} style={{ marginTop: 8 }}>
          <Form.Item name="file" label={t('execPkg.upload.field.file')} valuePropName="fileList" getValueFromEvent={normFileList} rules={[{ required: true, message: t('execPkg.upload.chooseFile') }]}>
            <Upload beforeUpload={beforePkgUpload} maxCount={1} accept={extensionsFor(uploadType)}>
              <Button icon={<UploadOutlined />}>{t('execPkg.upload.chooseFileBtn')}</Button>
            </Upload>
          </Form.Item>
          {/* B-12：上传进度条——axios onUploadProgress 驱动，上传中实时可见 */}
          {uploading && (
            <Progress percent={uploadPercent} size="small" style={{ marginBottom: 8 }} />
          )}
          {/* R5 交接：双列行窄屏堆叠——Space flex 布局无断点，375px 弹窗下
              每列仅 ~145px 偏紧；改 Row/Col xs=24 sm=12（对齐 ExecutorInstallWizardPage
              响应式先例），gutter 响应式对象 xs=0/sm=16 使堆叠后与上下整行字段
              （文件/描述）左缘对齐，sm+ 桌面 16px 间距不变。
              UX-WALK R9（走查 A 级 executor-packages@600，.ant-modal-body
              scrollWidth 480 > 472）：归因是本 Row 的 gutter 负 margin 而非
              上传控件内边距——antd 对 gutter 16 施加 margin-inline:-8px/
              padding-inline:8px 补偿，弹窗 body 自身无内边距（v6 内边距在
              .ant-modal-content）且 overflowX=visible，行盒右缘遂超出 body
              恰 8px（实测把行 margin 归零后 sw 480→472，上传子树无越界）。
              ux-gutter-flush（index.css ≥576px 媒体查询）把行盒钉回 body
              边缘，字段几何（0..228 / 244..472）与钳制前逐像素一致；xs 断点
              gutter=0 本无边距，规则不生效，375 不受影响（不走行内 style
              长写覆写的原因见 index.css 该节注释）。
              maxLength 对齐后端 CreateExecutorPackageDto（name ≤255 / version ≤64）：
              本表单随包上传大文件，超长值只在后端 400 才暴露——白等一次
              数百 MB 上传；输入端截断即可 */}
          <Row gutter={{ xs: 0, sm: 16 }} className="ux-gutter-flush">
            <Col xs={24} sm={12}>
              <Form.Item name="name" label={t('execPkg.upload.field.name')} rules={[{ required: true, message: t('execPkg.upload.field.nameRequired') }]}>
                <Input placeholder="python-runner" maxLength={255} />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12}>
              <Form.Item name="version" label={t('execPkg.upload.field.version')} rules={[{ required: true, message: t('execPkg.upload.field.versionRequired') }]}>
                <Input placeholder="1.0.0" maxLength={64} />
              </Form.Item>
            </Col>
          </Row>
          {/* 同上：双列行 no-bleed 覆写（机制见上一行注释） */}
          <Row gutter={{ xs: 0, sm: 16 }} className="ux-gutter-flush">
            <Col xs={24} sm={12}>
              <Form.Item name="type" label={t('execPkg.upload.field.type')} initialValue="node" rules={[{ required: true }]}>
                <Select options={[...PACKAGE_TYPES]} />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12}>
              <Form.Item name="platform" label={t('execPkg.upload.field.platform')} initialValue="linux" rules={[{ required: true }]}>
                <Select options={[
                  { value: 'linux', label: 'Linux' }, { value: 'windows', label: 'Windows' },
                  { value: 'macos', label: 'macOS' }, { value: 'all', label: t('execPkg.upload.platformAll') },
                ]} />
              </Form.Item>
            </Col>
          </Row>
          {/* maxLength 对齐后端 CreateExecutorPackageDto @MaxLength(1024) */}
          <Form.Item name="description" label={t('execPkg.upload.field.description')}>
            <Input.TextArea rows={2} maxLength={1024} />
          </Form.Item>
          <Form.Item style={{ marginBottom: 0, textAlign: 'right' }}>
            <Space>
              <Button onClick={() => setUploadOpen(false)}>{t('execPkg.cancel')}</Button>
              <Button type="primary" htmlType="submit" loading={uploading}>{t('execPkg.upload.confirm')}</Button>
            </Space>
          </Form.Item>
        </Form>
      </Modal>

      {/* 推送弹窗 */}
      <Modal
        title={
          pushTarget
            ? t('execPkg.push.titleWithPkg', { name: pushTarget.name, version: pushTarget.version })
            : t('execPkg.push.title')
        }
        open={!!pushTarget}
        onCancel={() => setPushTarget(null)}
        footer={
          pushResults ? (
            <Space>
              <Button onClick={() => setPushResults(null)}>{t('execPkg.push.retry')}</Button>
              <Button type="primary" onClick={() => setPushTarget(null)}>{t('execPkg.close')}</Button>
            </Space>
          ) : (
            <Space>
              <Button onClick={() => setPushTarget(null)}>{t('execPkg.cancel')}</Button>
              <Button
                type="primary" icon={<SendOutlined />} loading={pushing} onClick={handlePush}
                // P2-8：0 台在线时「全部在线」无目标，禁用——旧实现此时仍会
                // 对整个离线机群发起推送；P3-12：执行器列表加载失败同样禁用，
                // 不能在未知机群状态下推送。
                disabled={executorsLoadError || (pushAll ? onlineExecutors.length === 0 : selectedExecutors.length === 0)}
              >
                {t('execPkg.push.start')}
              </Button>
            </Space>
          )
        }
        destroyOnHidden
      >
        {!pushResults ? (
          <Space orientation="vertical" style={{ width: '100%' }} size="middle">
            <Alert
              title={t('execPkg.push.alert')}
              type="info" showIcon
            />
            {/* P3-12：执行器列表拉取失败 ≠ 机群为空——原位报错并给重试，
                绝不在未知机群状态下渲染「暂无在线调度机」。 */}
            {executorsLoadError ? (
              <Alert
                type="error"
                showIcon
                title={t('execPkg.push.executorsLoadError')}
                action={
                  <Button size="small" onClick={() => void loadPushExecutors()}>
                    {t('execPkg.push.retryLoad')}
                  </Button>
                }
              />
            ) : (
              <>
                <Checkbox checked={pushAll} onChange={e => setPushAll(e.target.checked)}>
                  {t('execPkg.push.pushAll', { count: onlineExecutors.length })}
                </Checkbox>
                {/* P2-8：0 台在线时明确提示并禁用推送（旧实现默认勾选且仍可
                    点击，把请求发给整个离线机群）。 */}
                {pushAll && onlineExecutors.length === 0 && (
                  <Alert type="warning" showIcon title={t('execPkg.push.noOnline')} />
                )}
                {!pushAll && (
                  <Card size="small" style={{ background: token.colorFillQuaternary }}>
                    <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 8 }}>
                      {t('execPkg.push.selectTarget')}
                    </Text>
                    {onlineExecutors.length === 0 ? (
                      <Text type="secondary">{t('execPkg.push.noOnline')}</Text>
                    ) : (
                      <Space orientation="vertical" size={4}>
                        {onlineExecutors.map(ex => (
                          <Checkbox
                            key={ex.id}
                            checked={selectedExecutors.includes(ex.id)}
                            onChange={e => setSelectedExecutors(sel =>
                              e.target.checked ? [...sel, ex.id] : sel.filter(id => id !== ex.id)
                            )}
                          >
                            <Space size="small">
                              <Text strong>{ex.name}</Text>
                              <Badge status="success" />
                              <Text type="secondary" style={{ fontSize: 12 }}>{ex.address}</Text>
                            </Space>
                          </Checkbox>
                        ))}
                      </Space>
                    )}
                  </Card>
                )}
              </>
            )}
          </Space>
        ) : (
          <Space orientation="vertical" style={{ width: '100%' }}>
            <Text strong>{t('execPkg.push.resultTitle')}</Text>
            {pushResults.map((r, i) => {
              // 遗留 P1-10：后端 push 响应补 per-executor 明细（executorId/commandId/
              // status/error）。优先读 status（queued/success/error），向后兼容旧布尔。
              const status: 'queued' | 'success' | 'error' =
                r.status ?? (r.queued ? 'queued' : r.success ? 'success' : 'error');
              return (
                <Alert
                  key={i}
                  // P1-10：queued（执行器忙、安装已入队异步执行）既不是绿色成功也不是
                  // 红色失败——旧实现 success=true 的 queued 行显示成绿色成功，让管理员
                  // 误以为包已装好；失败/入队/成功三态必须区分。
                  type={status === 'queued' ? 'info' : status === 'success' ? 'success' : 'error'}
                  showIcon
                  title={
                    <>
                      <Text strong>{r.address || t('execPkg.push.task')}</Text>
                      {status === 'queued' && <Text type="secondary"> — {t('execPkg.push.queued')}</Text>}
                      {r.commandId && <Text type="secondary"> — {t('execPkg.push.commandId', { id: r.commandId })}</Text>}
                      {r.error && <Text type="danger"> — {r.error}</Text>}
                    </>
                  }
                />
              );
            })}
          </Space>
        )}
      </Modal>
    </div>
  );
}
