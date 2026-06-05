#!/bin/bash

set -e

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

# 创建数据库表
echo -e "${YELLOW}创建数据库表...${NC}"
cd apps/admin-api && npx typeorm migration:run

if [ $? -eq 0 ]; then
    echo -e "${GREEN}数据库表创建成功${NC}"
else
    echo -e "${RED}数据库表创建失败${NC}"
    exit 1
fi

# 创建管理员用户
echo -e "${YELLOW}创建管理员用户...${NC}"

# 检查管理员用户是否已存在
ADMIN_EXISTS=$(cd apps/admin-api && npx ts-node -e "
import { DataSource } from 'typeorm';
import { User } from './src/modules/users/entities/user.entity';

async function checkAdmin() {
    const ds = new DataSource({
        type: 'postgres',
        host: '${DB_HOST:-localhost}',
        port: ${DB_PORT:-5432},
        username: '${DB_USERNAME:-autoflow}',
        password: '${DB_PASSWORD}',
        database: '${DB_DATABASE:-autoflow}',
        entities: [User],
    });
    await ds.initialize();
    const user = await ds.getRepository(User).findOne({ where: { username: 'admin' } });
    await ds.destroy();
    console.log(user ? 'exists' : 'not_exists');
}
checkAdmin();
")

if [ "$ADMIN_EXISTS" = "exists" ]; then
    echo -e "${YELLOW}管理员用户已存在，跳过创建${NC}"
else
    # 创建管理员用户
    cd apps/admin-api && npx ts-node -e "
import { DataSource } from 'typeorm';
import { User } from './src/modules/users/entities/user.entity';
import * as bcrypt from 'bcrypt';

async function createAdmin() {
    const ds = new DataSource({
        type: 'postgres',
        host: '${DB_HOST:-localhost}',
        port: ${DB_PORT:-5432},
        username: '${DB_USERNAME:-autoflow}',
        password: '${DB_PASSWORD}',
        database: '${DB_DATABASE:-autoflow}',
        entities: [User],
    });
    await ds.initialize();
    
    const hashedPassword = await bcrypt.hash('${INITIAL_ADMIN_PASSWORD:-admin123}', 10);
    const admin = ds.getRepository(User).create({
        username: 'admin',
        password: hashedPassword,
        email: 'admin@autoflow.local',
        role: 'admin',
    });
    await ds.getRepository(User).save(admin);
    await ds.destroy();
    console.log('Admin user created');
}
createAdmin();
"

    if [ $? -eq 0 ]; then
        echo -e "${GREEN}管理员用户创建成功${NC}"
        echo -e "${YELLOW}用户名: admin${NC}"
        echo -e "${YELLOW}密码: ${INITIAL_ADMIN_PASSWORD:-admin123}${NC}"
    else
        echo -e "${RED}管理员用户创建失败${NC}"
        exit 1
    fi
fi

echo -e "${GREEN}========== AutoFlow 数据库初始化完成 ==========${NC}"
