# 事故报告：admin-api OOM 崩溃（2026-09-23）

## 1. 现象

- 生产域名 `redirct.yskj.cc.cd` 的 `/api/*` 自 2026-09-23 01:33 起持续 502。
- Nginx `AutoCodeFlow.error.log` 从 01:34 起满屏：
  `connect() failed (111: Connection refused) while connecting to upstream ... 127.0.0.1:3105`
- 受影响的接口包括 executor 节点的 `POST /api/executors/pull`、`/api/executors/heartbeat`、`GET /api/health`。

## 2. 结论（一句话）

**admin-api 进程被内核 OOM killer 击杀。** 直接诱因是上传接口在内存已接近饱和的机器上产生瞬时内存峰值；系统 Swap = 0，没有缓冲，内核直接杀掉进程。

---

## 3. 证据链

### 3.1 内核 OOM 记录（dmesg / journalctl）

```
[Wed Sep 23 01:18:59 2026] Out of memory: Killed process 930768 (MainThread)
    total-vm:2115708kB, anon-rss:685692kB, UID:0
[Wed Sep 23 01:19:21 2026] Out of memory: Killed process 930762 (MainThread)
    total-vm:2162352kB, anon-rss:732876kB
[Wed Sep 23 01:24:20 2026] Out of memory: Killed process 930761 (MainThread)
    total-vm:2365784kB, anon-rss:880864kB
```

击杀时刻的内存现场（Node 0）：

```
Node 0 Normal    free:37412kB  min:42184kB   <- 已低于 min 水位
Node 0 DMA32     free:45304kB  min:25264kB
Node 0 active_anon:4087060kB  inactive_anon:3258700kB
```

即：**可用内存已跌破内核保留水位**，触发 `__alloc_pages_may_oom`。

### 3.2 上传请求与崩溃同秒（Nginx access log）

```
[23/Sep/2026:01:33:11] POST /api/applications/upload  201 523
[23/Sep/2026:01:33:11] GET  /api/applications        502 552   <- 同一秒即崩
[23/Sep/2026:01:33:12] GET  /api/applications        502 552
... 之后全部 502 / Connection refused
```

**上传返回 201 的同一秒，服务即不可达。** 关联性极强。

### 3.3 系统内存（崩溃后复查）

```
              total   used   free  buff/cache  available
Mem:           7749   4532    168        3429       3217
Swap:             0      0      0     <- 完全没有 Swap
```

`java -jar application.jar` 单进程占 898MB，MySQL 495MB，另一 mysqld 379MB，启动于 01:17——**在上传发生前，内存余量已被压缩到很低**。

### 3.4 当前进程状态（重要）

```
$ pgrep -af 'dist/src/main.js'
4317 node dist/src/main.js          <- 进程仍在，cgroup=/system.slice/bt.service
$ ps -o pid,nlwp,rss,cmd -p 4317
4317  20  369588  node dist/src/main.js
$ ss -lntp | grep 3105
(无输出)                             <- 但 3105 没有监听
$ curl /api/health/live
000                                 <- 健康检查不通
```

**注意：4317 这个 admin-api 进程并没有死，仍在运行（RSS 369MB、20 线程），但已不再监听 3105 端口。**
这说明它要么卡在某个未完成的启动/初始化阶段，要么端口绑定已丢失，处于**僵死（zombie-ish / wedged）状态**。
宝塔（bt.service）当前 pm2 列表为空，说明没有进程守护把它拉起来。

---

## 4. 根因分析

### 4.1 触发点：上传路径的瞬时内存放大

代码位置：
- `apps/admin-api/src/modules/application/application.controller.ts`（`upload` 方法）
- `apps/admin-api/src/common/utils/zip-guard.util.ts`（`assertZipFileSafe`）

流程：
1. multer 用 `diskStorage` 把包落到 `uploads/.app-upload-tmp`（限 200MB），**这层不占堆**，设计正确。
2. 进入 `assertZipFileSafe(tmpPath)` 做 zip-bomb 校验。
3. 发现包内 `.zip` 成员时，`readNestedZipSliceFromFile()` 会执行：

```ts
if (method === 8) {
  return inflateRawSync(payload, { maxOutputLength: uncompressedSize });
}
```

**它把嵌套 zip 成员一次性完整解压到 Node 堆。**

### 4.2 限制值过大，形同虚设

```ts
export const ZIP_GUARD_DEFAULT_LIMITS: ZipGuardLimits = {
  maxRatio: 100,
  maxEntries: 10_000,
  maxFileBytes: 1024 * 1024 * 1024,          // 1 GiB 单文件
  maxTotalUncompressedBytes: 2 * 1024 * 1024 * 1024,  // 2 GiB 总量
  maxNestingDepth: 1,
};
```

上传上限是 200MB，但**解压上限允许 1GiB/2GiB**。一个声称为 "1GiB 解压后" 的嵌套成员，会瞬间申请 GB 级堆内存——在 7.7GB 且已被占满的机器上足以触发 OOM。

### 4.3 叠加放大点

- `express.json({ limit: "55mb" })` + `express.json({ limit: "1mb" })`（`main.ts:95-106`）
- `readManifestFromZip(zipPath)` 解析 manifest 也会读取内容

### 4.4 无兜底

- **Swap = 0**：堆冲高时没有任何缓冲，内核只能杀进程。
- **无 `--max-old-space-size` 限制**：单进程可以一路吃到整机内存才被 OOM-killed。
- **无进程守护**：宝塔 pm2 列表为空，进程被杀后没有自动拉起，导致故障持续。

---

## 5. 关键疑点 / 未证实项

1. **4317 僵死原因未完全确证**——它没死但没监听端口，通常是启动流程在 Redis/DB/端口绑定环节卡住。需要看它的 stdout 才能定论。
2. **本次上传的包仅 9KB**（`refund-sync_1790098391110.zip`，内含 main.py/manifest.yaml/VERSION），**并非恶意 zip-bomb**。所以本次 OOM 是"小包 + 内存已饱和"共同触发，不代表必须大包才会崩。
3. **OOM 击杀的 `MainThread` PID(930761/930762/930768) 与当前 4317 不是同一个进程**——说明崩溃时刻前后有多次重启尝试，多次都在相同内存压力下被杀。

---

## 6. 建议的修复方向（本次未实施）

### 6.1 止血
- **加 2–4GB Swap**（`fallocate` + `mkswap` + `swapon`），给堆峰值一个缓冲。
- **给 Node 加 `--max-old-space-size=1024`**，让 V8 在崩溃前自行 GC/报错，而不是拖垮整机。
- **用 pm2 / 宝塔 Node 守护进程**，配置 `max_memory_restart` 与自启，确保被杀后自动拉起。

### 6.2 根治
- 把 `ZIP_GUARD_DEFAULT_LIMITS` 下调到与上传上限匹配：
  `maxFileBytes: 200MB`、`maxTotalUncompressedBytes: 400MB`。
- 把 `readNestedZipSliceFromFile` 的 `inflateRawSync` 改为**流式解压 + 累计上限**，避免一次性全量入堆。
- 评估上传接口是否需要串行/限流，避免并发上传同时解压。

---

## 7. 影响面

- executor 节点（119.145.34.48 / 154.217.234.30）持续上报失败，**任务拉取中断**。
- 前端 `/applications` 页面所有 API 请求 502。
- 服务当前**仍未恢复**（4317 僵死 + 3105 未监听），需人工介入。

---

*报告生成时间：2026-09-23 01:36（+0800）*
*排查方式：dmesg/journalctl + Nginx 日志 + 进程/cgroup + 代码走查；未做任何变更。*
