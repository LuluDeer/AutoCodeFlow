#!/usr/bin/env bash
#
# AutoCodeFlow 一键部署脚本 —— 双模（源码 / Docker）
#
# ── 为什么存在这个脚本 ─────────────────────────────────────────────
# 旧的 deploy.sh 只会 Docker Compose，而生产端需要源码部署（性能考虑：
# 执行器高频 fork 短命任务，容器网络/overlayfs/命名空间开销是复利的）。
# 源码部署此前等于「照 docs/deployment.md 手工敲 76KB 文档」——本脚本
# 把那套流程固化为可重入、可诊断、可回滚的流水线。
#
# ── 设计纪律（与项目既有约定对齐）─────────────────────────────────
#   · 向后兼容：不带 --mode 时默认 docker，行为与旧 deploy.sh 一致
#   · 配置单一来源：两种模式都读根 .env，行为不漂移
#   · 幂等可重入：重复执行不破坏已有数据/配置
#   · fail-fast：不静默降级（沿用 install.sh 的 set -euo pipefail 姿态）
#   · 不重造轮子：复用 scripts/pg-backup.sh、scripts/warm-interpreters.sh、
#     infra/docker-compose.yml 等既有资产
#
# ── 用法 ──────────────────────────────────────────────────────────
#   ./deploy.sh [--mode source|docker] [--env ...] [选项]
#   ./deploy.sh doctor [--json]
#   ./deploy.sh status|health|logs|restart|rollback
#
# 详见 ./deploy.sh --help 与 docs/design/agent-and-deployment/01-deployment.md

set -euo pipefail

# ── 路径与常量 ────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$SCRIPT_DIR"
readonly SCRIPT_DIR ROOT_DIR

readonly MANIFEST_FILE="$ROOT_DIR/.deploy-manifest.json"
readonly MANIFEST_PREV="$ROOT_DIR/.deploy-manifest.prev.json"
readonly DEPLOY_STATE_DIR="$ROOT_DIR/.deploy-state"
# 迁移前备份的失败原因日志（审计二轮 B-1）。logs/ 已 gitignore；备份**成功**
# 时会删除该文件，避免下次失败时误读到上一次的旧原因。
readonly PG_BACKUP_ERR_LOG="$ROOT_DIR/logs/pg-backup-last-error.log"

# 组件清单（源码模式下逐组件构建/启动）
readonly NODE_COMPONENTS="admin-api admin-web executor-node"
readonly PYTHON_COMPONENTS="executor-python"

# 端口（与 .env.example / docs/deployment.md 对齐）
readonly PORT_ADMIN_API=3105
readonly PORT_ADMIN_WEB=80
readonly PORT_EXECUTOR_NODE=8002
readonly PORT_EXECUTOR_PYTHON=8001
readonly PORT_POSTGRES=5432
readonly PORT_REDIS=6379

# systemd 服务前缀（源码模式）
readonly SYSTEMD_PREFIX="acf"
readonly ACF_SYSTEM_USER="acf"
readonly ACF_INSTALL_DIR="/opt/autocodeflow"

# ── 颜色（非 TTY 时自动关闭，便于日志采集）────────────────────────
if [ -t 1 ]; then
    RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
    BLUE='\033[0;34m'; BOLD='\033[1m'; NC='\033[0m'
else
    RED=''; GREEN=''; YELLOW=''; BLUE=''; BOLD=''; NC=''
fi
readonly RED GREEN YELLOW BLUE BOLD NC

# ── 输出通道 ──────────────────────────────────────────────────────
# JSON_MODE=true 时，一切人类可读输出改走 stderr，stdout 只留结构化 JSON。
# 为什么必须这样：机器消费方（中台 Agent 的 run_doctor 工具）会 `--json | jq`，
# 任何混进 stdout 的进度行都会让 JSON 解析失败（实测踩过）。
JSON_MODE=false
OUT_FD=1
refresh_out_fd() {
    if [ "$JSON_MODE" = true ]; then OUT_FD=2; else OUT_FD=1; fi
}

log()  { printf '%b\n' "${BLUE}==>${NC} $*" >&"$OUT_FD"; }
ok()   { printf '%b\n' "${GREEN}✔${NC} $*" >&"$OUT_FD"; }
warn() { printf '%b\n' "${YELLOW}⚠${NC} $*" >&2; }
err()  { printf '%b\n' "${RED}✘${NC} $*" >&2; }
die()  { err "$*"; exit 1; }

hr() { printf '%b\n' "${BOLD}────────────────────────────────────────────────────────${NC}" >&"$OUT_FD"; }

# ── 默认参数 ──────────────────────────────────────────────────────
MODE="docker"          # docker | source —— 默认 docker 保持向后兼容
ENV_NAME="development" # development | staging | production
BUILD=false
DETACH=true
COMPONENTS=""
WITH_PROFILES=""
DRY_RUN=false
ASSUME_YES=false
I_KNOW_ITS_PRODUCTION=false
SKIP_PREFLIGHT=false
SUBCOMMAND=""
SUBCOMMAND_ARGS=()

usage() {
    cat <<'EOF'
AutoCodeFlow 一键部署脚本（源码 / Docker 双模）

用法:
  ./deploy.sh [选项]                    部署
  ./deploy.sh <子命令> [选项]           运维操作

子命令:
  doctor                  只诊断不部署（检查环境、配置、服务状态）
  status                  查看各组件运行状态
  health                  深度健康检查（含 DB/Redis/执行器连通性）
  logs <component>        查看日志（源码=journalctl，docker=compose logs）
  restart <component>     重启单个组件
  rollback                回滚到上一版本（仅代码，迁移需人工确认）
  help                    显示本帮助

部署选项:
  --mode <source|docker>      部署模式（默认 docker，保持旧行为）
  --env <dev|staging|prod>    环境（默认 development）
  --component <name,...>      只部署指定组件（滚动升级）
  --with <monitoring,backup>  启用附加 profile
  --build                     Docker 模式强制重建镜像
  --no-detach                 前台运行（仅 Docker 模式）
  --dry-run                   只打印将执行的步骤，不改系统
  --yes                       非交互（CI 用）
  --i-know-its-production     生产模式额外确认（防误操作）
  --skip-preflight            跳过预检（排障用，不推荐）

示例:
  sudo ./deploy.sh --mode source --env production       # 生产源码部署
  ./deploy.sh --mode docker --env staging --build       # 试跑环境
  ./deploy.sh doctor --json                             # 结构化体检（Agent 用）
  ./deploy.sh --mode source --component admin-api       # 只滚动 admin-api
EOF
}

# ── 参数解析 ──────────────────────────────────────────────────────
#
# 分两步：① 先摘出子命令（子命令有自己的参数，如 `doctor --json`）；
#         ② 再解析部署选项。
# 为什么必须分开：`--json` 只属于 doctor，若先跑部署选项解析器会直接
# 「未知参数」报错（实测踩过）。
parse_args() {
    if [ $# -gt 0 ]; then
        case "$1" in
            doctor|status|health|logs|restart|rollback|help)
                SUBCOMMAND="$1"; shift ;;
        esac
    fi

    # 子命令一旦确定，其余参数交给它自己解析（见 main 的分发）
    [ -n "$SUBCOMMAND" ] && { SUBCOMMAND_ARGS=("$@"); return 0; }

    while [ $# -gt 0 ]; do
        case "$1" in
            --mode)          MODE="${2:-}"; shift 2 ;;
            --mode=*)        MODE="${1#*=}"; shift ;;
            --env)           ENV_NAME="${2:-}"; shift 2 ;;
            --env=*)         ENV_NAME="${1#*=}"; shift ;;
            --component)     COMPONENTS="${2:-}"; shift 2 ;;
            --component=*)   COMPONENTS="${1#*=}"; shift ;;
            --with)          WITH_PROFILES="${2:-}"; shift 2 ;;
            --with=*)        WITH_PROFILES="${1#*=}"; shift ;;
            --build)         BUILD=true; shift ;;
            --no-detach)     DETACH=false; shift ;;
            --dry-run)       DRY_RUN=true; shift ;;
            --yes|-y)        ASSUME_YES=true; shift ;;
            --i-know-its-production) I_KNOW_ITS_PRODUCTION=true; shift ;;
            --skip-preflight) SKIP_PREFLIGHT=true; shift ;;
            -h|--help|help)  usage; exit 0 ;;
            *) die "未知参数: $1（用 --help 查看用法）" ;;
        esac
    done

    case "$MODE" in
        source|docker) ;;
        *) die "--mode 只能是 source 或 docker（收到: ${MODE}）" ;;
    esac

    case "$ENV_NAME" in
        development|dev)      ENV_NAME="development" ;;
        staging|stage)        ENV_NAME="staging" ;;
        production|prod)      ENV_NAME="production" ;;
        *) die "--env 只能是 development|staging|production（收到: ${ENV_NAME}）" ;;
    esac
}

# ── 运行命令的包装（--dry-run 时只打印）───────────────────────────
run() {
    if [ "$DRY_RUN" = true ]; then
        printf '%b\n' "  ${YELLOW}[dry-run]${NC} $*"
        return 0
    fi
    "$@"
}

# 需要 root 的操作（源码模式的 systemd/文件写入）
run_root() {
    if [ "$DRY_RUN" = true ]; then
        printf '%b\n' "  ${YELLOW}[dry-run]${NC} $*"
        return 0
    fi
    if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo "$@"; fi
}

# ── compose 命令探测（E-28 既有纪律：v2 插件优先，回退 v1 二进制）──
compose() {
    if docker compose version >/dev/null 2>&1; then
        docker compose "$@"
    elif command -v docker-compose >/dev/null 2>&1; then
        docker-compose "$@"
    else
        die "Docker Compose 未安装（需要 \`docker compose\` v2 插件或 docker-compose v1）"
    fi
}

have() { command -v "$1" >/dev/null 2>&1; }

# ── 平台探测 ──────────────────────────────────────────────────────
detect_platform() {
    case "$(uname -s)" in
        Linux*)  PLATFORM="linux" ;;
        Darwin*) PLATFORM="macos" ;;
        MINGW*|MSYS*|CYGWIN*) PLATFORM="windows" ;;
        *)       PLATFORM="unknown" ;;
    esac
    readonly PLATFORM 2>/dev/null || true
}

# ══════════════════════════════════════════════════════════════════
# ① 预检 Preflight
# ══════════════════════════════════════════════════════════════════

# 收集预检结果到全局数组（供 doctor 复用）
declare -a PREFLIGHT_ROWS=()

# add_row <名称> <状态枚举 ok|warn|fail> <详情>
add_row() {
    PREFLIGHT_ROWS+=("$1|$2|$3")
}

check_version_ge() {
    # 语义化版本比较：check_version_ge <实际> <要求>
    local actual="$1" required="$2"
    [ "$(printf '%s\n%s\n' "$required" "$actual" | sort -V | head -n1)" = "$required" ]
}

preflight() {
    log "① 预检 Preflight"
    PREFLIGHT_ROWS=()

    # 平台
    detect_platform
    case "$PLATFORM" in
        linux)   add_row "平台" ok "Linux $(uname -r)" ;;
        macos)   add_row "平台" warn "macOS（源码模式的 systemd 不可用——将改用 launchd/手动）" ;;
        windows) add_row "平台" fail "Windows 原生不受支持（源码模式依赖 systemd）" ;;
        *)       add_row "平台" fail "未知平台: $(uname -s)" ;;
    esac

    # 源码模式必需：Bash 4+
    if [ "$MODE" = "source" ]; then
        local bash_major="${BASH_VERSINFO[0]:-0}"
        if [ "$bash_major" -ge 4 ]; then
            add_row "Bash" ok "${BASH_VERSION}"
        else
            add_row "Bash" fail "需要 Bash >= 4（当前 ${BASH_VERSION}）"
        fi
    fi

    # Docker（两模式都需要：源码模式用它跑 PG/Redis）
    if have docker; then
        if docker info >/dev/null 2>&1; then
            add_row "Docker" ok "$(docker --version | cut -d, -f1)"
        else
            add_row "Docker" warn "已安装但守护进程不可达（当前用户无权限？）"
        fi
    else
        add_row "Docker" fail "未安装（PostgreSQL/Redis 依赖它，或用 --infra external）"
    fi

    # Node / npm（源码模式必需）
    if [ "$MODE" = "source" ]; then
        if have node; then
            local node_v; node_v="$(node --version | sed 's/^v//')"
            if check_version_ge "$node_v" "20.0.0"; then
                add_row "Node.js" ok "v$node_v"
            else
                add_row "Node.js" fail "需要 >= 20（当前 v${node_v}）"
            fi
        else
            add_row "Node.js" fail "未安装（源码模式必需）"
        fi

        if have npm; then
            local npm_v; npm_v="$(npm --version)"
            if check_version_ge "$npm_v" "10.0.0"; then
                add_row "npm" ok "v$npm_v"
            else
                add_row "npm" warn "建议 >= 10（当前 v${npm_v}）"
            fi
        else
            add_row "npm" fail "未安装（源码模式必需）"
        fi

        # Python（executor-python 需要；缺了只影响该组件）。
        # `have python3` 只证明「PATH 上有这个名字」，不证明它真的能跑——
        # Windows 会给 python3 装 Microsoft Store 占位 stub（command -v 命中、
        # 实跑必败且退出码非零，在 set -euo pipefail 下直接打死脚本）。
        # 故先用 `--version` 实跑一次验真，坏 stub 当作未安装处理。
        local py_bin=""
        if have python3 && python3 --version >/dev/null 2>&1; then
            py_bin="python3"
        elif have python && python --version >/dev/null 2>&1; then
            py_bin="python"
        fi
        if [ -n "$py_bin" ]; then
            local py_v; py_v="$("$py_bin" --version 2>&1 | awk '{print $2}' || true)"
            if check_version_ge "$py_v" "3.11.0"; then
                add_row "Python" ok "$py_v"
            else
                add_row "Python" warn "建议 >= 3.11（当前 ${py_v:-不可用}，仅影响 executor-python）"
            fi
        else
            add_row "Python" warn "未安装（executor-python 组件将被跳过）"
        fi
    fi

    # 端口占用
    if [ "$MODE" = "source" ]; then
        check_port "$PORT_ADMIN_API"  "admin-api"
        check_port "$PORT_EXECUTOR_NODE" "executor-node"
        check_port "$PORT_ADMIN_WEB"  "admin-web(nginx)"
    fi

    check_port "$PORT_POSTGRES" "postgres"
    check_port "$PORT_REDIS"    "redis"

    # 磁盘
    local avail_gb
    avail_gb="$(df -Pk "$ROOT_DIR" 2>/dev/null | awk 'NR==2 {print int($4/1024/1024)}')"
    if [ -n "${avail_gb:-}" ]; then
        if [ "$avail_gb" -ge 10 ]; then
            add_row "磁盘可用" ok "${avail_gb} GB"
        else
            add_row "磁盘可用" warn "仅 ${avail_gb} GB（建议 >= 10 GB）"
        fi
    fi

    # 打印表格
    render_rows
}

# check_port <port> <用途> —— 被占用时判断是「本项目已有实例」还是「冲突」
check_port() {
    local port="$1" label="$2"
    local holder=""

    # 探测属 best-effort：探测命令非零（Git Bash 的 netstat 不认 -ltnp、
    # macOS 的 lsof 在端口空闲时退出 1）一律当「空闲」处理，绝不能让
    # set -euo pipefail 借命令替换的非零退出码把整个脚本打死——`2>/dev/null`
    # 只压掉报错文本，压不掉退出码（同 §实现陷阱 #2 的教训）。
    if have ss; then
        holder="$(ss -ltnp 2>/dev/null | awk -v p=":$port" '$4 ~ p {print $NF; exit}' || true)"
    elif have lsof; then
        holder="$(lsof -ti "tcp:$port" 2>/dev/null | head -n1 || true)"
    elif have netstat; then
        holder="$(netstat -ltnp 2>/dev/null | awk -v p=":$port" '$4 ~ p {print $7; exit}' || true)"
    fi

    if [ -z "$holder" ]; then
        add_row "端口 $port ($label)" ok "空闲"
    else
        # 占用本身不是失败——可能正是本项目在运行（重入场景）
        add_row "端口 $port ($label)" warn "被占用（${holder}）——若为既有实例则复用"
    fi
}

render_rows() {
    local name status detail
    printf '\n' >&"$OUT_FD"
    for row in "${PREFLIGHT_ROWS[@]}"; do
        IFS='|' read -r name status detail <<< "$row"
        case "$status" in
            ok)   printf '  %b %-26s %s\n' "${GREEN}✔${NC}" "$name" "$detail" >&"$OUT_FD" ;;
            warn) printf '  %b %-26s %s\n' "${YELLOW}⚠${NC}" "$name" "$detail" >&"$OUT_FD" ;;
            fail) printf '  %b %-26s %s\n' "${RED}✘${NC}" "$name" "$detail" >&"$OUT_FD" ;;
        esac
    done
    printf '\n' >&"$OUT_FD"
}

# 预检是否致命
preflight_gate() {
    local fails=0
    for row in "${PREFLIGHT_ROWS[@]}"; do
        IFS='|' read -r _ status _ <<< "$row"
        [ "$status" = "fail" ] && fails=$((fails + 1))
    done

    if [ "$fails" -gt 0 ]; then
        if [ "$PLATFORM" = "windows" ] && [ "$MODE" = "source" ]; then
            err "源码模式不支持 Windows 原生环境。"
            cat <<'EOF'

  Windows 部署请改用以下任一方式：
    1) Docker 模式（推荐）:  ./deploy.sh --mode docker
    2) WSL2 内的 Linux 环境:  在 WSL 里执行本脚本的源码模式
    3) 手动部署:             见 docs/deployment.md「Windows 部署」章节

EOF
        fi
        die "预检失败（$fails 项），已中止部署。用 --skip-preflight 可强制继续（不推荐）"
    fi
    ok "预检通过"
}

# ══════════════════════════════════════════════════════════════════
# ② 配置解析 Config
# ══════════════════════════════════════════════════════════════════

gen_secret() {
    if have openssl; then openssl rand -hex "$1"
    else head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'
    fi
}

# 从 .env 读键（不 source——避免值里的特殊字符被执行）
#
# 恒以 0 退出：缺失/文件不存在都返回空串。为什么关键——调用点普遍是
# `x="$(env_get KEY)"`，而 `set -e` 下命令替换里的非零返回会**直接中止脚本**。
# 实测踩过：`.env` 不存在时 dry-run 在配置阶段静默退出。
env_get() {
    local key="$1" file="${2:-$ROOT_DIR/.env}"
    [ -f "$file" ] || { printf ''; return 0; }
    # 取最后一个匹配（后定义覆盖前定义，与 shell 语义一致）
    local line
    line="$(grep -E "^${key}=" "$file" 2>/dev/null | tail -n1 || true)"
    printf '%s' "${line#*=}"
}

env_set() {
    # env_set <key> <value> —— 不存在则追加，存在则替换
    local key="$1" value="$2" file="$ROOT_DIR/.env"
    if grep -qE "^${key}=" "$file" 2>/dev/null; then
        # 用 | 作分隔符避免值里的 / 破坏 sed
        run sed -i.bak "s|^${key}=.*|${key}=${value}|" "$file"
        rm -f "${file}.bak" 2>/dev/null || true
    else
        printf '%s=%s\n' "$key" "$value" >> "$file"
    fi
}

config_phase() {
    log "② 配置解析 Config"

    local generated_env=false

    if [ ! -f "$ROOT_DIR/.env" ]; then
        if [ "$DRY_RUN" = true ]; then
            printf '%b\n' "  ${YELLOW}[dry-run]${NC} 将从 .env.example 生成 .env 并填充随机密钥"
            generated_env=true
        else
            warn ".env 不存在，从 .env.example 生成并自动填充强随机值"
            cp "$ROOT_DIR/.env.example" "$ROOT_DIR/.env"
            chmod 600 "$ROOT_DIR/.env" 2>/dev/null || true

            local jwt_secret jwt_refresh executor_secret redis_pass pg_pass
            jwt_secret="$(gen_secret 32)"
            jwt_refresh="$(gen_secret 32)"
            executor_secret="$(gen_secret 16)"
            redis_pass="$(gen_secret 16)"
            pg_pass="$(gen_secret 16)"

            env_set JWT_SECRET "$jwt_secret"
            env_set JWT_REFRESH_SECRET "$jwt_refresh"
            env_set EXECUTOR_SECRET "$executor_secret"
            env_set REDIS_PASSWORD "$redis_pass"
            env_set POSTGRES_PASSWORD "$pg_pass"
            env_set DB_PASSWORD "$pg_pass"
            ok "已生成 .env 并填充随机密钥（请妥善保管）"
            generated_env=true
        fi
    else
        ok ".env 已存在，复用现有配置"
    fi

    # 生产模式强校验。
    # 刚生成 .env 的情况跳过——密钥是本脚本用 openssl 现生成的，必然合规；
    # 此时校验只会因「dry-run 没真写盘」而误报（实测踩过：dry-run 下报
    # 一堆"当前 0 字符"，因为 env_get 读不到还没落盘的值）。
    if [ "$ENV_NAME" = "production" ]; then
        if [ "$generated_env" = true ]; then
            ok "生产配置：密钥由本脚本生成，视为合规"
        else
            validate_production_config
        fi
    fi
}

# 生产必填项校验——口径与 docs/deployment.md / README「生产环境必填项」一致
validate_production_config() {
    local problems=()

    local db_pass jwt_secret jwt_refresh executor_secret cors redis_pass
    db_pass="$(env_get DB_PASSWORD)"
    jwt_secret="$(env_get JWT_SECRET)"
    jwt_refresh="$(env_get JWT_REFRESH_SECRET)"
    executor_secret="$(env_get EXECUTOR_SECRET)"
    cors="$(env_get CORS_ORIGINS)"
    redis_pass="$(env_get REDIS_PASSWORD)"

    # 占位值检测（.env.example 里的 change_me 系列）
    local is_placeholder='^change_me|^$'

    [ "${#db_pass}" -ge 16 ] || problems+=("DB_PASSWORD 需 >= 16 字符（当前 ${#db_pass}）")
    [[ "$db_pass" =~ $is_placeholder ]] && problems+=("DB_PASSWORD 仍是占位值")

    [ "${#jwt_secret}" -ge 32 ] || problems+=("JWT_SECRET 需 >= 32 字符（当前 ${#jwt_secret}）")
    [[ "$jwt_secret" =~ $is_placeholder ]] && problems+=("JWT_SECRET 仍是占位值")

    [ "${#jwt_refresh}" -ge 32 ] || problems+=("JWT_REFRESH_SECRET 需 >= 32 字符（当前 ${#jwt_refresh}）")
    [[ "$jwt_refresh" =~ $is_placeholder ]] && problems+=("JWT_REFRESH_SECRET 仍是占位值")

    [ "${#executor_secret}" -ge 16 ] || problems+=("EXECUTOR_SECRET 需 >= 16 字符（当前 ${#executor_secret}）")
    [[ "$executor_secret" =~ $is_placeholder ]] && problems+=("EXECUTOR_SECRET 仍是占位值")

    [ "${#redis_pass}" -ge 16 ] || problems+=("REDIS_PASSWORD 需 >= 16 字符（当前 ${#redis_pass}）")

    if [ -z "$cors" ]; then
        problems+=("CORS_ORIGINS 未设置")
    elif printf '%s' "$cors" | grep -q 'localhost'; then
        problems+=("CORS_ORIGINS 生产环境不得含 localhost（当前: ${cors}）")
    fi

    if [ "${#problems[@]}" -gt 0 ]; then
        err "生产环境配置校验失败："
        for p in "${problems[@]}"; do printf '    · %s\n' "$p" >&2; done
        cat >&2 <<'EOF'

  生成强随机值：
    openssl rand -hex 32   # JWT_SECRET / JWT_REFRESH_SECRET
    openssl rand -hex 16   # EXECUTOR_SECRET / REDIS_PASSWORD / DB_PASSWORD

  详见 docs/deployment.md「必填环境变量」

EOF
        die "请修正 .env 后重试"
    fi

    ok "生产配置校验通过（密码强度 / 占位值 / CORS）"
}

# ══════════════════════════════════════════════════════════════════
# ③ 依赖 Dependencies
# ══════════════════════════════════════════════════════════════════

deps_phase() {
    log "③ 依赖准备 Dependencies"

    if [ "$MODE" = "docker" ]; then
        ok "Docker 模式：依赖在镜像内安装，跳过"
        return 0
    fi

    local components; components="$(resolve_components)"

    # 根依赖（workspace 载体）
    if [ -f "$ROOT_DIR/package.json" ]; then
        log "  安装根依赖..."
        run bash -c "cd '$ROOT_DIR' && npm ci --no-audit --no-fund 2>/dev/null || npm install --no-audit --no-fund"
    fi

    for c in $components; do
        case "$c" in
            executor-python)
                log "  安装 executor-python 依赖..."
                local py_bin; py_bin="$(have python3 && echo python3 || echo python)"
                if have uv; then
                    run bash -c "cd '$ROOT_DIR/apps/executor-python' && { [ -d .venv ] || uv venv .venv; } && uv pip install -r requirements.txt"
                else
                    run bash -c "cd '$ROOT_DIR/apps/executor-python' && { [ -d .venv ] || '$py_bin' -m venv .venv; } && .venv/bin/pip install -r requirements.txt"
                fi
                ;;
            *)
                if [ -f "$ROOT_DIR/apps/$c/package.json" ]; then
                    log "  安装 $c 依赖..."
                    run bash -c "cd '$ROOT_DIR/apps/$c' && npm ci --no-audit --no-fund 2>/dev/null || npm install --no-audit --no-fund"
                fi
                ;;
        esac
    done

    ok "依赖就绪"
}

# resolve_components —— 展开 --component 或返回全部
resolve_components() {
    if [ -n "$COMPONENTS" ]; then
        printf '%s\n' "$COMPONENTS" | tr ',' ' '
    else
        printf '%s %s\n' "$NODE_COMPONENTS" "$PYTHON_COMPONENTS"
    fi
}

component_enabled() {
    local target="$1"
    for c in $(resolve_components); do
        [ "$c" = "$target" ] && return 0
    done
    return 1
}

# ══════════════════════════════════════════════════════════════════
# ④ 构建 Build
# ══════════════════════════════════════════════════════════════════

build_phase() {
    log "④ 构建 Build"

    if [ "$MODE" = "docker" ]; then
        if [ "$BUILD" = true ]; then
            log "  构建 Docker 镜像（--build 指定）..."
            run compose build --no-cache
        else
            ok "Docker 模式：未指定 --build，跳过镜像构建（用现有镜像）"
        fi
        return 0
    fi

    for c in $(resolve_components); do
        case "$c" in
            executor-python) ok "  executor-python：Python 无需构建（解释执行）" ;;
            *)
                if [ -f "$ROOT_DIR/apps/$c/package.json" ]; then
                    log "  构建 $c..."
                    run bash -c "cd '$ROOT_DIR/apps/$c' && npm run build"
                fi
                ;;
        esac
    done

    write_manifest_artifacts
    ok "构建完成"
}

# ══════════════════════════════════════════════════════════════════
# ⑤ 基础设施 Infra
# ══════════════════════════════════════════════════════════════════

infra_phase() {
    log "⑤ 基础设施 Infra（PostgreSQL + Redis）"

    # 已有外部 DB（.env 指向非容器地址）→ 跳过
    local db_host; db_host="$(env_get DB_HOST)"
    if [ -n "$db_host" ] && [ "$db_host" != "postgres" ] && [ "$db_host" != "localhost" ] && [ "$db_host" != "127.0.0.1" ]; then
        ok "检测到外部数据库（DB_HOST=${db_host}），跳过本地 PG 启动"
    else
        if have docker; then
            log "  启动 PostgreSQL + Redis..."
            run compose -f "$ROOT_DIR/infra/docker-compose.yml" up -d
        else
            warn "Docker 不可用——跳过基础设施启动（请确保 PG/Redis 已在别处运行）"
        fi
    fi

    wait_for_postgres
    ok "基础设施就绪"
}

wait_for_postgres() {
    [ "$DRY_RUN" = true ] && { printf '%b\n' "  ${YELLOW}[dry-run]${NC} 等待 PostgreSQL 就绪"; return 0; }
    have docker || return 0
    [ "$(env_get DB_HOST)" = "postgres" ] || [ -z "$(env_get DB_HOST)" ] || return 0

    # 指数退避等待（替代 sleep 30 的硬等）
    log "  等待 PostgreSQL 接受连接..."
    local i=0 max=30
    while [ "$i" -lt "$max" ]; do
        if compose -f "$ROOT_DIR/infra/docker-compose.yml" exec -T postgres \
             pg_isready -U "$(env_get POSTGRES_USER || echo autoflow)" >/dev/null 2>&1; then
            ok "  PostgreSQL 已就绪（${i}s）"
            return 0
        fi
        i=$((i + 1))
        sleep 1
    done
    warn "  PostgreSQL 在 ${max}s 内未就绪——继续，但迁移可能失败"
}

# ══════════════════════════════════════════════════════════════════
# ⑥ 迁移 Migration
# ══════════════════════════════════════════════════════════════════

# 解析 .env 的数据库连接参数为「宿主机侧可达」的一组值（不 source .env，沿
# env_get 逐键读取），结果写入全局 DBF_* 变量，供 pg_dump/psql/node 查询共用。
#   · DB_HOST 是容器服务名（postgres）或为空 → 127.0.0.1：宿主机解析不了
#     compose 服务名，infra compose 把 5432 绑在 127.0.0.1 上；
#   · 密码 DB_PASSWORD / POSTGRES_PASSWORD 双兜底——.env 两套命名并存
#     （compose 注入的是后者），而 pg-backup.sh / psql 只认 PG*。
#   （审计二轮 B-1：旧迁移前备份默认必失败的根因正是这套命名断层——
#   pg-backup.sh 强依赖的 PGHOST/PGUSER/PGPASSWORD/PGDATABASE 只在根 compose
#   pg-backup 服务的 environment 里定义，deploy.sh 从不导出。）
parse_db_conn() {
    DBF_HOST="$(env_get DB_HOST)"
    case "$DBF_HOST" in ""|postgres) DBF_HOST="127.0.0.1" ;; esac
    DBF_PORT="$(env_get DB_PORT)";     [ -n "$DBF_PORT" ] || DBF_PORT=5432
    DBF_USER="$(env_get DB_USERNAME)"; [ -n "$DBF_USER" ] || DBF_USER="$(env_get POSTGRES_USER)"
    [ -n "$DBF_USER" ] || DBF_USER=autoflow
    DBF_PASS="$(env_get DB_PASSWORD)"; [ -n "$DBF_PASS" ] || DBF_PASS="$(env_get POSTGRES_PASSWORD)"
    DBF_NAME="$(env_get DB_DATABASE)"; [ -n "$DBF_NAME" ] || DBF_NAME=autoflow
}

# 空库探测：首次部署时库还没有任何表——空库 pg_dump 的 gzip 只有几百字节，
# pg-backup.sh 的 NETOPT-4 防截断阈值（1KB）必判「可疑小文件」而失败；而空库
# 本身也没有任何可备份内容。检测到空库就跳过备份，避免首次生产部署被自家
# 守卫卡死。探测失败（psql 不可用/连不上/口令缺失）一律按非空处理——保守
# 回落「照常备份」，让备份路径自己给出带日志的明确失败。
db_is_empty() {
    [ "$DRY_RUN" = true ] && return 1
    local out
    local count_sql="SELECT count(*) FROM information_schema.tables WHERE table_schema='public'"
    local db_host; db_host="$(env_get DB_HOST)"
    if [ "$MODE" = "docker" ] && { [ -z "$db_host" ] || [ "$db_host" = "postgres" ]; }; then
        # 借 pg-backup 服务连库：镜像即 postgres:16-alpine，environment 已带全套
        # PG*（PGHOST=postgres 指向主库）；compose run 会自动把 postgres 依赖
        # 先拉起来——迁移阶段 ⑦ start 尚未执行，首次部署时主库容器还没起。
        # 注意 --entrypoint 必须覆盖：服务默认 entrypoint 是起 crond 的脚本。
        out="$(compose -f "$ROOT_DIR/docker-compose.yml" --profile backup \
                  run --rm -T --entrypoint psql pg-backup -tAc "$count_sql" 2>/dev/null)" || return 1
    else
        have psql || return 1
        parse_db_conn
        [ -n "$DBF_PASS" ] || return 1
        out="$(PGPASSWORD="$DBF_PASS" psql -h "$DBF_HOST" -p "$DBF_PORT" -U "$DBF_USER" -d "$DBF_NAME" -tAc "$count_sql" 2>/dev/null)" || return 1
    fi
    [ "$(printf '%s' "$out" | tr -d '[:space:]')" = "0" ]
}

# 组装并执行备份命令（pre_migration_backup 的内层）。docker 模式与 source 模式
# 的分叉点；dry-run 只打印（口令以 ******** 掩码，不回显真实值）。
run_pre_migration_backup_cmd() {
    local db_host; db_host="$(env_get DB_HOST)"
    if [ "$MODE" = "docker" ] && { [ -z "$db_host" ] || [ "$db_host" = "postgres" ]; }; then
        # 与定时备份（profile backup）同一条服务定义：PG* 由 compose 注入、
        # 产物进 backup_data 卷、BACKUP_RETENTION_DAYS 保留策略共用。不能裸
        # `run pg-backup`——pg-backup-entrypoint.sh 无视参数起 crond 常驻，
        # 必须覆盖 entrypoint 直跑备份脚本本体。
        run compose -f "$ROOT_DIR/docker-compose.yml" --profile backup \
                run --rm -T --entrypoint /bin/sh pg-backup /usr/local/bin/pg-backup.sh
        return 0
    fi
    parse_db_conn
    if [ -z "$DBF_PASS" ]; then
        # 没有口令必然认证失败——提前给出可行动的提示，而不是让 pg_dump 报
        # 一句 password authentication failed 让人猜
        warn "  .env 缺 DB_PASSWORD/POSTGRES_PASSWORD——无法执行迁移前备份"
        return 1
    fi
    if [ "$DRY_RUN" = true ]; then
        run env PGHOST="$DBF_HOST" PGPORT="$DBF_PORT" PGUSER="$DBF_USER" \
            PGPASSWORD='********' PGDATABASE="$DBF_NAME" \
            BACKUP_DIR="$ROOT_DIR/logs/db-backups" bash "$ROOT_DIR/scripts/pg-backup.sh"
        return 0
    fi
    run env PGHOST="$DBF_HOST" PGPORT="$DBF_PORT" PGUSER="$DBF_USER" PGPASSWORD="$DBF_PASS" \
        PGDATABASE="$DBF_NAME" BACKUP_DIR="$ROOT_DIR/logs/db-backups" \
        bash "$ROOT_DIR/scripts/pg-backup.sh"
}

# 迁移前备份（审计二轮 B-1）：失败输出完整落 ${PG_BACKUP_ERR_LOG}（旧实现
# `2>/dev/null` 把 pg-backup.sh 的 `:?` 报错整个吞掉，失败时无从排查）；
# 成功即删除该日志，避免下次失败时误读到上一次的旧原因。
pre_migration_backup() {
    if [ "$DRY_RUN" = true ]; then
        run_pre_migration_backup_cmd
        return 0
    fi
    mkdir -p "$ROOT_DIR/logs"
    local rc=0
    run_pre_migration_backup_cmd >"$PG_BACKUP_ERR_LOG" 2>&1 || rc=$?
    if [ "$rc" -eq 0 ]; then
        [ -s "$PG_BACKUP_ERR_LOG" ] && tail -n 1 "$PG_BACKUP_ERR_LOG" >&2 || true
        rm -f "$PG_BACKUP_ERR_LOG"
    fi
    return "$rc"
}

migration_phase() {
    log "⑥ 数据库迁移 Migration"

    if ! component_enabled admin-api && [ -n "$COMPONENTS" ]; then
        ok "本次未部署 admin-api，跳过迁移"
        return 0
    fi

    # 迁移前强制备份（生产模式备份失败即中止——不带着未备份的库跑迁移）
    log "  迁移前备份数据库..."
    if [ ! -f "$ROOT_DIR/scripts/pg-backup.sh" ]; then
        warn "  未找到 scripts/pg-backup.sh，跳过备份"
    elif db_is_empty; then
        ok "  数据库为空（首次部署，尚无迁移），无可备份内容——跳过"
    else
        if pre_migration_backup; then
            ok "  备份完成"
        else
            # 失败原因完整落日志（不再是 2>/dev/null 的静默失败），现场同时
            # 回显末尾几行，die/warn 里带日志路径
            [ -s "$PG_BACKUP_ERR_LOG" ] && tail -n 20 "$PG_BACKUP_ERR_LOG" >&2 || true
            if [ "$ENV_NAME" = "production" ]; then
                die "生产环境备份失败，已中止迁移（不带着未备份的库跑迁移）——原因见 $PG_BACKUP_ERR_LOG"
            fi
            warn "  备份失败（非生产环境，继续）——原因见 $PG_BACKUP_ERR_LOG"
        fi
    fi

    if [ "$MODE" = "docker" ]; then
        # Docker 模式必须走 prod 脚本（typeorm CLI + dist/data-source.js）：
        # 运行镜像 npm ci --omit=dev 无 ts-node / src，dev 版 migration:run
        # （ts-node src/data-source.ts）在容器内必炸。compose run（而非 exec）：
        # 迁移发生在 ⑦ start 之前，全新部署时 admin-api 容器尚未运行，exec
        # 必报 "service not running"；run 以一次性容器跑完即弃（--rm），端口
        # 不发布、restart 策略默认 no，不会与后续 up 冲突。
        log "  执行迁移（容器内，prod 入口）..."
        run compose run --rm -T admin-api npm run migration:run:prod
    else
        log "  执行迁移..."
        run bash -c "cd '$ROOT_DIR/apps/admin-api' && npm run migration:run"
    fi

    ok "迁移完成"
}

# ══════════════════════════════════════════════════════════════════
# ⑦ 启动 Start ★ 模式分叉点
# ══════════════════════════════════════════════════════════════════

start_phase() {
    if [ "$MODE" = "docker" ]; then
        start_docker
    else
        start_source
    fi
}

start_docker() {
    log "⑦ 启动 Start（Docker 模式）"

    local args=(up)
    [ "$DETACH" = true ] && args+=(-d)

    # --with monitoring,backup → 附加 profile
    if [ -n "$WITH_PROFILES" ]; then
        for p in $(printf '%s' "$WITH_PROFILES" | tr ',' ' '); do
            args+=(--profile "$p")
        done
    fi

    run compose "${args[@]}"
    ok "Docker 服务已启动"
}

start_source() {
    log "⑦ 启动 Start（源码模式）"

    if [ "$PLATFORM" != "linux" ]; then
        err "源码模式的 systemd 部署仅支持 Linux"
        cat >&2 <<EOF

  当前平台: $PLATFORM
  可选：
    · ./deploy.sh --mode docker          （用 Docker 模式）
    · 在 WSL2 的 Linux 环境内执行源码模式

EOF
        die "源码模式中止"
    fi

    if [ "$DRY_RUN" = false ] && [ "$(id -u)" -ne 0 ]; then
        die "源码模式需要 root（写 systemd unit / 安装目录）。请用 sudo 运行。"
    fi

    ensure_system_user
    sync_source_tree
    install_systemd_units
    install_nginx_site
    warm_interpreters

    log "  启动服务..."
    for c in $(resolve_components); do
        local unit="${SYSTEMD_PREFIX}-${c}.service"
        run_root systemctl enable --now "$unit" 2>/dev/null || \
            run_root systemctl restart "$unit"
        ok "  $c 已启动"
    done

    run_root systemctl daemon-reload
    ok "源码服务已启动"
}

ensure_system_user() {
    if ! id -u "$ACF_SYSTEM_USER" >/dev/null 2>&1; then
        log "  创建系统用户 $ACF_SYSTEM_USER..."
        run_root useradd --system --create-home --shell /usr/sbin/nologin "$ACF_SYSTEM_USER" 2>/dev/null || \
            run_root useradd --system --create-home "$ACF_SYSTEM_USER"
    fi
}

# 把源码树同步到安装目录（systemd 从固定路径启动，不依赖仓库位置）
sync_source_tree() {
    if [ "$ROOT_DIR" = "$ACF_INSTALL_DIR" ]; then
        ok "  已在安装目录 ${ACF_INSTALL_DIR}，无需同步"
        return 0
    fi

    log "  同步源码到 $ACF_INSTALL_DIR..."
    run_root mkdir -p "$ACF_INSTALL_DIR"

    # 用 rsync 排除构建缓存与产物之外的临时文件
    if have rsync; then
        run_root rsync -a --delete \
            --exclude 'node_modules' --exclude '.git' --exclude '.venv' \
            --exclude '__pycache__' --exclude '.pytest_cache' \
            "$ROOT_DIR/apps/" "$ACF_INSTALL_DIR/apps/"
        run_root rsync -a --delete --exclude 'node_modules' \
            "$ROOT_DIR/packages/" "$ACF_INSTALL_DIR/packages/" 2>/dev/null || true
        run_root cp "$ROOT_DIR/.env" "$ACF_INSTALL_DIR/.env"
        run_root cp "$ROOT_DIR/package.json" "$ACF_INSTALL_DIR/" 2>/dev/null || true
    else
        warn "  未找到 rsync，改用 cp（较慢且不清理旧文件）"
        run_root mkdir -p "$ACF_INSTALL_DIR/apps"
        for c in $(resolve_components); do
            run_root cp -r "$ROOT_DIR/apps/$c" "$ACF_INSTALL_DIR/apps/"
        done
        run_root cp "$ROOT_DIR/.env" "$ACF_INSTALL_DIR/.env"
    fi

    run_root chown -R "$ACF_SYSTEM_USER:$ACF_SYSTEM_USER" "$ACF_INSTALL_DIR" 2>/dev/null || true
    run_root chmod 600 "$ACF_INSTALL_DIR/.env" 2>/dev/null || true
    ok "  源码已同步"
}

# systemd unit 生成（模板见设计文档 01 §5.1）
install_systemd_units() {
    log "  安装 systemd unit..."

    local node_heap; node_heap="$(env_get AGENT_NODE_MAX_OLD_SPACE_MB || echo 1536)"

    for c in $(resolve_components); do
        local unit_path="/etc/systemd/system/${SYSTEMD_PREFIX}-${c}.service"
        local workdir="$ACF_INSTALL_DIR/apps/$c"
        local exec_start
        local memory_max
        local env_lines=""

        case "$c" in
            admin-api)
                exec_start="/usr/bin/env node dist/main.js"
                memory_max="2G"
                # OOM 事故教训（docs/INCIDENT-2026-09-23-admin-api-oom.md）：
                # Node 堆上限必须低于 systemd MemoryMax，否则 systemd 先杀进程、
                # Node 来不及 GC。此处显式对齐。
                env_lines="Environment=NODE_OPTIONS=--max-old-space-size=1536"
                ;;
            executor-node)
                exec_start="/usr/bin/env node dist/main.js"
                memory_max="1G"
                ;;
            admin-web)
                # admin-web 是静态产物，由 nginx 服务，不单独起进程
                continue
                ;;
            executor-python)
                exec_start="$workdir/.venv/bin/uvicorn main:app --host 0.0.0.0 --port $PORT_EXECUTOR_PYTHON"
                memory_max="1G"
                ;;
            *)
                continue
                ;;
        esac

        if [ "$DRY_RUN" = true ]; then
            printf '%b\n' "  ${YELLOW}[dry-run]${NC} 写 $unit_path"
            continue
        fi

        run_root tee "$unit_path" >/dev/null <<EOF
[Unit]
Description=AutoCodeFlow $c
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$ACF_SYSTEM_USER
WorkingDirectory=$workdir
EnvironmentFile=$ACF_INSTALL_DIR/.env
Environment=NODE_ENV=$ENV_NAME
$env_lines
ExecStart=$exec_start
Restart=always
RestartSec=5
# 优雅退出：项目 R-08 已实现排空逻辑，给足时间（勿用 SIGKILL 打断）
TimeoutStopSec=60
KillSignal=SIGTERM
LimitNOFILE=65535
MemoryMax=$memory_max
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF
        ok "    $unit_path"
    done

    run_root systemctl daemon-reload
}

install_nginx_site() {
    component_enabled admin-web || return 0
    have nginx || { warn "  nginx 未安装，跳过站点配置（admin-web 将不可访问）"; return 0; }

    log "  配置 nginx 站点..."
    local conf_dir="/etc/nginx/conf.d"
    [ -d /etc/nginx/sites-available ] && conf_dir="/etc/nginx/sites-available"

    if [ "$DRY_RUN" = true ]; then
        printf '%b\n' "  ${YELLOW}[dry-run]${NC} 写 $conf_dir/autocodeflow.conf"
        return 0
    fi

    run_root tee "$conf_dir/autocodeflow.conf" >/dev/null <<EOF
# AutoCodeFlow admin-web + API 反向代理（由 deploy.sh 生成）
server {
    listen $PORT_ADMIN_WEB default_server;
    server_name _;

    root $ACF_INSTALL_DIR/apps/admin-web/dist;
    index index.html;

    # SPA 路由回退
    location / {
        try_files \$uri \$uri/ /index.html;
    }

    # API 反代到 admin-api
    location /api/ {
        proxy_pass http://127.0.0.1:$PORT_ADMIN_API;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;

        # SSE / 长轮询：必须关闭缓冲，且读超时须 > 执行器拉取窗口
        # （EXECUTOR_PULL_WAIT_MS 默认 25s，见 docs/deployment.md BUG-17）
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }

    location /metrics {
        proxy_pass http://127.0.0.1:$PORT_ADMIN_API;
        proxy_set_header Host \$host;
    }
}
EOF
    run_root nginx -t && run_root systemctl reload nginx
    ok "  nginx 站点已配置"
}

# 解释器池预热（复用既有脚本）
warm_interpreters() {
    [ -f "$ROOT_DIR/scripts/warm-interpreters.sh" ] || return 0
    log "  预热 Python 解释器池..."
    run bash "$ROOT_DIR/scripts/warm-interpreters.sh" 2>/dev/null || \
        warn "  解释器预热失败（不影响启动，首次执行任务时会较慢）"
}

# ══════════════════════════════════════════════════════════════════
# ⑧ 验证 Verify
# ══════════════════════════════════════════════════════════════════

verify_phase() {
    log "⑧ 验证 Verify"
    local failed=0

    # 指数退避等待（替代旧的 sleep 30）
    wait_http "http://127.0.0.1:$PORT_ADMIN_API/api/health/live" "admin-api (live)" 60 || failed=1
    wait_http "http://127.0.0.1:$PORT_ADMIN_API/api/health/ready" "admin-api (ready)" 60 || true

    if component_enabled executor-node; then
        wait_http "http://127.0.0.1:$PORT_EXECUTOR_NODE/health/live" "executor-node" 45 || true
    fi
    if component_enabled executor-python; then
        wait_http "http://127.0.0.1:$PORT_EXECUTOR_PYTHON/health/live" "executor-python" 45 || true
    fi
    if component_enabled admin-web; then
        wait_http "http://127.0.0.1:$PORT_ADMIN_WEB/" "admin-web" 30 || true
    fi

    if [ "$failed" -ne 0 ]; then
        err "验证失败——最近日志："
        dump_recent_logs admin-api
        die "部署未通过验证。排查建议：./deploy.sh doctor"
    fi

    write_manifest
    ok "验证通过"
}

# wait_http <url> <label> [timeout_sec] —— 轮询直到 2xx/3xx
wait_http() {
    local url="$1" label="$2" timeout="${3:-60}"
    if [ "$DRY_RUN" = true ]; then
        printf '%b\n' "  ${YELLOW}[dry-run]${NC} 等待 $label 就绪"
        return 0
    fi
    have curl || { warn "curl 不可用，跳过 $label 检查"; return 0; }

    local i=0 delay=1
    while [ "$i" -lt "$timeout" ]; do
        local code
        code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$url" 2>/dev/null)" || code="000"
        case "$code" in
            2*|3*) ok "  $label 就绪（${i}s，HTTP ${code}）"; return 0 ;;
        esac
        sleep "$delay"
        i=$((i + delay))
        [ "$delay" -lt 4 ] && delay=$((delay + 1))
    done
    warn "  $label 在 ${timeout}s 内未就绪"
    return 1
}

dump_recent_logs() {
    local c="$1"
    if [ "$MODE" = "docker" ]; then
        compose logs --tail=50 "$c" 2>/dev/null || true
    else
        journalctl -u "${SYSTEMD_PREFIX}-${c}" -n 50 --no-pager 2>/dev/null || true
    fi
}

# ══════════════════════════════════════════════════════════════════
# 部署清单与回滚
# ══════════════════════════════════════════════════════════════════

write_manifest_artifacts() {
    [ "$DRY_RUN" = true ] && return 0
    mkdir -p "$DEPLOY_STATE_DIR"
    for c in $(resolve_components); do
        local dist="$ROOT_DIR/apps/$c/dist"
        if [ -d "$dist" ]; then
            local hash
            hash="$(find "$dist" -type f -exec sha256sum {} + 2>/dev/null | sort -k2 | sha256sum | cut -d' ' -f1)"
            printf '%s  %s\n' "$hash" "$c" >> "$DEPLOY_STATE_DIR/artifacts.txt"
        fi
    done
}

# 查询 typeorm 已执行迁移名称列表（回填 manifest.appliedMigrations，审计二轮
# B-5——此前恒为 []，占位无信息量）。typeorm 默认迁移记录表名即 "migrations"
# （admin-api data-source.ts 未改 migrationsTableName，同源）。输出一行 JSON
# 数组；**尽力而为**：查不到（库不可达/表未建/docker 不可用/无 node）时输出
# "[]" 并以 0 退出——回填失败绝不能反过来阻塞部署本身。
collect_applied_migrations() {
    # JS 只用双引号（外层 shell 双引号安全）；错误说明走 stderr，stdout 恒是
    # 一个可解析的 JSON 数组。
    local js='const {Client}=require("pg");const c=new Client({host:process.env.DB_HOST,port:Number(process.env.DB_PORT||5432),user:process.env.DB_USERNAME,password:process.env.DB_PASSWORD,database:process.env.DB_DATABASE});c.connect().then(()=>c.query("SELECT name FROM migrations ORDER BY id")).then((r)=>{console.log(JSON.stringify(r.rows.map((x)=>x.name)));process.exit(0)}).catch((e)=>{console.error("appliedMigrations query failed:",String(e&&e.message||e));console.log("[]");process.exit(0)});'
    if [ "$MODE" = "docker" ]; then
        # 与迁移（migration_phase 的 compose run admin-api）同一条连接路径：
        # 容器 env 已带 DB_*（root compose admin-api environment）。
        compose run --rm -T admin-api node -e "$js"
        return 0
    fi
    parse_db_conn
    (
        cd "$ROOT_DIR/apps/admin-api" && DB_HOST="$DBF_HOST" DB_PORT="$DBF_PORT" \
            DB_USERNAME="$DBF_USER" DB_PASSWORD="$DBF_PASS" DB_DATABASE="$DBF_NAME" \
            node -e "$js"
    )
    return 0
}

write_manifest() {
    [ "$DRY_RUN" = true ] && return 0

    # 保留上一份清单（供 rollback）
    [ -f "$MANIFEST_FILE" ] && cp "$MANIFEST_FILE" "$MANIFEST_PREV"

    local git_commit="unknown"
    have git && git_commit="$(git -C "$ROOT_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"

    # 从 typeorm 迁移记录表回填真实列表（尽力而为——查询失败保留 []）。
    # 只在本次确实部署 admin-api 时查询：局部部署（--component executor-node）
    # 不该为一份清单去拉起 admin-api 容器。
    local migrations_json="[]"
    if component_enabled admin-api; then
        migrations_json="$(collect_applied_migrations || true)"
        case "$migrations_json" in
            \[*\]) : ;;                    # 形如 JSON 数组 → 采信
            *)     migrations_json="[]" ;; # 查询失败/输出异常 → 保留空数组
        esac
    fi

    cat > "$MANIFEST_FILE" <<EOF
{
  "mode": "$MODE",
  "env": "$ENV_NAME",
  "deployedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "gitCommit": "$git_commit",
  "components": "$(resolve_components | tr ' ' ',')",
  "appliedMigrations": ${migrations_json}
}
EOF
    ok "部署清单已写入 .deploy-manifest.json"
}

cmd_rollback() {
    log "回滚 Rollback"

    [ -f "$MANIFEST_PREV" ] || die "未找到 .deploy-manifest.prev.json——没有可回滚的上一次部署记录"

    local prev_commit
    prev_commit="$(grep -o '"gitCommit": *"[^"]*"' "$MANIFEST_PREV" | cut -d'"' -f4)"

    hr
    cat <<EOF
  上一次部署记录：
    commit:  $prev_commit
EOF
    hr

    # 迁移不可逆——与 docs/rollback-semantics.md 的既有姿态一致
    cat <<'EOF'

  ⚠ 默认只回滚代码，不回滚数据库迁移。

  项目既有语义（docs/rollback-semantics.md）：迁移是单向的，
  回滚代码而保留迁移后的 schema 通常安全；反向回滚迁移会丢数据。

  若确认需要回滚迁移，请人工执行：
EOF
    # docker 模式容器内无 ts-node/src（npm ci --omit=dev + 仅 dist），回滚与
    # 迁移同理必须走 prod 入口——与 migration_phase 的 compose run 姿态一致
    if [ "$MODE" = "docker" ]; then
        printf '    docker compose run --rm -T admin-api npm run migration:revert:prod\n\n'
    else
        printf '    cd apps/admin-api && npm run migration:revert\n\n'
    fi

    if [ "$ASSUME_YES" = false ]; then
        printf '  继续回滚代码？[y/N] '
        local reply
        read -r reply
        case "$reply" in
            [yY]|[yY][eE][sS]) ;;
            *) die "已取消" ;;
        esac
    fi

    if [ "$prev_commit" != "unknown" ] && have git; then
        # 审计二轮 B-5：checkout 旧 commit 必然产生 detached HEAD——回滚前先
        # 记录当前分支名，回滚完成后落盘到状态文件，供下一次 deploy 启动时
        # check_detached_head 提示「如何回到原分支」。当前本就处于 detached
        # HEAD（连续回滚）时保留更早的状态文件，不覆盖。
        local prev_branch
        prev_branch="$(git -C "$ROOT_DIR" symbolic-ref --short HEAD 2>/dev/null || echo '')"
        log "  检出 $prev_commit ..."
        run bash -c "cd '$ROOT_DIR' && git checkout '$prev_commit'"
        if [ "$DRY_RUN" != true ] && [ -n "$prev_branch" ]; then
            mkdir -p "$DEPLOY_STATE_DIR"
            printf '%s\n' "$prev_branch" > "$DEPLOY_STATE_DIR/detached-from-branch"
        fi
        # 重新构建并启动
        BUILD=true build_phase
        start_phase
        verify_phase
        ok "已回滚到 $prev_commit"
        if [ -n "$prev_branch" ]; then
            warn "仓库现在处于 detached HEAD（commit ${prev_commit}）；回滚前分支为 ${prev_branch}，确认稳定后执行 git checkout $prev_branch 可切回"
        else
            warn "仓库现在处于 detached HEAD（commit ${prev_commit}）——本就未在任何分支上，未记录原分支"
        fi
    else
        die "无法回滚：缺少有效的 git commit 记录，或 git 不可用"
    fi
}

# ══════════════════════════════════════════════════════════════════
# 子命令：doctor / status / health / logs / restart
# ══════════════════════════════════════════════════════════════════

JSON_OUT=false

cmd_doctor() {
    local json=false
    [ "${1:-}" = "--json" ] && json=true

    # JSON 模式必须先设好输出通道，再跑 preflight——否则 preflight 的进度行
    # 会写进 stdout，污染 JSON（顺序反了就是实测踩过的那个 bug）。
    if [ "$json" = true ]; then
        JSON_MODE=true
        refresh_out_fd
    fi

    # 复用 preflight 采集
    preflight
    check_services
    check_env_requirements
    check_node_heap_alignment

    if [ "$json" = true ]; then
        emit_doctor_json
        return 0
    fi

    hr
    printf '  %s\n' "${BOLD}AutoCodeFlow 环境体检${NC}"
    hr
    render_rows

    # 结论
    local fails=0 warns=0
    for row in "${PREFLIGHT_ROWS[@]}"; do
        IFS='|' read -r _ status _ <<< "$row"
        [ "$status" = "fail" ] && fails=$((fails + 1))
        [ "$status" = "warn" ] && warns=$((warns + 1))
    done

    if [ "$fails" -gt 0 ]; then
        err "结论：存在 $fails 项致命问题，需修复后才能部署"
        return 1
    elif [ "$warns" -gt 0 ]; then
        warn "结论：可部署，但有 $warns 项警告"
        return 0
    else
        ok "结论：全部通过，可部署"
        return 0
    fi
}

# 结构化 JSON 输出——供中台 Agent 程序化消费（设计文档 03 §4 run_doctor）
emit_doctor_json() {
    printf '{\n'
    printf '  "timestamp": "%s",\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf '  "platform": "%s",\n' "${PLATFORM:-unknown}"
    printf '  "checks": [\n'
    local first=true
    for row in "${PREFLIGHT_ROWS[@]}"; do
        IFS='|' read -r name status detail <<< "$row"
        [ "$first" = true ] && first=false || printf ',\n'
        # 转义双引号，避免破坏 JSON
        detail="${detail//\"/\\\"}"
        printf '    {"name": "%s", "status": "%s", "detail": "%s"}' "$name" "$status" "$detail"
    done
    printf '\n  ],\n'

    local fails=0 warns=0
    for row in "${PREFLIGHT_ROWS[@]}"; do
        IFS='|' read -r _ status _ <<< "$row"
        [ "$status" = "fail" ] && fails=$((fails + 1))
        [ "$status" = "warn" ] && warns=$((warns + 1))
    done
    printf '  "summary": {"fail": %d, "warn": %d},\n' "$fails" "$warns"
    if [ "$fails" -gt 0 ]; then
        printf '  "deployable": false\n'
    else
        printf '  "deployable": true\n'
    fi
    printf '}\n'
}

# 服务存活检查
check_services() {
    local url label code

    url="http://127.0.0.1:$PORT_ADMIN_API/api/health/live"; label="admin-api"
    code="$(http_code "$url")"
    if [ "$code" = "000" ]; then
        add_row "$label 服务" warn "未运行（未部署或已停止）"
    elif [ "${code:0:1}" = "2" ]; then
        add_row "$label 服务" ok "运行中（HTTP ${code}）"
    else
        add_row "$label 服务" fail "异常（HTTP ${code}）"
    fi

    # DB / Redis 连通性（经 admin-api 的 ready 探针）
    code="$(http_code "http://127.0.0.1:$PORT_ADMIN_API/api/health/ready")"
    if [ "$code" = "000" ]; then
        add_row "依赖连通性" warn "admin-api 未运行，无法判定"
    elif [ "${code:0:1}" = "2" ]; then
        add_row "依赖连通性" ok "DB + Redis 正常"
    else
        add_row "依赖连通性" fail "ready 探针返回 HTTP ${code}（DB/Redis 异常？）"
    fi
}

http_code() {
    have curl || { echo "000"; return 0; }
    # 注意两个坑（都实测踩过）：
    #   ① curl 连接失败时**自身**已输出 000，故不能 `|| echo "000"`（会拼成 "000000"）；
    #   ② curl 失败会返回非零退出码，而调用方在 `set -e` 下会因此**整个脚本中止**——
    #      故必须在函数内吞掉退出码（`|| true` 或用 `set +e` 局部包裹）。
    local code
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$1" 2>/dev/null || true)"
    echo "${code:-000}"
}

# .env 必填项
check_env_requirements() {
    if [ ! -f "$ROOT_DIR/.env" ]; then
        add_row ".env 文件" warn "不存在（首次部署会自动生成并填充随机值）"
        add_row ".env 必填项" warn "无 .env，无法校验"
        return
    fi
    add_row ".env 文件" ok "已存在"

    local missing=()
    for key in DB_PASSWORD JWT_SECRET JWT_REFRESH_SECRET EXECUTOR_SECRET REDIS_PASSWORD; do
        local v; v="$(env_get "$key")"
        [ -z "$v" ] && missing+=("$key")
    done

    if [ "${#missing[@]}" -eq 0 ]; then
        add_row ".env 必填项" ok "全部已设置（5/5）"
    else
        add_row ".env 必填项" fail "缺失: ${missing[*]}"
    fi

    local jwt; jwt="$(env_get JWT_SECRET)"
    if [ "${#jwt}" -ge 32 ]; then
        add_row "JWT_SECRET 强度" ok "${#jwt} 字符"
    else
        add_row "JWT_SECRET 强度" warn "仅 ${#jwt} 字符（生产要求 >= 32）"
    fi
}

# Node 堆上限 vs systemd MemoryMax 一致性
# 背景：docs/INCIDENT-2026-09-23-admin-api-oom.md——两者错配会导致
# systemd 先杀进程、Node 来不及 GC。
check_node_heap_alignment() {
    [ "$PLATFORM" = "linux" ] || return 0
    local unit="/etc/systemd/system/${SYSTEMD_PREFIX}-admin-api.service"
    [ -f "$unit" ] || return 0

    local memory_max heap_mb
    memory_max="$(grep -oP 'MemoryMax=\K.*' "$unit" 2>/dev/null | head -n1 || true)"
    heap_mb="$(grep -oP 'max-old-space-size=\K[0-9]+' "$unit" 2>/dev/null | head -n1 || true)"

    [ -z "$memory_max" ] && return 0

    # 把 MemoryMax 归一化为 MB
    local max_mb=0
    case "$memory_max" in
        *G|*g) max_mb=$(( ${memory_max%[Gg]} * 1024 )) ;;
        *M|*m) max_mb=${memory_max%[Mm]} ;;
        *) return 0 ;;
    esac

    if [ -z "$heap_mb" ]; then
        add_row "堆上限 vs 内存上限" warn "MemoryMax=$memory_max 但未设 NODE_OPTIONS 堆上限"
    elif [ "$heap_mb" -lt "$max_mb" ]; then
        add_row "堆上限 vs 内存上限" ok "${heap_mb}M / ${max_mb}M（一致）"
    else
        add_row "堆上限 vs 内存上限" fail "堆 ${heap_mb}M >= MemoryMax ${max_mb}M —— systemd 会先杀进程"
    fi
}

cmd_status() {
    log "AutoCodeFlow 状态"
    printf '\n'

    if [ "$MODE" = "docker" ] && have docker; then
        compose ps 2>/dev/null || warn "compose ps 失败"
    else
        for c in $NODE_COMPONENTS $PYTHON_COMPONENTS; do
            local unit="${SYSTEMD_PREFIX}-${c}"
            if systemctl list-unit-files 2>/dev/null | grep -q "^${unit}.service"; then
                local state
                state="$(systemctl is-active "$unit" 2>/dev/null || echo unknown)"
                printf '  %-20s %s\n' "$c" "$state"
            fi
        done
    fi

    printf '\n'
    printf '  健康端点：\n'
    printf '    admin-api:       %s\n' "http://localhost:$PORT_ADMIN_API/api/health/live"
    printf '    executor-node:   %s\n' "http://localhost:$PORT_EXECUTOR_NODE/health"
    printf '    executor-python: %s\n' "http://localhost:$PORT_EXECUTOR_PYTHON/health"
    printf '\n'
}

cmd_health() {
    log "深度健康检查"
    printf '\n'
    local code

    code="$(http_code "http://127.0.0.1:$PORT_ADMIN_API/api/health/live")"
    printf '  %-24s %s\n' "admin-api live" "$( [ "${code:0:1}" = "2" ] && echo '✔ 正常' || echo "✘ HTTP $code" )"

    code="$(http_code "http://127.0.0.1:$PORT_ADMIN_API/api/health/ready")"
    printf '  %-24s %s\n' "admin-api ready" "$( [ "${code:0:1}" = "2" ] && echo '✔ 正常' || echo "✘ HTTP $code" )"

    code="$(http_code "http://127.0.0.1:$PORT_EXECUTOR_NODE/health")"
    printf '  %-24s %s\n' "executor-node" "$( [ "${code:0:1}" = "2" ] && echo '✔ 正常' || echo "✘ HTTP $code" )"

    printf '\n  hint: 执行器在线数请查管理后台「执行器」页，或 GET /api/executors\n\n'
}

cmd_logs() {
    local component="${1:-admin-api}"
    if [ "$MODE" = "docker" ]; then
        compose logs -f --tail=100 "$component"
    else
        journalctl -u "${SYSTEMD_PREFIX}-${component}" -f -n 100
    fi
}

cmd_restart() {
    local component="${1:-}"
    [ -z "$component" ] && die "用法: ./deploy.sh restart <component>"

    # 封闭枚举——不接受任意服务名（与 executor-node commands.ts 同姿态）
    case "$component" in
        admin-api|admin-web|executor-node|executor-python|all) ;;
        *) die "未知组件: ${component}（可用: admin-api|admin-web|executor-node|executor-python|all）" ;;
    esac

    log "重启 $component"
    if [ "$MODE" = "docker" ]; then
        if [ "$component" = "all" ]; then compose restart; else compose restart "$component"; fi
    else
        if [ "$component" = "all" ]; then
            for c in $NODE_COMPONENTS $PYTHON_COMPONENTS; do
                [ "$c" = "admin-web" ] && continue
                run_root systemctl restart "${SYSTEMD_PREFIX}-${c}"
            done
        else
            [ "$component" = "admin-web" ] && { run_root systemctl reload nginx; ok "已重载 nginx"; return 0; }
            run_root systemctl restart "${SYSTEMD_PREFIX}-${component}"
        fi
    fi
    ok "重启完成"
}

# ══════════════════════════════════════════════════════════════════
# 主流程
# ══════════════════════════════════════════════════════════════════

# detached HEAD 检测（审计二轮 B-5）：rollback 的 `git checkout <commit>` 会把
# 仓库留在 detached HEAD，下一次 deploy 若毫无感知，operator 会误以为部署的
# 是分支最新代码。语义选择：**warn 并基于当前 commit 继续**，不自动切回分支——
# 自动 checkout 会静默改写工作树内容（回滚是显式决策，回到分支也应当是）；
# 这里只提示基于哪个 commit 继续、以及如何回到原分支（分支名由 rollback 记录
# 在 $DEPLOY_STATE_DIR/detached-from-branch）。
check_detached_head() {
    have git || return 0
    # 非 git 仓库 / 空仓库（无任何 commit）→ 无「detached」概念
    git -C "$ROOT_DIR" rev-parse --verify --quiet HEAD >/dev/null 2>&1 || return 0
    # symbolic-ref 成功 = 在分支上，正常
    [ -n "$(git -C "$ROOT_DIR" symbolic-ref --short HEAD 2>/dev/null || echo '')" ] && return 0
    local commit
    commit="$(git -C "$ROOT_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"
    local hint=""
    local branch_file="$DEPLOY_STATE_DIR/detached-from-branch"
    if [ -f "$branch_file" ]; then
        local from_branch
        from_branch="$(head -n1 "$branch_file" 2>/dev/null || echo '')"
        [ -n "$from_branch" ] && hint="（回滚前分支: ${from_branch}，确认稳定后 git checkout $from_branch 可切回）"
    fi
    warn "仓库当前处于 detached HEAD（commit ${commit}，可能由 rollback 产生）——本次部署将基于该 commit 构建${hint}"
}

main() {
    parse_args "$@"

    # 子命令分发（参数由子命令自己解析）
    case "$SUBCOMMAND" in
        doctor)   cmd_doctor "${SUBCOMMAND_ARGS[@]+"${SUBCOMMAND_ARGS[@]}"}"; exit $? ;;
        status)   cmd_status; exit $? ;;
        health)   cmd_health; exit $? ;;
        logs)     cmd_logs "${SUBCOMMAND_ARGS[@]+"${SUBCOMMAND_ARGS[@]}"}"; exit $? ;;
        restart)  cmd_restart "${SUBCOMMAND_ARGS[@]+"${SUBCOMMAND_ARGS[@]}"}"; exit $? ;;
        rollback) cmd_rollback; exit $? ;;
    esac

    # 回滚遗留的 detached HEAD 必须在一切阶段之前提示（--skip-preflight 也拦不住它）
    check_detached_head

    # 生产模式额外确认
    if [ "$ENV_NAME" = "production" ] && [ "$I_KNOW_ITS_PRODUCTION" = false ] && [ "$DRY_RUN" = false ]; then
        err "即将部署到【生产环境】。"
        printf '  确认请加 --i-know-its-production\n\n' >&2
        die "已中止（防误操作）"
    fi

    hr
    printf '  %s\n' "${BOLD}AutoCodeFlow 部署${NC}"
    printf '  模式: %s   环境: %s   组件: %s\n' "$MODE" "$ENV_NAME" "$(resolve_components | tr ' ' ',')"
    [ "$DRY_RUN" = true ] && printf '  %s\n' "${YELLOW}（dry-run：不会修改系统）${NC}"
    hr
    printf '\n'

    if [ "$SKIP_PREFLIGHT" = false ]; then
        preflight
        preflight_gate
    else
        warn "已跳过预检（--skip-preflight）"
    fi

    config_phase
    deps_phase
    build_phase
    infra_phase
    migration_phase
    start_phase
    verify_phase

    printf '\n'
    hr
    ok "${BOLD}部署完成${NC}"
    hr
    cat <<EOF

  管理后台:   http://localhost$( [ "$PORT_ADMIN_WEB" = "80" ] && echo "" || echo ":$PORT_ADMIN_WEB" )
  API 文档:   http://localhost:$PORT_ADMIN_API/api/docs
  健康检查:   http://localhost:$PORT_ADMIN_API/api/health/live
  Prometheus: http://localhost:$PORT_ADMIN_API/metrics

  下一步：
    ./deploy.sh doctor                 # 环境体检
    ./deploy.sh status                 # 组件状态
    ./deploy.sh logs admin-api         # 查看日志

EOF

    if [ -f "$ROOT_DIR/scripts/pg-backup.sh" ]; then
        printf '  %b\n' "${YELLOW}提醒: 生产环境建议启用定时备份（--with backup）${NC}"
        printf '       详见 docs/operations.md「数据备份与恢复」\n\n'
    fi
}

main "$@"
