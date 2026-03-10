#!/bin/bash
# WhatsApp Bot 升级脚本
# 此文件存于 git 仓库，每次升级后自动同步到 /usr/local/bin/whatsapp-upgrade

set -e

BOT_DIR=/opt/whatsapp-bot
cd "$BOT_DIR"

echo "========================================"
echo " WhatsApp Bot 升级程序"
echo "========================================"
echo ""

echo "[1/4] 拉取最新代码..."
git pull

echo ""
echo "[2/4] 同步升级脚本..."
cp scripts/upgrade.sh /usr/local/bin/whatsapp-upgrade
chmod +x /usr/local/bin/whatsapp-upgrade

echo ""
echo "[3/4] 安装依赖..."
npm install --omit=dev

echo ""
echo "[4/4] 重启服务..."
pm2 restart whatsapp-bot

VERSION=$(node -e "console.log(require('./package.json').version)")

echo ""
echo "========================================"
echo " 升级完成！当前版本：v${VERSION}"
echo "========================================"
