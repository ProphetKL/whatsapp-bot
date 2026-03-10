# WhatsApp 定时消息机器人

部署在云服务器（Ubuntu/Debian）的 WhatsApp 群组定时消息机器人。
通过网页管理界面设置定时任务，机器人在指定时间自动向指定群组发送消息。

---

## 功能

- 扫码登录个人 WhatsApp 账号，无需 API Key
- 网页管理界面：新增、编辑、删除定时任务
- 支持多种重复方式：每天、每周指定日、每月指定日、单次指定日期
- 保存任务后立即生效，无需重启
- 登录会话持久化，服务器重启后自动恢复连接
- 强制密码保护 + 登录频率限制，防止暴力破解
- PM2 守护进程，崩溃后自动重启，开机自启

---

## 系统要求

- Ubuntu 20.04 / 22.04 或 Debian 11 / 12
- 至少 1 GB 内存（Chromium 需要）
- root 或 sudo 权限

---

## 一键安装

```bash
curl -fsSL https://raw.githubusercontent.com/ProphetKL/whatsapp-bot/main/install.sh | sudo bash
```

脚本自动完成：检查系统 → 安装依赖 → 安装 Node.js → 安装 PM2 → 下载项目 → **强制设置用户名密码** → 启动 → 配置开机自启 → 开放防火墙端口

---

## 安装后使用

1. 浏览器访问 `http://服务器IP:3000`
2. 输入安装时设置的用户名和密码
3. 扫描页面上的 QR 码，完成 WhatsApp 登录
4. 在管理界面添加定时任务

---

## 常用命令

```bash
pm2 logs whatsapp-bot      # 查看实时日志
pm2 status                 # 查看运行状态
pm2 restart whatsapp-bot   # 重启
pm2 stop whatsapp-bot      # 停止
```

---

## 安全说明

- 管理界面强制 Basic Auth，未设置密码时程序拒绝启动
- 同一 IP 15 分钟内登录失败 5 次后自动封锁
- `.env` 文件权限 600，仅 root 可读
- 建议配合 Nginx 反向代理 + HTTPS，防止密码明文传输

---

## 注意事项

- `data/` 目录保存 WhatsApp 登录会话，删除后需重新扫码
- 仅支持个人 WhatsApp 账号（不支持 WhatsApp Business API）
- 请遵守 [WhatsApp 服务条款](https://www.whatsapp.com/legal/terms-of-service)
