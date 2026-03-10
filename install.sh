#!/usr/bin/env bash
set -euo pipefail

# ── 配置（发布前修改为你的 GitHub 地址）────────────────
REPO_URL="https://github.com/ProphetKL/whatsapp-bot.git"
INSTALL_DIR="/opt/whatsapp-bot"
PM2_APP_NAME="whatsapp-bot"

# ── 颜色 ──────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
info()  { echo -e "${GREEN}[✓]${NC} $*"; }
warn()  { echo -e "${YELLOW}[!]${NC} $*"; }
step()  { echo -e "\n${BLUE}──────────────────────────────────────${NC}"; echo -e "${BLUE}  $*${NC}"; echo -e "${BLUE}──────────────────────────────────────${NC}"; }
abort() { echo -e "\n${RED}[✗] 安装失败：$*${NC}\n"; exit 1; }

clear
echo ""
echo "  ╔════════════════════════════════════════════╗"
echo "  ║    WhatsApp 定时消息机器人  一键安装脚本     ║"
echo "  ╚════════════════════════════════════════════╝"
echo ""

# ── 检查：必须 root ───────────────────────────────────
if [[ $EUID -ne 0 ]]; then
  abort "请以 root 或 sudo 运行：\n\n  sudo bash install.sh\n  或\n  curl -fsSL <安装地址> | sudo bash"
fi

# ── 检查：仅支持 Ubuntu / Debian ─────────────────────
if [[ ! -f /etc/os-release ]]; then
  abort "无法检测操作系统，本脚本仅支持 Ubuntu / Debian"
fi
source /etc/os-release
if [[ "$ID" != "ubuntu" && "$ID" != "debian" ]]; then
  abort "不支持的操作系统：$PRETTY_NAME。本脚本仅支持 Ubuntu / Debian"
fi
info "操作系统：$PRETTY_NAME"

# ════════════════════════════════════════════════════
step "第 1 步：设置管理界面账户"
# ════════════════════════════════════════════════════
echo ""
echo "  请设置登录管理界面的用户名和密码。"
echo "  密码将保存在服务器的 .env 文件中（仅 root 可读）。"
echo ""

read -rp "  用户名 [默认: admin]: " AUTH_USER_INPUTAUTH_USER_INPUT="${AUTH_USER_INPUT:-admin}"

while true; do
  read -rsp "  密码（最少 8 位）: " AUTH_PASS_INPUT  echo ""
  if [[ ${#AUTH_PASS_INPUT} -lt 8 ]]; then
    warn "密码不足 8 位（当前 ${#AUTH_PASS_INPUT} 位），请重新输入"
    continue
  fi
  read -rsp "  再次输入密码确认: " AUTH_PASS_CONFIRM  echo ""
  if [[ "$AUTH_PASS_INPUT" != "$AUTH_PASS_CONFIRM" ]]; then
    warn "两次密码不一致，请重新输入"
    continue
  fi
  break
done

read -rp "  管理界面端口 [默认: 3000]: " PORT_INPUTPORT_INPUT="${PORT_INPUT:-3000}"
echo ""
info "账户设置完成"

# ════════════════════════════════════════════════════
step "第 2 步：安装 Chromium 系统依赖"
# ════════════════════════════════════════════════════
apt-get update -qq
apt-get install -y -qq \
  ca-certificates curl git fonts-liberation wget lsb-release xdg-utils \
  libappindicator3-1 libasound2 libatk-bridge2.0-0 libatk1.0-0 \
  libc6 libcairo2 libcups2 libdbus-1-3 libexpat1 libfontconfig1 \
  libgbm1 libgcc1 libglib2.0-0 libgtk-3-0 libnspr4 libnss3 \
  libpango-1.0-0 libpangocairo-1.0-0 libstdc++6 libx11-6 \
  libx11-xcb1 libxcb1 libxcomposite1 libxcursor1 libxdamage1 \
  libxext6 libxfixes3 libxi6 libxrandr2 libxrender1 libxss1 \
  libxtst6 2>/dev/null
info "系统依赖安装完成"

# ════════════════════════════════════════════════════
step "第 3 步：检查 / 安装 Node.js"
# ════════════════════════════════════════════════════
NEED_NODE=false
if command -v node &>/dev/null; then
  NODE_MAJOR=$(node -e "process.stdout.write(process.version.slice(1).split('.')[0])")
  if [[ $NODE_MAJOR -lt 20 ]]; then
    warn "当前 Node.js $(node --version) 版本过低，升级到 v20..."
    NEED_NODE=true
  else
    info "Node.js $(node --version) 已满足要求"
  fi
else
  NEED_NODE=true
fi

if [[ $NEED_NODE == true ]]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1
  apt-get install -y nodejs >/dev/null 2>&1
  info "Node.js $(node --version) 安装完成"
fi

# ════════════════════════════════════════════════════
step "第 4 步：检查 / 安装 PM2"
# ════════════════════════════════════════════════════
if ! command -v pm2 &>/dev/null; then
  npm install -g pm2 --quiet
  info "PM2 安装完成"
else
  info "PM2 $(pm2 --version) 已就绪"
fi

# ════════════════════════════════════════════════════
step "第 5 步：下载项目"
# ════════════════════════════════════════════════════
if [[ -d "$INSTALL_DIR/.git" ]]; then
  warn "已检测到安装目录，正在更新代码..."
  git -C "$INSTALL_DIR" pull --ff-only -q
  info "代码更新完成"
else
  git clone -q "$REPO_URL" "$INSTALL_DIR"
  info "项目下载完成：$INSTALL_DIR"
fi

cd "$INSTALL_DIR"
npm install --omit=dev --quiet
info "Node.js 依赖安装完成"

# ── 写入 .env（权限 600，仅 root 可读）────────────
cat > "$INSTALL_DIR/.env" <<EOF
PORT=${PORT_INPUT}
AUTH_USER=${AUTH_USER_INPUT}
AUTH_PASS=${AUTH_PASS_INPUT}
EOF
chmod 600 "$INSTALL_DIR/.env"
info ".env 配置文件已写入（权限 600）"

# ════════════════════════════════════════════════════
step "第 6 步：启动机器人"
# ════════════════════════════════════════════════════
pm2 delete "$PM2_APP_NAME" 2>/dev/null || true
pm2 start "$INSTALL_DIR/ecosystem.config.js" --silent
pm2 save --force >/dev/null
info "机器人已启动（PM2 守护）"

# ── 配置开机自启 ───────────────────────────────────
STARTUP_CMD=$(pm2 startup systemd -u root --hp /root 2>/dev/null | grep "sudo env" | head -1 || true)
if [[ -n "$STARTUP_CMD" ]]; then
  eval "$STARTUP_CMD" >/dev/null 2>&1 && info "开机自启配置完成" || warn "开机自启配置失败，请手动运行：pm2 startup && pm2 save"
else
  warn "请手动运行以下命令完成开机自启：pm2 startup && pm2 save"
fi

# ── 防火墙 ─────────────────────────────────────────
if command -v ufw &>/dev/null; then
  ufw allow "${PORT_INPUT}/tcp" >/dev/null 2>&1 && info "防火墙已开放端口 ${PORT_INPUT}" || true
fi

# ════════════════════════════════════════════════════
# 完成
# ════════════════════════════════════════════════════
SERVER_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "服务器IP")

echo ""
echo "  ╔════════════════════════════════════════════╗"
echo -e "  ║        ${GREEN}安装完成！${NC}                          ║"
echo "  ╚════════════════════════════════════════════╝"
echo ""
echo "  管理界面：http://${SERVER_IP}:${PORT_INPUT}"
echo "  用户名：${AUTH_USER_INPUT}"
echo "  密码：（你刚才设置的密码）"
echo ""
echo "  下一步：打开浏览器访问上方地址，扫码登录 WhatsApp"
echo ""
echo "  常用命令："
echo "    pm2 logs ${PM2_APP_NAME}     # 查看实时日志"
echo "    pm2 restart ${PM2_APP_NAME}  # 重启"
echo "    pm2 stop ${PM2_APP_NAME}     # 停止"
echo ""
