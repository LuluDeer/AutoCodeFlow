#!/bin/bash

# E-36（DEEP_REVIEW 0ef3bbe）：根级脚本补 -u/pipefail——未定义变量不再静默为空
# （.env 缺键时 PGPASSWORD="" 不致空口令尝试），管道中途失败不再被吞。
set -euo pipefail

# AutoFlow 数据库初始化脚本
# Usage: ./init-db.sh [options]
# Options:
#   -h, --help           显示帮助信息

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# 解析参数
while [[ $# -gt 0 ]]; do
    case "$1" in
        -h|--help)
            echo "AutoFlow 数据库初始化脚本"
            echo "Usage: ./init-db.sh [options]"
            echo ""
            echo "Options:"
            echo "  -h, --help           显示帮助信息"
            exit 0
            ;;
        *)
            echo "未知参数: $1"
            exit 1
            ;;
    esac
done

echo -e "${GREEN}========== 初始化 AutoFlow 数据库 ==========${NC}"

# 检查环境变量文件
if [ ! -f ".env" ]; then
    echo -e "${RED}错误: .env 文件不存在${NC}"
    exit 1
fi

# 加载环境变量
source .env

# 检查 PostgreSQL 是否可用
echo -e "${YELLOW}检查 PostgreSQL 连接...${NC}"
if ! PGPASSWORD="${POSTGRES_PASSWORD}" psql -h "${DB_HOST:-localhost}" -U "${POSTGRES_USER:-autoflow}" -d "${DB_DATABASE:-autoflow}" -c "SELECT 1" > /dev/null 2>&1; then
    echo -e "${RED}错误: 无法连接到 PostgreSQL${NC}"
    exit 1
fi

echo -e "${GREEN}PostgreSQL 连接成功${NC}"

# 安全注记（勿改回内插写法）：
# 此前把 ${DB_PASSWORD} 等值直接内插进 ts-node -e 的 JS 字符串字面量——
# 值含单引号/反斜杠即破坏语法，恶意值可注入任意 JS。现改为：
#   1) 值经「命令前缀环境变量」传递（VAR="$VAL" 赋值上下文不做分词/再解析，
#      单引号/反斜杠/换行等任意字符——除 NUL——都能原样到达子进程）；
#   2) ts-node -e 的 JS 片段用单引号包裹（片段内只允许双引号字符串），
#      内部一律读 process.env，字面量与用户值零接触。

# 创建数据库表
echo -e "${YELLOW}创建数据库表...${NC}"
# E-29（DEEP_REVIEW 0ef3bbe）：旧实现裸 `npx typeorm migration:run` 不带 -d，
# typeorm 0.3 CLI 找不到 data-source（仓库无 ormconfig 约定文件）——迁移实际失效。
# 改用 admin-api package.json 的规范脚本 `npm run migration:run`（内部
# `ts-node -r tsconfig-paths/register typeorm/cli migration:run -d src/data-source.ts`）。
# 同时删除 set -e 下的死分支 `if [ $? -eq 0 ]`：迁移失败时 set -e 已直接退出，
# else 永不到达，旧代码误导维护者以为有失败兜底。
cd apps/admin-api && npm run migration:run
echo -e "${GREEN}数据库表创建成功${NC}"

cd ../..

# 创建管理员用户
echo -e "${YELLOW}创建管理员用户...${NC}"

# 检查管理员用户是否已存在（连接参数经环境变量传入，JS 侧读 process.env）
ADMIN_EXISTS=$(cd apps/admin-api && \
    DB_HOST="${DB_HOST:-localhost}" \
    DB_PORT="${DB_PORT:-5432}" \
    DB_USERNAME="${DB_USERNAME:-autoflow}" \
    DB_PASSWORD="${DB_PASSWORD}" \
    DB_DATABASE="${DB_DATABASE:-autoflow}" \
    npx ts-node -e '
import { DataSource } from "typeorm";
import { User } from "./src/modules/users/entities/user.entity";

async function checkAdmin() {
    const port = parseInt(process.env.DB_PORT || "5432", 10);
    const ds = new DataSource({
        type: "postgres",
        host: process.env.DB_HOST || "localhost",
        port: Number.isFinite(port) ? port : 5432,
        username: process.env.DB_USERNAME || "autoflow",
        password: process.env.DB_PASSWORD ?? "",
        database: process.env.DB_DATABASE || "autoflow",
        entities: [User],
    });
    await ds.initialize();
    const user = await ds.getRepository(User).findOne({ where: { username: "admin" } });
    await ds.destroy();
    console.log(user ? "exists" : "not_exists");
}
checkAdmin();
')

if [ "$ADMIN_EXISTS" = "exists" ]; then
    echo -e "${YELLOW}管理员用户已存在，跳过创建${NC}"
else
    # 创建管理员用户（INITIAL_ADMIN_PASSWORD 同样经环境变量传递）
    cd apps/admin-api && \
    DB_HOST="${DB_HOST:-localhost}" \
    DB_PORT="${DB_PORT:-5432}" \
    DB_USERNAME="${DB_USERNAME:-autoflow}" \
    DB_PASSWORD="${DB_PASSWORD}" \
    DB_DATABASE="${DB_DATABASE:-autoflow}" \
    INITIAL_ADMIN_PASSWORD="${INITIAL_ADMIN_PASSWORD:-admin123}" \
    npx ts-node -e '
import { DataSource } from "typeorm";
import { User } from "./src/modules/users/entities/user.entity";
import * as bcrypt from "bcrypt";

async function createAdmin() {
    const port = parseInt(process.env.DB_PORT || "5432", 10);
    const ds = new DataSource({
        type: "postgres",
        host: process.env.DB_HOST || "localhost",
        port: Number.isFinite(port) ? port : 5432,
        username: process.env.DB_USERNAME || "autoflow",
        password: process.env.DB_PASSWORD ?? "",
        database: process.env.DB_DATABASE || "autoflow",
        entities: [User],
    });
    await ds.initialize();

    const hashedPassword = await bcrypt.hash(process.env.INITIAL_ADMIN_PASSWORD || "admin123", 10);
    const admin = ds.getRepository(User).create({
        username: "admin",
        password: hashedPassword,
        email: "admin@autoflow.local",
        role: "admin",
    });
    await ds.getRepository(User).save(admin);
    await ds.destroy();
    console.log("Admin user created");
}
createAdmin();
'

    # E-29（DEEP_REVIEW 0ef3bbe）：旧实现把初始管理员密码明文回显到终端（并进
    # CI/部署日志）——口令泄露面。改为只提示创建成功，密码不回显：它来自
    # INITIAL_ADMIN_PASSWORD 环境变量（运维自有），或通过 admin-api 首登改密/重置
    # 流程获取。set -e 已保证失败时直接退出，无需死分支 if [ $? -eq 0 ]。
    echo -e "${GREEN}管理员用户创建成功${NC}"
    echo -e "${YELLOW}用户名: admin（密码来自 INITIAL_ADMIN_PASSWORD 环境变量，未回显；首登后请立即改密）${NC}"
fi

echo -e "${GREEN}========== AutoFlow 数据库初始化完成 ==========${NC}"
