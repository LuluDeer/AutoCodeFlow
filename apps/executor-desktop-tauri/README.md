# Tauri 2 POC（执行器客户端外壳可行性验证）

> **状态：POC，不可发布。** 仅验证「同一份 V2 渲染层能否在 Tauri/WebKitGTK 上跑起来」。
> 不含 IPC 桥、托盘、更新器、sidecar 拉起与打包签名 —— 这些仍由 Electron 版承担。

## 结论

可行，但**不建议现在切换**：

- ✅ Tauri 2.12.4 + WebKitGTK 4.1 能完整渲染 V2（见 `../executor-desktop-v2/screenshots/tauri-poc.png`）；
- ⚠️ 渲染层没有 `window.electronAPI`，POC 里落到 mock bridge，看到的是模拟数据；
- ⚠️ 真迁移要把 `apps/executor-desktop/src/main` 的 15.8k 行能力（进程监管、托盘、更新器、配置、日志、Agent）重写成 Rust；
- ⚠️ 体积省不下来：安装包大头是 `executor-node` / `playwright` / Electron 运行时，sidecar 迁移前 Tauri 也要带同样资源。

## 构建（Ubuntu 24.04，无 sudo 的可行路径）

系统只缺**开发头文件**（运行库已装：`libwebkit2gtk-4.1.so.0`）。无法 `apt install` 时，
可以用用户级 sysroot：

```bash
# 1) 下载开发包（不需要 root）
mkdir -p /tmp/tauri-debs /tmp/tauri-sysroot && cd /tmp/tauri-debs
apt-get download libwebkit2gtk-4.1-dev libjavascriptcoregtk-4.1-dev libsoup-3.0-dev \
  libgtk-3-dev libglib2.0-dev libgdk-pixbuf-2.0-dev libpango1.0-dev libcairo2-dev \
  libatk1.0-dev libatk-bridge2.0-dev libharfbuzz-dev libfribidi-dev libx11-dev \
  libxext-dev libxrender-dev libxi-dev libxfixes-dev libxcursor-dev libxrandr-dev \
  libxdamage-dev libxcomposite-dev libwayland-dev libxkbcommon-dev libepoxy-dev \
  libegl-dev libgl-dev libglx-dev libgles-dev libgbm-dev libmount-dev libselinux1-dev \
  libpcre2-dev libffi-dev zlib1g-dev libpng-dev libjpeg-dev libtiff-dev libwebp-dev \
  libxml2-dev libsqlite3-dev libicu-dev libxslt1-dev libenchant-2-dev libsecret-1-dev \
  libjson-glib-dev libgstreamer1.0-dev libgstreamer-plugins-base1.0-dev libpsl-dev \
  libnghttp2-dev libbrotli-dev libgraphite2-dev libxcb1-dev libxcb-render0-dev \
  libxcb-shm0-dev libpixman-1-dev libxcb-util-dev libthai-dev \
  libsysprof-capture-4-dev libdatrie-dev libatspi2.0-dev libxtst-dev libxinerama-dev
for f in *.deb; do dpkg-deb -x "$f" /tmp/tauri-sysroot; done

# 2) 链接器需要无版本号的 .so：把系统运行库补进 sysroot（跟随软链拷贝实体）
cd /tmp/tauri-sysroot/usr/lib/x86_64-linux-gnu
for l in *.so; do
  t=$(readlink "$l"); [ -e "$t" ] && continue
  cp -L --remove-destination "/lib/x86_64-linux-gnu/$t" "$t"
done

# 3) Rust（用户级）
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
```

## 构建与运行

```bash
cd apps/executor-desktop-v2 && npm run build && cd -

export PATH="$HOME/.cargo/bin:$PATH"
export PKG_CONFIG_SYSROOT_DIR=/tmp/tauri-sysroot
export PKG_CONFIG_PATH=/tmp/tauri-sysroot/usr/lib/x86_64-linux-gnu/pkgconfig:/tmp/tauri-sysroot/usr/share/pkgconfig

cargo build --manifest-path apps/executor-desktop-tauri/src-tauri/Cargo.toml

# 本机（VM）需要关掉 WebKit 的 DMA-BUF 合成，否则窗口不出现
GDK_BACKEND=x11 WEBKIT_DISABLE_DMABUF_RENDERER=1 WEBKIT_DISABLE_COMPOSITING_MODE=1 \
  apps/executor-desktop-tauri/src-tauri/target/debug/acf-executor-tauri
```

有 sudo 的机器直接 `apt install libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev`
即可，不需要 sysroot。

## 配置

`src-tauri/tauri.conf.json` 直接把 `frontendDist` 指到 `../../executor-desktop-v2/dist`，
不复制产物；`bundle.active=false`，POC 只出二进制。

## 下一步（如果要做真迁移）

1. 用 Rust command 复刻 `preload` 的接口（配置、执行器状态、日志流、历史、应用、更新）；
2. 托盘 / 单实例 / 自启 / 更新器分别对 `tray-icon`、`single-instance`、`autostart`、`updater`；
3. sidecar：`tauri-plugin-shell` 拉起现有 `executor-node`（产物已在 `resources/`）；
4. 打包签名与 CI（AppImage/deb/NSIS/dmg）重做；
5. 迁移期保留 Electron 版，通过 `ACF_RENDERER` 式的开关切换。
