#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# install.sh artifact sha256 校验回归自检（E-P2-P6，阶段一跨端 sha256 校验）
#
# 本机无 admin-api、无真下载——验收路径为：
#   1) bash -n scripts/install.sh 语法检查；
#   2) 静态断言 install.sh 仍保留 X-SHA256 提取 + sha256sum -c 校验标记
#      （防止后续编辑把校验块误删/改名而不报警）；
#   3) 行为回放：用合成的「响应头文件」+「落盘 tarball」跑与 install.sh
#      逐字节一致的提取/校验管线，钉住三态——
#        - 头值与字节一致 → 校验通过（rc0）；
#        - 头值与字节不符  → 非零退出（删除可疑产物）；
#        - 无 X-SHA256 头  → 容忍放行（rc0，走既有 tar 结构检查）。
#
# 用法：bash scripts/install-artifact-sha256.selftest.sh   # 全过 rc0，否则 rc1
# ═══════════════════════════════════════════════════════════════════════════
set -uo pipefail
cd "$(dirname "$0")/.."

pass=0
fail=0
ok()  { printf '  ok    %s\n' "$1"; pass=$((pass + 1)); }
bad() { printf '  FAIL  %s\n' "$1"; fail=$((fail + 1)); }

# 与 scripts/install.sh 中 E-P2-P6 块逐字节一致的提取/校验管线（TMP_HEADERS /
# TMP_PKG 由调用方以同名变量传入）。改 install.sh 时必须同步这里。
run_verify_pipeline() {
  EXPECTED_SHA="$(grep -i '^X-SHA256:' "$TMP_HEADERS" | tr -d '\r' | awk '{print $2}' | tail -n1 | tr '[:upper:]' '[:lower:]' || true)"
  if [[ -n "$EXPECTED_SHA" ]]; then
    echo "$EXPECTED_SHA  $TMP_PKG" > "${TMP_PKG}.sha256"
    if ! sha256sum -c "${TMP_PKG}.sha256" >/dev/null 2>&1; then
      return 2   # mismatch：install.sh 此处删除产物并 exit 1
    fi
    return 0     # match
  fi
  return 1       # no header：容忍放行
}

TMP="$(mktemp -d /tmp/acf-install-sha256-selftest.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

# 造一个「tarball」与它的真实 sha256（任意非空字节即可）。
echo "fake-tarball-bytes" > "$TMP/pkg.tar.gz"
GOOD_SHA="$(sha256sum "$TMP/pkg.tar.gz" | awk '{print $1}')"
BAD_SHA="0000000000000000000000000000000000000000000000000000000000000000"

echo "== 0) bash -n 语法 =="
if bash -n scripts/install.sh 2>&1; then
  ok "bash -n scripts/install.sh"
else
  bad "bash -n scripts/install.sh"
fi

echo "== 1) 静态标记未被误删 =="
grep -q "grep -i '^X-SHA256:'" scripts/install.sh \
  && ok "install.sh 仍含 X-SHA256 头提取" || bad "install.sh 丢失 X-SHA256 提取"
grep -q "sha256sum -c" scripts/install.sh \
  && ok "install.sh 仍含 sha256sum -c 校验" || bad "install.sh 丢失 sha256sum -c"
grep -q 'sha256 校验失败' scripts/install.sh \
  && ok "install.sh 仍含 sha256 失败报错路径" || bad "install.sh 丢失 sha256 失败报错路径"

echo "== 2) 行为回放三态 =="

# 2a) match：头值 == 字节 sha256
printf 'HTTP/1.1 200 OK\r\nX-SHA256: %s\r\nContent-Length: 18\r\n' "$GOOD_SHA" > "$TMP/h-good.txt"
TMP_HEADERS="$TMP/h-good.txt" TMP_PKG="$TMP/pkg.tar.gz" run_verify_pipeline
rc=$?
if [[ $rc -eq 0 ]]; then ok "头值与字节一致 → 校验通过"; else bad "match 态（rc=${rc}）"; fi

# 2b) mismatch：头值 != 字节 sha256 → 非零退出
printf 'HTTP/1.1 200 OK\r\nX-SHA256: %s\r\n' "$BAD_SHA" > "$TMP/h-bad.txt"
TMP_HEADERS="$TMP/h-bad.txt" TMP_PKG="$TMP/pkg.tar.gz" run_verify_pipeline
rc=$?
if [[ $rc -eq 2 ]]; then ok "头值与字节不符 → 非零退出"; else bad "mismatch 态（rc=${rc}）"; fi

# 2c) no header：响应无 X-SHA256 → 容忍放行
printf 'HTTP/1.1 200 OK\r\nContent-Type: application/gzip\r\n' > "$TMP/h-none.txt"
TMP_HEADERS="$TMP/h-none.txt" TMP_PKG="$TMP/pkg.tar.gz" run_verify_pipeline
rc=$?
if [[ $rc -eq 1 ]]; then ok "无 X-SHA256 头 → 容忍放行"; else bad "no-header 态（rc=${rc}）"; fi

# 2d) 跨跳多响应头块：首个块带错误头，末块（最终响应）带正确头 → 取末条
printf 'HTTP/1.1 302 Found\r\nX-SHA256: %s\r\n\r\nHTTP/1.1 200 OK\r\nX-SHA256: %s\r\n' "$BAD_SHA" "$GOOD_SHA" > "$TMP/h-multi.txt"
TMP_HEADERS="$TMP/h-multi.txt" TMP_PKG="$TMP/pkg.tar.gz" run_verify_pipeline
rc=$?
if [[ $rc -eq 0 ]]; then ok "多响应头块取末条 → 校验通过"; else bad "multi-header 态（rc=${rc}）"; fi

# 2e) 大写头名 + CRLF 不影响提取（HTTP 头名不区分大小写、尾随 CRLF）
printf 'HTTP/1.1 200 OK\r\nx-sha256: %s\r\n' "$GOOD_SHA" > "$TMP/h-lower.txt"
TMP_HEADERS="$TMP/h-lower.txt" TMP_PKG="$TMP/pkg.tar.gz" run_verify_pipeline
rc=$?
if [[ $rc -eq 0 ]]; then ok "小写头名 + CRLF → 校验通过"; else bad "lowercase-header 态（rc=${rc}）"; fi

echo
if [[ $fail -eq 0 ]]; then
  echo "✓ install.sh artifact sha256 自检全部通过（$pass 例）"
  exit 0
else
  echo "✗ install.sh artifact sha256 自检失败 $fail / $pass 例" >&2
  exit 1
fi
